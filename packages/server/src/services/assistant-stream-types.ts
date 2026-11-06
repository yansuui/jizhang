/**
 * Bounded contracts for the v1 generation stream (protocol-v1).
 *
 * This module owns the transport constants, the sanitized stream error type and the
 * snapshot/event DTO shapes. It deliberately contains no persistence and no network
 * code so that the tokenizer, the transport and the generation service can all depend
 * on one source of truth without a cycle.
 */
import type { AssistantError } from './assistant-types.js';

/** Shared version tag for every generation/event envelope. */
export const ASSISTANT_STREAM_VERSION = 1 as const;

/** Hard bounds from protocol-v1 §"Runtime/persistence". */
export const MAX_REPLAY_EVENTS = 2_048;
export const MAX_REPLAY_BYTES = 2 * 1024 * 1024;
export const MAX_DISPLAY_CHARS_PER_TURN = 4_000;
export const MAX_DISPLAY_CHARS_TOTAL = 12_000;
/** Eight bounded provider decisions permit multi-resource reads before a final answer/card.
 * Background jobs and duplicate reads hand off immediately rather than consuming this budget. */
export const MAX_GENERATION_STEPS = 8;
export const MAX_GENERATION_DEADLINE_MS = 180_000;
export const SUBSCRIBER_QUEUE_MAX_EVENTS = 128;
export const SUBSCRIBER_QUEUE_MAX_BYTES = 256 * 1024;
export const SSE_HEARTBEAT_MS = 15_000;
/** Provider envelope and message-string ceilings (protocol-v1 §"Provider"). */
export const MAX_PROVIDER_ENVELOPE_BYTES = 2 * 1024 * 1024;
export const MAX_PROVIDER_MESSAGE_CHARS = 4_000;
export const MAX_STREAM_TOTAL_BYTES = 2 * 1024 * 1024;
export const MAX_STREAM_LINE_BYTES = 64 * 1024;
export const MAX_STREAM_EVENT_BYTES = 128 * 1024;
export const MAX_CLIENT_REQUEST_ID = 120;
export const MAX_GENERATION_INPUT_TEXT = 2_000;
export const MAX_QUESTION_CHARS = 200;
export const MAX_OPTION_LABEL_CHARS = 100;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 6;

/**
 * Byte length of a string in UTF-8. Replay/event bounds are transport bounds, so they
 * must be measured in bytes, never in UTF-16 code units: JS `String.length` counts
 * Chinese characters as 1 while a single one occupies 3 bytes on the wire.
 */
export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

export type AssistantStreamStatus =
  | 'accepted'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export const ASSISTANT_STREAM_TERMINAL: readonly AssistantStreamStatus[] = [
  'completed',
  'failed',
  'cancelled',
  'interrupted',
];

export type AssistantDelivery = 'stream' | 'buffered';

export type AssistantOutcome = 'answer' | 'awaiting-choice' | 'pending-confirmation';

export type AssistantInputType = 'text' | 'choice' | 'choice-text';

export interface AssistantGenerationInput {
  readonly type: AssistantInputType;
  readonly text?: string;
  readonly sourceGenerationId?: string;
  readonly questionId?: string;
  readonly optionId?: string;
}

export interface AssistantStreamErrorInfo {
  readonly code: string;
  readonly message: string;
}

export interface AssistantClarificationOption {
  readonly id: string;
  readonly label: string;
}

export interface AssistantClarification {
  readonly id: string;
  readonly selection: 'single';
  readonly question: string;
  readonly options: readonly AssistantClarificationOption[];
  readonly allowFreeText: true;
}

/** Provider-declared turn extension; ids are assigned server-side. */
export interface AssistantProviderClarification {
  readonly question: string;
  readonly options: readonly string[];
}

export interface AssistantPartialSnapshot {
  readonly messageId: string;
  readonly step: number;
  readonly text: string;
  readonly validated: boolean;
}

export interface AssistantGenerationSnapshot {
  readonly version: typeof ASSISTANT_STREAM_VERSION;
  readonly id: string;
  readonly conversationId: string;
  readonly userMessageId: string;
  readonly userMessage: unknown;
  readonly status: AssistantStreamStatus;
  readonly delivery: AssistantDelivery;
  readonly lastSeq: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly partialMessages: readonly AssistantPartialSnapshot[];
  readonly messageIds: readonly string[];
  readonly messages: readonly unknown[];
  readonly outcome: AssistantOutcome | null;
  readonly error: AssistantStreamErrorInfo | null;
}

export interface AssistantGenerationCreateResult {
  readonly created: boolean;
  readonly generation: AssistantGenerationSnapshot;
}

export type AssistantStreamEventType = 'state' | 'text-delta' | 'message' | 'terminal';

