/**
 * Bounded AI analysis for a merged import batch.
 *
 * Contract (`research/merged-import-protocol-v1.md` §5):
 *   * at most 20 sequential provider calls, 25 rows each, under one overall wall budget;
 *   * the per-call timeout/model come from the saved provider configuration and are not changed;
 *   * the run is all-or-nothing: any shard failure clears every AI-origin proposal. The
 *     deterministic `server-fallback` Other proposals are written elsewhere and survive;
 *   * more than 20 *distinct* new-category suggestions is an explicit failure, never a truncation;
 *   * `GET` never reaches this module, so a read can never start model work;
 *   * the fence (owner/version/revision) is written before the previous reader is aborted, and
 *     every publish rechecks all three.
 *
 * A model response has no financial authority: amounts, dates, order ids and refund identity are
 * never taken from it, and an invalid response fails the whole run instead of being repaired.
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';
import type { AppConfig } from '../config.js';
import { AssistantConversationService } from './assistant-conversation-service.js';
import { AiConfigService } from './ai-config-service.js';
import { AiProviderService, type AiCallOptions } from './ai-provider-service.js';
import type { StoredAiProviderConfig } from './ai-types.js';
import { MasterDataService } from './master-data-service.js';
import {
  MERGED_ANALYSIS_BUDGET_MS,
  MERGED_ANALYSIS_MAX_CALLS,
  MERGED_ANALYSIS_ROWS_PER_CALL,
  MERGED_MAX_CATEGORY_NAME_CHARS,
  MERGED_MAX_NEW_CATEGORIES,
  ImportBatchActiveError,
  type ImportCategoryOrigin,
} from './import-batch-types.js';
import { ImportBatchService, type StoredRecommendation } from './import-batch-service.js';
import type { ConversationActiveLock } from './assistant-active-lock.js';

const ANALYSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['recommendations'],
  properties: {
    recommendations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'include', 'reason', 'categoryId', 'newCategory'],
        properties: {
          id: { type: 'string' },
          include: { type: 'boolean' },
          reason: { type: 'string', maxLength: 300 },
          categoryId: { type: ['string', 'null'] },
          newCategory: {
            type: ['object', 'null'],
            additionalProperties: false,
            required: ['name', 'type', 'parentId'],
            properties: {
              name: { type: 'string' },
              type: { type: 'integer', enum: [0, 1] },
              parentId: { type: ['string', 'null'] },
            },
          },
        },
      },
    },
  },
} as const;

export interface ImportBatchAnalysisOptions {
  readonly db: Db;
  readonly config: AppConfig;
  readonly now?: (() => number) | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  /** Shared per-conversation provider-work lock; omitted in unit tests that never call `start`. */
  readonly activeLock?: ConversationActiveLock | undefined;
}

interface AnalysisRow {
  readonly itemId: string;
  readonly type: number;
  readonly amountCents: number;
  readonly dateLabel: string;
  readonly note: string;
  readonly sourceCategory: string;
  readonly rawStatus: string;
  readonly isRefund: boolean;
  readonly ignored: boolean;
  readonly ignoreReason: string | null;
  readonly existing: boolean;
  readonly fallbackCategoryName: string | null;
  readonly fallbackSource: string | null;
}

interface NewSuggestion {
  readonly name: string;
  readonly type: number;
  readonly parentId: string | null;
}

export class ImportBatchAnalysisError extends Error {
  readonly messageKey: string;

  constructor(messageKey: string) {
    super(messageKey);
    this.name = 'ImportBatchAnalysisError';
    this.messageKey = messageKey;
  }
}

export class ImportBatchAnalysisRunner {
  private readonly db: Db;
  private readonly batches: ImportBatchService;
  private readonly config: AiConfigService;
  private readonly provider: AiProviderService;
  private readonly now: () => number;
  private readonly lock: ConversationActiveLock | null;
  private readonly running = new Set<string>();
  private readonly tasks = new Set<Promise<void>>();
  private closing = false;

  constructor(options: ImportBatchAnalysisOptions) {
    this.db = options.db;
    this.now = options.now ?? (() => Date.now());
    this.batches = new ImportBatchService({
      db: options.db,
      dataDir: options.config.dataDir,
      now: this.now,
    });
    this.config = new AiConfigService(options.db, {
      aiEncryptionKey: options.config.aiEncryptionKey,
      production: options.config.nodeEnv === 'production',
      now: this.now,
    });
    this.provider = new AiProviderService(options.fetchImpl);
    this.lock = options.activeLock ?? null;
  }

  get service(): ImportBatchService {
    return this.batches;
  }

