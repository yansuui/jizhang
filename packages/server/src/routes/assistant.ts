import { createRouteServices, type TenantContextManager } from '../tenancy/context.js';
/** Authenticated conversation API. File bodies are request-local and never persisted. */
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/index.js';
import { AssistantConversationService, createConversationWriteLock } from '../services/assistant-conversation-service.js';
import { AssistantActionStaleError, AssistantError, AssistantValidationError, type AssistantAttachmentMetadata } from '../services/assistant-types.js';
import { AiSpendingOrganizationService } from '../services/ai-spending-organization-service.js';
import { AssistantGenerationService, parseCreateGenerationRequest } from '../services/assistant-generation-service.js';
import { AssistantGenerationRunner } from '../services/assistant-generation-runner.js';
import { AssistantStreamError, SSE_HEARTBEAT_MS, type AssistantStreamEvent } from '../services/assistant-stream-types.js';
import { AssistantImportComparisonService } from '../services/assistant-import-comparison-service.js';
import { ImportBatchAnalysisRunner } from '../services/import-batch-analysis.js';
import { ConversationActiveLock } from '../services/assistant-active-lock.js';
import { registerImportBatchRoutes } from './import-batches.js';
import { AssistantOrchestrator } from '../services/assistant-orchestrator.js';
import { AiConfigService } from '../services/ai-config-service.js';
import { supportsAssistantStream } from '../services/ai-provider-service.js';

const MAX_TEXT_LENGTH = 2_000;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed', 'cancelled', 'interrupted']);

export interface AssistantRoutesOptions {
  readonly actorId?: string | undefined;
  readonly tenants?: TenantContextManager | undefined;
  readonly db: Db;
  readonly config: AppConfig;
  readonly now?: (() => number) | undefined;
  readonly fetchImpl?: typeof fetch;
  /**
   * @deprecated Kept for compatibility with existing callers. Artificial streaming
   * latency was removed: the transport delivers provider bytes as they arrive and the
   * runner only coalesces them, so this value is ignored.
   */
  readonly generationDelayMs?: number | undefined;
  /** Pause between tool-loop steps (tests pass 0). */
  readonly generationStepDelayMs?: number | undefined;
}

