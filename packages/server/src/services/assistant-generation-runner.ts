/**
 * Production loop for one streamed assistant generation.
 *
 * The runner owns everything after the create decision: provider selection (true stream vs
 * explicitly buffered mode), bounded step loop, validated-message persistence, tool-card
 * preparation (which never writes the ledger), atomic finalization, cancellation and
 * deadline enforcement.
 *
 * Fences that matter (protocol-v1 §"Runtime/persistence"):
 *   * every provider/tool await is followed by a live-generation + archived-conversation
 *     fence, so a cancelled generation or archived conversation can never receive a late
 *     card, clarification or message;
 *   * a validated turn is persisted through one `persistTurn` unit: assistant row(s), the
 *     pending action, the awaiting-choice link and the terminal frame commit together under
 *     the shared conversation write lock, and `publish` runs only after that unit committed.
 *     A Stop that won the race leaves a terminal row, so `persistTurn` refuses the turn
 *     instead of publishing a message the terminal frame would then drop;
 *   * the streamed bubble's `messageId` is allocated *before* the provider turn and reused
 *     as the durable row id (and for the intermediate narration of a tool step), so the
 *     client replaces its provisional bubble instead of rendering a second one;
 *   * the generation canceller is registered before the provider request is issued, so a
 *     Stop that arrives while headers are still pending aborts the fetch itself;
 *   * the whole loop is wrapped: an unexpected throw still writes a terminal row, never
 *     leaving a generation stuck in `running`.
 */
import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config.js';
import type { Db } from '../db/index.js';
import { AiProviderService, AiProviderStream, type AiCallOptions } from './ai-provider-service.js';
import type { AiPromptContext, StoredAiProviderConfig } from './ai-types.js';
import { AssistantConversationService } from './assistant-conversation-service.js';
import { recoverProviderEnvelope } from './assistant-envelope-recovery.js';
import { AssistantTraceStore, summarizeToolArguments } from './assistant-trace-service.js';
import { AssistantGenerationService } from './assistant-generation-service.js';
import { AssistantWorkspaceStore } from './assistant-workspace-store.js';
import { requiresWorkspaceV1 } from './assistant-workspace-tools.js';
import { buildAssistantContext } from './assistant-orchestrator.js';
import {
  assistantBackgroundReply, assistantCanCorrectTool, assistantExpectedToolReply, assistantHistory, assistantReadIdentity, assistantRetiredAllocationInput,
  ASSISTANT_READ_LIMIT_REPLY, ASSISTANT_REPEATED_READ_REPLY,
  ASSISTANT_TOOL_CORRECTION_HINT, ASSISTANT_TOOL_CORRECTION_REPLY, MAX_ASSISTANT_TOOL_CORRECTIONS,
  ASSISTANT_NARROW_QUERY_REPLY, MAX_ASSISTANT_READ_FACT_BYTES,
  AssistantPreviewTooLargeError, ASSISTANT_PREVIEW_TOO_LARGE_REPLY, MAX_ASSISTANT_MESSAGE_EVENT_BYTES,
} from './assistant-turn-policy.js';
import { AssistantToolRegistry, type AssistantToolContext, type AssistantToolResult } from './assistant-tool-registry.js';
import {
  AssistantProviderTurnError,
  AssistantValidationError,
  normalizeAssistantJson,
  normalizeAssistantProviderTurn,
  type AssistantJsonObject,
  type AssistantMessageContent,
  type AssistantMessageDto,
  type AssistantProviderTurn,
  type AssistantToolName,
} from './assistant-types.js';
import {
  AssistantStreamError,
  MAX_DISPLAY_CHARS_PER_TURN,
  MAX_DISPLAY_CHARS_TOTAL,
  MAX_GENERATION_DEADLINE_MS,
  MAX_GENERATION_STEPS,
  MAX_PROVIDER_ENVELOPE_BYTES,
  toStreamError,
} from './assistant-stream-types.js';

/** Mirrors the legacy `TURN_SCHEMA` plus the additive `clarification` member. */
const STREAM_TURN_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    message: { type: 'string' },
    toolCall: {
      oneOf: [
        { type: 'null' },
        {
          type: 'object',
          properties: { name: { type: 'string' }, arguments: { type: 'object' } },
          required: ['name', 'arguments'],
          additionalProperties: false,
        },
      ],
    },
    clarification: {
      oneOf: [
        { type: 'null' },
        {
          type: 'object',
          properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } },
          required: ['question', 'options'],
          additionalProperties: false,
        },
      ],
    },
  },
  required: ['message', 'toolCall'],
  additionalProperties: false,
};

/** Coalescing window for text-delta writes: complete characters only, not per token. */
const COALESCE_CHARS = 32;
const COALESCE_MS = 50;
/** UTF-8 byte bound for the provisional snapshot text a reconnect may read. */
const MAX_PROVIDER_PARTIAL_BYTES = 12_000;

/**
 * Defensive shape of the additive provider open-stream handle. The parent owner of
 * `ai-provider-service.ts` returns `{body, streamTotalTimeoutMs, contentPath, cancel,
 * dispose}`; every member except `body` is read defensively so this runner keeps working
 * whether or not the parent's edit has landed.
 */
interface OpenStreamHandle {
  readonly body: ReadableStream<Uint8Array>;
  readonly streamTotalTimeoutMs?: number | undefined;
  readonly contentPath?: string | undefined;
  readonly cancel?: (() => void) | undefined;
  readonly dispose?: (() => void) | undefined;
}