  /** Boot recovery: a run from a previous process is failed, never resumed. */
  recover(): number {
    return this.batches.recoverRunning();
  }

  get hasActiveWork(): boolean { return this.running.size > 0; }

  async shutdown(): Promise<void> {
    this.closing = true;
    for (const batchId of [...this.running]) this.batches.abortAnalysis(batchId);
    await Promise.allSettled([...this.tasks]);
  }

  /**
   * Starts one analysis run in the background.
   *
   * Order: claim the conversation's provider-work lock (so a generation or legacy turn cannot run
   * concurrently) → write the batch fence → return. The fence is durable before the first
   * provider call, so a cancel/replace that lands meanwhile already blocks publication.
   * Returns `false` when the conversation is busy; the caller answers 409.
   */
  start(conversationId: string, batchId: string): boolean {
    if (this.closing) return false;
    // A failed file blocks analysis as well as confirmation: the run would analyse a partial row
    // set, which the user could easily mistake for a complete classification.
    if (this.batches.hasFailedFile(batchId)) {
      this.batches.markAnalysisNotStarted(batchId, '存在解析失败的文件，请移除或替换后再分析。');
      return true;
    }
    if (this.lock !== null && !this.lock.begin(conversationId, 'batch')) return false;
    let fence: ReturnType<ImportBatchService['beginAnalysis']>;
    try {
      fence = this.batches.beginAnalysis(conversationId, batchId, randomUUID());
    } catch (error) {
      this.lock?.end(conversationId, 'batch');
      throw error;
    }
    const owner = fence.batch.analyse_owner!;
    const version = fence.batch.version;
    const revision = fence.revision;
    this.running.add(batchId);
    const task = this.run(batchId, owner, version, revision).finally(() => {
      this.running.delete(batchId);
      this.batches.clearAnalysisAbort(batchId);
      this.lock?.end(conversationId, 'batch');
      this.tasks.delete(task);
    });
    this.tasks.add(task);
    // Domain failures are persisted in run(); surface an unexpected failure without
    // leaving an unhandled rejection while shutdown still waits for the same task.
    void task.catch(() => undefined);
    return true;
  }

  private async run(batchId: string, owner: string, version: number, revision: number): Promise<void> {
    let providerCalls = 0;
    try {
      const stored = this.config.getStoredOrThrow();
      const secret = this.config.getSecretOrThrow(stored);
      const result = await this.analyse(batchId, stored, secret, () => {
        providerCalls += 1;
      });
      this.batches.publishAnalysis(batchId, owner, version, revision, {
        state: 'complete',
        recommendations: result.recommendations,
        suggestions: result.suggestions,
        providerCalls,
      });
    } catch (error) {
      const message =
        error instanceof ImportBatchAnalysisError
          ? error.messageKey
          : 'AI分析失败或未配置。文件预览仍可核对；可显式重试分析，这不代表AI已完成分类。';
      this.batches.publishAnalysis(batchId, owner, version, revision, {
        state: 'failed',
        message,
        providerCalls,
      });
    }
  }

