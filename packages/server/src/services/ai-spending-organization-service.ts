/**
 * AI spending organization — bounded, complete, read-only analysis of a chosen
 * inclusive date range, a frozen review card, atomic idempotent apply and
 * conditional undo.
 *
 * The provider only analyses server-provided facts; it never decides ids or writes
 * data. Every accepted range is processed in sequential batches, and an accepted run
 * completes every batch. A provider or normalization failure fails the whole run
 * without publishing any actionable card. Card actions carry display-only transaction
 * facts; apply revalidates by id against the server-owned run snapshot.
 */
import { createHash, randomUUID } from 'node:crypto';
import { expenseContribution, type Transaction } from '@jizhang/shared';
import type { Db } from '../db/index.js';
import { AiConfigService } from './ai-config-service.js';
import { AiProviderService } from './ai-provider-service.js';
import {
  AiError,
  AiOrganizationConflictError,
  AiOrganizationResponseInvalidError,
  AiSpendingCardNotReadyError,
  AiSpendingOperationNotFoundError,
  AiSpendingOverCapError,
  AiSpendingRunNotFoundError,
  AiSpendingRunsInputError,
} from './ai-types.js';
import { normaliseTags, parseTagsJson, serialiseTags } from './tags.js';
import { TagCatalogService } from './tag-catalog-service.js';

/** Provisional cap/batch calibrated synthetically; NOT production-accepted numbers. */
const MAX_ELIGIBLE_ROWS = 500;
const BATCH_SIZE = 10;
const MAX_RUN_ATTEMPTS = 3;
const ATTEMPT_BUDGET_MS = 10 * 60 * 1000;
const MAX_REASON_LENGTH = 300;
const MAX_SUGGESTED_NOTE_LENGTH = 200;
const MAX_CATEGORY_NAME_LENGTH = 32;
const CARD_TTL_MS = 24 * 60 * 60 * 1000;

const RESPONSE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    reclassifications: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          transactionId: { type: 'string' },
          targetCategoryId: { type: 'string' },
          reason: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
        required: ['transactionId', 'targetCategoryId', 'reason', 'confidence'],
      },
    },
    tagSuggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          transactionId: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          reason: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
        required: ['transactionId', 'tags', 'reason', 'confidence'],
      },
    },
    noteSuggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          transactionId: { type: 'string' },
          suggestedNote: { type: 'string' },
          reason: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
        required: ['transactionId', 'suggestedNote', 'reason', 'confidence'],
      },
    },
    newCategories: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          type: { type: 'number', enum: [0, 1] },
          parentCategoryId: { type: ['string', 'null'] },
          evidenceTransactionIds: { type: 'array', items: { type: 'string' } },
          reason: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
        required: ['name', 'type', 'parentCategoryId', 'evidenceTransactionIds', 'reason', 'confidence'],
      },
    },
  },
  required: ['reclassifications', 'tagSuggestions', 'noteSuggestions', 'newCategories'],
};

interface EligibleRow {
  readonly id: string;
  readonly type: number;
  readonly amount_cents: number;
  readonly category_id: string;
  readonly note: string;
  readonly tags_json: string;
  readonly date: number;
}

interface CategoryFact {
  readonly id: string;
  readonly name: string;
  readonly type: number;
  readonly parentCategoryId: string | null;
}

export type SpendingSuggestionKind = 'category' | 'category-suggestion' | 'tag' | 'note';

export interface SpendingSuggestion {
  readonly actionId: string;
  readonly kind: SpendingSuggestionKind;
  readonly transactionId: string | null;
  /** Display-only facts captured with the run; apply still revalidates by id. */
  readonly transactionDateLabel: string | null;
  readonly transactionAmountCents: number | null;
  readonly transactionType: number | null;
  readonly beforeCategoryId: string | null;
  readonly beforeCategoryName: string | null;
  readonly afterCategoryId: string | null;
  readonly afterCategoryName: string | null;
  readonly beforeTags: readonly string[];
  readonly afterTags: readonly string[];
  readonly suggestedNote: string | null;
  readonly proposedCategoryName: string | null;
  readonly proposedCategoryType: number | null;
  readonly proposedParentCategoryId: string | null;
  readonly proposedParentCategoryName: string | null;
  readonly reason: string;
  readonly confidence: number;
}

export type SpendingProgressPhase = 'preparing' | 'analysing' | 'validating' | 'publishing' | 'ready' | 'failed';

export interface SpendingRunProgress {
  phase: SpendingProgressPhase;
  totalBatches: number;
  completedBatches: number;
  currentBatch: number;
  suggestionCount: number;
  startedAt: number;
  updatedAt: number;
  events: { seq: number; phase: SpendingProgressPhase; batch: number; completedCount: number; message: string; at: number }[];
  errorDetail: { stage: string; field: string | null; batch: number } | null;
}

/** Only a server-defined schema field is retained, never model output. */
class SpendingResponseShapeError extends AiOrganizationResponseInvalidError {
  constructor(readonly field: string) { super(); }
}

