/**
 * Durable generation lifecycle for the v1 streaming assistant.
 *
 * Responsibilities (protocol-v1 §"Runtime/persistence"):
 *   * create/read/status replay-safe snapshots with opaque server ids;
 *   * persist monotonic events *before* publishing them, and hard-bound the replay;
 *   * own-active-generation and payload-hash dedup at the conversation level;
 *   * atomic finalization fenced by the live generation, so a late tool result cannot
 *     resurrect a cancelled or archived turn;
 *   * recovery (accepted/running → interrupted without rerun) and shutdown cleanup;
 *   * a subscriber registry with bounded queues and a bounded replay window.
 *
 * The provider/tool loop lives in `AssistantGenerationRunner`; this module never calls a
 * provider, so a status read or a reconnect can never start model work.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';
import { AssistantConversationService, type ConversationWriteLock, type CreatePendingActionInput } from './assistant-conversation-service.js';
import {
  AssistantError,
  assistantJsonObject,
  findClarification,
  isAssistantToolName,
  normalizeAssistantAttachment,
  normalizeAssistantContent,
  type AssistantMessageContent,
  type AssistantMessageDto,
  type AssistantMessageKind,
  type AssistantRole,
} from './assistant-types.js';
import {
  AssistantStreamError,
  MAX_CLIENT_REQUEST_ID,
  MAX_DISPLAY_CHARS_PER_TURN,
  MAX_GENERATION_INPUT_TEXT,
  MAX_GENERATION_STEPS,
  MAX_REPLAY_BYTES,
  MAX_REPLAY_EVENTS,
  SUBSCRIBER_QUEUE_MAX_BYTES,
  utf8Bytes,
  SUBSCRIBER_QUEUE_MAX_EVENTS,
  type AssistantDelivery,
  type AssistantGenerationCreateResult,
  type AssistantGenerationInput,
  type AssistantGenerationSnapshot,
  type AssistantOutcome,
  type AssistantPartialSnapshot,
  type AssistantStreamEvent,
  type AssistantStreamStatus,
} from './assistant-stream-types.js';

/** Terminal statuses never change again. */
const TERMINAL_STATUSES: readonly AssistantStreamStatus[] = [
  'completed',
  'failed',
  'cancelled',
  'interrupted',
];

/** One bounded queue per live subscriber; see `subscribe`. */
export interface AssistantGenerationSubscriber {
  readonly closed: boolean;
  /** Queue head, or `undefined` when the queue is momentarily empty. */
  readonly peek: () => AssistantStreamEvent | undefined;
  /** Removes and returns the queue head. */
  readonly shift: () => AssistantStreamEvent | undefined;
  /** Drops this subscriber; returns false when it was already removed. */
  readonly close: () => boolean;
}

interface SubscriberState {
  readonly queue: AssistantStreamEvent[];
  bytes: number;
  closed: boolean;
  cursor: number;
  idle: { resolve: () => void } | null;
  readonly peek: () => AssistantStreamEvent | undefined;
  readonly shift: () => AssistantStreamEvent | undefined;
  readonly close: () => boolean;
}

interface GenerationRow {
  readonly id: string;
  readonly conversation_id: string;
  readonly client_request_id: string;
  readonly request_hash: string;
  readonly input_json: string;
  readonly user_message_id: string;
  readonly status: AssistantStreamStatus;
  readonly delivery: AssistantDelivery;
  readonly outcome: AssistantOutcome | null;
  readonly last_seq: number;
  readonly message_ids_json: string;
  readonly partials_json: string;
  readonly source_generation_id: string | null;
  readonly question_id: string | null;
  readonly question_json: string | null;
  readonly answered_option_id: string | null;
  readonly answered_at: number | null;
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly today: string;
  readonly created_at: number;
  readonly updated_at: number;
}

interface EventRow {
  readonly seq: number;
  readonly type: string;
  readonly payload_json: string;
}

export interface CreateGenerationRequest {
  readonly version: number;
  readonly clientRequestId: string;
  readonly input: AssistantGenerationInput;
}

export interface CreateGenerationContext {
  /** Streamed Chat-completions reply, or buffered for responses/custom modes. */
  readonly delivery: AssistantDelivery;
  /** One captured server-local day label for this generation's prompt. */
  readonly today: string;
}

export interface GenerationTransition {
  readonly status: Exclude<AssistantStreamStatus, 'accepted' | 'running'>;
  readonly outcome: AssistantOutcome | null;
  readonly error: { readonly code: string; readonly message: string } | null;
}

export interface PlannedAssistantMessage {
  readonly id: string;
  readonly role: AssistantRole;
  readonly kind: AssistantMessageKind;
  readonly content: AssistantMessageContent;
}

/**
 * Everything a runner wants to become durable in one uninterruptible unit: the assistant
 * rows it produced, the pending action a write turn prepared, the validated preview of a
 * provisional streamed bubble, the awaiting-choice question link and the terminal
 * transition itself.
 */
export interface PlannedAssistantTurn {
  readonly messages: readonly PlannedAssistantMessage[];
  readonly pendingActions?: readonly CreatePendingActionInput[] | undefined;
  readonly question?: { readonly id: string; readonly clarification: unknown } | undefined;
  /** Validated streamed text for the provisional bubble announced before validation. */
  readonly partial?: { readonly messageId: string; readonly text: string } | undefined;
  /**
   * Omitted for an intermediate write (assistant narration between tool steps): the rows
   * and their `message` events commit and publish, and the generation stays live.
   */
  readonly transition?: GenerationTransition | undefined;
}

export interface AssistantGenerationServiceOptions {
  /** Shared domain lock; see {@link ConversationWriteLock}. */
  readonly withConversationLock?: ConversationWriteLock | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new AssistantError(500, 'INTERNAL_ERROR', '生成记录无法读取。');
  }
}

function stringArray(value: string): string[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new AssistantError(500, 'INTERNAL_ERROR', '生成记录无法读取。');
  }
  return parsed as string[];
}