  /**
   * Runs the bounded shard loop. Never throws for a provider/envelope problem — the caller turns
   * every failure into an explicit `failed` publication. It DOES throw for a cancelled/replaced
   * batch, which the fence then rejects at publication.
   */
  private async analyse(
    batchId: string,
    stored: StoredAiProviderConfig,
    secret: string | null,
    onCall: () => void,
  ): Promise<{ recommendations: StoredRecommendation[]; suggestions: NewSuggestionSuggestion[] }> {
    const rows = this.db
      .prepare(
        `SELECT item_id, type, amount_cents, date_label, note, source_category, raw_status, is_refund,
                ignored, ignore_reason, existing, fallback_category_name, fallback_source
           FROM assistant_import_batch_rows WHERE batch_id = ? ORDER BY ordinal`,
      )
      .all(batchId) as {
      item_id: string;
      type: number;
      amount_cents: number;
      date_label: string;
      note: string;
      source_category: string;
      raw_status: string;
      is_refund: number;
      ignored: number;
      ignore_reason: string | null;
      existing: number;
      fallback_category_name: string | null;
      fallback_source: string | null;
    }[];
    const analysisRows: AnalysisRow[] = rows.map((row) => ({
      itemId: row.item_id,
      type: row.type,
      amountCents: row.amount_cents,
      dateLabel: row.date_label,
      note: row.note,
      sourceCategory: row.source_category,
      rawStatus: row.raw_status,
      isRefund: row.is_refund === 1,
      ignored: row.ignored === 1,
      ignoreReason: row.ignore_reason,
      existing: row.existing === 1,
      fallbackCategoryName: row.fallback_category_name,
      fallbackSource: row.fallback_source,
    }));
    if (analysisRows.length === 0) return { recommendations: [], suggestions: [] };

    const shards: AnalysisRow[][] = [];
    for (let start = 0; start < analysisRows.length; start += MERGED_ANALYSIS_ROWS_PER_CALL) {
      shards.push(analysisRows.slice(start, start + MERGED_ANALYSIS_ROWS_PER_CALL));
    }
    if (shards.length > MERGED_ANALYSIS_MAX_CALLS) {
      throw new ImportBatchAnalysisError(
        `本批需要 ${shards.length} 次 AI 调用，超过 ${MERGED_ANALYSIS_MAX_CALLS} 次上限，请拆分文件后重试。`,
      );
    }

    const categories = this.liveLeaves();
    const deadline = this.now() + MERGED_ANALYSIS_BUDGET_MS;
    const recommendations: StoredRecommendation[] = [];
    const suggestions = new Map<string, { suggestion: NewSuggestion; itemIds: string[] }>();

    for (const shard of shards) {
      if (this.now() > deadline) {
        throw new ImportBatchAnalysisError('AI 分析总时长超出预算，已整轮失败；可拆分文件后重试。');
      }
      const controller = new AbortController();
      this.batches.setAnalysisAbort(batchId, () => controller.abort());
      onCall();
      let raw: unknown;
      try {
        const facts = {
          rows: shard,
          categories,
          note: '每行必须恰有一条建议：categoryId 为现有同类型可记账分类 ID，或 newCategory 为新分类建议，二者不可同时给出。',
        };
        const options: AiCallOptions = { signal: controller.signal };
        raw = await this.provider.complete(stored, secret, {
          input: JSON.stringify(facts),
          facts,
          categories,
          accounts: [],
          model: stored.model,
          today: dayLabel(this.now()),
          responseSchema: ANALYSIS_SCHEMA as unknown as Record<string, unknown>,
          feature: 'bill-import',
        }, options);
      } catch (error) {
        if (controller.signal.aborted && this.closing) throw new ImportBatchActiveError('服务正在停止，分析已中止。');
        throw new ImportBatchAnalysisError(
          error instanceof Error && error.message.length > 0
            ? 'AI分析失败，本轮建议已整轮丢弃；确定性兜底分类仍可手动使用。'
            : 'AI分析失败。',
        );
      }
      const parsed = this.normalizeShard(raw, shard, categories);
      for (const item of parsed) {
        if (item.newCategory !== null) {
          const key = `${item.newCategory.name}\u0000${item.newCategory.type}\u0000${item.newCategory.parentId ?? ''}`;
          const bucket = suggestions.get(key);
          if (bucket === undefined) {
            if (suggestions.size >= MERGED_MAX_NEW_CATEGORIES) {
              throw new ImportBatchAnalysisError(
                `AI 建议的新分类超过 ${MERGED_MAX_NEW_CATEGORIES} 个，本次分析明确失败，请人工处理分类后重试。`,
              );
            }
            suggestions.set(key, { suggestion: item.newCategory, itemIds: [item.id] });
          } else {
            bucket.itemIds.push(item.id);
          }
        }
        recommendations.push({
          itemId: item.id,
          include: item.include,
          reason: item.reason,
          categoryId: item.categoryId,
          newSuggestionId: null,
        });
      }
    }

    const published: NewSuggestionSuggestion[] = [];
    let index = 0;
    for (const [, bucket] of suggestions) {
      index += 1;
      const suggestionId = `nc-ai-${index}`;
      published.push({
        ...bucket.suggestion,
        suggestionId,
        origin: 'ai',
        itemIds: bucket.itemIds,
        relatedItemIds: bucket.itemIds,
      });
      for (const recommendation of recommendations) {
        if (bucket.itemIds.includes(recommendation.itemId)) {
          (recommendation as { newSuggestionId: string | null }).newSuggestionId = suggestionId;
        }
      }
    }
    return { recommendations, suggestions: published };
  }