export interface SpendingRunSummary {
  readonly runId: string;
  readonly status: 'running' | 'ready' | 'failed' | 'cancelled';
  readonly startDate: string;
  readonly endDate: string;
  readonly eligibleCount: number;
  readonly completedCount: number;
  readonly errorCode: string | null;
  readonly attempt: number;
  readonly canResume: boolean;
  readonly progress: SpendingRunProgress | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface TemplateModuleProposal {
  readonly categoryId: string;
  readonly ratio: number;
}

export interface TemplateProposal {
  readonly actionId: string;
  readonly kind: 'new' | 'update';
  readonly templateId: string | null;
  readonly templateName: string;
  readonly modules: readonly TemplateModuleProposal[];
  readonly beforeModules: readonly TemplateModuleProposal[];
  readonly reason: string;
  readonly confidence: number;
}

export interface SpendingApplyResult {
  readonly operationId: string;
  readonly status: 'applied' | 'undone';
  readonly appliedActions: readonly string[];
}

interface OperationProjection {
  readonly transactions: readonly { readonly id: string; readonly category_id: string; readonly tags_json: string }[];
  readonly createdCategoryIds: readonly string[];
  /**
   * Template projections are still *read* here because operations applied before the
   * template surface was retired recorded them, and an undo of such an operation must be
   * able to reverse it. New operations never populate them.
   */
  readonly createdTemplateIds?: readonly string[];
  readonly templateUpdates?: readonly { readonly id: string; readonly before_modules: string }[];
}

interface OperationRow {
  readonly id: string;
  readonly run_id: string;
  readonly status: string;
  readonly action_ids_json: string;
  readonly fingerprint: string;
  readonly before_json: string;
  readonly after_json: string;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface SpendingRunCard {
  readonly runId: string;
  readonly status: 'ready';
  readonly startDate: string;
  readonly endDate: string;
  readonly eligibleCount: number;
  readonly completedCount: number;
  readonly version: number;
  readonly expiresAt: number;
  readonly fingerprint: string;
  readonly coverage: {
    readonly eligibleIds: readonly string[];
  };
  readonly evidenceByCategory: Readonly<Record<string, number>>;
  readonly actions: readonly SpendingSuggestion[];
  readonly templateProposals: readonly TemplateProposal[];
  readonly noteSuggestions: readonly {
    readonly actionId: string;
    readonly transactionId: string;
    readonly transactionDateLabel: string | null;
    readonly transactionAmountCents: number | null;
    readonly transactionType: number | null;
    readonly suggestedNote: string;
  }[];
}

interface RunRow {
  readonly id: string;
  readonly status: string;
  readonly start_date: string;
  readonly end_date: string;
  readonly eligible_count: number;
  readonly completed_count: number;
  readonly coverage_json: string;
  readonly suggestions_json: string;
  readonly template_proposals_json: string;
  readonly progress_json: string;
  readonly client_request_id: string | null;
  readonly request_hash: string | null;
  readonly checkpoint_json: string;
  readonly source_hash: string;
  readonly batch_size: number;
  readonly attempt: number;
  readonly fingerprint: string;
  readonly error_code: string | null;
  readonly created_at: number;
  readonly updated_at: number;
}

interface SpendingCheckpoint {
  version: 1;
  startMs: number;
  endMsExclusive: number;
  batchSize: number;
  completedCount: number;
  suggestions: SpendingSuggestion[];
  templateProposals: TemplateProposal[];
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AiOrganizationResponseInvalidError();
  }
  return value as Record<string, unknown>;
}

function boundedReason(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  return value.trim().slice(0, MAX_REASON_LENGTH);
}

function clampedConfidence(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0;
}

function normalizedName(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('zh-CN');
}

function redactNote(note: string): string {
  return note
    .replace(/\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b/g, '[日期]')
    .replace(/\d{1,2}月\d{1,2}[日号]/g, '[日期]')
    .replace(/(?:尾号|卡号|账户)[\s:：-]*\d{2,}/g, '[账户]')
    .trim()
    .replace(/(?:\d[\d,.]*\s*(?:元|块|块钱|人民币|¥|￥|元钱))/gi, '[金额]')
    .replace(/\b\d{4,}\b/g, '[数字]')
    .slice(0, 120);
}

function errorCodeOf(error: unknown): string {
  if (error instanceof AiError) return error.code;
  return 'AI_ORGANIZATION_FAILED';
}

export interface AiSpendingOrganizationServiceOptions {
  readonly now?: () => number;
}

type SpendingWork = Map<string, { controller: AbortController; task: Promise<SpendingRunSummary> }>;

export class AiSpendingOrganizationService {
  private readonly now: () => number;
  // Route and assistant contexts can use different scoped providers for the same private
  // ledger. Share work ownership, and recover interrupted persisted runs only once.
  private static readonly workByDb = new WeakMap<Db, SpendingWork>();
  private static readonly closingWork = new WeakSet<SpendingWork>();
  private readonly active: SpendingWork;
  private closing = false;

  constructor(
    private readonly db: Db,
    private readonly config: AiConfigService,
    private readonly provider: AiProviderService,
    options: AiSpendingOrganizationServiceOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    const existing = AiSpendingOrganizationService.workByDb.get(db);
    this.active = existing ?? new Map();
    this.closing = AiSpendingOrganizationService.closingWork.has(this.active);
    if (existing === undefined) {
      AiSpendingOrganizationService.workByDb.set(db, this.active);
      this.purgeExpiredCheckpoints();
    }
    // Runs from a previous process cannot safely resume an in-memory provider call.
    const interrupted = this.db.prepare("SELECT id FROM ai_analysis_runs WHERE status = 'running'").all() as { id: string }[];
    for (const { id } of interrupted) {
      // A scoped provider can be constructed while another service owns a live
      // run. Only a durable row with no in-process owner is interrupted work.
      if (!this.active.has(id)) this.failRun(id, 'AI_ORGANIZATION_INTERRUPTED', { stage: 'interrupted', field: null, batch: 0 });
    }
  }

  get hasActiveWork(): boolean { return this.active.size > 0; }

  static hasActiveFor(db: Db): boolean { return (this.workByDb.get(db)?.size ?? 0) > 0; }

  static async shutdownFor(db: Db): Promise<void> {
    const active = this.workByDb.get(db);
    if (!active) return;
    this.closingWork.add(active);
    for (const entry of active.values()) entry.controller.abort();
    await Promise.allSettled([...active.values()].map((entry) => entry.task));
    // The original owner's DB handle survives an idle tenant eviction. Retire
    // this service generation, not the connection identity: a later lease can
    // construct a fresh generation only after this work has drained.
    if (this.workByDb.get(db) === active) this.workByDb.delete(db);
  }

  async close(): Promise<void> {
    this.closing = true;
    await AiSpendingOrganizationService.shutdownFor(this.db);
  }

  async startAnalysis(input: unknown): Promise<SpendingRunSummary> {
    const record = typeof input === 'object' && input !== null && !Array.isArray(input)
      ? input as Record<string, unknown>
      : {};
    const start = this.parseDay(record['startDate'], 'startDate');
    const end = this.parseDay(record['endDate'], 'endDate');
    const startMs = this.dayStartMs(start);
    const endMsExclusive = this.dayEndExclusiveMs(end);
    if (startMs >= endMsExclusive) {
      throw new AiSpendingRunsInputError('startDate must be on or before endDate.');
    }
    if (this.closing || AiSpendingOrganizationService.closingWork.has(this.active)) throw new AiError(503, 'AI_ORGANIZATION_INTERRUPTED', '服务正在停止，请稍后重试。');
    if (record['background'] !== undefined && typeof record['background'] !== 'boolean') {
      throw new AiSpendingRunsInputError('background 必须是布尔值。');
    }
    const background = record['background'] === true;
    const requestId = record['clientRequestId'];
    if ((background || requestId !== undefined) &&
        (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(requestId))) {
      throw new AiSpendingRunsInputError('异步分析需要有效的 clientRequestId。');
    }
    const requestHash = hashJson({ startDate: start.value, endDate: end.value, background });
    if (typeof requestId === 'string') {
      const prior = this.db.prepare('SELECT id, request_hash FROM ai_analysis_runs WHERE client_request_id = ?')
        .get(requestId) as { id: string; request_hash: string | null } | undefined;
      if (prior) {
        if (prior.request_hash !== requestHash) throw new AiSpendingRunsInputError('相同请求编号不能用于不同日期范围。');
        return this.getRun(prior.id);
      }
    }
    if (this.active.size > 0) throw new AiError(409, 'AI_ORGANIZATION_BUSY', '已有整理任务正在分析，请继续查看原任务。');

    const eligible = this.db
      .prepare(
        `SELECT id, type, amount_cents, category_id, note, tags_json, date
           FROM transactions
          WHERE deleted = 0 AND date >= ? AND date < ?
          ORDER BY date ASC, id ASC`,
      )
      .all(startMs, endMsExclusive) as EligibleRow[];

    if (eligible.length > MAX_ELIGIBLE_ROWS) {
      throw new AiSpendingOverCapError(
        `该时间段内有 ${eligible.length} 笔账单，超过单次分析上限 ${MAX_ELIGIBLE_ROWS} 笔，请缩小日期范围。`,
      );
    }

    const runId = randomUUID();
    const nowMs = this.now();
    const evidence = new Map<string, number>();
    for (const row of eligible) {
      const contribution = expenseContribution({
        id: row.id,
        type: row.type,
        amountCents: row.amount_cents,
        categoryId: row.category_id,
        date: row.date,
      } as Transaction);
      if (contribution > 0) evidence.set(row.category_id, (evidence.get(row.category_id) ?? 0) + contribution);
    }
    const coverage = {
      eligibleIds: eligible.map((row) => row.id),
      evidenceByCategory: Object.fromEntries(evidence),
      beforeStates: eligible.map((row) => ({
        id: row.id,
        categoryId: row.category_id,
        tags: parseTagsJson(row.tags_json),
      })),
    };
    this.db
      .prepare(
        `INSERT INTO ai_analysis_runs
           (id, status, start_date, end_date, eligible_count, completed_count, coverage_json, suggestions_json, fingerprint, error_code, created_at, updated_at)
         VALUES (?, 'running', ?, ?, ?, 0, ?, '[]', '', NULL, ?, ?)`,
      )
      .run(runId, start.value, end.value, eligible.length, JSON.stringify(coverage), nowMs, nowMs);

    const checkpoint: SpendingCheckpoint = {
      version: 1, startMs, endMsExclusive, batchSize: BATCH_SIZE, completedCount: 0,
      suggestions: [], templateProposals: [],
    };
    this.db.prepare('UPDATE ai_analysis_runs SET client_request_id = ?, request_hash = ?, checkpoint_json = ?, source_hash = ?, batch_size = ? WHERE id = ?')
      .run(typeof requestId === 'string' ? requestId : null, requestHash, JSON.stringify(checkpoint),
        this.sourceHash(startMs, endMsExclusive), BATCH_SIZE, runId);
    this.checkpoint(runId, 'preparing', 0, 0, 0, `已读取所选区间 ${eligible.length} 笔账单，正在准备分类与标签分析。`);
    if (eligible.length === 0) {
      this.finishReady(runId, coverage, []);
      this.checkpoint(runId, 'ready', 0, 0, 0, '所选区间没有账单，无需调用 AI。');
      return this.getRun(runId);
    }

    const task = this.scheduleRun(runId, eligible, coverage);
    if (background) return this.getRun(runId);
    return task;
  }