/** Defensive shape of the additive provider abort options (fourth argument). */
interface ProviderAbortOptions {
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface AssistantGenerationRunnerOptions {
  readonly actorId?: string | undefined;
  readonly db: Db;
  readonly config: AppConfig;
  readonly now?: (() => number) | undefined;
  readonly fetchImpl?: typeof fetch;
  /** Pause between tool-loop steps (defaults to 50 ms; tests pass 0). */
  readonly stepDelayMs?: number;
}

interface ActiveRun {
  readonly conversationId: string;
  cancelled: boolean;
  promise: Promise<void>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dateLabel(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function jsonObject(value: unknown): AssistantJsonObject {
  const normalized = normalizeAssistantJson(value);
  if (typeof normalized !== 'object' || normalized === null || Array.isArray(normalized)) {
    throw new AssistantValidationError('助手结果必须是对象。');
  }
  return normalized as AssistantJsonObject;
}

function contextText(message: AssistantMessageDto): string {
  return (message.content.text ?? message.content.card?.summary ?? '').slice(0, 2_000);
}

/**
 * Longest UTF-8 safe prefix of `text` that fits `maxBytes`. The provisional snapshot is a
 * transport bound, so it is measured in bytes, and a multi-byte character is never cut in
 * half (a lone surrogate or half-decoded character would reach the client mangled).
 */
function boundedUtf8Prefix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const encoder = new TextEncoder();
  let used = 0;
  let out = '';
  for (const character of text) {
    const size = encoder.encode(character).byteLength;
    if (used + size > maxBytes) break;
    used += size;
    out += character;
  }
  return out;
}

/**
 * First `maxUnits` UTF-16 units of `text`, never splitting a surrogate pair.
 *
 * The delta budget is a UTF-16 offset budget (protocol-v1 §"Events": `offset` equals the
 * accumulated length), so a cut can land between a high and a low surrogate. The client
 * would then receive a lone surrogate (mangled glyph) that no amount of transport-level
 * decoding can repair, because the split happened here.
 */
function takeUtf16Units(text: string, maxUnits: number): string {
  if (maxUnits <= 0) return '';
  if (text.length <= maxUnits) return text;
  let end = maxUnits;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

export class AssistantGenerationRunner {
  private readonly conversations: AssistantConversationService;
  private readonly generations: AssistantGenerationService;
  private readonly db: Db;
  private readonly now: () => number;
  private readonly registry = new AssistantToolRegistry();
  private readonly toolContext: AssistantToolContext;
  private readonly aiConfig: ReturnType<typeof buildAssistantContext>['config'];
  /**
   * The runner's view of the provider transport: `complete`/`openStream` take the abort
   * options as their fourth argument and `openStream` returns the incremental handle with
   * its own cancel/dispose. Typed structurally so the runner compiles against both the
   * current provider and the in-flight parent edit to `ai-provider-service.ts`.
   */
  private readonly providerTransport: {
    complete(
      config: StoredAiProviderConfig,
      secret: string | null,
      context: AiPromptContext,
      options?: ProviderAbortOptions,
    ): Promise<unknown>;
    openStream(
      config: StoredAiProviderConfig,
      secret: string | null,
      context: AiPromptContext,
      options?: ProviderAbortOptions,
    ): Promise<OpenStreamHandle | null>;
  };
  private readonly stepDelayMs: number;
  private readonly runs = new Map<string, ActiveRun>();
  /** Diagnostic per-step trace; never holds model reasoning or provider payloads. */
  private readonly trace: AssistantTraceStore;
  private closing = false;
  private readonly appConfig: AppConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly actorId: string | undefined;

  constructor(
    db: Db,
    config: AppConfig,
    conversations: AssistantConversationService,
    generations: AssistantGenerationService,
    options: Omit<AssistantGenerationRunnerOptions, 'db' | 'config'> = {},
  ) {
    this.db = db;
    this.appConfig = config;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.actorId = options.actorId;
    this.conversations = conversations;
    this.generations = generations;
    const now = options.now ?? (() => Date.now());
    this.now = now;
    this.stepDelayMs = options.stepDelayMs ?? 0;
    const built = buildAssistantContext({
      actorId: this.actorId,
      db,
      config,
      now,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
    this.toolContext = built.context;
    this.aiConfig = built.config;
    this.providerTransport = built.provider as unknown as AssistantGenerationRunner['providerTransport'];
    this.trace = new AssistantTraceStore(db, now);
  }

  get hasActiveWork(): boolean { return this.runs.size > 0; }

  /** Boot recovery: unfinished generations become interrupted; nothing is rerun. */
  recover(): number {
    const recovered = this.generations.recoverUnfinished();
    new AssistantWorkspaceStore(this.db, this.now).reconcile();
    return recovered;
  }

  /** Starts the loop; the returned promise settles once a terminal status is persisted. */
  start(conversationId: string, generationId: string): Promise<void> {
    if (this.closing) return Promise.resolve();
    const existing = this.runs.get(generationId);
    if (existing !== undefined) return existing.promise;
    const active: ActiveRun = {
      conversationId,
      cancelled: false,
      promise: Promise.resolve(),
    };
    active.promise = this.run(conversationId, generationId)
      .catch(() => undefined)
      .finally(() => {
        this.runs.delete(generationId);
        this.generations.clearUpstreamCanceller(generationId);
      });
    this.runs.set(generationId, active);
    return active.promise;
  }

  /**
   * Explicit Stop: abort the upstream reader and wait for the loop to settle.
   *
   * The caller performs the durable cancel first (ownership-checked), so this method only
   * releases resources and drains the loop — a Stop response is never sent while a provider
   * turn is still able to write.
   */
  async cancel(generationId: string): Promise<void> {
    const run = this.runs.get(generationId);
    if (run === undefined) {
      this.generations.abortUpstream(generationId);
      return;
    }
    run.cancelled = true;
    this.generations.abortUpstream(generationId);
    await run.promise;
  }

  /** Archival: abort and drain every generation owned by one conversation. */
  async cancelConversation(conversationId: string): Promise<void> {
    const matches = [...this.runs.entries()].filter(([, run]) => run.conversationId === conversationId);
    for (const [generationId, run] of matches) {
      run.cancelled = true;
      this.generations.abortUpstream(generationId);
    }
    await Promise.all(matches.map(([, run]) => run.promise));
  }

  /** Shutdown: abort readers, wait for loops, then release subscribers/timers. Idempotent. */
  async shutdown(): Promise<void> {
    this.closing = true;
    const entries = [...this.runs.entries()];
    for (const [, run] of entries) run.cancelled = true;
    for (const [generationId] of entries) this.generations.abortUpstream(generationId);
    await Promise.all(entries.map(([, run]) => run.promise));
    this.generations.abortAllUpstream();
    this.generations.closeAllSubscribers();
  }

  private isLive(conversationId: string, generationId: string): boolean {
    const row = this.db
      .prepare('SELECT status FROM assistant_generations WHERE id = ? AND conversation_id = ?')
      .get(generationId, conversationId) as { status: string } | undefined;
    if (row === undefined) return false;
    return row.status === 'accepted' || row.status === 'running';
  }

  private isArchived(conversationId: string): boolean {
    const row = this.db
      .prepare('SELECT archived FROM assistant_conversations WHERE id = ?')
      .get(conversationId) as { archived: number } | undefined;
    return row === undefined || row.archived === 1;
  }

  private finalizeFailed(conversationId: string, generationId: string, error: unknown): void {
    const mapped = toStreamError(error);
    // Record the failure itself so the trace explains *why* the turn ended, not only which
    // tool ran last. The mapped sentence is a fixed server-owned string, never a provider body.
    const failureStep = this.trace.begin({ generationId, conversationId, step: MAX_GENERATION_STEPS, kind: 'error',
      argumentSummary: mapped.code });
    this.trace.finish(failureStep, 'failed');
    // Any step still open (a Stop mid-tool, an unexpected throw) must not claim to be in flight.
    this.trace.closeOpenSteps(generationId, 'failed');
    // `persistTurn` refuses a generation that already reached a terminal status, so this
    // can never resurrect a cancelled or archived turn.
    this.generations.finalize(conversationId, generationId, {
      status: 'failed',
      outcome: null,
      error: { code: mapped.code, message: mapped.message },
    });
  }

  /** Wraps the loop so *any* unexpected failure still leaves a terminal generation. */
  private async run(conversationId: string, generationId: string): Promise<void> {
    try {
      await this.runLoop(conversationId, generationId);
    } catch (error) {
      // A cancelled/archived generation already owns its terminal row; writing a second
      // terminal frame there is a refused no-op, and required everywhere else.
      this.finalizeFailed(conversationId, generationId, error);
    } finally {
      const workspace = new AssistantWorkspaceStore(this.db, this.now);
      const bound = workspace.binding(generationId);
      if (bound) {
        const snapshot = this.generations.get(conversationId, generationId);
        const workflow = workspace.workflow(conversationId, bound.workflow_id);
        if (snapshot.status === 'cancelled' || snapshot.status === 'interrupted') workspace.phase(generationId, 'cancelled');
        else if (snapshot.status === 'failed') workspace.phase(generationId, 'failed');
        else if (snapshot.status === 'completed' && snapshot.outcome !== 'pending-confirmation' && workflow?.['phase'] !== 'awaiting-selection') workspace.phase(generationId, 'completed');
      }
    }
  }

  private async runLoop(conversationId: string, generationId: string): Promise<void> {
    const row = this.db
      .prepare('SELECT today, delivery, user_message_id FROM assistant_generations WHERE id = ?')
      .get(generationId) as
      | { today: string; delivery: 'stream' | 'buffered'; user_message_id: string }
      | undefined;
    if (row === undefined) return;

    const checkout = this.now();
    const deadline = checkout + MAX_GENERATION_DEADLINE_MS;
    const userMessage = this.conversations.getMessage(row.user_message_id);
    const inputText = contextText(userMessage);
    const workspace = new AssistantWorkspaceStore(this.db, this.now);
    const workspaceFacts = workspace.facts(generationId);
    const daily = workspaceFacts?.['dailyReview'];
    const today = row.today === '' ? dateLabel(checkout) : row.today;

    this.generations.setStatus(conversationId, generationId, 'running');

    let lastResult: AssistantToolResult | null = null;
    let displayChars = 0;
    const reads = new Map<string, AssistantToolResult>();
    let toolCorrections = 0;
    let toolFailure: AssistantJsonObject | null = null;
    let readFactBytes = 0;

    if (daily !== undefined) {
      const result = await this.registry.read(this.toolContext, 'daily.review', daily);
      if (!this.isLive(conversationId, generationId) || this.isArchived(conversationId)) return;
      lastResult = result;
      this.generations.persistTurn(conversationId, generationId, { messages: [{ id: randomUUID(), role: 'assistant', kind: 'result', content: { version: 1, generationId,
        result: { version: 1, toolName: result.toolName, summary: result.summary, data: result.data } } }] });
    }

    for (let step = 0; step < MAX_GENERATION_STEPS; step += 1) {
      if (!this.isLive(conversationId, generationId)) return;
      if (this.now() >= deadline) return this.failDeadline(conversationId, generationId);
      if (displayChars >= MAX_DISPLAY_CHARS_TOTAL && lastResult !== null) {
        this.finishTextTurn(conversationId, generationId, { message: '', toolCall: null, clarification: null }, null, null);
        return;
      }
      if (step > 0 && this.stepDelayMs > 0) await delay(this.stepDelayMs);
      if (!this.isLive(conversationId, generationId)) return;

      let stored: StoredAiProviderConfig;
      let secret: string | null;
      try {
        stored = this.aiConfig.getStoredOrThrow();
        secret = this.aiConfig.getSecretOrThrow(stored);
      } catch (error) {
        return this.finalizeFailed(conversationId, generationId, error);
      }

      const categories = this.toolContext.services.masterData.listCategories().map(({ id, name, type }) => ({ id, name, type }));
      const accounts = this.toolContext.services.masterData.listAccounts().map(({ id, name, type }) => ({ id, name, type }));
      const messages = assistantHistory(this.conversations.context(conversationId));
      const requestContext: AiPromptContext = {
        input: JSON.stringify({
          request: inputText,
          priorMessages: messages,
          ...(lastResult === null ? {} : { previousResult: lastResult }),
          ...(toolFailure === null ? {} : { toolFailure }),
          ...(workspaceFacts === null ? {} : { workspace: workspaceFacts }),
          today,
        }),
        categories,
        accounts,
        model: stored.model,
        today,
        responseSchema: STREAM_TURN_SCHEMA,
        feature: 'assistant',
        facts: {
          messages,
          tools: this.registry.catalog().filter((tool) => (workspaceFacts !== null || !requiresWorkspaceV1(tool.name)) && (daily === undefined || tool.access === 'read')),
          ...(workspaceFacts === null ? {} : { workspace: workspaceFacts }),
          ...(lastResult === null ? {} : { lastToolResult: lastResult }),
          ...(toolFailure === null ? {} : { toolFailure }),
          remainingProviderSteps: MAX_GENERATION_STEPS - step,
          categories,
          accounts,
          // Explicit server-local date so the model never has to ask for it.
          serverToday: today,
        },
      };

      const remaining = Math.max(0, deadline - this.now());
      const providerTimeoutMs = Math.max(1_000, Math.min(stored.timeoutMs, remaining));

      let turn: AssistantProviderTurn | null = null;
      let streamError: unknown = null;
      let partial: { messageId: string; text: string } | null = null;

      try {
        if (row.delivery === 'stream') {
          turn = await this.runStreamedStep(
            conversationId,
            generationId,
            step,
            providerTimeoutMs,
            (offset) => Math.max(0, Math.min(
              MAX_DISPLAY_CHARS_PER_TURN - offset,
              MAX_DISPLAY_CHARS_TOTAL - displayChars,
            )),
            (produced) => {
              displayChars += produced;
            },
            (current) => {
              partial = current;
            },
            stored,
            secret,
            requestContext,
          );
        } else {
          const raw = await this.completeBuffered(stored, secret, requestContext, providerTimeoutMs, generationId);
          turn = normalizeAssistantProviderTurn(raw);
          turn = { ...turn, message: takeUtf16Units(turn.message, Math.max(0, Math.min(MAX_DISPLAY_CHARS_PER_TURN, MAX_DISPLAY_CHARS_TOTAL - displayChars))) };
          displayChars += turn.message.length;
        }
      } catch (error) {
        streamError = error;
      }

      if (streamError !== null) {
        if (this.runs.get(generationId)?.cancelled === true || !this.isLive(conversationId, generationId)) return;
        return this.finalizeFailed(conversationId, generationId, streamError);
      }
      if (turn === null) {
        return this.finalizeFailed(conversationId, generationId, new AssistantProviderTurnError());
      }
      if (this.now() >= deadline) return this.failDeadline(conversationId, generationId);
      // Fence: a provider turn is only actionable while the generation is still live.
      if (!this.isLive(conversationId, generationId) || this.isArchived(conversationId)) return;

      const normalizedTurn = turn;
      if (normalizedTurn.toolCall === null) {
        const answerStep = this.trace.begin({ generationId, conversationId, step, kind: 'result' });
        this.trace.finish(answerStep, 'ok');
        this.finishTextTurn(conversationId, generationId, normalizedTurn, null, partial);
        return;
      }
      // Unknown/retired tools remain hard failures; only known tools may correct arguments.
      if (this.registry.get(normalizedTurn.toolCall.name) === undefined || assistantRetiredAllocationInput(normalizedTurn.toolCall.name, normalizedTurn.toolCall.arguments) || (workspaceFacts === null && requiresWorkspaceV1(normalizedTurn.toolCall.name))) {
        const rejected = this.trace.begin({ generationId, conversationId, step, kind: 'error',
          toolName: normalizedTurn.toolCall.name, argumentSummary: 'unsupported-tool' });
        this.trace.finish(rejected, 'failed');
        throw new AssistantValidationError('AI 选择了不受支持的工具或已停用的分配方式，未执行任何操作。');
      }

      const toolStep = this.trace.begin({ generationId, conversationId, step, kind: 'tool',
        toolName: normalizedTurn.toolCall.name,
        argumentSummary: summarizeToolArguments(normalizedTurn.toolCall.arguments) });
      try {
        const { tool, arguments: args } = this.registry.parseArguments(
          normalizedTurn.toolCall.name,
          normalizedTurn.toolCall.arguments,
        );
        if (tool.definition.access === 'write') {
          if (daily !== undefined) {
            this.finishTextTurn(conversationId, generationId, { message: '每日复盘只读取账本，不会生成或执行修改。', toolCall: null, clarification: null }, null, partial);
            return;
          }
          await this.finishWriteTurn(conversationId, generationId, normalizedTurn, tool.definition.name, args,
            row.user_message_id, partial, deadline);
          this.trace.finish(toolStep, 'ok');
          return;
        }
        const identity = assistantReadIdentity(tool.definition.name, args);
        if (reads.has(identity)) {
          this.trace.finish(toolStep, 'ok');
          this.finishTextTurn(conversationId, generationId,
            { message: ASSISTANT_REPEATED_READ_REPLY, toolCall: null, clarification: null }, null, partial);
          return;
        }
        const read = await this.readTool(conversationId, generationId, normalizedTurn, tool.definition.name, args, partial, deadline);
        if (read.dropped || read.result === null) {
          this.trace.finish(toolStep, 'failed');
          return;
        }
        this.trace.finish(toolStep, 'ok');
        lastResult = read.result;
        toolFailure = null;
        reads.set(identity, read.result);
        const handoff = assistantBackgroundReply(read.result);
        const workspaceHandoff = read.result.toolName === 'workspace.select' ? '请在卡片中选择，随后继续原任务；选择不会修改账本。' : read.result.toolName === 'workspace.open' ? read.result.summary : null;
        if (handoff !== null || workspaceHandoff !== null) {
          this.finishTextTurn(conversationId, generationId,
            { message: handoff ?? workspaceHandoff ?? '', toolCall: null, clarification: null }, read.result, null);
          return;
        }
        const resultMessageId = randomUUID();
        this.generations.persistTurn(conversationId, generationId, {
          messages: [{ id: resultMessageId, role: 'assistant', kind: 'result', content: {
            version: 1, generationId,
            result: { version: 1, toolName: read.result.toolName, summary: read.result.summary, data: read.result.data },
          } }],
        });
        if (workspaceFacts !== null) workspace.recordResult(resultMessageId, conversationId, tool.definition.name, args);
        readFactBytes += Buffer.byteLength(JSON.stringify(read.result), 'utf8');
        if (read.result.data['requiresNarrowerQuery'] === true || readFactBytes > MAX_ASSISTANT_READ_FACT_BYTES) {
          this.finishTextTurn(conversationId, generationId,
            { message: ASSISTANT_NARROW_QUERY_REPLY, toolCall: null, clarification: null }, null, null);
          return;
        }
      } catch (error) {
        if (!this.isLive(conversationId, generationId) || this.isArchived(conversationId)) {
          this.trace.finish(toolStep, 'failed');
          return;
        }
        const expectedReply = assistantExpectedToolReply(error);
        if (expectedReply !== null) {
          this.trace.finish(toolStep, 'failed');
          this.finishTextTurn(conversationId, generationId,
            { message: expectedReply, toolCall: null, clarification: null }, null, partial);
          return;
        }
        if (error instanceof AssistantPreviewTooLargeError) {
          this.trace.finish(toolStep, 'failed');
          this.finishTextTurn(conversationId, generationId,
            { message: ASSISTANT_PREVIEW_TOO_LARGE_REPLY, toolCall: null, clarification: null }, null, partial);
          return;
        }
        if (!assistantCanCorrectTool(error)) {
          this.trace.finish(toolStep, 'failed');
          throw error;
        }
        this.trace.finish(toolStep, 'failed');
        toolCorrections += 1;
        if (toolCorrections > MAX_ASSISTANT_TOOL_CORRECTIONS) {
          this.finishTextTurn(conversationId, generationId,
            { message: ASSISTANT_TOOL_CORRECTION_REPLY, toolCall: null, clarification: null }, null, partial);
          return;
        }
        toolFailure = { code: 'TOOL_ARGUMENTS_INVALID', message: ASSISTANT_TOOL_CORRECTION_HINT };
      }
    }

    if (!this.isLive(conversationId, generationId)) return;
    if (lastResult !== null || toolFailure !== null) {
      this.finishTextTurn(conversationId, generationId,
        { message: toolFailure === null ? ASSISTANT_READ_LIMIT_REPLY : ASSISTANT_TOOL_CORRECTION_REPLY, toolCall: null, clarification: null }, null, null);
    } else {
      this.finalizeFailed(conversationId, generationId,
        new AssistantStreamError('ASSISTANT_STREAM_BOUNDS', '本次生成步骤过多，已中断。'));
    }
  }

  private failDeadline(conversationId: string, generationId: string): void {
    // A provisional bubble the model never finished is dropped by the same write that
    // stores the terminal frame: it is never persisted as a validated message.
    this.finalizeFailed(
      conversationId,
      generationId,
      new AssistantStreamError('ASSISTANT_STREAM_BOUNDS', '本次生成超出时限，已中断。'),
    );
  }

  /** Buffered provider turn (responses/custom); never simulated as incremental output. */
  private async completeBuffered(
    stored: StoredAiProviderConfig,
    secret: string | null,
    requestContext: AiPromptContext,
    providerTimeoutMs: number,
    generationId: string,
  ): Promise<unknown> {
    const controller = new AbortController();
    // Registered before the request: a Stop while the buffered call is in flight aborts the
    // fetch instead of waiting for the whole provider round trip.
    this.generations.setUpstreamCanceller(generationId, () => controller.abort());
    try {
      return await this.providerTransport.complete(
        stored,
        secret,
        requestContext,
        this.providerAbortOptions(controller, providerTimeoutMs),
      );
    } finally {
      this.generations.clearUpstreamCanceller(generationId);
    }
  }

  /**
   * Abort options for the provider's fourth argument: an external `signal` so a Stop aborts
   * the in-flight fetch, plus the configured ceiling. Nothing else is sent.
   */
  private providerAbortOptions(controller: AbortController, timeoutMs: number): ProviderAbortOptions {
    return { signal: controller.signal, timeoutMs };
  }

  /**
   * Drives one streamed provider turn. Returns the validated turn; throws on any transport
   * or envelope failure so the caller can finalize `failed` (never a silent fallback).
   *
   * `onPartial` is invoked as soon as the provisional bubble exists (and again whenever its
   * text changes) so the caller can hand the very same id to the validated message.
   */
  private async runStreamedStep(
    conversationId: string,
    generationId: string,
    step: number,
    providerTimeoutMs: number,
    budgetFor: (offset: number) => number,
    onProduced: (chars: number) => void,
    onPartial: (partial: { messageId: string; text: string } | null) => void,
    stored: StoredAiProviderConfig,
    secret: string | null,
    requestContext: AiPromptContext,
  ): Promise<AssistantProviderTurn> {
    // The bubble id is allocated before the provider call and reused as the durable row id,
    // so the client's provisional bubble is *replaced* by the validated message.
    const messageId = randomUUID();
    const controller = new AbortController();
    let handle: OpenStreamHandle | null = null;
    // The reader belongs to the transport once it exists, so cancellation goes through the
    // transport's own `cancel()` (which owns its lock). `body.cancel()` would reject on a
    // locked stream and leave a pending `read()` — and therefore the whole run — hung.
    let cancelReader: (() => void) | null = null;
    const canceller = (): void => {
      controller.abort();
      cancelReader?.();
      handle?.cancel?.();
      handle?.dispose?.();
    };
    // Registered before the request is issued: a Stop that races the header wait aborts the
    // fetch itself, not just a reader that does not exist yet.
    this.generations.setUpstreamCanceller(generationId, canceller);
    try {
      const opened = await this.providerTransport.openStream(
        stored,
        secret,
        requestContext,
        this.providerAbortOptions(controller, providerTimeoutMs),
      );
      if (opened === null) {
        // Delivery was frozen at acceptance. A changed configuration cannot secretly
        // replace a stream with a second buffered provider request.
        throw new AssistantStreamError('ASSISTANT_STREAM_BOUNDS', '配置已变化，请核对后重新发起生成。');
      }
      handle = opened;

      this.generations.announcePartial(conversationId, generationId, { messageId, step, text: '', validated: false });
      onPartial({ messageId, text: '' });
      let offset = 0;
      let pending = '';
      let received = '';
      let flushTimer: ReturnType<typeof setTimeout> | null = null;
      let flushError: unknown = null;
      const clearFlushTimer = (): void => {
        if (flushTimer !== null) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
      };
      const flush = (): void => {
        clearFlushTimer();
        if (pending === '') return;
        this.generations.appendTextDelta(conversationId, generationId, { messageId, step, offset, text: pending });
        offset += pending.length;
        // Keep the snapshot comparable with the event log: a reconnect without replay
        // must still show the provisional text of an in-flight step, bounded in UTF-8 bytes.
        received = boundedUtf8Prefix(received, MAX_PROVIDER_PARTIAL_BYTES);
        this.generations.updatePartialText(conversationId, generationId, messageId, received);
        onPartial({ messageId, text: received });
        onProduced(pending.length);
        pending = '';
      };

      const stream = new AiProviderStream(opened.body.getReader(), {
        step,
        contentPath: opened.contentPath ?? stored.responsePath,
        streamTotalTimeoutMs: this.streamDeadlineMs(opened, providerTimeoutMs),
        onDone: () => undefined,
        onError: () => undefined,
      });
      cancelReader = () => stream.cancel();
      try {
        for (;;) {
          // `next()` yields only complete, decoded characters of the top-level message
          // string — never raw envelope JSON and never a split surrogate pair. Coalescing
          // happens here so the event log stays bounded while the client still sees text
          // before the upstream turn ends.
          const chunk = await stream.next();
          if (flushError !== null) throw flushError;
          if (chunk === null) break;
          if (!this.isLive(conversationId, generationId)) break;
          received += chunk;
          const budget = budgetFor(offset);
          if (budget <= 0) continue;
          const take = takeUtf16Units(chunk, budget);
          if (take === '') continue;
          pending += take;
          if (pending.length >= COALESCE_CHARS) {
            flush();
            continue;
          }
          // Slow provider: guarantee first-text latency with a short debounce instead of
          // waiting for a full coalescing window or the end of the turn.
          if (flushTimer === null) {
            flushTimer = setTimeout(() => {
              flushTimer = null;
              try {
                if (this.isLive(conversationId, generationId)) flush();
              } catch (error) {
                flushError = error;
                stream.cancel();
              }
            }, COALESCE_MS);
          }
        }
      } catch (error) {
        stream.cancel();
        throw error;
      } finally {
        clearFlushTimer();
      }
      flush();
      if (received.trim() === '') {
        throw new AssistantStreamError('ASSISTANT_STREAM_BOUNDS', 'AI 返回了空的回复内容，本次生成未产生结果。');
      }
      // The decoded increments are already at the client; the authoritative envelope is the
      // transport's own verbatim accumulation (never re-derived from the coalesced preview,
      // which is trimmed to the display budget). A malformed envelope fails here, before any
      // tool card or clarification can be persisted.
      const envelopeText = stream.envelope;
      let envelope: unknown;
      try {
        envelope = JSON.parse(envelopeText) as unknown;
      } catch {
        // The model was asked for a JSON object, but a gateway or the model itself may still
        // wrap it in a Markdown fence or surround it with prose. Recovering the shape keeps a
        // decided tool call alive instead of losing the whole reply; an unrecoverable body
        // still fails below with the same bounded error.
        const recovered = recoverProviderEnvelope(envelopeText);
        if (recovered === null) {
          throw new AssistantStreamError('ASSISTANT_STREAM_BOUNDS', 'AI 返回内容无法识别，本次生成未产生结果。');
        }
        if (recovered.text !== undefined) {
          // Plain prose: no tool call and no clarification can be honoured, so this is only
          // ever an ordinary answer. The user still sees the model's actual words.
          return { message: takeUtf16Units(recovered.text, MAX_DISPLAY_CHARS_PER_TURN), toolCall: null, clarification: null };
        }
        envelope = recovered.object;
      }
      // The same ceiling the transport used applies to the authoritative envelope, so the
      // configured total timeout also covers the body, not only time-to-headers.
      if (Buffer.byteLength(envelopeText, 'utf8') > MAX_PROVIDER_ENVELOPE_BYTES) {
        throw new AssistantStreamError('ASSISTANT_STREAM_BOUNDS', 'AI 返回内容超出大小上限，本次生成未产生结果。');
      }
      return normalizeAssistantProviderTurn(envelope);
    } finally {
      cancelReader?.();
      handle?.cancel?.();
      handle?.dispose?.();
      cancelReader = null;
      this.generations.clearUpstreamCanceller(generationId);
    }
  }

  /**
   * Configured total timeout for the stream body.
   *
   * The provider timeout bounds time-to-headers; the body gets its own configured ceiling,
   * but never more than this runner is prepared to wait. The generation's remaining 180 s
   * deadline is enforced by the loop itself (`failDeadline`), so it cannot be widened here.
   */
  private streamDeadlineMs(handle: OpenStreamHandle, providerTimeoutMs: number): number {
    const configured = Math.min(providerTimeoutMs * 2, MAX_GENERATION_DEADLINE_MS);
    const fromHandle = typeof handle.streamTotalTimeoutMs === 'number' && handle.streamTotalTimeoutMs > 0
      ? handle.streamTotalTimeoutMs
      : configured;
    return Math.max(1, Math.min(fromHandle, configured));
  }

  /**
   * Reads one tool and persists the assistant's narration under the *same* id as the
   * provisional bubble.
   *
   * The narration is made durable before the tool runs (the client already received its
   * text, so dropping it would leave an orphan bubble) and the read result is fenced after
   * the await, so an archive or Stop during the tool call cannot persist a late answer.
   */
  private async readTool(
    conversationId: string,
    generationId: string,
    turn: AssistantProviderTurn,
    toolName: AssistantToolName,
    args: AssistantJsonObject,
    partial: { messageId: string; text: string } | null,
    deadline: number,
  ): Promise<{ dropped: boolean; result: AssistantToolResult | null }> {
    const text = takeUtf16Units(turn.message, MAX_DISPLAY_CHARS_PER_TURN);
    if (text.trim() !== '') {
      const id = partial?.messageId ?? randomUUID();
      this.generations.persistTurn(conversationId, generationId, {
        messages: [{ id, role: 'assistant', kind: 'text', content: { version: 1, text, generationId } }],
      });
    }
    const scope = this.openToolScope(generationId, deadline);
    try {
      // These tools only schedule durable background work and return immediately. Their
      // provider belongs to the tenant lifecycle, not this short-lived tool scope: disposing
      // the latter aborts its signal and would otherwise cancel every scheduled batch.
      const context = toolName === 'spending.preview' || toolName === 'spending.resume'
        ? this.toolContext : scope.context;
      const result = await Promise.race([this.registry.read({ ...context, conversationId, generationId }, toolName, args), scope.aborted]);
      if (!this.isLive(conversationId, generationId) || this.isArchived(conversationId)) {
        return { dropped: true, result: null };
      }
      return { dropped: false, result };
    } finally {
      scope.dispose();
    }
  }

  /**
   * Cancellable execution scope for one tool that may call a nested provider.
   *
   * Domain services capture their provider when they are built, so a shared context makes a
   * Stop, an archive or the generation deadline unable to cut an in-flight nested request.
   * The scope registers itself as the generation's upstream canceller (so Stop/archive abort
   * it immediately), arms a timer for the remaining generation deadline, and builds a
   * per-tool context whose provider composes the caller's signal with this scope's.
   *
   * `remainingMs` is frozen at construction: a provider that resolved after the deadline must
   * not be handed a fresh budget by a later tool.
   */
  private openToolScope(
    generationId: string,
    deadline: number,
  ): {
    readonly context: AssistantToolContext;
    readonly aborted: Promise<never>;
    readonly remainingMs: number;
    dispose: () => void;
  } {
    const controller = new AbortController();
    const remainingMs = Math.max(1, deadline - this.now());
    const timer = setTimeout(() => controller.abort(), remainingMs);
    let rejectAbort: () => void = () => undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(new AssistantStreamError('ASSISTANT_STREAM_BOUNDS', '本次生成已停止或超出时限。'));
    });
    void aborted.catch(() => undefined);
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
    this.generations.setUpstreamCanceller(generationId, () => controller.abort());
    // Domain services capture their provider when built. Build a per-call context rather
    // than mutating a shared provider while another conversation is running.
    const scopedProvider = new class extends AiProviderService {
      override complete(config: StoredAiProviderConfig, secret: string | null, context: AiPromptContext, options: AiCallOptions = {}): Promise<unknown> {
        return super.complete(config, secret, context, {
          signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal,
          timeoutMs: Math.min(options.timeoutMs ?? config.timeoutMs, remainingMs),
        });
      }
    }(this.fetchImpl);
    const context = buildAssistantContext({
      actorId: this.actorId,
      db: this.db,
      config: this.appConfig,
      now: this.now,
      provider: scopedProvider,
    }).context;
    return {
      context,
      aborted,
      remainingMs,
      dispose: () => {
        clearTimeout(timer);
        controller.signal.removeEventListener('abort', rejectAbort);
        controller.abort();
        this.generations.clearUpstreamCanceller(generationId);
      },
    };
  }

  private finishTextTurn(
    conversationId: string,
    generationId: string,
    turn: AssistantProviderTurn,
    lastResult: AssistantToolResult | null,
    partial: { messageId: string; text: string } | null,
  ): void {
    const text = takeUtf16Units(turn.message, MAX_DISPLAY_CHARS_PER_TURN);
    // A read may already have persisted its streamed narration before a domain state
    // (for example an oversized organization range) stopped the tool. Its safe outcome
    // needs a new row; reusing that id would make persistTurn's replay fence skip it.
    const partialStored = partial !== null && this.db.prepare('SELECT id FROM assistant_messages WHERE id = ?').get(partial.messageId) !== undefined;
    const messageId = partial === null || partialStored ? randomUUID() : partial.messageId;
    if (turn.clarification !== null) {
      // Server-owned question and option ids: the model only proposes labels.
      const question = {
        id: randomUUID(),
        options: turn.clarification.options.map((label) => ({ id: randomUUID(), label })),
      };
      const content: AssistantMessageContent = {
        version: 1,
        text,
        generationId,
        clarification: {
          id: question.id,
          selection: 'single' as const,
          question: turn.clarification.question,
          options: question.options,
          allowFreeText: true as const,
        },
      };
      this.generations.persistTurn(conversationId, generationId, {
        messages: [{ id: messageId, role: 'assistant', kind: 'text', content }],
        question: { id: question.id, clarification: content.clarification },
        transition: { status: 'completed', outcome: 'awaiting-choice', error: null },
      });
      return;
    }
    this.generations.persistTurn(conversationId, generationId, {
      messages: [{
        id: messageId,
        role: 'assistant',
        kind: lastResult === null ? 'text' : 'result',
        content: lastResult === null
          ? { version: 1, text, generationId }
          : {
              version: 1,
              text,
              generationId,
              result: {
                version: 1,
                toolName: lastResult.toolName,
                summary: lastResult.summary,
                data: lastResult.data,
              },
            },
      }],
      transition: { status: 'completed', outcome: 'answer', error: null },
    });
  }

  private async finishWriteTurn(
    conversationId: string,
    generationId: string,
    turn: AssistantProviderTurn,
    toolName: AssistantToolName,
    args: AssistantJsonObject,
    userMessageId: string,
    partial: { messageId: string; text: string } | null,
    deadline: number,
  ): Promise<void> {
    // `prepare` may read and validate, but it never writes the ledger. The one provider-backed
    // prepare (`organization.apply` → `organization.preview`) runs under the same scoped
    // context/abort/deadline as a read tool, so a Stop/archive aborts the nested provider
    // instead of waiting for its own timeout.
    const scope = this.openToolScope(generationId, deadline);
    try {
      const prepared = await Promise.race([this.registry.prepare(scope.context, toolName, args), scope.aborted]);
      // Fence: the write card may only be persisted while the generation is still live, the
      // conversation is not archived and the generation deadline has not passed.
      if (!this.isLive(conversationId, generationId) || this.isArchived(conversationId)) return;
      if (this.now() >= deadline) return this.failDeadline(conversationId, generationId);
      const preview = jsonObject(prepared.preview);
      const pendingId = randomUUID();
      const messageId = partial?.messageId ?? randomUUID();
      const text = takeUtf16Units(turn.message, MAX_DISPLAY_CHARS_PER_TURN);
      const content: AssistantMessageContent = {
        version: 1, text, generationId,
        card: {
          version: 1, actionId: pendingId, toolName: prepared.toolName,
          operation: prepared.operation, summary: prepared.summary, writes: true,
          affected: prepared.affected, values: prepared.values, warnings: prepared.warnings,
          fingerprint: prepared.fingerprint, status: 'pending', preview,
          ...(prepared.attachment === undefined ? {} : { attachment: prepared.attachment }),
        },
      };
      // One SSE data line must fit existing native parsers (64 KiB). Never truncate
      // the scope of a financial preview to make it fit; ask for a smaller selection.
      const messageBytes = Buffer.byteLength(JSON.stringify({ id: messageId, conversationId, role: 'assistant',
        kind: 'tool-card', content, createdAt: this.now() }), 'utf8');
      if (messageBytes + 512 > MAX_ASSISTANT_MESSAGE_EVENT_BYTES) throw new AssistantPreviewTooLargeError();
      // Pending action + card + terminal frame are one uninterruptible unit, so a Stop can
      // never land between the card and the confirmation state that authorizes it.
      this.generations.persistTurn(conversationId, generationId, {
        pendingActions: [{
          id: pendingId,
          conversationId,
          sourceMessageId: userMessageId,
          toolName: prepared.toolName,
          arguments: prepared.arguments,
          preview,
          fingerprint: prepared.fingerprint,
          ...(prepared.attachment === undefined ? {} : { attachment: prepared.attachment }),
        }],
        messages: [{
          id: messageId,
          role: 'assistant',
          kind: 'tool-card',
          content,
        }],
        transition: { status: 'completed', outcome: 'pending-confirmation', error: null },
      });
      new AssistantWorkspaceStore(this.db, this.now).linkAction(pendingId, conversationId, generationId);
    } finally {
      scope.dispose();
    }
  }
}