export interface AssistantStateEvent {
  readonly version: typeof ASSISTANT_STREAM_VERSION;
  readonly generationId: string;
  readonly seq: number;
  readonly type: 'state';
  readonly status: 'accepted' | 'running';
}

export interface AssistantTextDeltaEvent {
  readonly version: typeof ASSISTANT_STREAM_VERSION;
  readonly generationId: string;
  readonly seq: number;
  readonly type: 'text-delta';
  readonly messageId: string;
  readonly step: number;
  readonly offset: number;
  readonly text: string;
}

export interface AssistantMessageEvent {
  readonly version: typeof ASSISTANT_STREAM_VERSION;
  readonly generationId: string;
  readonly seq: number;
  readonly type: 'message';
  readonly message: unknown;
}

export interface AssistantTerminalEvent {
  readonly version: typeof ASSISTANT_STREAM_VERSION;
  readonly generationId: string;
  readonly seq: number;
  readonly type: 'terminal';
  readonly status: 'completed' | 'failed' | 'cancelled' | 'interrupted';
  readonly outcome: AssistantOutcome | null;
  readonly messageIds: readonly string[];
  readonly error: AssistantStreamErrorInfo | null;
}

export type AssistantStreamEvent =
  | AssistantStateEvent
  | AssistantTextDeltaEvent
  | AssistantMessageEvent
  | AssistantTerminalEvent;

/** Stable snapshot/stream error codes. Codes are part of the client contract. */
export type AssistantStreamErrorCode =
  | 'ASSISTANT_GENERATION_INVALID'
  | 'ASSISTANT_REQUEST_CONFLICT'
  | 'ASSISTANT_GENERATION_ACTIVE'
  | 'ASSISTANT_CHOICE_STALE'
  | 'ASSISTANT_REPLAY_UNAVAILABLE'
  | 'ASSISTANT_STREAM_BOUNDS'
  | 'ASSISTANT_GENERATION_NOT_FOUND';

const STATUS_BY_CODE: Readonly<Record<AssistantStreamErrorCode, number>> = {
  ASSISTANT_GENERATION_INVALID: 400,
  ASSISTANT_REQUEST_CONFLICT: 409,
  ASSISTANT_GENERATION_ACTIVE: 409,
  ASSISTANT_CHOICE_STALE: 409,
  ASSISTANT_REPLAY_UNAVAILABLE: 409,
  ASSISTANT_STREAM_BOUNDS: 502,
  ASSISTANT_GENERATION_NOT_FOUND: 404,
};

/**
 * Bounded stream error. Its `message` is always a fixed, safe sentence — provider
 * bodies, prompts and credentials can never reach a client through this path.
 */
export class AssistantStreamError extends Error {
  readonly statusCode: number;
  readonly code: AssistantStreamErrorCode;

  constructor(code: AssistantStreamErrorCode, message: string) {
    super(message);
    this.name = 'AssistantStreamError';
    this.statusCode = STATUS_BY_CODE[code];
    this.code = code;
  }
}

/** Maps a thrown value to a bounded, safe stream error without leaking internals. */
export function toStreamError(error: unknown): AssistantStreamError {
  if (error instanceof AssistantStreamError) return error;
  const candidate = error as { code?: unknown; statusCode?: unknown } | null;
  const code = typeof candidate?.code === 'string' ? candidate.code : '';
  switch (code) {
    case 'AI_PROVIDER_TIMEOUT':
      return new AssistantStreamError('ASSISTANT_STREAM_BOUNDS', 'AI 响应超时，本次生成已中断。');
    case 'AI_PROVIDER_ERROR':
      return new AssistantStreamError('ASSISTANT_STREAM_BOUNDS', '暂时无法连接 AI 服务，本次生成已中断。');
    case 'AI_NOT_CONFIGURED':
    case 'AI_SECRET_UNAVAILABLE':
    case 'AI_ENCRYPTION_KEY_REQUIRED':
      return new AssistantStreamError('ASSISTANT_STREAM_BOUNDS', 'AI 服务当前不可用，本次生成已中断。');
    case 'AI_RESPONSE_INVALID':
      return new AssistantStreamError('ASSISTANT_STREAM_BOUNDS', 'AI 返回内容无法识别，本次生成未产生结果。');
    default:
      return new AssistantStreamError('ASSISTANT_STREAM_BOUNDS', '本次生成未能完成，请稍后重试。');
  }
}

/** True for the assistant/AI typed errors whose safe message we may surface. */
export function streamErrorMessage(error: unknown): string {
  const candidate = error as Partial<AssistantError> | null;
  if (candidate instanceof Error && typeof candidate.message === 'string' && candidate.message !== '') {
    return candidate.message.slice(0, 200);
  }
  return '本次生成未能完成，请稍后重试。';
}
