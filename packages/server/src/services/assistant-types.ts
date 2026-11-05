/** Typed, bounded contracts for the conversational assistant. */

export const ASSISTANT_VERSION = 1 as const;

export type AssistantRole = 'user' | 'assistant' | 'tool';
export type AssistantMessageKind =
  | 'text'
  | 'progress'
  | 'tool-card'
  | 'result'
  | 'error'
  | 'attachment';
export type AssistantActionStatus = 'pending' | 'confirmed' | 'cancelled' | 'expired';

/**
 * Names are deliberately boring and explicit. The provider can only select a name in this
 * union, and the registry still validates the parsed arguments before a service is called.
 */
/**
 * Single source of truth for the tool allowlist. The registry must register every
 * name here; callers must never silently drop or rename entries.
 */
export const ASSISTANT_TOOL_NAMES = [
  'transactions.recent',
  'accounts.balances',
  'budget.overview',
  'stats.monthly',
  'recurring.pending',
  'monthly.evaluate',
  'organization.preview',
  'backups.list',
  'backup.export-links',
  'transaction.create',
  'transaction.update',
  'transaction.delete',
  'transaction.restore',
  'transfer.create',
  'category.create',
  'category.update',
  'category.delete',
  'account.create',
  'account.update',
  'account.delete',
  'backup.create',
  'platform-import.prepare',
  'organization.apply',
  'organization.undo',
  'recurring.confirm',
  'recurring.ignore',
  'tag.rename',
  'tag.delete',
  'transactions.query', 'transaction.details', 'transactions.daily', 'master-data.read', 'master-data.move',
  'tag.create', 'tag.update', 'tag.remove', 'transfers.query', 'transfer.update', 'transfer.delete',
  'trash.list', 'trash.restore-all', 'trash.purge', 'trash.purge-all',
  'recurring.rules', 'recurring.create', 'recurring.update', 'recurring.toggle', 'recurring.delete', 'recurring.generate',
  'funds.read', 'funds.configure', 'funds.review', 'salaries.read', 'salary.create', 'salary.update', 'salary.delete',
  'plan.read', 'plan.preview', 'plan.save', 'goals.read', 'goals.opening', 'goals.create', 'goals.update', 'goals.delete',
  'items.read', 'item.create', 'item.update', 'item.sell', 'item.retire', 'item.delete',
    // Template tools were removed with the allocation-template surface (migration 022 folds
// template names into tags). The names are dropped here rather than kept as dead entries,
// because `catalog()` throws for an allowlisted name with no registered tool.
  'settings.read', 'settings.cycle',
  'stats.query', 'planning.read', 'planning.configure', 'planning.mapping', 'planning.preview', 'planning.confirm',
  'planning.reconcile', 'planning.purpose', 'planning.refund-splits',
  'spending.preview', 'spending.card', 'spending.status', 'spending.evidence', 'spending.resume', 'spending.apply', 'spending.undo',
] as const;

export type AssistantToolName = (typeof ASSISTANT_TOOL_NAMES)[number];

const ASSISTANT_TOOL_NAME_SET: ReadonlySet<string> = new Set(ASSISTANT_TOOL_NAMES);

export function isAssistantToolName(value: string): value is AssistantToolName {
  return ASSISTANT_TOOL_NAME_SET.has(value);
}

export function requireAssistantToolName(value: unknown, field: string): AssistantToolName {
  if (typeof value !== 'string' || !isAssistantToolName(value)) {
    throw new AssistantValidationError(`${field} 不是允许的助手工具名。`);
  }
  return value;
}

export type AssistantJsonPrimitive = string | number | boolean | null;
export type AssistantJsonValue =
  | AssistantJsonPrimitive
  | readonly AssistantJsonValue[]
  | { readonly [key: string]: AssistantJsonValue };
export type AssistantJsonObject = { readonly [key: string]: AssistantJsonValue };

