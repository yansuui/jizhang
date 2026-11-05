/** Bounded provider/tool loop for persisted assistant conversations. */
import { BILL_ANALYSIS_SCHEMA, normalizeBillRecommendations, type BillRecommendation, type BillAnalysisRow, type BillAnalysisCategory } from './bill-import-analysis.js';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/index.js';
import { AccountBalanceService } from './account-balance-service.js';
import { AiConfigService } from './ai-config-service.js';
import { AiOrganizationService } from './ai-organization-service.js';
import { AiProviderService } from './ai-provider-service.js';
import { AssistantConversationService } from './assistant-conversation-service.js';
import { AssistantActionStaleError, normalizeAssistantJson, normalizeAssistantProviderTurn, type AssistantAttachmentMetadata, type AssistantJsonObject, type AssistantMessageDto, type AssistantPendingActionDto } from './assistant-types.js';
import { AssistantToolRegistry, type AssistantToolContext, type AssistantToolResult } from './assistant-tool-registry.js';
import { BudgetOverviewService } from './budget-overview-service.js';
import { MasterDataService } from './master-data-service.js';
import { MonthlyEvaluationService } from './monthly-evaluation-service.js';
import { PortabilityService } from './portability-service.js';
import { RecurringService } from './recurring-service.js';
import { SalaryService } from './salary-service.js';
import { StatsService } from './stats-service.js';
import { TemplateService } from './template-service.js';
import { TransactionService } from './transaction-service.js';
import { TransferService } from './transfer-service.js';

const TURN_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    message: { type: 'string' },
    toolCall: {
      oneOf: [
        { type: 'null' },
        { type: 'object', properties: { name: { type: 'string' }, arguments: { type: 'object' } }, required: ['name', 'arguments'], additionalProperties: false },
      ],
    },
  },
  required: ['message', 'toolCall'],
  additionalProperties: false,
};

export interface AssistantOrchestratorOptions {
  readonly actorId?: string | undefined;
  readonly db: Db;
  readonly config: AppConfig;
  readonly conversations: AssistantConversationService;
  readonly now?: (() => number) | undefined;
  readonly fetchImpl?: typeof fetch;
}

export interface AssistantTurnResult {
  readonly messages: readonly AssistantMessageDto[];
  readonly pendingActionId?: string;
}

interface PreparedConfirmation {
  readonly pending: AssistantPendingActionDto;
  readonly context: AssistantToolContext;
  readonly arguments: AssistantJsonObject;
  readonly attachmentBytes?: Uint8Array;
}