function partialArray(value: string): AssistantPartialSnapshot[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) throw new AssistantError(500, 'INTERNAL_ERROR', '生成记录无法读取。');
  if (parsed.some((item: unknown) => !isRecord(item) ||
    typeof item['messageId'] !== 'string' || item['messageId'] === '' ||
    !Number.isInteger(item['step']) || Number(item['step']) < 0 || Number(item['step']) >= MAX_GENERATION_STEPS ||
    typeof item['text'] !== 'string' || typeof item['validated'] !== 'boolean')) {
    throw new AssistantError(500, 'INTERNAL_ERROR', '生成记录无法读取。');
  }
  return (parsed as Record<string, unknown>[]).map((item) => ({
    messageId: String(item['messageId'] ?? ''),
    step: Number(item['step'] ?? 0),
    text: String(item['text'] ?? ''),
    validated: item['validated'] === true,
  }));
}

/** Validated text of a streamed provisional bubble, keyed by its announced id. */
interface PlannerPartial {
  readonly messageId: string;
  readonly text: string;
  readonly generationId: string;
}

function parsePartial(record: Record<string, unknown>): { messageId: string; text: string } | null {
  const messageId = record['messageId'];
  const text = record['text'];
  if (typeof messageId !== 'string' || messageId === '') return null;
  return { messageId, text: typeof text === 'string' ? text : '' };
}

/** Reads the single provisional bubble of a turn (a turn never produces more than one). */
function parsePartialSnapshot(planned: Record<string, unknown>, generationId: string): PlannerPartial | null {
  const partial = planned['partial'];
  if (!isRecord(partial)) return null;
  const parsed = parsePartial(partial);
  if (parsed === null) throw new AssistantStreamError('ASSISTANT_GENERATION_INVALID', '生成消息编号无效。');
  return { ...parsed, generationId };
}

function parseTransition(value: unknown): GenerationTransition {
  if (!isRecord(value)) throw new AssistantStreamError('ASSISTANT_GENERATION_INVALID', '生成终态无效。');
  const status = value['status'];
  if (status !== 'completed' && status !== 'failed' && status !== 'cancelled' && status !== 'interrupted') {
    throw new AssistantStreamError('ASSISTANT_GENERATION_INVALID', '生成终态无效。');
  }
  const outcome = value['outcome'];
  if (outcome !== null && outcome !== 'answer' && outcome !== 'awaiting-choice' && outcome !== 'pending-confirmation') {
    throw new AssistantStreamError('ASSISTANT_GENERATION_INVALID', '生成结果无效。');
  }
  const error = value['error'];
  if (error !== null && (!isRecord(error) || typeof error['code'] !== 'string' || typeof error['message'] !== 'string')) {
    throw new AssistantStreamError('ASSISTANT_GENERATION_INVALID', '生成错误无效。');
  }
  return {
    status,
    outcome,
    error:
      error === null || !isRecord(error)
        ? null
        : { code: error['code'] as string, message: error['message'] as string },
  };
}

/**
 * Turns a runner-supplied plan into the typed unit `persistTurn` accepts. The plan is a
 * structured clone over the sqlite worker boundary, so its plain arrays/objects are re-read
 * here — never cast through, or a boundary that drops a field would silently persist an
 * empty or partially-applied turn.
 */
function parsePlannedTurn(planned: unknown, conversationId: string, generationId: string): PlannedAssistantTurn {
  if (!isRecord(planned)) throw new AssistantStreamError('ASSISTANT_GENERATION_INVALID', '生成写入无效。');
  const rawMessages = planned['messages'];
  if (!Array.isArray(rawMessages)) throw new AssistantStreamError('ASSISTANT_GENERATION_INVALID', '生成消息无效。');
  const messages: PlannedAssistantMessage[] = rawMessages.map((item) => {
    if (!isRecord(item)) throw new AssistantStreamError('ASSISTANT_GENERATION_INVALID', '生成消息无效。');
    const id = item['id'];
    const role = item['role'];
    const kind = item['kind'];
    if (typeof id !== 'string' || id === '') throw new AssistantStreamError('ASSISTANT_GENERATION_INVALID', '生成消息编号无效。');
    if (role !== 'user' && role !== 'assistant') throw new AssistantStreamError('ASSISTANT_GENERATION_INVALID', '生成消息角色无效。');
    if (typeof kind !== 'string') throw new AssistantStreamError('ASSISTANT_GENERATION_INVALID', '生成消息类型无效。');
    const messageKind = kind as AssistantMessageKind;
    return {
      id,
      role: role as AssistantRole,
      kind: messageKind,
      content: normalizeAssistantContent(messageKind, item['content']),
    };
  });

  const questionRaw = planned['question'];
  let question: { id: string; clarification: unknown } | undefined;
  if (questionRaw !== undefined) {
    if (!isRecord(questionRaw) || typeof questionRaw['id'] !== 'string' || questionRaw['id'] === '') {
      throw new AssistantStreamError('ASSISTANT_GENERATION_INVALID', '追问记录无效。');
    }
    question = { id: questionRaw['id'], clarification: questionRaw['clarification'] };
  }

  const pendingRaw = planned['pendingActions'];
  let pendingActions: CreatePendingActionInput[] | undefined;
  if (pendingRaw !== undefined) {
    if (!Array.isArray(pendingRaw)) throw new AssistantStreamError('ASSISTANT_GENERATION_INVALID', '待确认操作无效。');
    pendingActions = pendingRaw.map((item) => {
      if (!isRecord(item)) throw new AssistantStreamError('ASSISTANT_GENERATION_INVALID', '待确认操作无效。');
      const id = item['id'];
      const sourceMessageId = item['sourceMessageId'];
      const toolName = item['toolName'];
      const fingerprint = item['fingerprint'];
      if (
        typeof id !== 'string' || id === '' ||
        typeof sourceMessageId !== 'string' || sourceMessageId === '' ||
        typeof toolName !== 'string' ||
        typeof fingerprint !== 'string' || fingerprint === ''
      ) {
        throw new AssistantStreamError('ASSISTANT_GENERATION_INVALID', '待确认操作无效。');
      }
      if (!isAssistantToolName(toolName)) {
        throw new AssistantStreamError('ASSISTANT_GENERATION_INVALID', '待确认操作工具无效。');
      }
      const attachment = item['attachment'];
      return {
        id,
        conversationId,
        sourceMessageId,
        toolName,
        arguments: assistantJsonObject(item['arguments'], '操作参数'),
        preview: assistantJsonObject(item['preview'], '操作预览'),
        fingerprint,
        ...(isRecord(attachment) ? { attachment: normalizeAssistantAttachment(attachment) } : {}),
      };
    });
  }

  const transitionRaw = planned['transition'];
  const partial = parsePartialSnapshot(planned, generationId);
  return {
    messages,
    ...(pendingActions === undefined ? {} : { pendingActions }),
    ...(question === undefined ? {} : { question }),
    ...(partial === null ? {} : { partial }),
    ...(transitionRaw === undefined ? {} : { transition: parseTransition(transitionRaw) }),
  };
}