export interface AssistantAttachmentMetadata {
  readonly source: 'auto' | 'wechat' | 'alipay';
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface AssistantProgress {
  readonly state: 'running' | 'complete' | 'failed';
  readonly toolName?: AssistantToolName;
}

export interface AssistantConfirmationCard {
  readonly version: typeof ASSISTANT_VERSION;
  readonly actionId: string;
  readonly toolName: AssistantToolName;
  readonly operation: string;
  readonly summary: string;
  readonly writes: true;
  readonly affected: {
    readonly count: number;
    readonly ids?: readonly string[];
  };
  readonly values: AssistantJsonObject;
  readonly warnings: readonly string[];
  readonly fingerprint: string;
  readonly status: AssistantActionStatus;
  readonly preview: AssistantJsonObject;
  readonly attachment?: AssistantAttachmentMetadata;
}

export interface AssistantResultCard {
  readonly version: typeof ASSISTANT_VERSION;
  readonly toolName: AssistantToolName;
  readonly summary: string;
  readonly data: AssistantJsonObject;
}

export interface AssistantMessageContent {
  readonly version: typeof ASSISTANT_VERSION;
  readonly text?: string;
  /**
   * Additive merged-import batch metadata on a `kind='text'` message.
   *
   * Deliberately *not* a tool card: it carries no rows, no review token and no write claim, so
   * the strict `tool-card` contract (which requires `card`) is not relaxed. The client always
   * reads live batch state from the dedicated batch endpoint.
   */
  readonly importBatch?: AssistantJsonObject;
  readonly attachment?: AssistantAttachmentMetadata;
  readonly progress?: AssistantProgress;
  readonly card?: AssistantConfirmationCard;
  readonly result?: AssistantResultCard;
  readonly error?: { readonly code: string; readonly message: string };
  /** Owning streamed generation; additive so legacy history stays readable. */
  readonly generationId?: string;
  /** Server-owned single-select clarification attached to a validated text message. */
  readonly clarification?: AssistantClarificationContent;
}

export interface AssistantClarificationOptionDto {
  readonly id: string;
  readonly label: string;
}

export interface AssistantClarificationContent {
  readonly id: string;
  readonly selection: 'single';
  readonly question: string;
  readonly options: readonly AssistantClarificationOptionDto[];
  readonly allowFreeText: true;
}

export interface AssistantConversationDto {
  readonly id: string;
  readonly title: string;
  readonly archived: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface AssistantMessageDto {
  readonly id: string;
  readonly conversationId: string;
  readonly role: AssistantRole;
  readonly kind: AssistantMessageKind;
  readonly content: AssistantMessageContent;
  readonly createdAt: number;
}

export interface AssistantPendingActionDto {
  readonly id: string;
  readonly conversationId: string;
  readonly sourceMessageId: string;
  readonly toolName: AssistantToolName;
  readonly arguments: AssistantJsonObject;
  readonly preview: AssistantJsonObject;
  readonly fingerprint: string;
  readonly attachment: AssistantAttachmentMetadata | null;
  readonly status: AssistantActionStatus;
  readonly result: AssistantJsonObject | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface AssistantProviderToolCall {
  readonly name: string;
  readonly arguments: AssistantJsonObject;
}

/** Provider-declared clarification; server assigns public ids after validation. */
export interface AssistantProviderClarification {
  readonly question: string;
  readonly options: readonly string[];
}

const MAX_CLARIFICATION_QUESTION_CHARS = 200;
const MAX_CLARIFICATION_LABEL_CHARS = 100;

/**
 * Validates a provider-declared clarification (2–6 unique, non-blank, bounded labels).
 * Anything else fails the turn, because a half-valid question must never become a card.
 */
export function normalizeProviderClarification(value: unknown): AssistantProviderClarification {
  if (!isRecord(value)) throw new AssistantProviderTurnError();
  for (const key of Object.keys(value)) {
    if (key !== 'question' && key !== 'options') throw new AssistantProviderTurnError();
  }
  const question = typeof value['question'] === 'string' ? value['question'].trim() : '';
  if (question === '' || question.length > MAX_CLARIFICATION_QUESTION_CHARS) {
    throw new AssistantProviderTurnError();
  }
  const rawOptions = value['options'];
  if (!Array.isArray(rawOptions) || rawOptions.length < 2 || rawOptions.length > 6) {
    throw new AssistantProviderTurnError();
  }
  const options: string[] = [];
  const seen = new Set<string>();
  for (const option of rawOptions) {
    if (typeof option !== 'string') throw new AssistantProviderTurnError();
    const label = option.trim();
    if (label === '' || label.length > MAX_CLARIFICATION_LABEL_CHARS || seen.has(label)) {
      throw new AssistantProviderTurnError();
    }
    seen.add(label);
    options.push(label);
  }
  return { question, options };
}

export interface AssistantProviderTurn {
  readonly message: string;
  readonly toolCall: AssistantProviderToolCall | null;
  /** Optional clarification; never coexists with a non-null toolCall. */
  readonly clarification: AssistantProviderClarification | null;
}

export interface AssistantContextMessage {
  readonly role: AssistantRole;
  readonly kind: AssistantMessageKind;
  readonly text: string;
  readonly data?: AssistantJsonObject;
}

export class AssistantError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'AssistantError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class AssistantValidationError extends AssistantError {
  constructor(message: string) {
    super(400, 'ASSISTANT_INVALID', message);
    this.name = 'AssistantValidationError';
  }
}

export class AssistantNotFoundError extends AssistantError {
  constructor(message = '对话或助手操作不存在。') {
    super(404, 'ASSISTANT_NOT_FOUND', message);
    this.name = 'AssistantNotFoundError';
  }
}

export class AssistantActionStaleError extends AssistantError {
  constructor(message = '助手预览已过期，请重新生成预览后再确认。') {
    super(409, 'ASSISTANT_ACTION_STALE', message);
    this.name = 'AssistantActionStaleError';
  }
}

export class AssistantAttachmentRequiredError extends AssistantError {
  constructor() {
    super(409, 'ASSISTANT_ATTACHMENT_REQUIRED', '文件预览已过期，请重新附加原文件。');
    this.name = 'AssistantAttachmentRequiredError';
  }
}

export class AssistantProviderTurnError extends AssistantError {
  constructor() {
    super(502, 'AI_RESPONSE_INVALID', 'AI 返回内容无法解析为有效的助手回复。');
    this.name = 'AssistantProviderTurnError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const FORBIDDEN_KEYS = /(?:base64|cookie|credential|password|prompt|providerbody|secret|token)/i;
// These SHA-256 optimistic-concurrency facts are not credentials. Business tools
// must round-trip them without weakening the provider/session secret boundary.
const BUSINESS_HASH_KEYS = new Set(['previewToken', 'topologyToken', 'expectedTopologyToken', 'sourceToken', 'expectedSourceToken', 'transactionToken', 'expectedTransactionToken', 'refundToken', 'expectedRefundToken']);
/*
 * Every string that enters a bounded assistant JSON value is truncated to this many UTF-16
 * units. The truncation must never cut a surrogate pair (`boundedProviderMessage`), because a
 * persisted lone surrogate is escaped by JSON without error and renders as `�` on the client.
 */
const MAX_STRING_LENGTH = 4_000;
const MAX_ARRAY_LENGTH = 200;
const MAX_OBJECT_KEYS = 100;
const MAX_DEPTH = 8;

/**
 * Converts a provider/domain projection into a bounded JSON value safe for SQLite. Raw file
 * bytes, provider prompts and credentials are refused instead of being accidentally copied
 * into a conversation card.
 */
export function normalizeAssistantJson(value: unknown, path = '$', depth = 0): AssistantJsonValue {
  if (depth > MAX_DEPTH) throw new AssistantValidationError('助手结果层级过深。');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    // Decimals (category ratios, template weights, AI confidence) must survive.
    // Only non-finite values and integers outside the IEEE safe range are rejected.
    if (!Number.isFinite(value)) {
      throw new AssistantValidationError(`助手结果包含无效数字：${path}。`);
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new AssistantValidationError(`助手结果包含超出安全范围的整数：${path}。`);
    }
    return value;
  }
  if (typeof value === 'string') return boundedProviderMessage(value, MAX_STRING_LENGTH);
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_LENGTH)
      .map((item, index) => normalizeAssistantJson(item, `${path}[${index}]`, depth + 1));
  }
  if (!isRecord(value)) throw new AssistantValidationError(`助手结果包含无效值：${path}。`);
  const entries = Object.entries(value);
  if (entries.length > MAX_OBJECT_KEYS) throw new AssistantValidationError('助手结果字段过多。');
  const output: Record<string, AssistantJsonValue> = {};
  for (const [key, item] of entries) {
    if (item === undefined) continue;
    if (FORBIDDEN_KEYS.test(key) && !(BUSINESS_HASH_KEYS.has(key) && typeof item === 'string' && /^[a-f0-9]{64}$/i.test(item))) throw new AssistantValidationError('助手结果包含受保护字段。');
    output[key.slice(0, 80)] = normalizeAssistantJson(item, `${path}.${key}`, depth + 1);
  }
  return output;
}

function stringValue(value: unknown, field: string, maxLength = MAX_STRING_LENGTH): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new AssistantValidationError(`${field} 必须是非空文本。`);
  }
  return value.trim().slice(0, maxLength);
}