function dateLabel(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function jsonObject(value: unknown): AssistantJsonObject {
  const result = normalizeAssistantJson(value);
  if (typeof result !== 'object' || result === null || Array.isArray(result)) throw new Error('Expected normalized object');
  return result as AssistantJsonObject;
}

export interface AssistantContextBundle {
  readonly config: AiConfigService;
  readonly provider: AiProviderService;
  readonly context: AssistantToolContext;
}

/**
 * Builds the shared tool context. Extracted so the streaming generation runner and the
 * legacy orchestrator use exactly the same services, provider and clock.
 */
export function buildAssistantContext(
  options: Omit<AssistantOrchestratorOptions, 'conversations'> & { readonly provider?: AiProviderService },
): AssistantContextBundle {
  const now = options.now ?? (() => Date.now());
  const config = new AiConfigService(options.db, {
    aiEncryptionKey: options.config.aiEncryptionKey,
    production: options.config.nodeEnv === 'production',
    now,
  });
  const provider = options.provider ?? new AiProviderService(options.fetchImpl);
  const masterData = new MasterDataService(options.db, { now });
  const context: AssistantToolContext = {
    db: options.db,
    now,
    config,
    provider,
    services: {
      transactions: new TransactionService(options.db, { now, actorId: options.actorId }),
      balances: new AccountBalanceService(options.db),
      budget: new BudgetOverviewService(options.db, { now }),
      stats: new StatsService(options.db, { now }),
      recurring: new RecurringService(options.db, { now, actorId: options.actorId }),
      monthly: new MonthlyEvaluationService(options.db, config, provider, now),
      organization: new AiOrganizationService(options.db, config, provider, { now }),
      portability: new PortabilityService(options.db, { dataDir: options.config.dataDir, dbFile: options.config.dbFile, actorId: options.actorId }),
      masterData,
      salaries: new SalaryService(options.db, { now, actorId: options.actorId }),
      transfers: new TransferService(options.db, { now }),
      templates: new TemplateService(options.db, { now }),
    },
  };
  return { config, provider, context };
}

export class AssistantOrchestrator {
  private readonly db: Db;
  private readonly conversations: AssistantConversationService;
  private readonly now: () => number;
  private readonly config: AiConfigService;
  private readonly provider: AiProviderService;
  private readonly registry = new AssistantToolRegistry();
  private readonly context: AssistantToolContext;

  constructor(options: AssistantOrchestratorOptions) {
    this.db = options.db;
    this.conversations = options.conversations;
    this.now = options.now ?? (() => Date.now());
    const built = buildAssistantContext(options);
    this.config = built.config;
    this.provider = built.provider;
    this.context = built.context;
  }

  catalog(): ReturnType<AssistantToolRegistry['catalog']> {
    return this.registry.catalog();
  }

  async handleMessage(conversationId: string, userText: string, userMessageId: string, attachment?: { metadata: AssistantAttachmentMetadata; bytes: Uint8Array }): Promise<AssistantTurnResult> {
    if (attachment !== undefined) {
      const prepared = await this.registry.prepare({ ...this.context, attachmentBytes: attachment.bytes, attachment: attachment.metadata }, 'platform-import.prepare', {
        source: attachment.metadata.source,
        fileName: attachment.metadata.fileName,
      });
      let analysis: Record<string, unknown>;
      try {
        const stored = this.config.getStoredOrThrow();
        const secret = this.config.getSecretOrThrow(stored);
        const rows = (prepared.preview['rows'] as unknown as readonly (BillAnalysisRow & Record<string, unknown>)[]).map((row) => ({ id: row.id, type: row.type, amountCents: row['amountCents'], dateLabel: row['dateLabel'], note: row['note'], sourceCategory: row['sourceCategory'], counterparty: row['counterparty'], rawStatus: row['rawStatus'], isRefund: row['isRefund'], ignored: row['ignored'], ignoreReason: row['ignoreReason'], alreadyExists: row['alreadyExists'], possibleDuplicate: row['possibleDuplicate'] }));
        const categories = prepared.preview['categories'] as unknown as readonly (BillAnalysisCategory & { name: string })[];
        const recommendations: BillRecommendation[] = [];
        for (let start = 0; start < rows.length; start += 25) {
          const batch = rows.slice(start, start + 25);
          const facts = { rows: batch, categories };
          const raw = await this.provider.complete(stored, secret, {
            input: JSON.stringify(facts), facts, categories, accounts: [], model: stored.model,
            today: dateLabel(this.now()), responseSchema: BILL_ANALYSIS_SCHEMA, feature: 'bill-import',
          });
          recommendations.push(...normalizeBillRecommendations(raw, batch, categories));
        }
        analysis = { status: 'complete', analysed: rows.length, recommendations };
      } catch {
        // No raw provider response, endpoint, prompt or credential is stored in messages.
        analysis = { status: 'failed', analysed: 0, recommendations: [], message: 'AI分析失败或未配置。文件预览仍可核对；请显式重试分析，不代表AI已完成。' };
      }
      const analysedPreview = jsonObject({ ...prepared.preview, analysis });
      const pending = this.conversations.createPendingAction({
        conversationId,
        sourceMessageId: userMessageId,
        toolName: prepared.toolName,
        arguments: prepared.arguments,
        preview: analysedPreview,
        fingerprint: prepared.fingerprint,
        attachment: attachment.metadata,
      });
      const card = {
        version: 1 as const,
        actionId: pending.id,
        toolName: prepared.toolName,
        operation: prepared.operation,
        summary: prepared.summary,
        writes: true as const,
        affected: prepared.affected,
        values: prepared.values,
        warnings: prepared.warnings,
        fingerprint: prepared.fingerprint,
        status: 'pending' as const,
        preview: analysedPreview,
        attachment: attachment.metadata,
      };
      this.conversations.appendMessage({ conversationId, role: 'assistant', kind: 'tool-card', content: { version: 1, text: prepared.summary, card } });
      return { messages: this.conversations.messages(conversationId), pendingActionId: pending.id };
    }

    const progress = this.conversations.appendMessage({
      conversationId,
      role: 'tool',
      kind: 'progress',
      content: { version: 1, progress: { state: 'running' } },
    });
    let lastResult: AssistantToolResult | null = null;
    let providerMessage = '';
    for (let step = 0; step < 3; step += 1) {
      const stored = this.config.getStoredOrThrow();
      const secret = this.config.getSecretOrThrow(stored);
      const categories = this.context.services.masterData.listCategories().map(({ id, name, type }) => ({ id, name, type }));
      const accounts = this.context.services.masterData.listAccounts().map(({ id, name, type }) => ({ id, name, type }));
      const messages = this.conversations.context(conversationId);
      const facts = {
        messages,
        tools: this.registry.catalog(),
        ...(lastResult === null ? {} : { lastToolResult: lastResult }),
        categories,
        accounts,
      };
      const input = JSON.stringify({ request: userText.slice(0, 2_000), priorMessages: messages.slice(-12), ...(lastResult === null ? {} : { previousResult: lastResult }) });
      const raw = await this.provider.complete(stored, secret, {
        input,
        categories,
        accounts,
        model: stored.model,
        today: dateLabel(this.now()),
        responseSchema: TURN_SCHEMA,
        feature: 'assistant',
        facts,
      });
      const turn = normalizeAssistantProviderTurn(raw);
      providerMessage = turn.message;
      if (turn.toolCall === null) break;

      // A name is checked before argument parsing, and arguments before an adapter or domain service runs.
      const { tool, arguments: args } = this.registry.parseArguments(turn.toolCall.name, turn.toolCall.arguments);
      if (tool.definition.access === 'write') {
        const prepared = await this.registry.prepare(this.context, tool.definition.name, args);
        const pending = this.conversations.createPendingAction({
          conversationId,
          sourceMessageId: userMessageId,
          toolName: prepared.toolName,
          arguments: prepared.arguments,
          preview: jsonObject(prepared.preview),
          fingerprint: prepared.fingerprint,
          attachment: prepared.attachment,
        });
        const card = {
          version: 1 as const,
          actionId: pending.id,
          toolName: prepared.toolName,
          operation: prepared.operation,
          summary: prepared.summary,
          writes: true as const,
          affected: prepared.affected,
          values: prepared.values,
          warnings: prepared.warnings,
          fingerprint: prepared.fingerprint,
          status: 'pending' as const,
          preview: prepared.preview,
          ...(prepared.attachment === undefined ? {} : { attachment: prepared.attachment }),
        };
        this.conversations.updateProgressStatus(progress.id, 'complete');
        this.conversations.appendMessage({ conversationId, role: 'assistant', kind: 'tool-card', content: { version: 1, text: providerMessage, card } });
        return { messages: this.conversations.messages(conversationId), pendingActionId: pending.id };
      }
      lastResult = await this.registry.read(this.context, tool.definition.name, args);
    }
    this.conversations.updateProgressStatus(progress.id, 'complete');
    if (providerMessage.trim() === '') providerMessage = lastResult?.summary ?? '无法处理这条请求，请补充更多信息。';
    this.conversations.appendMessage({
      conversationId,
      role: 'assistant',
      kind: lastResult === null ? 'text' : 'result',
      content: lastResult === null
        ? { version: 1, text: providerMessage.slice(0, 4_000) }
        : { version: 1, text: providerMessage.slice(0, 4_000), result: { version: 1, toolName: lastResult.toolName, summary: lastResult.summary, data: lastResult.data } },
    });
    return { messages: this.conversations.messages(conversationId) };
  }

  async prepareConfirmation(conversationId: string, actionId: string, attachmentBytes?: Uint8Array, edits?: { selectedIds?: readonly string[] | null; categoryOverrides?: Readonly<Record<string, string>>; noteOverrides?: Readonly<Record<string, string>> }): Promise<PreparedConfirmation> {
    const pending = this.conversations.pending(actionId);
    if (pending.conversationId !== conversationId) throw new AssistantActionStaleError();
    if (pending.status !== 'pending') throw new AssistantActionStaleError();
    if (pending.attachment !== null) {
      if (attachmentBytes === undefined) throw new AssistantActionStaleError('附件预览已失效，请重新附加原文件。');
      const { createHash } = await import('node:crypto');
      const digest = createHash('sha256').update(attachmentBytes).digest('hex');
      if (digest !== pending.attachment.sha256 || attachmentBytes.byteLength !== pending.attachment.sizeBytes) throw new AssistantActionStaleError('文件摘要不匹配，请重新附加预览中的原文件。');
    }
    const attachment = pending.attachment ?? undefined;
    const toolContext = { ...this.context, ...(attachmentBytes === undefined ? {} : { attachmentBytes }), ...(attachment === undefined ? {} : { attachment }) };
    let argumentsForConfirm: AssistantJsonObject = pending.arguments;
    if (pending.toolName === 'platform-import.prepare') {
      const refreshed = await this.registry.prepare(toolContext, pending.toolName, pending.arguments);
      if (refreshed.fingerprint !== pending.fingerprint) throw new AssistantActionStaleError('文件预览已变化，请重新上传并预览。');
      const rows = Array.isArray(refreshed.preview['rows']) ? refreshed.preview['rows'] as readonly Record<string, unknown>[] : [];
      const validIds = new Set(rows.map((row) => row['id']).filter((id): id is string => typeof id === 'string'));
      if (edits?.selectedIds !== undefined && edits.selectedIds !== null && edits.selectedIds.some((id) => !validIds.has(id))) throw new AssistantActionStaleError('选择的导入行不属于当前文件预览。');
      const overrides = edits?.categoryOverrides ?? {};
      if (Object.keys(overrides).some((id) => !validIds.has(id))) throw new AssistantActionStaleError('分类覆盖引用了当前预览中不存在的行。');
      if (!edits?.selectedIds || edits.selectedIds.length === 0 || edits.selectedIds.length > 100) throw new AssistantActionStaleError('必须显式选择1–100条账单。');
      if (Object.keys(edits?.noteOverrides ?? {}).some((id) => !validIds.has(id))) throw new AssistantActionStaleError('备注行不属于预览。');
      const editedArguments = jsonObject({ ...pending.arguments, ...(edits?.selectedIds === undefined ? {} : { selectedIds: edits.selectedIds }), ...(edits?.categoryOverrides === undefined ? {} : { categoryOverrides: edits.categoryOverrides }), ...(edits?.noteOverrides === undefined ? {} : { noteOverrides: edits.noteOverrides }) });
      const editedPreview = await this.registry.prepare(toolContext, pending.toolName, editedArguments);
      argumentsForConfirm = jsonObject({ ...editedArguments, __fingerprint: editedPreview.fingerprint });
    } else {
      const refreshed = await this.registry.prepare(toolContext, pending.toolName, pending.arguments);
      if (refreshed.fingerprint !== pending.fingerprint) throw new AssistantActionStaleError();
      argumentsForConfirm = ['tag.rename', 'tag.delete'].includes(pending.toolName)
        ? jsonObject({ ...pending.arguments, __fingerprint: pending.fingerprint })
        : pending.arguments;
    }
    return { pending, context: toolContext, arguments: argumentsForConfirm, ...(attachmentBytes === undefined ? {} : { attachmentBytes }) };
  }

  async confirmAction(conversationId: string, actionId: string, attachmentBytes?: Uint8Array, edits?: { selectedIds?: readonly string[] | null; categoryOverrides?: Readonly<Record<string, string>>; noteOverrides?: Readonly<Record<string, string>> }): Promise<{ action: AssistantPendingActionDto; message: AssistantMessageDto }> {
    const initial = this.conversations.pending(actionId);
    if (initial.conversationId !== conversationId) throw new AssistantActionStaleError();
    if (initial.status === 'confirmed') {
      const existing = this.conversations.messages(conversationId).filter((message) => message.content.result?.toolName === initial.toolName).at(-1);
      if (existing === undefined) throw new AssistantActionStaleError();
      return { action: initial, message: existing };
    }
    const ready = await this.prepareConfirmation(conversationId, actionId, attachmentBytes, edits);
    const commit = this.db.transaction(() => {
      const current = this.conversations.pending(actionId);
      if (current.status === 'confirmed') {
        const existing = this.conversations.messages(conversationId).filter((message) => message.content.result?.toolName === current.toolName).at(-1);
        if (existing === undefined) throw new AssistantActionStaleError();
        return { action: current, message: existing };
      }
      if (current.status !== 'pending') throw new AssistantActionStaleError();
      const result = this.registry.confirmInTransaction(ready.context, current.toolName, ready.arguments, ready.attachmentBytes);
      const data = jsonObject(result.data);
      const action = this.conversations.setPendingStatus(actionId, 'confirmed', data);
      const cardMessage = this.conversations.messages(conversationId).find((message) => message.content.card?.actionId === actionId);
      if (cardMessage !== undefined) this.conversations.updateCardStatus(cardMessage.id, 'confirmed');
      const message = this.conversations.appendMessage({
        conversationId,
        role: 'assistant',
        kind: 'result',
        content: { version: 1, text: result.summary, result: { version: 1, toolName: result.toolName, summary: result.summary, data } },
      });
      return { action, message };
    });
    return commit();
  }
}