/**
 * Bounds display text by code points, never inside a surrogate pair. `String.slice`
 * counts UTF-16 units, so a cut at an odd offset can emit half of an emoji that then
 * fails to re-encode and reaches the client as a replacement character.
 */
function boundedDisplayText(text: string, maxChars: number): string {
  const points = [...text];
  if (points.length <= maxChars) return text;
  return points.slice(0, maxChars).join('');
}

/** Stable canonical hash so an identical request replays and a changed one conflicts. */
export function canonicalRequestHash(conversationId: string, request: CreateGenerationRequest): string {
  const canonical = JSON.stringify({
    conversationId,
    version: request.version,
    clientRequestId: request.clientRequestId,
    input: inputCanonical(request.input),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function inputCanonical(input: AssistantGenerationInput): Record<string, unknown> {
  switch (input.type) {
    case 'text':
      return { type: 'text', text: input.text ?? '' };
    case 'choice':
      return {
        type: 'choice',
        sourceGenerationId: input.sourceGenerationId ?? '',
        questionId: input.questionId ?? '',
        optionId: input.optionId ?? '',
      };
    case 'choice-text':
      return {
        type: 'choice-text',
        sourceGenerationId: input.sourceGenerationId ?? '',
        questionId: input.questionId ?? '',
        text: input.text ?? '',
      };
    default:
      return { type: input.type };
  }
}

function requireText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new AssistantStreamError('ASSISTANT_GENERATION_INVALID', `${field} 必须是文本。`);
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > max) {
    throw new AssistantStreamError('ASSISTANT_GENERATION_INVALID', `${field} 长度无效。`);
  }
  return trimmed;
}

function requireOpaqueId(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new AssistantStreamError('ASSISTANT_GENERATION_INVALID', `${field} 无效。`);
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > 120) {
    throw new AssistantStreamError('ASSISTANT_GENERATION_INVALID', `${field} 无效。`);
  }
  return trimmed;
}

/**
 * Strict request validation: unknown fields are rejected instead of ignored, and the
 * client's label/arguments are never trusted (protocol-v1 §"Routes / requests").
 */
export function parseCreateGenerationRequest(body: unknown): CreateGenerationRequest {
  if (!isRecord(body)) throw new AssistantStreamError('ASSISTANT_GENERATION_INVALID', '请求体无效。');
  for (const key of Object.keys(body)) {
    if (key !== 'version' && key !== 'clientRequestId' && key !== 'input') {
      throw new AssistantStreamError('ASSISTANT_GENERATION_INVALID', '请求包含未知字段。');
    }
  }
  if (body['version'] !== 1) throw new AssistantStreamError('ASSISTANT_GENERATION_INVALID', '版本无效。');
  const clientRequestId = requireText(body['clientRequestId'], 'clientRequestId', MAX_CLIENT_REQUEST_ID);
  const rawInput = body['input'];
  if (!isRecord(rawInput)) throw new AssistantStreamError('ASSISTANT_GENERATION_INVALID', 'input 无效。');
  const type = rawInput['type'];
  if (type === 'text') {
    for (const key of Object.keys(rawInput)) {
      if (key !== 'type' && key !== 'text') throw new AssistantStreamError('ASSISTANT_GENERATION_INVALID', 'input 包含未知字段。');
    }
    const text = requireText(rawInput['text'], 'text', MAX_GENERATION_INPUT_TEXT);
    return { version: 1, clientRequestId, input: { type: 'text', text } };
  }
  if (type === 'choice') {
    for (const key of Object.keys(rawInput)) {
      if (key !== 'type' && key !== 'sourceGenerationId' && key !== 'questionId' && key !== 'optionId') {
        throw new AssistantStreamError('ASSISTANT_GENERATION_INVALID', 'input 包含未知字段。');
      }
    }
    return {
      version: 1,
      clientRequestId,
      input: {
        type: 'choice',
        sourceGenerationId: requireOpaqueId(rawInput['sourceGenerationId'], 'sourceGenerationId'),
        questionId: requireOpaqueId(rawInput['questionId'], 'questionId'),
        optionId: requireOpaqueId(rawInput['optionId'], 'optionId'),
      },
    };
  }
  if (type === 'choice-text') {
    for (const key of Object.keys(rawInput)) {
      if (key !== 'type' && key !== 'sourceGenerationId' && key !== 'questionId' && key !== 'text') {
        throw new AssistantStreamError('ASSISTANT_GENERATION_INVALID', 'input 包含未知字段。');
      }
    }
    return {
      version: 1,
      clientRequestId,
      input: {
        type: 'choice-text',
        sourceGenerationId: requireOpaqueId(rawInput['sourceGenerationId'], 'sourceGenerationId'),
        questionId: requireOpaqueId(rawInput['questionId'], 'questionId'),
        text: requireText(rawInput['text'], 'text', MAX_GENERATION_INPUT_TEXT),
      },
    };
  }
  throw new AssistantStreamError('ASSISTANT_GENERATION_INVALID', 'input.type 无效。');
}

/** Validates provider-declared clarification before it can become a card (delegates). */
export { normalizeProviderClarification } from './assistant-types.js';

export class AssistantGenerationService {
  private readonly db: Db;
  private readonly conversations: AssistantConversationService;
  private readonly now: () => number;
  private readonly withWriteLock: ConversationWriteLock;
  private readonly subscribers = new Map<string, Set<SubscriberState>>();
  /**
   * Terminal-event sequence reservations, per generation.
   *
   * A terminal frame is the frame a client must never see twice, never see out of order
   * and never see vanish. Its seq is therefore decided once and kept reserved: a
   * rollback leaves a gap rather than reusing an id, and no later non-terminal frame may
   * take the reserved slot. Only a committed terminal frame advances `last_seq`, so the
   * reservation never leaks into a replay bundle that could be pruned or rewritten.
   */
  private readonly terminalSeq = new Map<string, number>();