function optionalString(value: unknown, maxLength = MAX_STRING_LENGTH): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, maxLength) : undefined;
}

function attachment(value: unknown): AssistantAttachmentMetadata {
  if (!isRecord(value)) throw new AssistantValidationError('附件信息无效。');
  const source = value['source'];
  if (source !== 'auto' && source !== 'wechat' && source !== 'alipay') {
    throw new AssistantValidationError('附件来源无效。');
  }
  const fileName = stringValue(value['fileName'], '附件名称', 200);
  const sizeBytes = value['sizeBytes'];
  const sha256 = stringValue(value['sha256'], '附件摘要', 64);
  if (!Number.isSafeInteger(sizeBytes) || (sizeBytes as number) < 0 || !/^[a-f0-9]{64}$/i.test(sha256)) {
    throw new AssistantValidationError('附件大小或摘要无效。');
  }
  return { source, fileName, sizeBytes: sizeBytes as number, sha256: sha256.toLowerCase() };
}

/** Public reader for an attachment that crosses the generation planner boundary. */
export function normalizeAssistantAttachment(value: unknown): AssistantAttachmentMetadata {
  return attachment(value);
}

function jsonObject(value: unknown, field: string): AssistantJsonObject {
  if (!isRecord(value)) throw new AssistantValidationError(`${field} 必须是对象。`);
  const normalized = normalizeAssistantJson(value, field);
  if (!isRecord(normalized)) throw new AssistantValidationError(`${field} 必须是对象。`);
  return normalized as AssistantJsonObject;
}