  /**
   * Validates one shard's response. Any deviation fails the whole run: a half-valid shard must
   * never become a card the user reads as an AI classification.
   */
  private normalizeShard(
    raw: unknown,
    shard: readonly AnalysisRow[],
    categories: readonly { readonly id: string; readonly name: string; readonly type: number; readonly parentId: string | null }[],
  ): { id: string; include: boolean; reason: string; categoryId: string | null; newCategory: NewSuggestion | null }[] {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new ImportBatchAnalysisError('AI 返回内容无法解析。');
    const record = raw as Record<string, unknown>;
    const list = record['recommendations'];
    if (!Array.isArray(list) || list.length !== shard.length) {
      throw new ImportBatchAnalysisError('AI 返回的建议数量与账单行数不一致。');
    }
    const byId = new Map(shard.map((row) => [row.itemId, row]));
    const seen = new Set<string>();
    const out: { id: string; include: boolean; reason: string; categoryId: string | null; newCategory: NewSuggestion | null }[] = [];
    for (const entry of list) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new ImportBatchAnalysisError('AI 返回的建议格式无效。');
      }
      const item = entry as Record<string, unknown>;
      if (Object.keys(item).some((key) => !['id', 'include', 'reason', 'categoryId', 'newCategory'].includes(key))) {
        throw new ImportBatchAnalysisError('AI 返回的建议包含多余字段。');
      }
      const id = item['id'];
      if (typeof id !== 'string' || !byId.has(id) || seen.has(id)) {
        throw new ImportBatchAnalysisError('AI 返回了未知或重复的账单编号。');
      }
      const row = byId.get(id)!;
      const include = item['include'];
      const reason = item['reason'];
      if (typeof include !== 'boolean' || typeof reason !== 'string' || reason.trim() === '' || reason.trim().length > 300) {
        throw new ImportBatchAnalysisError('AI 返回的建议理由无效。');
      }
      const categoryId = item['categoryId'];
      const rawNew = item['newCategory'];
      if (categoryId !== null && typeof categoryId !== 'string') {
        throw new ImportBatchAnalysisError('AI 返回的分类编号无效。');
      }
      if (rawNew !== null && (typeof rawNew !== 'object' || Array.isArray(rawNew))) {
        throw new ImportBatchAnalysisError('AI 返回的新分类建议无效。');
      }
      if ((categoryId === null) === (rawNew === null || rawNew === undefined)) {
        // Exactly one of the two must be present: existing category X or new suggestion X.
        throw new ImportBatchAnalysisError('AI 必须在“现成分类”与“新分类建议”之间二选一。');
      }
      if (categoryId !== null) {
        const match = categories.find((category) => category.id === categoryId);
        if (match === undefined || match.type !== row.type) {
          throw new ImportBatchAnalysisError('AI 返回了不存在或收支类型不符的分类。');
        }
        out.push({ id, include, reason: reason.trim(), categoryId, newCategory: null });
        seen.add(id);
        continue;
      }
      const newRecord = rawNew as Record<string, unknown>;
      if (Object.keys(newRecord).some((key) => !['name', 'type', 'parentId'].includes(key))) {
        throw new ImportBatchAnalysisError('AI 返回的新分类建议包含多余字段。');
      }
      const name = typeof newRecord['name'] === 'string' ? newRecord['name'].trim() : '';
      if (name === '' || name.length > MERGED_MAX_CATEGORY_NAME_CHARS) {
        throw new ImportBatchAnalysisError('AI 返回的新分类名称无效。');
      }
      const type = newRecord['type'];
      if (type !== row.type) throw new ImportBatchAnalysisError('AI 返回的新分类类型与账单不符。');
      const parentId = newRecord['parentId'] ?? null;
      if (parentId !== null) {
        const parent = categories.find((category) => category.id === parentId);
        if (parent === undefined || parent.type !== 0 || parent.parentId !== null) {
          throw new ImportBatchAnalysisError('AI 返回的新分类父级无效（只允许支出一级分类）。');
        }
        if (row.type !== 0) throw new ImportBatchAnalysisError('收入账单不能挂在父分类下。');
      }
      out.push({
        id,
        include,
        reason: reason.trim(),
        categoryId: null,
        newCategory: { name, type: type as number, parentId: parentId as string | null },
      });
      seen.add(id);
    }
    return out;
  }

  private liveLeaves() {
    const masterData = new MasterDataService(this.db, { now: this.now });
    const categories = masterData.listCategories();
    return categories
      .filter((category) => category.type !== 0 || !categories.some((child) => child.parentId === category.id))
      .map(({ id, name, type, parentId }) => ({ id, name, type, parentId }));
  }
}

/** A new-category suggestion as published by one analysis run. */
export interface NewSuggestionSuggestion {
  readonly suggestionId: string;
  readonly origin: ImportCategoryOrigin;
  readonly name: string;
  readonly type: number;
  readonly parentId: string | null;
  readonly itemIds: readonly string[];
  readonly relatedItemIds: readonly string[];
}

function dayLabel(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

void AssistantConversationService;