  async resumeAnalysis(runId: string, input: unknown): Promise<SpendingRunSummary> {
    const record = typeof input === 'object' && input !== null && !Array.isArray(input)
      ? input as Record<string, unknown> : {};
    const requestId = record['clientRequestId'];
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(requestId)) {
      throw new AiSpendingRunsInputError('继续分析需要有效的 clientRequestId。');
    }
    const replay = this.db.prepare('SELECT run_id FROM ai_organization_resume_requests WHERE client_request_id = ?')
      .get(requestId) as { run_id: string } | undefined;
    if (replay) {
      if (replay.run_id !== runId) throw new AiSpendingRunsInputError('继续请求编号已被其他任务使用。');
      return this.getRun(runId);
    }
    if (this.closing || AiSpendingOrganizationService.closingWork.has(this.active)) throw new AiError(503, 'AI_ORGANIZATION_INTERRUPTED', '服务正在停止，请稍后重试。');
    if (this.active.size > 0) throw new AiError(409, 'AI_ORGANIZATION_BUSY', '已有整理任务正在分析，请继续查看原任务。');
    this.purgeExpiredCheckpoints();
    const row = this.runRow(runId);
    if (!this.isResumable(row)) throw new AiOrganizationConflictError('本任务不能继续：已过期、达到次数上限或没有安全断点，请重新分析。');
    const checkpoint = this.readCheckpoint(row);
    try { this.assertSource(row, checkpoint); } catch (error) {
      this.failRun(runId, 'AI_ORGANIZATION_CONFLICT', { stage: 'preparing', field: null, batch: 0 });
      throw error;
    }
    const eligible = this.loadEligible(checkpoint.startMs, checkpoint.endMsExclusive);
    const claim = this.db.transaction(() => {
      this.db.prepare("UPDATE ai_analysis_runs SET status = 'running', attempt = attempt + 1, error_code = NULL WHERE id = ? AND status = 'failed'")
        .run(runId);
      this.db.prepare('INSERT INTO ai_organization_resume_requests (client_request_id,run_id,attempt,created_at) VALUES (?,?,?,?)')
        .run(requestId, runId, row.attempt + 1, this.now());
      this.checkpoint(runId, 'preparing', Math.floor(checkpoint.completedCount / checkpoint.batchSize), checkpoint.completedCount,
        checkpoint.suggestions.length + checkpoint.templateProposals.length,
        `已明确继续第 ${row.attempt + 1}/${MAX_RUN_ATTEMPTS} 次分析：复用已校验 ${checkpoint.completedCount} 笔，只请求未完成批次；可能产生新的 AI 调用费用。`);
    });
    claim();
    this.scheduleRun(runId, eligible, JSON.parse(row.coverage_json) as unknown);
    return this.getRun(runId);
  }

  /** Assistant scopes await completion so cancellation/lifetime stay owned by their turn. */
  async resumeAndWait(runId: string, input: unknown): Promise<SpendingRunSummary> {
    const run = await this.resumeAnalysis(runId, input);
    return this.active.get(runId)?.task ?? run;
  }