function card(value: unknown): AssistantConfirmationCard {
  const record = jsonObject(value, 'card') as Record<string, unknown>;
  if (record['version'] !== ASSISTANT_VERSION || record['writes'] !== true) {
    throw new AssistantValidationError('助手确认卡版本或写入标记无效。');
  }
  const toolNameValue = stringValue(record['toolName'], '确认卡工具名');
  if (!isAssistantToolName(toolNameValue)) throw new AssistantValidationError('确认卡工具名无效。');
  const toolName = toolNameValue;
  const status = record['status'];
  if (!['pending', 'confirmed', 'cancelled', 'expired'].includes(String(status))) {
    throw new AssistantValidationError('确认卡状态无效。');
  }
  const affected = jsonObject(record['affected'], 'affected');
  if (!Number.isSafeInteger(affected['count']) || (affected['count'] as number) < 0) {
    throw new AssistantValidationError('确认卡影响数量无效。');
  }
  const warnings = record['warnings'];
  if (!Array.isArray(warnings)) throw new AssistantValidationError('确认卡警告无效。');
  return {
    version: ASSISTANT_VERSION,
    actionId: stringValue(record['actionId'], '确认卡操作编号', 80),
    toolName,
    operation: stringValue(record['operation'], '确认卡操作', 200),
    summary: stringValue(record['summary'], '确认卡摘要', 1_000),
    writes: true,
    affected: {
      count: affected['count'] as number,
      ...(Array.isArray(affected['ids']) ? { ids: affected['ids'].filter((id): id is string => typeof id === 'string').slice(0, 100) } : {}),
    },
    values: jsonObject(record['values'], 'values'),
    warnings: warnings.filter((item): item is string => typeof item === 'string').slice(0, 20),
    fingerprint: stringValue(record['fingerprint'], '确认卡指纹', 128),
    status: status as AssistantActionStatus,
    preview: jsonObject(record['preview'], 'preview'),
    ...(record['attachment'] === undefined ? {} : { attachment: attachment(record['attachment']) }),
  };
}