  constructor(
    db: Db,
    conversations: AssistantConversationService,
    now: () => number = () => Date.now(),
    options: AssistantGenerationServiceOptions = {},
  ) {
    this.db = db;
    this.conversations = conversations;
    this.now = now;
    this.withWriteLock = options.withConversationLock ?? ((operation) => conversations.withWriteLock(operation));
  }

  // ── Reads ───────────────────────────────────────────────────────────────────

  /** Latest 0/1 generation for a screen/process reconcile. Never starts model work. */
  latest(conversationId: string): AssistantGenerationSnapshot | null {
    this.conversations.get(conversationId);
    const row = this.db
      .prepare(
        `SELECT * FROM assistant_generations
          WHERE conversation_id = ?
          ORDER BY created_at DESC, rowid DESC
          LIMIT 1`,
      )
      .get(conversationId) as GenerationRow | undefined;
    return row === undefined ? null : this.snapshot(row);
  }

  get(conversationId: string, generationId: string): AssistantGenerationSnapshot {
    return this.snapshot(this.requireRow(conversationId, generationId));
  }

  listEvents(conversationId: string, generationId: string, afterSeq: number): AssistantStreamEvent[] {
    const row = this.requireRow(conversationId, generationId);
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || afterSeq > row.last_seq) {
      throw new AssistantStreamError('ASSISTANT_REPLAY_UNAVAILABLE', '无法从该位置恢复生成进度，请刷新会话快照。');
    }
    const rows = this.db
      .prepare(
        `SELECT seq, type, payload_json FROM assistant_generation_events
          WHERE generation_id = ? AND seq > ?
          ORDER BY seq`,
      )
      .all(row.id, afterSeq) as EventRow[];
    return rows.map((event) => parseJson(event.payload_json) as AssistantStreamEvent);
  }

  /** True when the conversation has a live (accepted/running) generation. */
  hasActive(conversationId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS x FROM assistant_generations
          WHERE conversation_id = ? AND status IN ('accepted', 'running')
          LIMIT 1`,
      )
      .get(conversationId) as { x: number } | undefined;
    return row !== undefined;
  }

  // ── Creation / choice ───────────────────────────────────────────────────────

  /**
   * Creates (or replays) a generation and resolves the user message it belongs to.
   * The whole decision runs in one transaction: replay, conflict, active-generation
   * exclusion and choice consumption cannot interleave with another request.
   */
  create(
    conversationId: string,
    request: CreateGenerationRequest,
    context: CreateGenerationContext,
  ): AssistantGenerationCreateResult {
    const requestHash = canonicalRequestHash(conversationId, request);
    const transaction = this.db.transaction((): AssistantGenerationCreateResult => {
      this.conversations.get(conversationId);
      const existing = this.db
        .prepare('SELECT * FROM assistant_generations WHERE conversation_id = ? AND client_request_id = ?')
        .get(conversationId, request.clientRequestId) as GenerationRow | undefined;
      if (existing !== undefined) {
        // Identical replay wins even when the source question has since gone stale.
        if (existing.request_hash !== requestHash) {
          throw new AssistantStreamError('ASSISTANT_REQUEST_CONFLICT', '相同请求编号已用于不同的内容。');
        }
        return { created: false, generation: this.snapshot(existing) };
      }

      const active = this.db
        .prepare("SELECT 1 AS x FROM assistant_generations WHERE conversation_id = ? AND status IN ('accepted', 'running')")
        .get(conversationId) as { x: number } | undefined;
      if (active !== undefined) {
        throw new AssistantStreamError('ASSISTANT_GENERATION_ACTIVE', '当前会话仍有进行中的生成，请先等待或停止。');
      }

      const source = this.resolveInput(conversationId, request.input);
      if (source.sourceGenerationId !== null) {
        // Consume the question on its *source* generation so a replay, a double tap or a
        // forged second option is rejected even with a fresh client request id.
        this.db
          .prepare(
            `UPDATE assistant_generations
                SET answered_at = ?, answered_option_id = ?
              WHERE id = ? AND answered_at IS NULL`,
          )
          .run(this.now(), source.optionId, source.sourceGenerationId);
      } else {
        // New ordinary input supersedes any live question in this conversation, so a
        // late option click is stale even though nothing answered it explicitly. This
        // must run inside the same transaction that materialises the replacement
        // generation, otherwise a crash could close a question without an answer.
        this.db
          .prepare(
            `UPDATE assistant_generations
                SET answered_at = ?
              WHERE conversation_id = ?
                AND status = 'completed'
                AND outcome = 'awaiting-choice'
                AND answered_at IS NULL`,
          )
          .run(this.now(), conversationId);
      }
      const text = source.text;
      const user = this.conversations.appendMessage({
        conversationId,
        role: 'user',
        kind: 'text',
        content: { version: 1, text },
      });

      const id = randomUUID();
      const at = this.now();
      // `answered_option_id`/`answered_at` describe whether *this* generation's own question
      // has been answered, so a fresh row always starts unanswered (both NULL). Copying the
      // consumed source answer here used to mark a brand-new generation answered before it
      // asked anything, which permanently blocked every second clarification hop with
      // ASSISTANT_CHOICE_STALE (the device-reported stuck account question). The consumed
      // answer is recorded on the source row by the UPDATE above; provenance for the new row
      // survives in `source_generation_id`, `question_id`/`question_json` and `input_json`.
      this.db
        .prepare(
          `INSERT INTO assistant_generations
             (id, conversation_id, client_request_id, request_hash, input_json, user_message_id,
              status, delivery, outcome, last_seq, message_ids_json, partials_json,
              source_generation_id, question_id, question_json, answered_option_id, answered_at,
              error_code, error_message, today, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'accepted', ?, NULL, 0, '[]', '[]', ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)`,
        )
        .run(
          id,
          conversationId,
          request.clientRequestId,
          requestHash,
          JSON.stringify(request.input),
          user.id,
          context.delivery,
          source.sourceGenerationId,
          source.questionId,
          source.questionJson,
          context.today,
          at,
          at,
        );
      // The decision is persisted before the state event so a reconnect can never
      // observe a generation without its first replayable frame.
      this.appendEventWithin(id, { type: 'state', status: 'accepted' });
      return { created: true, generation: this.snapshot(this.requireRow(conversationId, id)) };
    });
    const result = transaction();
    if (result.created) this.publish(conversationId, result.generation.id);
    return result;
  }

  private resolveInput(
    conversationId: string,
    input: AssistantGenerationInput,
  ): {
    text: string;
    sourceGenerationId: string | null;
    questionId: string | null;
    questionJson: string | null;
    optionId: string | null;
  } {
    if (input.type === 'text') {
      return {
        text: input.text ?? '',
        sourceGenerationId: null,
        questionId: null,
        questionJson: null,
        optionId: null,
      };
    }
    const sourceId = input.sourceGenerationId ?? '';
    const questionId = input.questionId ?? '';
    const source = this.db
      .prepare('SELECT * FROM assistant_generations WHERE id = ? AND conversation_id = ?')
      .get(sourceId, conversationId) as GenerationRow | undefined;
    if (source === undefined || source.status !== 'completed' || source.outcome !== 'awaiting-choice') {
      throw new AssistantStreamError('ASSISTANT_CHOICE_STALE', '该追问已失效，请刷新对话后重新提问。');
    }
    if (source.answered_at !== null) {
      throw new AssistantStreamError('ASSISTANT_CHOICE_STALE', '该追问已被回答。');
    }
    if (source.question_id !== questionId || source.question_json === null) {
      throw new AssistantStreamError('ASSISTANT_CHOICE_STALE', '追问编号不匹配。');
    }
    const question = parseJson(source.question_json);
    const clarification = findClarification(question);
    if (clarification === null || clarification.id !== questionId) {
      throw new AssistantStreamError('ASSISTANT_CHOICE_STALE', '追问内容无法读取。');
    }

    if (input.type === 'choice') {
      const optionId = input.optionId ?? '';
      const option = clarification.options.find((candidate) => candidate.id === optionId);
      if (option === undefined) throw new AssistantStreamError('ASSISTANT_CHOICE_STALE', '选项不属于该追问。');
      return {
        text: option.label,
        sourceGenerationId: sourceId,
        questionId,
        questionJson: source.question_json,
        optionId,
      };
    }
    // choice-text keeps the free-text answer as the user message while consuming the question.
    return {
      text: input.text ?? '',
      sourceGenerationId: sourceId,
      questionId,
      questionJson: source.question_json,
      optionId: null,
    };
  }

  // ── Event log ───────────────────────────────────────────────────────────────

  setStatus(conversationId: string, generationId: string, status: 'accepted' | 'running'): void {
    const row = this.requireRow(conversationId, generationId);
    if (TERMINAL_STATUSES.includes(row.status) || row.status === status) return;
    this.db
      .prepare('UPDATE assistant_generations SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, this.now(), generationId);
    this.appendEvent(conversationId, generationId, { type: 'state', status });
  }

  /** Persists the accumulated provisional text of one streamed step (bounded, byte-safe). */
  updatePartialText(
    conversationId: string,
    generationId: string,
    messageId: string,
    text: string,
  ): void {
    const row = this.requireRow(conversationId, generationId);
    if (TERMINAL_STATUSES.includes(row.status)) return;
    this.updatePartialTextWithin(generationId, messageId, text);
    this.db.prepare('UPDATE assistant_generations SET updated_at = ? WHERE id = ?').run(this.now(), generationId);
  }

  /** Bounded, byte-safe partial write inside a caller-owned transaction. */
  private updatePartialTextWithin(generationId: string, messageId: string, text: string): void {
    const row = this.requireRowById(generationId);
    if (TERMINAL_STATUSES.includes(row.status)) return;
    const bounded = boundedDisplayText(text, MAX_DISPLAY_CHARS_PER_TURN);
    const partials = this.partialMessages(row).map((item) =>
      item.messageId === messageId ? { ...item, text: bounded } : item,
    );
    this.db
      .prepare('UPDATE assistant_generations SET partials_json = ? WHERE id = ?')
      .run(JSON.stringify(partials), generationId);
  }

  /** Registers the stable message id for a streamed step and persists the event. */
  announcePartial(
    conversationId: string,
    generationId: string,
    partial: AssistantPartialSnapshot,
  ): void {
    const row = this.requireRow(conversationId, generationId);
    if (TERMINAL_STATUSES.includes(row.status)) return;
    if (partial.step < 0 || partial.step >= MAX_GENERATION_STEPS) {
      throw new AssistantStreamError('ASSISTANT_GENERATION_INVALID', '生成步骤超出上限。');
    }
    const existing = this.partialMessages(row).filter((item) => item.messageId !== partial.messageId);
    existing.push({ messageId: partial.messageId, step: partial.step, text: '', validated: false });
    this.db
      .prepare('UPDATE assistant_generations SET partials_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(existing), this.now(), generationId);
  }

  /** Persists one text-delta event; the runner has already coalesced the characters. */
  appendTextDelta(
    conversationId: string,
    generationId: string,
    delta: { readonly messageId: string; readonly step: number; readonly offset: number; readonly text: string },
  ): boolean {
    const row = this.requireRow(conversationId, generationId);
    if (TERMINAL_STATUSES.includes(row.status)) return false;
    this.appendEvent(conversationId, generationId, {
      type: 'text-delta',
      messageId: delta.messageId,
      step: delta.step,
      offset: delta.offset,
      text: delta.text,
    });
    return true;
  }

  /** Persists a validated message event (replaces the matching partial). */
  appendMessage(conversationId: string, generationId: string, message: AssistantMessageDto): void {
    const row = this.requireRow(conversationId, generationId);
    if (TERMINAL_STATUSES.includes(row.status)) return;
    const ids = this.messageIds(row);
    if (!ids.includes(message.id)) ids.push(message.id);
    const partials = this.partialMessages(row).filter((item) => item.messageId !== message.id);
    this.db
      .prepare('UPDATE assistant_generations SET message_ids_json = ?, partials_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(ids), JSON.stringify(partials), this.now(), generationId);
    this.appendEvent(conversationId, generationId, { type: 'message', message });
  }

  /**
   * Atomic finalization: terminal event + status/outcome/messageIds commit together.
   * Delegates to {@link persistTurn} so there is exactly one write path.
   */
  finalize(conversationId: string, generationId: string, transition: GenerationTransition): void {
    this.persistTurn(conversationId, generationId, { messages: [], transition });
  }

  /**
   * One uninterruptible unit that persists a validated turn: the assistant rows, the
   * awaiting-choice link, the validated provisional text, any prepared pending action and
   * the terminal transition.
   *
   * Why this exists: the previous shape inserted the message, published its `message`
   * event and finalized the generation as three separate steps. A Stop (or an archive)
   * in between either published a message the terminal frame then dropped, or left the
   * generation live while the answer was already in the conversation.
   *
   * Synchronous SQLite work is *not* the same as atomicity: `db.transaction()` cannot
   * prevent a run-loop turn between two statements, so publication (`publish`) is done by
   * the caller only after this unit committed, and the conversation lock keeps the read
   * fence ("is the generation still live and not archived?") and the write in one unit.
   */
  persistTurn(conversationId: string, generationId: string, plannedInput: PlannedAssistantTurn): void {
    // Re-read the plan at the trust boundary of the write path (see `parsePlannedTurn`).
    const planned = parsePlannedTurn(plannedInput, conversationId, generationId);
    const applied = this.withWriteLock(() =>
      this.db.transaction((): boolean => {
        const row = this.requireRow(conversationId, generationId);
        if (TERMINAL_STATUSES.includes(row.status)) return false;

        for (const pending of planned.pendingActions ?? []) {
          if (pending.conversationId !== conversationId) {
            throw new AssistantStreamError('ASSISTANT_GENERATION_INVALID', '生成操作与对话不匹配。');
          }
          this.conversations.createPendingAction(pending);
        }

        const committed = this.messageIds(row);
        const inserted: string[] = [];
        for (const message of planned.messages) {
          // Idempotent append: a message id the generation already owns (replay, crash
          // retry, duplicate entry in one plan) is never inserted or announced twice.
          if (committed.includes(message.id) || inserted.includes(message.id)) continue;
          const created = this.conversations.appendMessage({
            conversationId,
            id: message.id,
            role: message.role,
            kind: message.kind,
            content: message.content,
          });
          if (created.conversationId !== conversationId) {
            throw new AssistantStreamError('ASSISTANT_GENERATION_INVALID', '生成消息与对话不匹配。');
          }
          inserted.push(created.id);
          this.appendEventWithin(generationId, { type: 'message', message: created });
        }
        if (inserted.length > 0) {
          // The generation's message list commits in the same unit as its `message` events,
          // and the validated rows replace their provisional snapshots.
          const ids = [...committed, ...inserted];
          const partials = this.partialMessages(row).filter((item) => !ids.includes(item.messageId));
          this.db
            .prepare('UPDATE assistant_generations SET message_ids_json = ?, partials_json = ? WHERE id = ?')
            .run(JSON.stringify(ids), JSON.stringify(partials), generationId);
        }

        if (planned.partial !== undefined) {
          this.updatePartialTextWithin(generationId, planned.partial.messageId, planned.partial.text);
        }
        if (planned.question !== undefined) {
          // Stored as `{version, id, clarification}`: exactly the shape a later choice
          // request re-validates against (`findClarification`), so `question_id` and the
          // persisted message's clarification can never drift apart.
          const stored = {
            version: 1,
            id: planned.question.id,
            clarification: planned.question.clarification,
          };
          this.db
            .prepare('UPDATE assistant_generations SET question_id = ?, question_json = ? WHERE id = ?')
            .run(planned.question.id, JSON.stringify(stored), generationId);
        }

        const transition = planned.transition;
        if (transition === undefined) {
          // Intermediate write (assistant narration between tool steps): the rows and their
          // `message` events are committed and published, and the generation stays live.
          return true;
        }
        if (transition.status === 'completed' && transition.outcome === null) {
          throw new AssistantStreamError('ASSISTANT_GENERATION_INVALID', '完成状态必须携带 outcome。');
        }
        if (transition.status !== 'completed' && transition.outcome !== null) {
          throw new AssistantStreamError('ASSISTANT_GENERATION_INVALID', '非完成状态不能携带 outcome。');
        }
        // The request that wrote the terminal status last owns it: a slow `failed` can
        // never overwrite an explicit `cancelled`, and the terminal frame matches the row.
        const status = this.db
          .prepare(
            `UPDATE assistant_generations
                SET status = ?, outcome = ?, error_code = ?, error_message = ?, updated_at = ?
              WHERE id = ? AND status IN ('accepted', 'running')`,
          )
          .run(
            transition.status,
            transition.outcome,
            transition.error?.code ?? null,
            transition.error?.message ?? null,
            this.now(),
            generationId,
          );
        if (status.changes === 0) {
          const current = this.requireRow(conversationId, generationId);
          this.appendEventWithin(generationId, {
            type: 'terminal',
            status: current.status as 'completed' | 'failed' | 'cancelled' | 'interrupted',
            outcome: current.outcome,
            messageIds: this.messageIds(current),
            error:
              current.error_code === null
                ? null
                : { code: current.error_code, message: current.error_message ?? '本次生成未能完成。' },
          });
          return true;
        }
        this.appendEventWithin(generationId, {
          type: 'terminal',
          status: transition.status,
          outcome: transition.outcome,
          messageIds: [...committed, ...inserted],
          error: transition.error,
        });
        return true;
      })(),
    );
    // A rolled-back unit leaves the terminal seq reservation in place on purpose: the id
    // is never reused, and the replay bundle is unchanged because the seq was never
    // committed to `last_seq`.
    if (applied) {
      this.terminalSeq.delete(generationId);
      this.publish(conversationId, generationId);
    }
  }

  /**
   * Completes an awaiting-choice turn once the provider turn was validated: stores the
   * server-assigned question (used to validate a later choice) and finalizes atomically.
   */
  completeWithChoice(
    conversationId: string,
    generationId: string,
    question: { readonly id: string; readonly clarification: unknown },
    messages: readonly PlannedAssistantMessage[] = [],
  ): void {
    this.persistTurn(conversationId, generationId, {
      messages,
      question,
      transition: { status: 'completed', outcome: 'awaiting-choice', error: null },
    });
  }

  /** Explicit Stop. Idempotent and never undoes a committed result or confirmation. */
  cancel(conversationId: string, generationId: string): AssistantGenerationSnapshot {
    const before = this.requireRow(conversationId, generationId);
    if (!TERMINAL_STATUSES.includes(before.status)) {
      this.finalize(conversationId, generationId, {
        status: 'cancelled',
        outcome: null,
        error: { code: 'ASSISTANT_GENERATION_CANCELLED', message: '生成已被用户停止。' },
      });
    }
    return this.snapshot(this.requireRow(conversationId, generationId));
  }

  /** Archival fence: the conversation is gone, so no late card may be persisted. */
  cancelForArchive(conversationId: string): void {
    const rows = this.db
      .prepare("SELECT id FROM assistant_generations WHERE conversation_id = ? AND status IN ('accepted', 'running')")
      .all(conversationId) as { id: string }[];
    for (const row of rows) {
      this.finalize(conversationId, row.id, {
        status: 'interrupted',
        outcome: null,
        error: { code: 'ASSISTANT_GENERATION_INTERRUPTED', message: '对话已归档，生成已中断。' },
      });
    }
  }

  /** Boot recovery: unfinished work becomes interrupted and is never rerun. */
  recoverUnfinished(): number {
    const rows = this.db
      .prepare("SELECT id, conversation_id FROM assistant_generations WHERE status IN ('accepted', 'running')")
      .all() as { id: string; conversation_id: string }[];
    for (const row of rows) {
      this.finalize(row.conversation_id, row.id, {
        status: 'interrupted',
        outcome: null,
        error: { code: 'ASSISTANT_GENERATION_INTERRUPTED', message: '服务重启，生成已中断。' },
      });
    }
    return rows.length;
  }

  /** Shutdown: close every subscriber (running its queue/listener cleanup) and reset state. */
  closeAllSubscribers(): void {
    const all = [...this.subscribers.values()].flatMap((set) => [...set]);
    for (const state of all) state.close();
    this.subscribers.clear();
  }

  // ── Subscriptions ───────────────────────────────────────────────────────────

  /**
   * Registers a live subscriber positioned *after* `afterSeq`. The route replays
   * persisted events itself and de-duplicates by seq, so an event persisted between the
   * replay read and this call can never be lost or delivered twice.
   */
  subscribe(generationId: string, afterSeq: number): AssistantGenerationSubscriber {
    const set = this.subscribers.get(generationId) ?? new Set<SubscriberState>();
    this.subscribers.set(generationId, set);
    const state: SubscriberState = {
      queue: [],
      bytes: 0,
      closed: false,
      cursor: afterSeq,
      idle: null,
      peek: () => state.queue[0],
      shift: () => {
        const event = state.queue.shift();
        if (event !== undefined) state.bytes -= utf8Bytes(JSON.stringify(event));
        return event;
      },
      close: () => {
        const had = set.delete(state);
        state.closed = true;
        state.queue.length = 0;
        state.bytes = 0;
        if (set.size === 0) this.subscribers.delete(generationId);
        state.idle?.resolve();
        return had;
      },
    };
    set.add(state);
    return state;
  }

  /** Resolves when the subscriber queue becomes non-empty, is closed, or `timeoutMs` elapses. */
  waitForEvent(subscriber: AssistantGenerationSubscriber, timeoutMs: number): Promise<void> {
    if (subscriber.peek() !== undefined) return Promise.resolve();
    const state = subscriber as unknown as SubscriberState;
    if (state.closed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        state.idle = null;
        resolve();
      }, timeoutMs);
      state.idle = {
        resolve: () => {
          clearTimeout(timer);
          state.idle = null;
          resolve();
        },
      };
    });
  }

  /** Appends any persisted event newer than the subscriber cursor to its bounded queue. */
  private publish(conversationId: string, generationId: string): void {
    void conversationId;
    const set = this.subscribers.get(generationId);
    if (set === undefined || set.size === 0) return;
    for (const state of set) {
      if (state.closed) continue;
      const rows = this.db
        .prepare(
          `SELECT seq, payload_json FROM assistant_generation_events
            WHERE generation_id = ? AND seq > ?
            ORDER BY seq`,
        )
        .all(generationId, state.cursor) as { seq: number; payload_json: string }[];
      for (const row of rows) {
        state.queue.push(parseJson(row.payload_json) as AssistantStreamEvent);
        state.bytes += utf8Bytes(row.payload_json);
        state.cursor = row.seq;
        if (
          state.queue.length > SUBSCRIBER_QUEUE_MAX_EVENTS ||
          state.bytes > SUBSCRIBER_QUEUE_MAX_BYTES
        ) {
          // Slow subscriber: close it. The producer keeps persisting, so the client can
          // reconcile from its last seq (protocol-v1 §"Events").
          state.close();
          break;
        }
      }
      if (state.closed) continue;
      state.idle?.resolve();
    }
    if (set.size === 0) this.subscribers.delete(generationId);
  }

  setUpstreamCanceller(generationId: string, canceller: () => void): void {
    this.cancellers.set(generationId, canceller);
  }

  clearUpstreamCanceller(generationId: string): void {
    this.cancellers.delete(generationId);
  }

  /** Aborts in-flight upstream readers (explicit Stop, archival, shutdown). */
  abortUpstream(generationId: string): void {
    const canceller = this.cancellers.get(generationId);
    this.cancellers.delete(generationId);
    canceller?.();
  }

  abortAllUpstream(): void {
    for (const canceller of this.cancellers.values()) canceller();
    this.cancellers.clear();
  }

  private readonly cancellers = new Map<string, () => void>();

  // ── Internals ───────────────────────────────────────────────────────────────

  private requireRow(conversationId: string, generationId: string): GenerationRow {
    const row = this.db
      .prepare('SELECT * FROM assistant_generations WHERE id = ? AND conversation_id = ?')
      .get(generationId, conversationId) as GenerationRow | undefined;
    if (row === undefined) throw new AssistantStreamError('ASSISTANT_GENERATION_NOT_FOUND', '生成记录不存在。');
    return row;
  }

  private requireRowById(generationId: string): GenerationRow {
    const row = this.db
      .prepare('SELECT * FROM assistant_generations WHERE id = ?')
      .get(generationId) as GenerationRow | undefined;
    if (row === undefined) throw new AssistantStreamError('ASSISTANT_GENERATION_NOT_FOUND', '生成记录不存在。');
    return row;
  }

  private messageIds(row: GenerationRow): string[] {
    return stringArray(row.message_ids_json);
  }

  private partialMessages(row: GenerationRow): AssistantPartialSnapshot[] {
    return partialArray(row.partials_json);
  }

  private appendEvent(
    conversationId: string,
    generationId: string,
    event:
      | { readonly type: 'state'; readonly status: 'accepted' | 'running' }
      | { readonly type: 'text-delta'; readonly messageId: string; readonly step: number; readonly offset: number; readonly text: string }
      | { readonly type: 'message'; readonly message: AssistantMessageDto }
      | {
          readonly type: 'terminal';
          readonly status: 'completed' | 'failed' | 'cancelled' | 'interrupted';
          readonly outcome: AssistantOutcome | null;
          readonly messageIds: readonly string[];
          readonly error: { readonly code: string; readonly message: string } | null;
        },
  ): void {
    this.db.transaction(() => {
      this.appendEventWithin(generationId, event);
    })();
    this.publish(conversationId, generationId);
  }

  /**
   * Persists one event inside the caller's transaction and enforces replay bounds.
   *
   * Bounds are measured in UTF-8 bytes (`payload.length` is UTF-16 units and under-counts
   * CJK payloads by 3×, which is how a replay bundle could silently exceed 2 MiB) and a
   * terminal seq is reserved before the event is built so no concurrent non-terminal
   * write can consume the id the terminal frame was promised.
   */
  private appendEventWithin(
    generationId: string,
    event:
      | { readonly type: 'state'; readonly status: 'accepted' | 'running' }
      | { readonly type: 'text-delta'; readonly messageId: string; readonly step: number; readonly offset: number; readonly text: string }
      | { readonly type: 'message'; readonly message: AssistantMessageDto }
      | {
          readonly type: 'terminal';
          readonly status: 'completed' | 'failed' | 'cancelled' | 'interrupted';
          readonly outcome: AssistantOutcome | null;
          readonly messageIds: readonly string[];
          readonly error: { readonly code: string; readonly message: string } | null;
        },
  ): number {
    const row = this.db.prepare('SELECT last_seq FROM assistant_generations WHERE id = ?').get(generationId) as
      | { last_seq: number }
      | undefined;
    if (row === undefined) throw new AssistantStreamError('ASSISTANT_GENERATION_NOT_FOUND', '生成记录不存在。');
    const seq = event.type === 'terminal' ? this.reserveTerminalSeq(generationId, row.last_seq + 1) : row.last_seq + 1;
    if (seq > MAX_REPLAY_EVENTS - (event.type === 'terminal' ? 0 : 1)) {
      throw new AssistantStreamError('ASSISTANT_STREAM_BOUNDS', '本次生成事件过多，已停止。');
    }
    const envelope = { version: 1, generationId, seq, ...event };
    const payload = JSON.stringify(envelope);
    const payloadBytes = utf8Bytes(payload);
    const stored = this.db
      .prepare("SELECT COALESCE(SUM(length(CAST(payload_json AS BLOB))), 0) AS bytes FROM assistant_generation_events WHERE generation_id = ?")
      .get(generationId) as { bytes: number };
    // Always reserve room for the safe failure terminal, even if a producer hits a bound.
    const byteCeiling = MAX_REPLAY_BYTES - (event.type === 'terminal' ? 0 : 16 * 1024);
    if (stored.bytes + payloadBytes > byteCeiling) {
      throw new AssistantStreamError('ASSISTANT_STREAM_BOUNDS', '本次生成回放数据超出上限，已停止。');
    }
    this.db
      .prepare('INSERT INTO assistant_generation_events (generation_id, seq, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(generationId, seq, event.type, payload, this.now());
    this.db.prepare('UPDATE assistant_generations SET last_seq = ?, updated_at = ? WHERE id = ?').run(seq, this.now(), generationId);
    return seq;
  }

  /**
   * Reserves the seq promised to a terminal frame, as a monotonic floor.
   *
   * A rolled-back attempt keeps its reservation, so an id is never reused; a retry whose
   * plan has grown (e.g. an extra narration row) gets a *higher* seq rather than colliding
   * with a committed non-terminal event. Every committed event has `seq <= last_seq`, so a
   * terminal seq that is always `>= last_seq + 1` can never collide.
   */
  private reserveTerminalSeq(generationId: string, nextSeq: number): number {
    const reserved = Math.max(this.terminalSeq.get(generationId) ?? 0, nextSeq);
    this.terminalSeq.set(generationId, reserved);
    return reserved;
  }

  private snapshot(row: GenerationRow): AssistantGenerationSnapshot {
    return {
      version: 1,
      id: row.id,
      conversationId: row.conversation_id,
      userMessageId: row.user_message_id,
      userMessage: this.conversations.getMessage(row.user_message_id),
      status: row.status,
      delivery: row.delivery,
      lastSeq: row.last_seq,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      partialMessages: this.partialMessages(row),
      messageIds: this.messageIds(row),
      messages: this.messageIds(row).map((id) => this.safeMessage(id)),
      outcome: row.outcome,
      error:
        row.error_code === null
          ? null
          : { code: row.error_code, message: row.error_message ?? '本次生成未能完成。' },
    };
  }

  private safeMessage(id: string): AssistantMessageDto | null {
    try {
      return normalizeAssistantContentSafe(this.conversations.getMessage(id));
    } catch {
      return null;
    }
  }
}

function normalizeAssistantContentSafe(message: AssistantMessageDto): AssistantMessageDto {
  return { ...message, content: normalizeAssistantContent(message.kind, message.content) };
}