function dateLabel(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Minimal SSE writer: `id:<seq>`, `event:<type>`, one JSON data line per event. */

interface PumpOptions {
  readonly request: FastifyRequest;
  readonly reply: FastifyReply;
  readonly generations: AssistantGenerationService;
  readonly conversationId: string;
  readonly generationId: string;
  readonly subscriber: import('../services/assistant-generation-service.js').AssistantGenerationSubscriber;
  readonly initial: readonly AssistantStreamEvent[];
}

/**
 * Streams one generation to one subscriber.
 *
 * Contract points:
 *   * persisted events are replayed first and live events are de-duplicated by `seq`, so a
 *     frame cannot be delivered twice or skipped;
 *   * heartbeats are SSE comments: they carry no seq and are never persisted;
 *   * a client disconnect closes only the subscription — the producer keeps running within
 *     its deadline and an explicit Stop is a separate cancel request.
 */
async function pumpGenerationEvents(options: PumpOptions): Promise<void> {
  const { request, reply, generations, conversationId, generationId, subscriber, initial } = options;
  const raw = reply.raw;
  let closed = false;
  let resolveClosed: () => void = () => undefined;
  const socketClosed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const onSocketClose = (): void => {
    closed = true;
    resolveClosed();
  };
  // Every socket listener is registered exactly once and removed in `finally`: a pump that
  // returns (terminal frame, client disconnect, backpressure failure) must not leave a
  // 'close'/'drain' handler attached to a socket the server keeps for the next request.
  const drains: Array<() => void> = [];
  const detachSocket = (): void => {
    request.raw.removeListener('aborted', onSocketClose);
    raw.removeListener('close', onSocketClose);
    for (const remove of drains.splice(0)) remove();
  };
  request.raw.once('aborted', onSocketClose);
  raw.once('close', onSocketClose);

  /** Writes one frame, respecting backpressure; never buffers without bound. */
  const write = (body: string): Promise<boolean> => {
    if (closed || raw.destroyed) return Promise.resolve(false);
    if (raw.write(body)) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const onDrain = (): void => {
        cleanup();
        resolve(!raw.destroyed && !closed);
      };
      const onClose = (): void => {
        cleanup();
        resolve(false);
      };
      const timer = setTimeout(onClose, 15000);
      const cleanup = (): void => {
        clearTimeout(timer);
        raw.removeListener('drain', onDrain);
        raw.removeListener('close', onClose);
      };
      raw.once('drain', onDrain);
      raw.once('close', onClose);
      drains.push(cleanup);
    });
  };
  const frame = (event: AssistantStreamEvent): string =>
    `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

  try {
    let lastSeq = 0;
    let terminal = false;
    for (const event of initial) {
      if (event.seq <= lastSeq) continue;
      lastSeq = event.seq;
      if (!(await write(frame(event)))) return;
      if (event.type === 'terminal') terminal = true;
    }
    while (!terminal && !subscriber.closed && !closed) {
      const event = subscriber.shift();
      if (event !== undefined) {
        if (event.seq <= lastSeq) continue;
        lastSeq = event.seq;
        if (!(await write(frame(event)))) break;
        if (event.type === 'terminal') break;
        continue;
      }
      const status = generations.get(conversationId, generationId).status;
      if (TERMINAL_STATUSES.has(status)) break;
      await Promise.race([generations.waitForEvent(subscriber, SSE_HEARTBEAT_MS), socketClosed]);
      if (closed || raw.destroyed || subscriber.closed) break;
      if (subscriber.peek() === undefined) {
        if (!(await write(': keep-alive\n\n'))) break;
      }
    }
  } finally {
    // The subscription is closed *before* the socket listeners are detached, so a Stop or
    // archive that publishes concurrently cannot wake a pump that is already gone.
    subscriber.close();
    detachSocket();
    try {
      raw.end();
    } catch {
      // Client already gone; nothing to flush.
    }
  }
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new AssistantValidationError(`${field} 必须是对象。`);
  return value as Record<string, unknown>;
}

function b64Bytes(value: unknown): Uint8Array {
  if (typeof value !== 'string' || value.length === 0 || value.length > Math.ceil(MAX_ATTACHMENT_BYTES * 4 / 3) + 8) {
    throw new AssistantValidationError('附件内容为空或超出大小限制。');
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new AssistantValidationError('附件编码无效。');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new AssistantValidationError('附件超出 5 MB 大小限制。');
  return new Uint8Array(bytes);
}

function parseAttachment(value: unknown): { metadata: AssistantAttachmentMetadata; bytes: Uint8Array } {
  const input = record(value, 'attachment');
  const fileName = typeof input['fileName'] === 'string' ? input['fileName'].trim().slice(0, 200) : '';
  if (fileName === '' || /[\\/\0]/.test(fileName)) throw new AssistantValidationError('附件名称无效。');
  const source = input['source'] ?? 'auto';
  if (source !== 'auto' && source !== 'wechat' && source !== 'alipay') throw new AssistantValidationError('附件来源无效。');
  const extension = fileName.toLowerCase().split('.').pop();
  if (extension !== 'xlsx' && extension !== 'csv') throw new AssistantValidationError('仅支持微信 XLSX 或支付宝 CSV 账单。');
  if ((source === 'wechat' && extension !== 'xlsx') || (source === 'alipay' && extension !== 'csv')) throw new AssistantValidationError('文件格式与账单来源不匹配。');
  const bytes = b64Bytes(input['fileBase64']);
  const metadata: AssistantAttachmentMetadata = {
    source,
    fileName,
    sizeBytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  return { metadata, bytes };
}

function safeError(error: unknown): { code: string; message: string } {
  const value = typeof error === 'object' && error !== null
    ? error as { code?: unknown; statusCode?: unknown }
    : undefined;
  const code = typeof value?.code === 'string' ? value.code : '';
  const messages: Readonly<Record<string, string>> = {
    AI_PROVIDER_TIMEOUT: 'AI 服务响应超时，请稍后重试。若持续发生，请检查服务地址与超时设置。',
    AI_PROVIDER_ERROR: '暂时无法连接 AI 服务，请检查服务地址、网络和服务状态后重试。',
    AI_NOT_CONFIGURED: 'AI 服务尚未配置或已停用，请前往设置完成配置。',
    AI_SECRET_UNAVAILABLE: 'AI 密钥当前不可用，请前往设置重新保存密钥。',
    AI_ENCRYPTION_KEY_REQUIRED: '服务器暂未启用 AI 密钥存储，请稍后重试或联系管理员。',
    AI_RESPONSE_INVALID: 'AI 服务返回内容无法识别，请检查模型配置后重试。',
    AI_CONFIG_INVALID: 'AI 配置无效，请检查服务地址、模型及高级请求设置。',
    AI_INPUT_INVALID: '输入内容无效，请补充描述后重试。',
    ASSISTANT_INVALID: '请求内容无效，请检查输入后重试。',
    ASSISTANT_ACTION_STALE: '此操作已过期，请刷新对话后重新发起。',
    ASSISTANT_ATTACHMENT_REQUIRED: '附件预览已失效，请重新附加原文件。',
    ASSISTANT_NOT_FOUND: '对话或操作不存在，请刷新后重试。',
  };
  const message = messages[code];
  if (message !== undefined) return { code, message };
  if (code === 'AI_ORGANIZATION_INVALID' || code === 'AI_ORGANIZATION_CONFLICT') {
    return { code, message: code === 'AI_ORGANIZATION_CONFLICT' ? '数据已发生变化，请刷新预览后重试。' : '整理请求无效，请调整选择后重试。' };
  }
  if (error instanceof AssistantError) {
    return { code: error.code, message: error.statusCode >= 500 ? '助手暂时无法处理请求，请稍后重试。' : '请求未能完成，请检查输入后重试。' };
  }
  // Preserve stable AI codes without serializing arbitrary provider or internal messages.
  if (code.startsWith('AI_') && typeof value?.statusCode === 'number') {
    return { code, message: 'AI 服务暂时无法处理请求，请检查配置或稍后重试。' };
  }
  return { code: 'INTERNAL_ERROR', message: '助手暂时无法处理请求，请稍后重试。' };
}

export async function registerAssistantRoutes(app: FastifyInstance, options: AssistantRoutesOptions): Promise<void> {
  const getServices = createRouteServices(app, options, (options, lifecycle) => {
    const now = options.now ?? (() => Date.now());  const withConversationLock = createConversationWriteLock();
    const conversations = new AssistantConversationService(options.db, now, { withConversationLock });
    const orchestrator = new AssistantOrchestrator({
      actorId: options.actorId,
      db: options.db,
      config: options.config,
      conversations,
      now,
      fetchImpl: options.fetchImpl,
    });
    const confirmingActions = new Map<string, Promise<unknown>>();
    /**
     * Live *legacy* provider turns per conversation (message send, import analyse).
     *
     * v1 generations and legacy turns are mutually exclusive in both directions. The legacy
     * routes already refused to start while a generation was live; this counter closes the
     * other direction, because a legacy turn holds no generation row for `hasActive` to see.
     * Both checks run under the shared write lock, so a create decision and a legacy start
     * cannot both pass.
     */
    /**
     * Provider-work exclusion shared by legacy turns and merged-batch analysis.
     *
     * The lock reads live generations from the database, so a module that only knows the routes it
     * registered still observes v1 streaming exactly as `generations.hasActive` would.
     */
    const activeLock = new ConversationActiveLock(options.db);
    const beginLegacyTurn = (conversationId: string): boolean =>
      withConversationLock(() => activeLock.begin(conversationId, 'legacy'));
    const endLegacyTurn = (conversationId: string): void => activeLock.end(conversationId, 'legacy');
    const legacyTurnActiveError = (): AssistantStreamError =>
      new AssistantStreamError('ASSISTANT_GENERATION_ACTIVE', '当前会话仍有进行中的生成，请先等待或停止。');

    // ── v1 streamed generations (additive; legacy endpoints below stay compatible) ──
    // `generations` is created after the shared provider-work lock so both can be handed to the
    // batch analysis runner; the lock itself reads live generations straight from the database.
    const generations = new AssistantGenerationService(options.db, conversations, now, { withConversationLock });
    const runner = new AssistantGenerationRunner(options.db, options.config, conversations, generations, {
      actorId: options.actorId,
      now,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.generationStepDelayMs === undefined ? {} : { stepDelayMs: options.generationStepDelayMs }),
    });
    // Boot recovery: unfinished work becomes `interrupted` and is never rerun automatically.
    runner.recover();

    const aiConfigService = new AiConfigService(options.db, {
      aiEncryptionKey: options.config.aiEncryptionKey,
      production: options.config.nodeEnv === 'production',
      now,
    });

    /**
     * Merged (multi-file) import batches. Same authenticated plugin context, same conversation
     * lock; the legacy single-file import routes below are untouched.
     */
    const batchAnalysis = new ImportBatchAnalysisRunner({
      db: options.db,
      config: options.config,
      now,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      activeLock,
    });
    // Boot recovery: a run left `running` by a previous process becomes `failed`, never resumed.
    batchAnalysis.recover();


    lifecycle.onClose(async () => {
      await AiSpendingOrganizationService.shutdownFor(options.db);
      await batchAnalysis.shutdown();
      await runner.shutdown();
    });


    lifecycle.whileBusy(() => runner.hasActiveWork || batchAnalysis.hasActiveWork || AiSpendingOrganizationService.hasActiveFor(options.db));

    return { now, withConversationLock, conversations, orchestrator, confirmingActions, activeLock, beginLegacyTurn, endLegacyTurn, legacyTurnActiveError, generations, runner, aiConfigService, batchAnalysis, options };
  });

  await registerImportBatchRoutes(app, { resolveAnalysis: (request) => getServices(request).batchAnalysis });

  app.post<{ Params: { conversationId: string } }>(
    '/api/v1/assistant/conversations/:conversationId/generations',
    async (request, reply) => {
      const { aiConfigService, withConversationLock, activeLock, legacyTurnActiveError, generations, now, runner } = getServices(request);
      const body = parseCreateGenerationRequest(request.body);
      let delivery: 'stream' | 'buffered' = 'buffered';
      try {
        const stored = aiConfigService.getStoredOrThrow();
        delivery = supportsAssistantStream(stored) ? 'stream' : 'buffered';
      } catch {
        // Still create the generation: the failure belongs to its terminal envelope,
        // not to a 400 the client cannot attach to a generation id.
        delivery = 'buffered';
      }
      // The same lock the legacy entry point takes: one create decision at a time, so a
      // legacy `/messages` write (or an in-flight legacy provider turn) cannot interleave
      // between the active-generation check and the new generation becoming live.
      const result = withConversationLock(() => {
        // A legacy turn or a merged-batch analysis also owns the conversation's provider-work
        // lock: one conversation never runs two model calls at once.
        if (
          activeLock.legacyActive(request.params.conversationId) ||
          activeLock.batchActive(request.params.conversationId)
        ) {
          throw legacyTurnActiveError();
        }
        return generations.create(request.params.conversationId, body, {
          delivery,
          today: dateLabel(now()),
        });
      });
      if (result.created) void runner.start(request.params.conversationId, result.generation.id);
      return reply.status(result.created ? 202 : 200).send(result);
    },
  );

  app.get<{ Params: { conversationId: string }; Querystring: { limit?: unknown } }>(
    '/api/v1/assistant/conversations/:conversationId/generations',
    async (request, reply) => {
      const { generations } = getServices(request);
      reply.header('Cache-Control', 'no-store');
      if (request.query.limit !== undefined && String(request.query.limit) !== '1') {
        throw new AssistantStreamError('ASSISTANT_GENERATION_INVALID', 'limit 仅支持 1。');
      }
      const latest = generations.latest(request.params.conversationId);
      return { items: latest === null ? [] : [latest] };
    },
  );

  app.get<{ Params: { conversationId: string; generationId: string } }>(
    '/api/v1/assistant/conversations/:conversationId/generations/:generationId',
    async (request, reply) => {
      const { generations } = getServices(request);
      reply.header('Cache-Control', 'no-store');
      return { generation: generations.get(request.params.conversationId, request.params.generationId) };
    },
  );

  app.post<{ Params: { conversationId: string; generationId: string } }>(
    '/api/v1/assistant/conversations/:conversationId/generations/:generationId/cancel',
    async (request) => {
      const { generations, runner } = getServices(request);
      const { conversationId, generationId } = request.params;
      // Order matters. Ownership and the durable terminal status first (`requireRow` scopes
      // the generation to this conversation and `cancel` is idempotent), then the upstream
      // abort and drain. The old order aborted a generation id from *any* conversation
      // before discovering it did not belong here, and a Stop that raced an already-finished
      // generation used to abort nothing while the row stayed live.
      const generation = generations.cancel(conversationId, generationId);
      await runner.cancel(generationId);
      return { generation };
    },
  );

  app.get<{ Params: { conversationId: string; generationId: string }; Querystring: { afterSeq?: unknown } }>(
    '/api/v1/assistant/conversations/:conversationId/generations/:generationId/events',
    async (request, reply) => {
      const { generations } = getServices(request);
      const { conversationId, generationId } = request.params;
      const raw = request.query.afterSeq === undefined ? 0 : Number(request.query.afterSeq);
      if (!Number.isSafeInteger(raw) || raw < 0) {
        throw new AssistantStreamError('ASSISTANT_GENERATION_INVALID', 'afterSeq 必须是非负整数。');
      }
      // Validation/replay read happen before the response head, so a missing replay is a
      // normal JSON error the client can act on (fetch the snapshot) rather than a broken stream.
      const replay = generations.listEvents(conversationId, generationId, raw);
      const subscriber = generations.subscribe(generationId, raw);
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      reply.hijack();
      await pumpGenerationEvents({
        request,
        reply,
        generations,
        conversationId,
        generationId,
        subscriber,
        initial: replay,
      });
      return reply;
    },
  );

  app.get('/api/v1/assistant/tools', async (request) => {
      const { orchestrator } = getServices(request);
      return ({ items: orchestrator.catalog() });
    });
  app.get('/api/v1/assistant/conversations', async (request) => {
      const { conversations } = getServices(request);
      return ({ items: conversations.list() });
    });
  app.post('/api/v1/assistant/conversations', async (request: FastifyRequest) => {
      const { conversations } = getServices(request);
    const body = request.body === undefined ? {} : record(request.body, 'body');
    const title = typeof body['title'] === 'string' ? body['title'].slice(0, 120) : '';
    return conversations.create(title);
  });

  app.get<{ Params: { id: string } }>('/api/v1/assistant/conversations/:id/messages', async (request) => {
      const { conversations } = getServices(request);
      return ({
    items: conversations.messages(request.params.id),
  });
    });

  app.post<{ Params: { id: string } }>('/api/v1/assistant/conversations/:id/messages', async (request) => {
      const { conversations, beginLegacyTurn, legacyTurnActiveError, orchestrator, endLegacyTurn } = getServices(request);
    const body = record(request.body, 'body');
    const text = typeof body['text'] === 'string' ? body['text'].trim() : '';
    const clientRequestId = typeof body['clientRequestId'] === 'string' ? body['clientRequestId'].trim().slice(0, 120) : undefined;
    if (text.length > MAX_TEXT_LENGTH) throw new AssistantValidationError('消息不能超过 2,000 个字符。');
    if (text === '' && body['attachment'] === undefined) throw new AssistantValidationError('请输入内容或附加账单文件。');
    if (clientRequestId !== undefined && clientRequestId !== '') {
      const existing = conversations.findByClientRequestId(request.params.id, clientRequestId);
      if (existing !== undefined) return { items: conversations.messages(request.params.id) };
    }
    // Legacy entry point shares the active-turn exclusion: no hidden parallel generation.
    // The check and the turn's registration happen under the create lock, so a v1
    // generation cannot become live between them.
    // Parse untrusted input before acquiring the live-turn exclusion.
    const attachment = body['attachment'] === undefined ? undefined : parseAttachment(body['attachment']);
    const metadata = attachment?.metadata;
    if (!beginLegacyTurn(request.params.id)) throw legacyTurnActiveError();
    try {
      const user = conversations.appendMessage({
        conversationId: request.params.id,
        role: 'user',
        kind: metadata === undefined ? 'text' : 'attachment',
        content: { version: 1, ...(text === '' ? {} : { text }), ...(metadata === undefined ? {} : { attachment: metadata }) },
        clientRequestId,
      });
      try {
        await orchestrator.handleMessage(request.params.id, text, user.id, attachment);
      } catch (error) {
        const running = [...conversations.messages(request.params.id)].reverse().find((message) => message.content.progress?.state === 'running');
        if (running !== undefined) conversations.updateProgressStatus(running.id, 'failed');
        const safe = safeError(error);
        conversations.appendMessage({ conversationId: request.params.id, role: 'assistant', kind: 'error', content: { version: 1, text: safe.message, error: safe } });
      }
    } finally {
      // appendMessage can throw too: every acquired lock must be released.
      endLegacyTurn(request.params.id);
    }
    return { items: conversations.messages(request.params.id) };
  });

  app.get<{ Params: { conversationId: string; id: string; rowId: string }; Querystring: { limit?: unknown; cursor?: unknown } }>(
    '/api/v1/assistant/conversations/:conversationId/actions/:id/rows/:rowId/duplicates', async (request, reply) => {
      const { options, now } = getServices(request);
      reply.header('Cache-Control', 'no-store');
      return new AssistantImportComparisonService(options.db, options.config.dataDir, now).read(
        request.params.conversationId, request.params.id, request.params.rowId, request.query.limit, request.query.cursor,
      );
    },
  );

  app.post<{ Params: { id: string } }>('/api/v1/assistant/actions/:id/analyse', async (request) => {
      const { conversations, beginLegacyTurn, legacyTurnActiveError, orchestrator, endLegacyTurn } = getServices(request);
    const pending = conversations.pending(request.params.id);
    if (pending.status !== 'pending' || pending.toolName !== 'platform-import.prepare' || !pending.attachment) throw new AssistantActionStaleError();
    const body = record(request.body, 'body');
    const bytes = b64Bytes(body['fileBase64']);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== pending.attachment.sha256 || bytes.byteLength !== pending.attachment.sizeBytes) throw new AssistantActionStaleError('原文件摘要不匹配。');
    // The analyse turn is a legacy provider turn too: it holds the legacy exclusion so a
    // v1 generation cannot run concurrently in the same conversation.
    if (!beginLegacyTurn(pending.conversationId)) throw legacyTurnActiveError();
    let result: Awaited<ReturnType<typeof orchestrator.handleMessage>>;
    try {
      result = await orchestrator.handleMessage(pending.conversationId, '', pending.sourceMessageId, { metadata: pending.attachment, bytes });
    } finally {
      endLegacyTurn(pending.conversationId);
    }
    // If another request closed the original while the provider ran, close the replacement too.
    if (conversations.pending(pending.id).status !== 'pending' && result.pendingActionId) {
      conversations.setPendingStatus(result.pendingActionId, 'expired', null);
      const replacement = conversations.messages(pending.conversationId).find((m) => m.content.card?.actionId === result.pendingActionId);
      if (replacement) conversations.updateCardStatus(replacement.id, 'expired');
      return { items: conversations.messages(pending.conversationId) };
    }
    conversations.setPendingStatus(pending.id, 'cancelled', null);
    const card = conversations.messages(pending.conversationId).find((m) => m.content.card?.actionId === pending.id);
    if (card) conversations.updateCardStatus(card.id, 'cancelled');
    return { items: conversations.messages(pending.conversationId) };
  });

  app.post<{ Params: { id: string } }>('/api/v1/assistant/actions/:id/confirm', async (request) => {
      const { confirmingActions, conversations, orchestrator } = getServices(request);
    const alreadyConfirming = confirmingActions.get(request.params.id);
    if (alreadyConfirming !== undefined) return alreadyConfirming;
    const operation = (async () => {
    const body = request.body === undefined ? {} : record(request.body, 'body');
    const pending = conversations.pending(request.params.id);
    if (pending.status === 'confirmed') return { action: pending, message: conversations.messages(pending.conversationId).at(-1) ?? null };
    const attachedBytes = body['fileBase64'] === undefined ? undefined : b64Bytes(body['fileBase64']);
    let selectedIds: readonly string[] | null | undefined;
    if (body['selectedIds'] !== undefined) {
      if (body['selectedIds'] !== null && (!Array.isArray(body['selectedIds']) || body['selectedIds'].length > 100 || body['selectedIds'].some((id) => typeof id !== 'string' || id.length > 100))) throw new AssistantValidationError('selectedIds 必须是最多 100 个有效行编号的数组或 null。');
      selectedIds = body['selectedIds'] as string[] | null;
    }
    let categoryOverrides: Readonly<Record<string, string>> | undefined;
    if (body['categoryOverrides'] !== undefined) {
      const raw = record(body['categoryOverrides'], 'categoryOverrides');
      if (Object.keys(raw).length > 100 || Object.keys(raw).some((id) => id.length > 100)) throw new AssistantValidationError('分类覆盖行数超出限制。');
      if (Object.values(raw).some((name) => typeof name !== 'string')) throw new AssistantValidationError('分类覆盖值必须是文本。');
      categoryOverrides = raw as Record<string, string>;
    }
    let noteOverrides: Readonly<Record<string, string>> | undefined;
    if (body['noteOverrides'] !== undefined) {
      const raw = record(body['noteOverrides'], 'noteOverrides');
      if (Object.keys(raw).length > 100 || Object.entries(raw).some(([id, value]) => id.length > 100 || typeof value !== 'string' || value.length > 200)) throw new AssistantValidationError('备注覆盖无效。');
      noteOverrides = raw as Record<string, string>;
    }
    try {
      return await orchestrator.confirmAction(pending.conversationId, pending.id, attachedBytes, {
        ...(selectedIds === undefined ? {} : { selectedIds }),
        ...(categoryOverrides === undefined ? {} : { categoryOverrides }),
        ...(noteOverrides === undefined ? {} : { noteOverrides }),
      });
    } catch (error) {
      if (error instanceof AssistantActionStaleError) {
        const expired = conversations.setPendingStatus(pending.id, 'expired', null);
        const card = conversations.messages(pending.conversationId).find((message) => message.content.card?.actionId === pending.id);
        if (card) conversations.updateCardStatus(card.id, expired.status);
      }
      throw error;
    }
    })();
    confirmingActions.set(request.params.id, operation);
    try {
      return await operation;
    } finally {
      confirmingActions.delete(request.params.id);
    }
  });

  app.post<{ Params: { id: string } }>('/api/v1/assistant/actions/:id/cancel', async (request) => {
      const { conversations } = getServices(request);
    const pending = conversations.pending(request.params.id);
    const action = conversations.setPendingStatus(pending.id, 'cancelled', null);
    const cardMessage = conversations.messages(pending.conversationId).find((message) => message.content.card?.actionId === pending.id);
    if (cardMessage !== undefined) conversations.updateCardStatus(cardMessage.id, action.status);
    return { action };
  });

  app.delete<{ Params: { id: string } }>('/api/v1/assistant/conversations/:id', async (request) => {
      const { generations, batchAnalysis, runner, conversations } = getServices(request);
    // Order matters: fence first, then abort and drain, then hide the conversation.
    // 1. The durable fence writes `interrupted` for every live generation *before* we wait
    //    on the provider, so a slow upstream can never keep the generation live after the
    //    archive response, and every later `persistTurn` is refused instead of racing us.
    // 2. Only then are the upstream readers aborted and their loops awaited.
    generations.cancelForArchive(request.params.id);
    // Non-terminal import batches are fenced (metadata only, zero financial writes) before their
    // readers are aborted, so an in-flight analysis cannot write back into an archived chat.
    batchAnalysis.service.fenceArchived(request.params.id);
    await runner.cancelConversation(request.params.id);
    conversations.archive(request.params.id);
    return { ok: true };
  });
}