function resultCard(value: unknown): AssistantResultCard {
  const record = jsonObject(value, 'result') as Record<string, unknown>;
  if (record['version'] !== ASSISTANT_VERSION) throw new AssistantValidationError('助手结果版本无效。');
  return {
    version: ASSISTANT_VERSION,
    toolName: requireAssistantToolName(record['toolName'], '结果工具名'),
    summary: stringValue(record['summary'], '结果摘要', 1_000),
    data: jsonObject(record['data'], 'result.data'),
  };
}

function errorMessage(value: unknown): { readonly code: string; readonly message: string } {
  if (!isRecord(value)) throw new AssistantValidationError('错误信息无效。');
  return {
    code: stringValue(value['code'], '错误代码', 100),
    message: stringValue(value['message'], '错误信息', 1_000),
  };
}

const MAX_CLARIFICATION_OPTIONS = 6;
const MIN_CLARIFICATION_OPTIONS = 2;

/**
 * Defensive reader for a persisted clarification. A card that cannot be re-read exactly
 * (bad option count, duplicate ids, empty labels) is rejected rather than half-rendered.
 */
export function normalizeClarificationContent(value: unknown): AssistantClarificationContent {
  if (!isRecord(value)) throw new AssistantValidationError('追问内容无效。');
  if (value['selection'] !== 'single' || value['allowFreeText'] !== true) {
    throw new AssistantValidationError('追问选择方式无效。');
  }
  const id = stringValue(value['id'], '追问编号', 80);
  const question = stringValue(value['question'], '追问问题', 200);
  const rawOptions = value['options'];
  if (
    !Array.isArray(rawOptions) ||
    rawOptions.length < MIN_CLARIFICATION_OPTIONS ||
    rawOptions.length > MAX_CLARIFICATION_OPTIONS
  ) {
    throw new AssistantValidationError('追问选项数量必须为 2–6 个。');
  }
  const options: AssistantClarificationOptionDto[] = [];
  const ids = new Set<string>();
  for (const option of rawOptions) {
    if (!isRecord(option)) throw new AssistantValidationError('追问选项无效。');
    const optionId = stringValue(option['id'], '选项编号', 80);
    if (ids.has(optionId)) throw new AssistantValidationError('追问选项编号重复。');
    ids.add(optionId);
    options.push({ id: optionId, label: stringValue(option['label'], '选项文本', 100) });
  }
  return { id, selection: 'single', question, options, allowFreeText: true };
}

/** Reads the clarification out of a validated assistant message, or `null`. */
export function findClarification(value: unknown): AssistantClarificationContent | null {
  if (!isRecord(value)) return null;
  const content = value['content'];
  const candidate = isRecord(content) ? content['clarification'] : value['clarification'];
  if (candidate === undefined || candidate === null) return null;
  try {
    return normalizeClarificationContent(candidate);
  } catch {
    return null;
  }
}