  private scheduleRun(runId: string, eligible: readonly EligibleRow[], coverage: unknown): Promise<SpendingRunSummary> {
    const controller = new AbortController();
    const task = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => this.analyseRun(runId, eligible, coverage, controller.signal))
      .finally(() => { this.active.delete(runId); });
    this.active.set(runId, { controller, task });
    return task;
  }

  private async analyseRun(
    runId: string,
    eligible: readonly EligibleRow[],
    coverage: unknown,
    signal: AbortSignal,
  ): Promise<SpendingRunSummary> {
    let stage: SpendingProgressPhase = 'preparing';
    let currentBatch = 0;
    try {
      const stored = this.config.getStoredOrThrow();
      const secret = this.config.getSecretOrThrow(stored);
      const categories = this.loadCategories();
      const categoryNames = new Map(categories.map((category) => [category.id, category.name]));
      const initial = this.runRow(runId);
      const saved = this.readCheckpoint(initial);
      this.assertSource(initial, saved);
      const suggestions: SpendingSuggestion[] = [...saved.suggestions];
      // `templateProposals` stays on the checkpoint/row shape for older runs, but new
      // batches no longer produce any: allocation templates are retired in favour of
      // tags, so proposing a template would suggest an action the product cannot honour.
      const templateProposals: TemplateProposal[] = [];
      const deadline = performance.now() + ATTEMPT_BUDGET_MS;

      for (let offset = saved.completedCount; offset < eligible.length; offset += saved.batchSize) {
        this.assertRunning(runId, signal);
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw new AiError(504, 'AI_PROVIDER_TIMEOUT', '本次分析观察预算已用完，请明确继续剩余批次。');
        const batch = eligible.slice(offset, offset + saved.batchSize);
        currentBatch = Math.floor(offset / saved.batchSize) + 1;
        stage = 'analysing';
        this.checkpoint(runId, stage, currentBatch, offset, suggestions.length + templateProposals.length,
          `正在调用 AI 分析第 ${currentBatch}/${Math.ceil(eligible.length / saved.batchSize)} 批（${batch.length} 笔），检查分类、标签和独立备注建议；第 ${initial.attempt}/${MAX_RUN_ATTEMPTS} 次分析。`);
        const raw = await this.provider.complete(stored, secret, {
          input: '请分析这些账单的分类、标签和备注是否需要整理，并提出建议。',
          categories: [],
          accounts: [],
          model: stored.model,
          today: new Date(this.now()).toISOString().slice(0, 10),
          responseSchema: RESPONSE_SCHEMA,
          feature: 'spending-organization',
          facts: this.batchFacts(batch, categories, categoryNames),
        }, { signal, timeoutMs: Math.max(1, Math.floor(remaining)) });
        this.assertRunning(runId, signal);
        stage = 'validating';
        this.checkpoint(runId, stage, currentBatch, offset, suggestions.length + templateProposals.length,
          `第 ${currentBatch} 批 AI 已返回，正在校验结构、账单编号与分类约束。`);
        this.assertResponseShape(raw);
        const batchSuggestions = this.normalize(raw, batch, categories);
        suggestions.push(...batchSuggestions);
        const committed: SpendingCheckpoint = { ...saved, completedCount: offset + batch.length, suggestions, templateProposals };
        const commit = this.db.transaction(() => {
          this.db.prepare('UPDATE ai_analysis_runs SET completed_count = ?, checkpoint_json = ?, updated_at = ? WHERE id = ?')
            .run(committed.completedCount, JSON.stringify(committed), this.now(), runId);
          this.checkpoint(runId, stage, currentBatch, committed.completedCount, suggestions.length + templateProposals.length,
            `第 ${currentBatch} 批已校验并保存安全断点，累计完成 ${committed.completedCount}/${eligible.length} 笔；未生成可应用的部分卡片。`);
        });
        commit();
        await new Promise<void>((resolve) => setImmediate(resolve));
      }

      this.assertRunning(runId, signal);
      stage = 'publishing';
      this.checkpoint(runId, stage, currentBatch, eligible.length, suggestions.length + templateProposals.length,
        '全部批次已校验，正在生成完整审查卡片；未修改账本。');
      const publish = this.db.transaction(() => {
        const current = this.runRow(runId);
        this.assertSource(current, this.readCheckpoint(current));
        this.finishReady(runId, coverage, suggestions);
        this.db.prepare('UPDATE ai_analysis_runs SET checkpoint_json = ? WHERE id = ?')
          .run(JSON.stringify({ ...saved, completedCount: eligible.length, suggestions: [], templateProposals: [] }), runId);
        this.checkpoint(runId, 'ready', currentBatch, eligible.length, suggestions.length + templateProposals.length,
          '审查卡片已生成，等待你核对并确认；没有自动应用整理。');
      });
      publish();
      return this.getRun(runId);
    } catch (error) {
      this.failRun(runId, signal.aborted ? 'AI_ORGANIZATION_INTERRUPTED' : errorCodeOf(error), {
        stage: signal.aborted ? 'interrupted' : stage,
        field: error instanceof SpendingResponseShapeError ? error.field : null,
        batch: currentBatch,
      });
      return this.getRun(runId);
    }
  }

  private loadEligible(startMs: number, endMsExclusive: number): EligibleRow[] {
    return this.db.prepare(`SELECT id,type,amount_cents,category_id,note,tags_json,date FROM transactions
      WHERE deleted = 0 AND date >= ? AND date < ? ORDER BY date ASC,id ASC`)
      .all(startMs, endMsExclusive) as EligibleRow[];
  }

  private sourceHash(startMs: number, endMsExclusive: number): string {
    // Notes are hashed transiently, never copied into the checkpoint or progress.
    return hashJson({
      transactions: this.db.prepare('SELECT * FROM transactions WHERE deleted = 0 AND date >= ? AND date < ? ORDER BY date,id')
        .all(startMs, endMsExclusive),
      categories: this.db.prepare('SELECT * FROM categories ORDER BY id').all(),
      tags: this.db.prepare('SELECT * FROM tags ORDER BY id').all(),
      templates: this.db.prepare('SELECT * FROM budget_templates ORDER BY id').all(),
      refundLinks: this.db.prepare('SELECT * FROM refund_links ORDER BY refund_tx_id,original_tx_id').all(),
    });
  }

  private readCheckpoint(row: RunRow): SpendingCheckpoint {
    try {
      const value = JSON.parse(row.checkpoint_json) as SpendingCheckpoint;
      if (value.version !== 1 || !Number.isSafeInteger(value.startMs) || !Number.isSafeInteger(value.endMsExclusive) ||
          value.startMs >= value.endMsExclusive || value.batchSize !== row.batch_size || !Number.isInteger(value.batchSize) ||
          value.batchSize < 1 || value.batchSize > 25 || value.completedCount !== row.completed_count ||
          value.completedCount < 0 || value.completedCount > row.eligible_count ||
          (value.completedCount !== row.eligible_count && value.completedCount % value.batchSize !== 0) ||
          !Array.isArray(value.suggestions) || !Array.isArray(value.templateProposals)) throw new Error('bad checkpoint');
      return value;
    } catch { throw new AiOrganizationConflictError('没有可校验的安全断点，请重新分析。'); }
  }

  private assertSource(row: RunRow, checkpoint: SpendingCheckpoint): void {
    if (!row.source_hash || row.source_hash !== this.sourceHash(checkpoint.startMs, checkpoint.endMsExclusive)) {
      throw new AiOrganizationConflictError('账单、分类、标签或模板已变化，不能复用旧分析，请重新分析。');
    }
  }

  private purgeExpiredCheckpoints(): void {
    // Maintenance occurs only on service startup or an explicit paid-resume gesture, never GET.
    this.db.prepare("UPDATE ai_analysis_runs SET checkpoint_json = '{}' WHERE status = 'failed' AND checkpoint_json <> '{}' AND created_at < ?")
      .run(this.now() - CARD_TTL_MS);
  }

  private isResumable(row: RunRow): boolean {
    if (row.status !== 'failed' || row.error_code !== 'AI_PROVIDER_TIMEOUT' || row.attempt >= MAX_RUN_ATTEMPTS ||
        this.now() > row.created_at + CARD_TTL_MS || !row.source_hash) return false;
    try { this.readCheckpoint(row); return true; } catch { return false; }
  }

  private assertRunning(id: string, signal: AbortSignal): void {
    if (signal.aborted || this.runRow(id).status !== 'running') {
      throw new AiError(409, 'AI_ORGANIZATION_INTERRUPTED', '整理任务已中断。');
    }
  }

  private assertResponseShape(raw: unknown): void {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SpendingResponseShapeError('response');
    const record = raw as Record<string, unknown>;
    for (const field of ['reclassifications', 'tagSuggestions', 'noteSuggestions', 'newCategories']) {
      if (!Array.isArray(record[field])) throw new SpendingResponseShapeError(field);
    }
  }

  private checkpoint(
    id: string, phase: SpendingProgressPhase, batch: number, completed: number, suggestionCount: number, message: string,
  ): void {
    const row = this.runRow(id);
    const previous = this.readProgress(row);
    const at = this.now();
    const events = [...(previous?.events ?? [])];
    events.push({ seq: (events.at(-1)?.seq ?? 0) + 1, phase, batch, completedCount: completed, message, at });
    const progress: SpendingRunProgress = {
      phase, totalBatches: Math.ceil(row.eligible_count / row.batch_size),
      completedBatches: Math.min(Math.ceil(completed / row.batch_size), Math.ceil(row.eligible_count / row.batch_size)),
      currentBatch: batch, suggestionCount, startedAt: previous?.startedAt ?? row.created_at, updatedAt: at,
      events: events.slice(-256), errorDetail: phase === 'failed' ? previous?.errorDetail ?? null : null,
    };
    this.db.prepare('UPDATE ai_analysis_runs SET progress_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(progress), at, id);
  }

  private readProgress(row: RunRow): SpendingRunProgress | null {
    try {
      const progress = JSON.parse(row.progress_json) as Partial<SpendingRunProgress>;
      return Array.isArray(progress.events) && typeof progress.phase === 'string'
        ? progress as SpendingRunProgress : null;
    } catch { return null; }
  }

  private failRun(id: string, code: string, detail: { stage: string; field: string | null; batch: number }): void {
    const row = this.runRow(id);
    const fail = this.db.transaction(() => {
      this.db.prepare("UPDATE ai_analysis_runs SET status = 'failed', suggestions_json = '[]', template_proposals_json = '[]', fingerprint = '', error_code = ?, updated_at = ? WHERE id = ?")
        .run(code, this.now(), id);
      this.db.prepare('DELETE FROM ai_note_suggestions WHERE run_id = ?').run(id);
      const keepCheckpoint = code === 'AI_PROVIDER_TIMEOUT' && row.attempt < MAX_RUN_ATTEMPTS &&
        this.now() <= row.created_at + CARD_TTL_MS && row.source_hash !== '';
      if (!keepCheckpoint) {
        this.db.prepare("UPDATE ai_analysis_runs SET checkpoint_json = '{}' WHERE id = ?").run(id);
      }
      this.checkpoint(id, 'failed', detail.batch, row.completed_count, 0,
        detail.field ? `第 ${detail.batch} 批结果结构校验失败：${detail.field} 必须为数组；本次未生成卡片、未改账本。`
          : keepCheckpoint ? `第 ${detail.batch} 批等待 AI 响应超时；已保留 ${row.completed_count} 笔安全断点，可明确继续未完成批次（可能产生 AI 调用费用），未改账本。`
            : '本次分析未完成；未发布部分建议卡片，未修改账本。');
      const updated = this.readProgress(this.runRow(id));
      if (updated) {
        updated.errorDetail = detail;
        this.db.prepare('UPDATE ai_analysis_runs SET progress_json = ? WHERE id = ?').run(JSON.stringify(updated), id);
      }
    });
    fail();
  }

  getRun(id: string): SpendingRunSummary {
    const row = this.runRow(id);
    return {
      runId: row.id,
      status: row.status as SpendingRunSummary['status'],
      startDate: row.start_date,
      endDate: row.end_date,
      eligibleCount: row.eligible_count,
      completedCount: row.completed_count,
      errorCode: row.error_code,
      attempt: row.attempt,
      canResume: this.isResumable(row),
      progress: this.readProgress(row),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  getCard(id: string): SpendingRunCard {
    const row = this.runRow(id);
    if (row.status !== 'ready') throw new AiSpendingCardNotReadyError();
    const suggestions = this.parseSuggestions(row.suggestions_json);
    const coverage = this.parseCoverage(row.coverage_json);
    return {
      runId: row.id,
      status: 'ready',
      startDate: row.start_date,
      endDate: row.end_date,
      eligibleCount: row.eligible_count,
      completedCount: row.completed_count,
      version: row.updated_at,
      expiresAt: row.updated_at + CARD_TTL_MS,
      fingerprint: row.fingerprint,
      coverage: { eligibleIds: coverage.eligibleIds },
      evidenceByCategory: coverage.evidenceByCategory,
      actions: suggestions,
      // Always empty: the template surface is retired. Older runs may still carry stored
      // proposals; returning them would present an action the client can no longer apply.
      templateProposals: [],
      noteSuggestions: suggestions
        .filter((suggestion) => suggestion.kind === 'note' && suggestion.transactionId !== null)
        .map((suggestion) => ({
          actionId: suggestion.actionId,
          transactionId: suggestion.transactionId as string,
          transactionDateLabel: suggestion.transactionDateLabel ?? null,
          transactionAmountCents: suggestion.transactionAmountCents ?? null,
          transactionType: suggestion.transactionType ?? null,
          suggestedNote: suggestion.suggestedNote as string,
        })),
    };
  }

  apply(runId: string, actionIds: unknown): SpendingApplyResult {
    const row = this.runRow(runId);
    if (row.status !== 'ready') throw new AiSpendingCardNotReadyError();
    const nowMs = this.now();
    if (nowMs > row.updated_at + CARD_TTL_MS) {
      throw new AiOrganizationConflictError('这张审查卡片已过期，请重新分析后再应用。');
    }
    const ids = this.parseActionIds(actionIds);
    const suggestions = this.parseSuggestions(row.suggestions_json);
    const coverage = this.parseCoverage(row.coverage_json);

    // Template proposals are no longer a thing to apply. A caller that still sends one of
    // those ids (an older client, or a card cached from a run that produced them) simply
    // selects nothing, so the request fails with the ordinary "nothing to apply" error
    // instead of silently creating a budget template behind the user's back.
    const suggestionById = new Map(suggestions.map((suggestion) => [suggestion.actionId, suggestion]));
    const selectedSuggestions = ids
      .map((id) => suggestionById.get(id))
      .filter((suggestion): suggestion is SpendingSuggestion => suggestion !== undefined && suggestion.kind !== 'note');

    if (selectedSuggestions.length === 0) {
      throw new AiSpendingRunsInputError('没有可应用的动作。');
    }
    const appliedIds = selectedSuggestions.map((suggestion) => suggestion.actionId);

    const fingerprint = hashJson({ runId, actionIds: [...appliedIds].sort() });
    const existing = this.db
      .prepare("SELECT * FROM ai_organization_operations WHERE fingerprint = ? AND status = 'applied'")
      .get(fingerprint) as OperationRow | undefined;
    if (existing !== undefined) {
      return {
        operationId: existing.id,
        status: existing.status as 'applied' | 'undone',
        appliedActions: JSON.parse(existing.action_ids_json) as string[],
      };
    }

    const beforeById = new Map(coverage.beforeStates.map((state) => [state.id, state]));
    const affectedTxIds = new Set(
      selectedSuggestions.filter((suggestion) => suggestion.transactionId !== null).map((suggestion) => suggestion.transactionId as string),
    );
    const beforeTransactions: { id: string; category_id: string; tags_json: string }[] = [];
    for (const txId of affectedTxIds) {
      const expected = beforeById.get(txId);
      const current = this.db
        .prepare('SELECT category_id, tags_json FROM transactions WHERE id = ?')
        .get(txId) as { category_id: string; tags_json: string } | undefined;
      if (current === undefined) throw new AiOrganizationConflictError('账单已不存在，无法应用。');
      if (expected === undefined) throw new AiOrganizationConflictError('账单不在本次分析范围内。');
      if (
        current.category_id !== expected.categoryId ||
        parseTagsJson(current.tags_json).join('\u0000') !== expected.tags.join('\u0000')
      ) {
        throw new AiOrganizationConflictError('账单已变化，请重新分析后再应用。');
      }
      beforeTransactions.push({ id: txId, category_id: current.category_id, tags_json: current.tags_json });
    }

    const afterTransactions: { id: string; category_id: string; tags_json: string }[] = [];
    const createdCategoryIds: string[] = [];
    const catalog = new TagCatalogService(this.db, this.now);

    const run = this.db.transaction((): string => {
      for (const suggestion of selectedSuggestions) {
        if (suggestion.kind === 'category' && suggestion.transactionId !== null && suggestion.afterCategoryId !== null) {
          this.db.prepare('UPDATE transactions SET category_id = ?, updated_at = ? WHERE id = ?')
            .run(suggestion.afterCategoryId, nowMs, suggestion.transactionId);
          afterTransactions.push({
            id: suggestion.transactionId,
            category_id: suggestion.afterCategoryId,
            tags_json: beforeTransactions.find((tx) => tx.id === suggestion.transactionId)?.tags_json ?? '[]',
          });
        } else if (suggestion.kind === 'tag' && suggestion.transactionId !== null) {
          const json = serialiseTags(suggestion.afterTags);
          this.db.prepare('UPDATE transactions SET tags_json = ?, updated_at = ? WHERE id = ?')
            .run(json, nowMs, suggestion.transactionId);
          for (const tag of suggestion.afterTags) catalog.ensureTag(this.db, tag, nowMs);
          afterTransactions.push({
            id: suggestion.transactionId,
            category_id: beforeTransactions.find((tx) => tx.id === suggestion.transactionId)?.category_id ?? '',
            tags_json: json,
          });
        } else if (
          suggestion.kind === 'category-suggestion' &&
          suggestion.proposedCategoryName !== null &&
          suggestion.proposedCategoryType !== null
        ) {
          createdCategoryIds.push(
            this.createCategory(suggestion.proposedCategoryName, suggestion.proposedCategoryType, suggestion.proposedParentCategoryId, nowMs),
          );
        }
      }

      const before: OperationProjection = {
        transactions: beforeTransactions,
        createdCategoryIds: [],
      };
      const after: OperationProjection = {
        transactions: afterTransactions,
        createdCategoryIds,
      };
      const operationId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO ai_organization_operations
             (id, run_id, status, action_ids_json, fingerprint, before_json, after_json, created_at, updated_at)
           VALUES (?, ?, 'applied', ?, ?, ?, ?, ?, ?)`,
        )
        .run(operationId, runId, JSON.stringify(appliedIds), fingerprint, JSON.stringify(before), JSON.stringify(after), nowMs, nowMs);
      return operationId;
    });

    const operationId = run();
    return { operationId, status: 'applied', appliedActions: appliedIds };
  }

  undo(operationId: string): SpendingApplyResult {
    const operation = this.db
      .prepare('SELECT * FROM ai_organization_operations WHERE id = ?')
      .get(operationId) as OperationRow | undefined;
    if (operation === undefined) throw new AiSpendingOperationNotFoundError();
    if (operation.status === 'undone') {
      return { operationId: operation.id, status: 'undone', appliedActions: JSON.parse(operation.action_ids_json) as string[] };
    }
    const before = JSON.parse(operation.before_json) as OperationProjection;
    const after = JSON.parse(operation.after_json) as OperationProjection;
    const nowMs = this.now();

    for (const tx of after.transactions) {
      const current = this.db
        .prepare('SELECT category_id, tags_json FROM transactions WHERE id = ?')
        .get(tx.id) as { category_id: string; tags_json: string } | undefined;
      if (current === undefined || current.category_id !== tx.category_id || current.tags_json !== tx.tags_json) {
        throw new AiOrganizationConflictError('账单已变化，无法撤销。');
      }
    }
    for (const categoryId of after.createdCategoryIds) {
      const current = this.db.prepare('SELECT deleted FROM categories WHERE id = ?').get(categoryId) as { deleted: number } | undefined;
      if (current === undefined || current.deleted !== 0) throw new AiOrganizationConflictError('分类已变化，无法撤销。');
    }
    // Template guard/restore loops are kept for operations applied *before* the template
    // surface was retired: dropping them would let those old operations report "undone"
    // while the created template stayed behind. New operations have no such fields.
    for (const templateId of after.createdTemplateIds ?? []) {
      const current = this.db.prepare('SELECT deleted FROM budget_templates WHERE id = ?').get(templateId) as { deleted: number } | undefined;
      if (current === undefined || current.deleted !== 0) throw new AiOrganizationConflictError('模板已变化，无法撤销。');
    }
    for (const update of after.templateUpdates ?? []) {
      const current = this.db
        .prepare('SELECT modules_json FROM budget_templates WHERE id = ?')
        .get(update.id) as { modules_json: string } | undefined;
      if (current === undefined || current.modules_json !== update.before_modules) throw new AiOrganizationConflictError('模板已变化，无法撤销。');
    }

    const run = this.db.transaction((): void => {
      for (const tx of before.transactions) {
        this.db.prepare('UPDATE transactions SET category_id = ?, tags_json = ?, updated_at = ? WHERE id = ?')
          .run(tx.category_id, tx.tags_json, nowMs, tx.id);
      }
      for (const categoryId of after.createdCategoryIds) {
        this.db.prepare('UPDATE categories SET deleted = 1, updated_at = ? WHERE id = ?').run(nowMs, categoryId);
      }
      for (const templateId of after.createdTemplateIds ?? []) {
        this.db.prepare('UPDATE budget_templates SET deleted = 1, updated_at = ? WHERE id = ?').run(nowMs, templateId);
      }
      for (const update of before.templateUpdates ?? []) {
        this.db.prepare('UPDATE budget_templates SET modules_json = ?, updated_at = ? WHERE id = ?')
          .run(update.before_modules, nowMs, update.id);
      }
      this.db.prepare("UPDATE ai_organization_operations SET status = 'undone', updated_at = ? WHERE id = ?").run(nowMs, operationId);
    });
    run();

    return { operationId, status: 'undone', appliedActions: JSON.parse(operation.action_ids_json) as string[] };
  }

  private parseActionIds(value: unknown): string[] {
    if (!Array.isArray(value)) throw new AiSpendingRunsInputError('actionIds 必须是数组。');
    const ids = new Set<string>();
    for (const item of value) {
      if (typeof item === 'string' && item.trim() !== '') ids.add(item);
    }
    if (ids.size === 0) throw new AiSpendingRunsInputError('至少选择一个动作。');
    if (ids.size > 100) throw new AiSpendingRunsInputError('一次最多应用 100 个动作。');
    return [...ids];
  }

  private createCategory(name: string, type: number, parentId: string | null, nowMs: number): string {
    if (type !== 0 && type !== 1) throw new AiOrganizationConflictError('分类类型无效。');
    const normalized = name.trim().slice(0, MAX_CATEGORY_NAME_LENGTH);
    if (normalized === '') throw new AiOrganizationConflictError('分类名不能为空。');
    const existing = this.db
      .prepare('SELECT 1 AS x FROM categories WHERE deleted = 0 AND lower(name) = lower(?)')
      .get(normalized) as { x: number } | undefined;
    if (existing !== undefined) throw new AiOrganizationConflictError('同名分类已存在。');
    if (parentId !== null) {
      const parent = this.db
        .prepare('SELECT parent_id, type FROM categories WHERE id = ? AND deleted = 0')
        .get(parentId) as { parent_id: string | null; type: number } | undefined;
      if (parent === undefined || parent.parent_id !== null || parent.type !== 0) {
        throw new AiOrganizationConflictError('父分类必须是有效的根分类。');
      }
    }
    const id = randomUUID();
    const maxSort = this.db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM categories WHERE type = ?').get(type) as { m: number };
    this.db
      .prepare(
        `INSERT INTO categories (id, name, type, parent_id, icon, color, sort_order, is_builtin, deleted, updated_at)
         VALUES (?, ?, ?, ?, 'folder', 1, ?, 0, 0, ?)`,
      )
      .run(id, normalized, type, parentId, maxSort.m + 1, nowMs);
    return id;
  }

  private runRow(id: string): RunRow {
    const row = this.db.prepare('SELECT * FROM ai_analysis_runs WHERE id = ?').get(id) as RunRow | undefined;
    if (row === undefined) throw new AiSpendingRunNotFoundError();
    return row;
  }

  private parseCoverage(raw: string): {
    readonly eligibleIds: readonly string[];
    readonly evidenceByCategory: Readonly<Record<string, number>>;
    readonly beforeStates: readonly { readonly id: string; readonly categoryId: string; readonly tags: readonly string[] }[];
  } {
    try {
      const value: unknown = JSON.parse(raw);
      if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('bad coverage');
      const record = value as { eligibleIds?: unknown; evidenceByCategory?: unknown; beforeStates?: unknown };
      const evidence = record.evidenceByCategory;
      const beforeStates = Array.isArray(record.beforeStates)
        ? (record.beforeStates as { id: string; categoryId: string; tags: string[] }[]).map((state) => ({
            id: state.id,
            categoryId: state.categoryId,
            tags: state.tags,
          }))
        : [];
      return {
        eligibleIds: Array.isArray(record.eligibleIds) ? (record.eligibleIds as string[]) : [],
        evidenceByCategory:
          typeof evidence === 'object' && evidence !== null && !Array.isArray(evidence)
            ? (evidence as Record<string, number>)
            : {},
        beforeStates,
      };
    } catch {
      return { eligibleIds: [], evidenceByCategory: {}, beforeStates: [] };
    }
  }

  private parseSuggestions(raw: string): SpendingSuggestion[] {
    try {
      const value: unknown = JSON.parse(raw);
      return Array.isArray(value) ? (value as SpendingSuggestion[]) : [];
    } catch {
      return [];
    }
  }

  private finishReady(
    runId: string,
    coverage: unknown,
    suggestions: readonly SpendingSuggestion[],
  ): void {
    // The template column is still written (as an empty array) because the schema keeps
    // it for runs created before templates were retired; readers ignore it either way.
    const templateProposals: TemplateProposal[] = [];
    const fingerprint = hashJson({ coverage, suggestions, templateProposals });
    this.db
      .prepare(
        `UPDATE ai_analysis_runs SET status = 'ready', completed_count = eligible_count, suggestions_json = ?, template_proposals_json = ?, fingerprint = ?, error_code = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(JSON.stringify(suggestions), JSON.stringify(templateProposals), fingerprint, this.now(), runId);

    const insertNote = this.db.prepare(
      `INSERT INTO ai_note_suggestions (id, run_id, transaction_id, suggested_note, created_at) VALUES (?, ?, ?, ?, ?)`,
    );
    for (const suggestion of suggestions) {
      if (suggestion.kind !== 'note' || suggestion.transactionId === null || suggestion.suggestedNote === null) continue;
      insertNote.run(randomUUID(), runId, suggestion.transactionId, suggestion.suggestedNote, this.now());
    }
  }

  private batchFacts(
    batch: readonly EligibleRow[],
    categories: readonly CategoryFact[],
    categoryNames: ReadonlyMap<string, string>,
  ): {
    readonly transactions: readonly {
      readonly transactionId: string;
      readonly type: number;
      readonly categoryId: string;
      readonly categoryName: string;
      readonly note: string;
      readonly tags: readonly string[];
    }[];
    readonly categories: readonly {
      readonly id: string;
      readonly name: string;
      readonly type: number;
      readonly parentCategoryId: string | null;
    }[];
  } {
    return {
      transactions: batch.map((row) => ({
        transactionId: row.id,
        type: row.type,
        categoryId: row.category_id,
        categoryName: categoryNames.get(row.category_id) ?? row.category_id,
        note: redactNote(row.note),
        tags: parseTagsJson(row.tags_json),
      })),
      categories: categories.map((category) => ({
        id: category.id,
        name: category.name,
        type: category.type,
        parentCategoryId: category.parentCategoryId,
      })),
    };
  }

  private loadCategories(): CategoryFact[] {
    const rows = this.db
      .prepare('SELECT id, name, type, parent_id FROM categories WHERE deleted = 0 ORDER BY id')
      .all() as { id: string; name: string; type: number; parent_id: string | null }[];
    const children = new Set(rows.filter((row) => row.parent_id !== null).map((row) => row.parent_id as string));
    // Bookable target facts only: parents with children are not usable by transactions.
    return rows
      .filter((row) => !children.has(row.id))
      .map((row) => ({ id: row.id, name: row.name, type: row.type, parentCategoryId: row.parent_id }));
  }

  private normalize(raw: unknown, batch: readonly EligibleRow[], categories: readonly CategoryFact[]): SpendingSuggestion[] {
    const record = asRecord(raw);
    const byId = new Map(batch.map((row) => [row.id, row]));
    const categoriesById = new Map(categories.map((category) => [category.id, category]));
    const seen = new Set<string>();
    const suggestions: SpendingSuggestion[] = [];

    const reclassifications = record['reclassifications'];
    if (!Array.isArray(reclassifications)) throw new AiOrganizationResponseInvalidError();
    for (const item of reclassifications.slice(0, MAX_ELIGIBLE_ROWS)) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
      const value = item as Record<string, unknown>;
      const transactionId = value['transactionId'];
      const targetCategoryId = value['targetCategoryId'];
      if (typeof transactionId !== 'string' || typeof targetCategoryId !== 'string') continue;
      const row = byId.get(transactionId);
      const target = categoriesById.get(targetCategoryId);
      if (row === undefined || target === undefined) continue;
      if (target.type !== row.type || target.id === row.category_id) continue;
      const actionId = hashJson({ kind: 'category', transactionId, targetCategoryId }).slice(0, 24);
      if (seen.has(actionId)) continue;
      seen.add(actionId);
      suggestions.push({
        actionId,
        kind: 'category',
        transactionId,
        transactionDateLabel: this.dayLabel(row.date),
        transactionAmountCents: row.amount_cents,
        transactionType: row.type,
        beforeCategoryId: row.category_id,
        beforeCategoryName: categoriesById.get(row.category_id)?.name ?? null,
        afterCategoryId: target.id,
        afterCategoryName: target.name,
        beforeTags: [],
        afterTags: [],
        suggestedNote: null,
        proposedCategoryName: null,
        proposedCategoryType: null,
        proposedParentCategoryId: null,
        proposedParentCategoryName: null,
        reason: boundedReason(value['reason'], '这笔账可能属于更合适的现有分类。'),
        confidence: clampedConfidence(value['confidence']),
      });
    }

    const tagSuggestions = record['tagSuggestions'];
    if (!Array.isArray(tagSuggestions)) throw new AiOrganizationResponseInvalidError();
    for (const item of tagSuggestions.slice(0, MAX_ELIGIBLE_ROWS)) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
      const value = item as Record<string, unknown>;
      const transactionId = value['transactionId'];
      if (typeof transactionId !== 'string') continue;
      const row = byId.get(transactionId);
      if (row === undefined || !Array.isArray(value['tags'])) continue;
      const afterTags = normaliseTags(value['tags']);
      const beforeTags = parseTagsJson(row.tags_json);
      if (JSON.stringify(afterTags) === JSON.stringify(beforeTags)) continue;
      const actionId = hashJson({ kind: 'tag', transactionId, afterTags }).slice(0, 24);
      if (seen.has(actionId)) continue;
      seen.add(actionId);
      suggestions.push({
        actionId,
        kind: 'tag',
        transactionId,
        transactionDateLabel: this.dayLabel(row.date),
        transactionAmountCents: row.amount_cents,
        transactionType: row.type,
        beforeCategoryId: null,
        beforeCategoryName: null,
        afterCategoryId: null,
        afterCategoryName: null,
        beforeTags,
        afterTags,
        suggestedNote: null,
        proposedCategoryName: null,
        proposedCategoryType: null,
        proposedParentCategoryId: null,
        proposedParentCategoryName: null,
        reason: boundedReason(value['reason'], '这笔账的标签可以调整。'),
        confidence: clampedConfidence(value['confidence']),
      });
    }

    const noteSuggestions = record['noteSuggestions'];
    if (!Array.isArray(noteSuggestions)) throw new AiOrganizationResponseInvalidError();
    for (const item of noteSuggestions.slice(0, MAX_ELIGIBLE_ROWS)) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
      const value = item as Record<string, unknown>;
      const transactionId = value['transactionId'];
      if (typeof transactionId !== 'string') continue;
      const row = byId.get(transactionId);
      if (row === undefined || typeof value['suggestedNote'] !== 'string') continue;
      const suggestedNote = value['suggestedNote'].trim().slice(0, MAX_SUGGESTED_NOTE_LENGTH);
      if (suggestedNote === '' || suggestedNote === row.note) continue;
      const actionId = hashJson({ kind: 'note', transactionId }).slice(0, 24);
      if (seen.has(actionId)) continue;
      seen.add(actionId);
      suggestions.push({
        actionId,
        kind: 'note',
        transactionId,
        transactionDateLabel: this.dayLabel(row.date),
        transactionAmountCents: row.amount_cents,
        transactionType: row.type,
        beforeCategoryId: null,
        beforeCategoryName: null,
        afterCategoryId: null,
        afterCategoryName: null,
        beforeTags: [],
        afterTags: [],
        suggestedNote,
        proposedCategoryName: null,
        proposedCategoryType: null,
        proposedParentCategoryId: null,
        proposedParentCategoryName: null,
        reason: boundedReason(value['reason'], '这笔账可以补充一条整理后的备注。'),
        confidence: clampedConfidence(value['confidence']),
      });
    }

    const newCategories = record['newCategories'];
    if (!Array.isArray(newCategories)) throw new AiOrganizationResponseInvalidError();
    for (const item of newCategories.slice(0, 20)) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
      const value = item as Record<string, unknown>;
      const rawName = value['name'];
      const rawType = value['type'];
      if (typeof rawName !== 'string' || (rawType !== 0 && rawType !== 1)) continue;
      const name = rawName.trim().slice(0, MAX_CATEGORY_NAME_LENGTH);
      if (name === '') continue;
      const parentRaw = value['parentCategoryId'];
      const parent = parentRaw === null || parentRaw === undefined ? null : categoriesById.get(parentRaw as string);
      if (parentRaw !== null && parentRaw !== undefined && parent === undefined) continue;
      if (
        parent !== null &&
        parent !== undefined &&
        (rawType !== 0 || parent.type !== 0 || parent.parentCategoryId !== null)
      ) {
        continue;
      }
      if (
        categories.some(
          (category) =>
            category.type === rawType &&
            category.parentCategoryId === (parent?.id ?? null) &&
            normalizedName(category.name) === normalizedName(name),
        )
      ) {
        continue;
      }
      const evidence = Array.isArray(value['evidenceTransactionIds'])
        ? value['evidenceTransactionIds'].filter((id): id is string => typeof id === 'string' && byId.has(id)).slice(0, 5)
        : [];
      if (evidence.length === 0) continue;
      const actionId = hashJson({ kind: 'category-suggestion', name: normalizedName(name), type: rawType, parentCategoryId: parent?.id ?? null }).slice(0, 24);
      if (seen.has(actionId)) continue;
      seen.add(actionId);
      suggestions.push({
        actionId,
        kind: 'category-suggestion',
        transactionId: null,
        transactionDateLabel: null,
        transactionAmountCents: null,
        transactionType: null,
        beforeCategoryId: null,
        beforeCategoryName: null,
        afterCategoryId: null,
        afterCategoryName: null,
        beforeTags: [],
        afterTags: [],
        suggestedNote: null,
        proposedCategoryName: name,
        proposedCategoryType: rawType,
        proposedParentCategoryId: parent?.id ?? null,
        proposedParentCategoryName: parent?.name ?? null,
        reason: boundedReason(value['reason'], '这些账单可能适合一个新的分类。'),
        confidence: clampedConfidence(value['confidence']),
      });
    }

    return suggestions.sort((a, b) => b.confidence - a.confidence);
  }

  private dayLabel(epochMs: number): string {
    const date = new Date(epochMs);
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
  }

  private parseDay(value: unknown, field: string): { year: number; month: number; day: number; value: string } {
    if (typeof value !== 'string') throw new AiSpendingRunsInputError(`${field} must be a YYYY-MM-DD date string.`);
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (match === null) throw new AiSpendingRunsInputError(`${field} must be a YYYY-MM-DD date string.`);
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const probe = new Date(year, month - 1, day);
    if (probe.getFullYear() !== year || probe.getMonth() !== month - 1 || probe.getDate() !== day) {
      throw new AiSpendingRunsInputError(`${field} is not a valid calendar day.`);
    }
    return { year, month, day, value };
  }

  private dayStartMs(day: { year: number; month: number; day: number }): number {
    return new Date(day.year, day.month - 1, day.day, 0, 0, 0, 0).getTime();
  }

  private dayEndExclusiveMs(day: { year: number; month: number; day: number }): number {
    return new Date(day.year, day.month - 1, day.day + 1, 0, 0, 0, 0).getTime();
  }
}