/** Defensive reader for persisted message content. Unknown versions never get cast through. */
export function normalizeAssistantContent(
  kind: AssistantMessageKind,
  value: unknown,
): AssistantMessageContent {
  const record = jsonObject(value, 'message.content') as Record<string, unknown>;
  if (record['version'] !== ASSISTANT_VERSION) throw new AssistantValidationError('助手消息版本无效。');
  const text = optionalString(record['text']);
  const generationId = optionalString(record['generationId'], 80);
  const importBatch =
    record['importBatch'] === undefined ? undefined : jsonObject(record['importBatch'], 'message.importBatch');
  const normalized: AssistantMessageContent = {
    version: ASSISTANT_VERSION,
    ...(text === undefined ? {} : { text }),
    ...(importBatch === undefined ? {} : { importBatch }),
    ...(generationId === undefined ? {} : { generationId }),
    ...(record['attachment'] === undefined ? {} : { attachment: attachment(record['attachment']) }),
    ...(record['progress'] === undefined ? {} : { progress: progress(record['progress']) }),
    ...(record['card'] === undefined ? {} : { card: card(record['card']) }),
    ...(record['result'] === undefined ? {} : { result: resultCard(record['result']) }),
    ...(record['error'] === undefined ? {} : { error: errorMessage(record['error']) }),
    ...(record['clarification'] === undefined
      ? {}
      : { clarification: normalizeClarificationContent(record['clarification']) }),
  };
  const hasPayload =
    normalized.text !== undefined ||
    normalized.importBatch !== undefined ||
    normalized.attachment !== undefined ||
    normalized.progress !== undefined ||
    normalized.card !== undefined ||
    normalized.result !== undefined ||
    normalized.error !== undefined ||
    normalized.clarification !== undefined;
  if (!hasPayload) throw new AssistantValidationError('助手消息内容不能为空。');
  if (kind === 'tool-card' && normalized.card === undefined) throw new AssistantValidationError('工具卡消息缺少确认卡。');
  if (kind === 'error' && normalized.error === undefined) throw new AssistantValidationError('错误消息缺少错误内容。');
  if (kind === 'attachment' && normalized.attachment === undefined) throw new AssistantValidationError('附件消息缺少附件信息。');
  return normalized;
}

function progress(value: unknown): AssistantProgress {
  const record = jsonObject(value, 'progress');
  const state = record['state'];
  if (state !== 'running' && state !== 'complete' && state !== 'failed') {
    throw new AssistantValidationError('助手进度状态无效。');
  }
  const toolName = record['toolName'];
  return {
    state,
    ...(toolName === undefined ? {} : { toolName: requireAssistantToolName(toolName, '助手进度工具名') }),
  };
}

/*
 * The provider turn's message bound is a UTF-16 unit budget, but it must never cut a
 * surrogate pair: a buffered provider message is arbitrary text, and `String.slice` at an
 * odd offset persists half an emoji (the client renders a replacement character).
 */
const MAX_PROVIDER_MESSAGE_UNITS = 4_000;

/**
 * First `maxUnits` UTF-16 units of `text`, never cutting a surrogate pair in half.
 * Mirrors the streamed path's `takeUtf16Units` in `assistant-generation-runner.ts`.
 */
function boundedProviderMessage(text: string, maxUnits: number): string {
  if (text.length <= maxUnits) return text;
  let end = maxUnits;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

export function normalizeAssistantProviderTurn(value: unknown): AssistantProviderTurn {
  const record = jsonObject(value, 'provider.turn') as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => key !== 'message' && key !== 'toolCall' && key !== 'clarification')) {
    throw new AssistantProviderTurnError();
  }
  const message =
    typeof record['message'] === 'string'
      ? boundedProviderMessage(record['message'].trim(), MAX_PROVIDER_MESSAGE_UNITS)
      : '';
  if (message === '') throw new AssistantProviderTurnError();
  const rawClarification = record['clarification'];
  const clarification =
    rawClarification === undefined || rawClarification === null
      ? null
      : normalizeProviderClarification(rawClarification);
  const rawTool = record['toolCall'];
  if (rawTool === null || rawTool === undefined) return { message, toolCall: null, clarification };
  if (clarification !== null) throw new AssistantProviderTurnError();
  const call = jsonObject(rawTool, 'provider.toolCall') as Record<string, unknown>;
  if (Object.keys(call).some((key) => key !== 'name' && key !== 'arguments')) {
    throw new AssistantProviderTurnError();
  }
  return {
    message,
    clarification: null,
    toolCall: {
      name: stringValue(call['name'], '工具名称', 100),
      arguments: jsonObject(call['arguments'], '工具参数'),
    },
  };
}

export function assistantJsonObject(value: unknown, field: string): AssistantJsonObject {
  return jsonObject(value, field);
}
