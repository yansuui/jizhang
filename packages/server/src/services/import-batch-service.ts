/**
 * Merged platform-bill import batch: parse → merge → store → review → confirm.
 *
 * This is a *separate* path from the legacy single-attachment assistant import. It owns four
 * additive tables, its own paginated DTOs, and its own final confirmation transaction. The
 * legacy 200-preview/100-confirm interfaces and the generic assistant JSON budget are untouched.
 *
 * Non-negotiables implemented here (protocol `research/merged-import-protocol-v1.md`):
 *   * the client never supplies a digest, an item id or a ledger id — all of them are server
 *     computed from the actual decoded bytes;
 *   * original bytes are never persisted; every mutation and the confirmation retransmit them;
 *   * budget exhaustion rejects the whole batch instead of cropping;
 *   * the final write is one synchronous `db.transaction` with no provider, no `await` and no
 *     network call inside it.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';
import { parsePlatformBills, PlatformBillsLimitError, type PlatformBillRow, type PlatformBillSource } from '@jizhang/shared';
import { AssistantConversationService, createConversationWriteLock, type ConversationWriteLock } from './assistant-conversation-service.js';
import { AiConfigService } from './ai-config-service.js';
import { decodeBillFile, DecodeBillLimitError } from './bill-decode.js';
import { XlsxLimitError } from './xlsx-lite.js';
import { MasterDataService } from './master-data-service.js';
import {
  MERGED_MAX_CATEGORY_NAME_CHARS,
  MERGED_MAX_CELL_CHARS,
  MERGED_MAX_CSV_COLUMNS,
  MERGED_MAX_FILES,
  MERGED_MAX_FILE_BYTES,
  MERGED_MAX_FILE_RAW_ROWS,
  MERGED_MAX_FILE_TEXT_BYTES,
  MERGED_MAX_INFLATE_ENTRY,
  MERGED_MAX_INFLATE_TOTAL,
  MERGED_MAX_ITEMS,
  MERGED_MAX_NOTE_CHARS,
  MERGED_MAX_REQUEST_ID_CHARS,
  MERGED_MAX_SOURCES_RECORDS,
  MERGED_PAGE_MAX,
  MERGED_MAX_TOTAL_BYTES,
  MERGED_MAX_TOTAL_RAW_ROWS,
  MERGED_MAX_TOTAL_TEXT_BYTES,
  MERGED_MAX_ZIP_ENTRIES,
  MERGED_PARSE_DEADLINE_MS,
  MERGED_REVIEW_TTL_SEC,
  ImportBatchActionStaleError,
  ImportBatchAlreadyConfirmedError,
  ImportBatchCategoryConflictError,
  ImportBatchCategoryRequiredError,
  ImportBatchDuplicateFileError,
  ImportBatchFileFailedError,
  ImportBatchIdempotencyMismatchError,
  ImportBatchIdentityConflictError,
  ImportBatchInvalidError,
  ImportBatchLimitError,
  ImportBatchNotFoundError,
  ImportBatchStaleVersionError,
  isTerminalBatchStatus,
  type ImportAnalysisState,
  type ImportBatchAnalysisDto,
  type ImportBatchApprovedCategory,
  type ImportBatchCategoriesDto,
  type ImportBatchCategorySuggestionDto,
  type ImportBatchConflictDecision,
  type ImportBatchDto,
  type ImportBatchError as _ImportBatchErrorUnused,
  type ImportBatchFileDto,
  type ImportBatchNoticeDto,
  type ImportBatchResultDto,
  type ImportBatchReviewRecord,
  type ImportBatchReviewResponseDto,
  type ImportBatchRowDto,
  type ImportBatchRowsPageDto,
  type ImportBatchSourceRefDto,
  type ImportBatchStatus,
  type ImportBatchSummaryDto,
  type ImportCategoryAssignment,
} from './import-batch-types.js';
import {
  canonicalJson,
  canonicalOrigin,
  compareItems,
  digestOf,
  identifyRow,
  itemIdCollisions,
  legacyLedgerId,
  mergeRows,
  sha256Hex,
  simpleHash,
  type IdentityInput,
  type MergedItem,
} from './import-batch-identity.js';

void (0 as unknown as _ImportBatchErrorUnused);

// ── inputs ──────────────────────────────────────────────────────────────────

export interface ImportBatchFileInput {
  readonly fileName: string;
  readonly source: 'auto' | PlatformBillSource;
  readonly bytes: Buffer;
}

export interface CreateImportBatchInput {
  readonly files: readonly ImportBatchFileInput[];
  readonly analyse: boolean;
  readonly clientRequestId: string;
}

export interface AnalyseImportBatchInput {
  /** Re-transmitted originals, indexed to match the batch's remaining files. */
  readonly files: readonly { readonly fileIndex: number; readonly bytes: Buffer }[];
  readonly clientRequestId: string;
}

export interface MutateImportBatchInput {
  readonly expectedVersion: number;
  readonly clientRequestId: string;
  readonly targetFileIndex?: number;
  readonly files: readonly ImportBatchFileInput[];
}

export interface CancelImportBatchInput {
  readonly expectedVersion: number;
  readonly clientRequestId: string;
}

export interface ReviewImportBatchInput {
  readonly version: number;
  readonly analysisRevision: number;
  readonly viewRevision: string;
  readonly selectedItemIds: readonly string[];
  readonly categoryAssignments: Readonly<Record<string, ImportCategoryAssignment>>;
  readonly noteOverrides: Readonly<Record<string, string>>;
  readonly approvedCategories: readonly ImportBatchApprovedCategory[];
  readonly conflictDecisions: readonly ImportBatchConflictDecision[];
}

export interface ConfirmImportBatchInput {
  readonly reviewToken: string;
  readonly expectedVersion: number;
  readonly files: readonly { readonly fileIndex: number; readonly bytes: Buffer }[];
}

export interface ImportBatchServiceOptions {
  readonly db: Db;
  readonly dataDir: string;
  readonly now?: (() => number) | undefined;
  readonly withConversationLock?: ConversationWriteLock | undefined;
}

// ── stored shapes ───────────────────────────────────────────────────────────

interface BatchRow {
  readonly id: string;
  readonly conversation_id: string;
  readonly client_request_id: string;
  readonly request_hash: string;
  readonly status: ImportBatchStatus;
  readonly version: number;
  readonly analysis_revision: number;
  readonly view_revision: string;
  readonly base_fingerprint: string;
  readonly category_set_hash: string;
  readonly files_json: string;
  readonly summary_json: string;
  readonly suggestions_json: string;
  readonly review_json: string | null;
  readonly provenance_json: string;
  readonly result_json: string | null;
  readonly analyse_state: ImportAnalysisState;
  readonly analyse_owner: string | null;
  readonly analyse_lease_until: number | null;
  readonly analyse_message: string | null;
  readonly provider_calls: number;
  readonly created_at: number;
  readonly updated_at: number;
}

interface StoredRow {
  readonly batch_id: string;
  readonly item_id: string;
  readonly ordinal: number;
  readonly ledger_id: string;
  readonly identity_kind: 'platform_order' | 'occurrence';
  readonly canonical_origin: string;
  readonly semantic_key: string;
  readonly conflict_group: string | null;
  readonly conflict_kind: MergedItem['conflictKind'];
  readonly type: number;
  readonly amount_cents: number;
  readonly source_timestamp: string | null;
  readonly date_label: string;
  readonly note: string;
  readonly note_alternatives_json: string;
  readonly is_refund: number;
  readonly refund_warning: string | null;
  readonly raw_status: string;
  readonly source_category: string;
  readonly ignored: number;
  readonly ignore_reason: string | null;
  readonly existing: number;
  readonly possible_duplicate: number;
  readonly duplicate_of_note: string | null;
  readonly comparison_account_id: string | null;
  readonly sources_json: string;
  readonly weak_dup_group: string | null;
  readonly legacy_ledger_id: string | null;
  readonly legacy_ledger_match: number;
  readonly fallback_effective_existing_id: string | null;
  readonly fallback_category_name: string | null;
  readonly fallback_source: string | null;
  readonly fallback_new_other_suggestion_id: string | null;
  readonly ai_status: string;
  readonly ai_include: number | null;
  readonly ai_reason: string | null;
  readonly ai_category_id: string | null;
  readonly ai_new_suggestion_id: string | null;
}

export interface StoredSuggestion {
  readonly suggestionId: string;
  readonly origin: 'ai' | 'server-fallback';
  readonly name: string;
  readonly type: number;
  readonly parentId: string | null;
  readonly relatedItemIds: readonly string[];
}

interface StoredProvenance {
  readonly reviewToken: string | null;
  readonly fileDigests: readonly string[];
  readonly confirmKey: string | null;
}

/** Recommendation row published by one analysis run. */
export interface StoredRecommendation {
  readonly itemId: string;
  readonly include: boolean;
  readonly reason: string;
  readonly categoryId: string | null;
  readonly newSuggestionId: string | null;
}

/** Outcome of a file mutation, stored so a replay returns the same remap/drop answer. */
export interface MutationOutcome {
  readonly idRemap: Readonly<Record<string, string>>;
  readonly droppedDraftItemIds: readonly string[];
  readonly identityUnchangedItemIds: readonly string[];
  readonly replacedWithIdenticalDigest: boolean;
  readonly notices: readonly ImportBatchNoticeDto[];
}

function emptyMutationOutcome(stored: MutationOutcome | null): MutationOutcome {
  return {
    idRemap: stored?.idRemap ?? {},
    droppedDraftItemIds: stored?.droppedDraftItemIds ?? [],
    identityUnchangedItemIds: stored?.identityUnchangedItemIds ?? [],
    replacedWithIdenticalDigest: stored?.replacedWithIdenticalDigest ?? false,
    notices: stored?.notices ?? [],
  };
}


// ── helpers ─────────────────────────────────────────────────────────────────

function jsonText(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parseJson<T>(text: string | null): T | null {
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function dayLabel(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function dateLabelToEpoch(label: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(label.trim());
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(year, month - 1, day);
  if (date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date.getTime();
}

function requireRequestId(value: unknown): string {
  if (typeof value !== 'string') throw new ImportBatchInvalidError('clientRequestId 必须是文本。');
  const id = value.trim();
  if (id === '' || id.length > MERGED_MAX_REQUEST_ID_CHARS) {
    throw new ImportBatchInvalidError(`clientRequestId 长度必须为 1–${MERGED_MAX_REQUEST_ID_CHARS} 个字符。`);
  }
  return id;
}

/**
 * Parses the `files[]` part of a request body. This is the *only* place raw file input is
 * validated, so every route accepts exactly the same shape: a non-empty file name without path
 * separators, a source paired with a compatible extension, and base64 whose decoded size is
 * within the per-file budget.
 */
export function parseImportBatchFiles(value: unknown): ImportBatchFileInput[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ImportBatchInvalidError('files 必须是非空的文件数组。');
  }
  if (value.length > MERGED_MAX_FILES) {
    throw new ImportBatchLimitError(`一次最多导入 ${MERGED_MAX_FILES} 个文件，请分批导入。`);
  }
  const out: ImportBatchFileInput[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new ImportBatchInvalidError('files 中的每一项必须是对象。');
    }
    const file = entry as Record<string, unknown>;
    const fileName = requireFileName(file['fileName']);
    const source = requireSource(file['source']);
    const extension = fileName.toLowerCase().split('.').pop();
    if (extension !== 'xlsx' && extension !== 'csv') {
      throw new ImportBatchInvalidError('仅支持微信 XLSX 或支付宝 CSV 账单。');
    }
    if ((source === 'wechat' && extension !== 'xlsx') || (source === 'alipay' && extension !== 'csv')) {
      throw new ImportBatchInvalidError('文件格式与账单来源不匹配。');
    }
    const bytes = requireBase64(file['fileBase64']);
    if (bytes.byteLength > MERGED_MAX_FILE_BYTES) {
      throw new ImportBatchLimitError(`单个文件不能超过 ${MERGED_MAX_FILE_BYTES / 1024 / 1024} MiB。`);
    }
    out.push({ fileName, source, bytes });
  }
  return out;
}

function requireFileName(value: unknown): string {
  if (typeof value !== 'string') throw new ImportBatchInvalidError('fileName 必须是文本。');
  const name = value.trim();
  if (name === '' || name.length > 200 || name.includes('/') || name.includes('\\') || name.includes('\x00')) {
    throw new ImportBatchInvalidError('fileName 无效（需为 1–200 字符且不含路径分隔符）。');
  }
  return name;
}

function requireSource(value: unknown): 'auto' | PlatformBillSource {
  const source = value ?? 'auto';
  if (source !== 'auto' && source !== 'wechat' && source !== 'alipay') {
    throw new ImportBatchInvalidError('source 必须是 auto、wechat 或 alipay。');
  }
  return source;
}

function requireBase64(value: unknown): Buffer {
  if (typeof value !== 'string' || value === '') throw new ImportBatchInvalidError('fileBase64 不能为空。');
  if (value.length > Math.ceil(MERGED_MAX_FILE_BYTES * 4 / 3) + 16) {
    throw new ImportBatchLimitError(`单个文件不能超过 ${MERGED_MAX_FILE_BYTES / 1024 / 1024} MiB。`);
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new ImportBatchInvalidError('fileBase64 编码无效。');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.byteLength === 0) throw new ImportBatchInvalidError('文件内容为空。');
  return bytes;
}

/**
 * Parses `files[]` for `analyse`/`confirm`, where each entry is only `{fileIndex, fileBase64}`:
 * the name/source are authoritative server state from the stored batch, so a client cannot
 * relabel a retransmitted file as a different platform.
 */
export function parseOriginalFiles(value: unknown): { fileIndex: number; bytes: Buffer }[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ImportBatchInvalidError('files 必须是原始文件字节数组。');
  }
  if (value.length > MERGED_MAX_FILES) {
    throw new ImportBatchLimitError(`一次最多处理 ${MERGED_MAX_FILES} 个文件。`);
  }
  return value.map((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new ImportBatchInvalidError('files 中的每一项必须是对象。');
    }
    const file = entry as Record<string, unknown>;
    const fileIndex = file['fileIndex'];
    if (typeof fileIndex !== 'number' || !Number.isSafeInteger(fileIndex) || fileIndex < 0) {
      throw new ImportBatchInvalidError('fileIndex 必须是非负整数。');
    }
    const bytes = requireBase64(file['fileBase64']);
    if (bytes.byteLength > MERGED_MAX_FILE_BYTES) {
      throw new ImportBatchLimitError(`单个文件不能超过 ${MERGED_MAX_FILE_BYTES / 1024 / 1024} MiB。`);
    }
    return { fileIndex, bytes };
  });
}

/** Query strings arrive as text; only a plain non-negative integer is accepted. */
function requireIntegerQuery(value: unknown, field: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value === 'number') return requireInteger(value, field);
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new ImportBatchInvalidError(`${field} 必须是整数。`);
  }
  return Number(value);
}

function requireInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new ImportBatchInvalidError(`${field} 必须是整数。`);
  }
  return value;
}

/**
 * Feature-scoped request digest. The client never sends this (or any other digest): it is
 * computed from the decoded bytes plus the exact metadata and options that were accepted.
 */
function requestDigest(files: readonly ImportBatchFileInput[], options: unknown): string {
  const fileFacts = files.map((file) => [
    sha256Hex(file.bytes),
    file.fileName,
    file.source,
    file.bytes.byteLength,
  ]);
  return digestOf([fileFacts, options]);
}

/**
 * One parsed file, or an explicit failure record. A failed file keeps `null` counts (never `0`),
 * blocks review/confirm, and stays visible so the user can remove or replace it.
 */
interface ParsedFile {
  readonly meta: ImportBatchFileDto;
  readonly rows: readonly PlatformBillRow[];
  readonly resolvedSource: PlatformBillSource | null;
}

// ── service ─────────────────────────────────────────────────────────────────

export class ImportBatchService {
  private readonly db: Db;
  private readonly now: () => number;
  private readonly withConversationLock: ConversationWriteLock;
  /** In-process readers per batch; the fence is always written *before* these are aborted. */
  private readonly aborts = new Map<string, () => void>();

  constructor(options: ImportBatchServiceOptions) {
    this.db = options.db;
    this.now = options.now ?? (() => Date.now());
    this.withConversationLock = options.withConversationLock ?? createConversationWriteLock();
  }

  // ── abort registry ────────────────────────────────────────────────────────

  /** Registers the current in-flight provider reader for a batch. */
  setAnalysisAbort(batchId: string, abort: () => void): void {
    this.aborts.set(batchId, abort);
  }

  clearAnalysisAbort(batchId: string): void {
    this.aborts.delete(batchId);
  }

  abortAnalysis(batchId: string): void { this.abortReaders(batchId); }

  private abortReaders(batchId: string): void {
    const abort = this.aborts.get(batchId);
    if (abort === undefined) return;
    this.aborts.delete(batchId);
    try {
      abort();
    } catch {
      // Aborting is best effort; the persistent fence already stopped the work.
    }
  }

  // ── catalogue helpers ─────────────────────────────────────────────────────

  private masterData(): MasterDataService {
    return new MasterDataService(this.db, { now: this.now });
  }

  /** Live bookable leaves, mirroring the assistant's import category projection. */
  private liveCategories() {
    const categories = this.masterData().listCategories();
    return categories
      .filter((category) => category.type !== 0 || !categories.some((child) => child.parentId === category.id))
      .map(({ id, name, type, parentId }) => ({ id, name, type, parentId }));
  }

  private categorySetHash(): string {
    return digestOf(this.liveCategories());
  }

  private liveAccountFor(source: PlatformBillSource): string | null {
    const name = source === 'wechat' ? '微信' : '支付宝';
    const row = this.db
      .prepare('SELECT id FROM accounts WHERE name = ? AND deleted = 0 ORDER BY sort_order LIMIT 1')
      .get(name) as { id: string } | undefined;
    return row?.id ?? null;
  }

  private existingIds(): Set<string> {
    return new Set(
      (this.db.prepare('SELECT id FROM transactions').all() as { id: string }[]).map((row) => row.id),
    );
  }

  private legacyLedgerNotes(): Record<string, string> {
    const out: Record<string, string> = {};
    const rows = this.db
      .prepare("SELECT id, note FROM transactions WHERE id LIKE 'pb-%'")
      .all() as { id: string; note: string }[];
    for (const row of rows) if (out[row.id] === undefined) out[row.id] = row.note;
    return out;
  }

  /** Soft duplicate hint: same live platform account + local day + type + amount. */
  private softDuplicates(accountId: string | null): Map<string, string> {
    const map = new Map<string, string>();
    if (accountId === null) return map;
    const rows = this.db
      .prepare('SELECT date, type, amount_cents, note FROM transactions WHERE account_id = ? AND deleted = 0')
      .all(accountId) as { date: number; type: number; amount_cents: number; note: string }[];
    for (const row of rows) {
      const key = `${dayLabel(row.date)}|${row.type}|${row.amount_cents}`;
      if (!map.has(key)) map.set(key, row.note);
    }
    return map;
  }

  // ── parsing ───────────────────────────────────────────────────────────────

  /**
   * Decodes and parses every file. Budget violations throw (whole batch rejected, never cropped);
   * a per-file *parse* failure becomes an explicit failure record instead.
   */
  private parseFiles(files: readonly ImportBatchFileInput[]): ParsedFile[] {
    if (files.length === 0) throw new ImportBatchInvalidError('请至少选择一个账单文件。');
    if (files.length > MERGED_MAX_FILES) {
      throw new ImportBatchLimitError(`一次最多导入 ${MERGED_MAX_FILES} 个文件，请分批导入。`);
    }
    const seen = new Set<string>();
    let totalBytes = 0;
    for (const file of files) {
      const digest = sha256Hex(file.bytes);
      if (seen.has(digest)) throw new ImportBatchDuplicateFileError('同一批次中出现了内容完全相同的文件。');
      seen.add(digest);
      totalBytes += file.bytes.byteLength;
    }
    if (totalBytes > MERGED_MAX_TOTAL_BYTES) {
      throw new ImportBatchLimitError(`本批文件合计不能超过 ${MERGED_MAX_TOTAL_BYTES / 1024 / 1024} MiB，请拆分后重试。`);
    }

    const parsed: ParsedFile[] = [];
    let totalRawRows = 0;
    // One accumulator for the whole batch: the 16 MiB inflate ceiling is a batch total, not a
    // per-file number that a caller can multiply by the file count.
    const inflated = { total: 0 };
    let textShared = MERGED_MAX_TOTAL_TEXT_BYTES;
    for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
      const file = files[fileIndex]!;
      const sha256 = sha256Hex(file.bytes);
      const meta = {
        fileIndex,
        fileName: file.fileName,
        source: file.source,
        sizeBytes: file.bytes.byteLength,
        sha256,
      };
      let text: string;
      try {
        const decoded = decodeBillFile(file.bytes, file.fileName, {
          xlsx: {
            maxEntries: MERGED_MAX_ZIP_ENTRIES,
            maxEntryBytes: MERGED_MAX_INFLATE_ENTRY,
            maxTotalBytes: MERGED_MAX_INFLATE_TOTAL,
            maxRows: MERGED_MAX_FILE_RAW_ROWS + 81, // Up to 80 preamble/header rows plus the data-row budget.
            maxColumns: MERGED_MAX_CSV_COLUMNS,
            maxCellChars: MERGED_MAX_CELL_CHARS,
            counter: inflated,
          },
          maxTextBytes: MERGED_MAX_FILE_TEXT_BYTES,
        });
        if (Buffer.byteLength(decoded.text, 'utf8') > MERGED_MAX_FILE_TEXT_BYTES) {
          throw new ImportBatchLimitError('单个文件解码文本超出限制，请拆分后重试。');
        }
        if (producedTextBytes(decoded.text) > textShared) {
          throw new ImportBatchLimitError('本批解码文本总量超出限制，请拆分后重试。');
        }
        textShared -= producedTextBytes(decoded.text);
        text = decoded.text;
      } catch (error) {
        throw mapLimitError(error);
      }
      if (Buffer.byteLength(text, 'utf8') > MERGED_MAX_FILE_TEXT_BYTES) {
        throw new ImportBatchLimitError('单个文件解码文本超出限制，请拆分后重试。');
      }

      try {
        const result = parsePlatformBills(text, file.source, {
          maxRows: MERGED_MAX_FILE_RAW_ROWS,
          maxTotalRows: MERGED_MAX_TOTAL_RAW_ROWS - totalRawRows,
          maxColumns: MERGED_MAX_CSV_COLUMNS,
          maxCellChars: MERGED_MAX_CELL_CHARS,
          deadlineMs: MERGED_PARSE_DEADLINE_MS,
        });
        totalRawRows += result.total;
        if (totalRawRows > MERGED_MAX_TOTAL_RAW_ROWS) {
          throw new ImportBatchLimitError(`本批账单数据行超出限制（最多 ${MERGED_MAX_TOTAL_RAW_ROWS} 行），请拆分后重试。`);
        }
        parsed.push({
          meta: {
            ...meta,
            parseStatus: 'ok',
            rawRowCount: result.total,
            collectedRowCount: result.rows.length,
            error: null,
          },
          rows: result.rows,
          resolvedSource: result.source,
        });
      } catch (error) {
        if (error instanceof PlatformBillsLimitError || error instanceof ImportBatchLimitError) {
          throw mapLimitError(error);
        }
        // A malformed file is recorded, not fatal for the whole batch: the user can still see
        // the other files and explicitly remove or replace this one.
        parsed.push({
          meta: {
            ...meta,
            parseStatus: 'failed',
            rawRowCount: null,
            collectedRowCount: null,
            error: error instanceof Error ? error.message.slice(0, 300) : '无法解析该账单文件。',
          },
          rows: [],
          resolvedSource: null,
        });
      }
    }
    return parsed;
  }

  private identityInputs(parsed: readonly ParsedFile[]): { inputs: IdentityInput[] } {
    const inputs: IdentityInput[] = [];
    for (const file of parsed) {
      if (file.meta.parseStatus !== 'ok' || file.resolvedSource === null) continue;
      const accountId = this.liveAccountFor(file.resolvedSource);
      for (const row of file.rows) {
        inputs.push({
          fileIndex: file.meta.fileIndex,
          fileName: file.meta.fileName,
          fileSha256: file.meta.sha256,
          source: file.resolvedSource,
          sourceRow: row.sourceRow ?? 0,
          comparisonAccountId: accountId,
          fullExternalId: row.fullExternalId ?? row.externalId,
          row,
        });
      }
    }
    return { inputs };
  }

  // ── batch persistence ─────────────────────────────────────────────────────

  private batchRow(batchId: string): BatchRow | undefined {
    return this.db
      .prepare('SELECT * FROM assistant_import_batches WHERE id = ?')
      .get(batchId) as BatchRow | undefined;
  }

  /** Ownership gate used by every route: a batch from another conversation does not exist. */
  requireBatch(conversationId: string, batchId: string): BatchRow {
    new AssistantConversationService(this.db, this.now).get(conversationId);
    const row = this.batchRow(batchId);
    if (row === undefined || row.conversation_id !== conversationId) throw new ImportBatchNotFoundError();
    return row;
  }

  private writeBatch(
    batchId: string,
    patch: Partial<{
      status: ImportBatchStatus;
      version: number;
      analysis_revision: number;
      view_revision: string;
      base_fingerprint: string;
      category_set_hash: string;
      files_json: string;
      summary_json: string;
      suggestions_json: string;
      review_json: string | null;
      provenance_json: string;
      result_json: string | null;
      analyse_state: ImportAnalysisState;
      analyse_owner: string | null;
      analyse_lease_until: number | null;
      analyse_message: string | null;
      provider_calls: number;
    }>,
  ): void {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (keys.length === 0) return;
    const assignments = keys.map((key) => `${key} = @${key}`).join(', ');
    this.db
      .prepare(`UPDATE assistant_import_batches SET ${assignments}, updated_at = @updated_at WHERE id = @id`)
      .run({ ...patch, id: batchId, updated_at: this.now() });
  }

  private loadStoredItems(batchId: string): MergedItem[] {
    const rows = this.db
      .prepare('SELECT * FROM assistant_import_batch_rows WHERE batch_id = ? ORDER BY ordinal')
      .all(batchId) as StoredRow[];
    return rows.map((row) => this.rowToItem(row));
  }

  private rowToItem(row: StoredRow): MergedItem {
    return {
      itemId: row.item_id,
      ledgerId: row.ledger_id,
      identityKind: row.identity_kind,
      canonicalOrigin: row.canonical_origin,
      semanticKey: '',
      groupKey: null,
      comparisonAccountId: row.comparison_account_id,
      dateLabel: row.date_label,
      type: row.type,
      amountCents: row.amount_cents,
      sourceTimestamp: row.source_timestamp,
      note: row.note,
      sourceCategory: row.source_category,
      isRefund: row.is_refund === 1,
      refundWarning: row.refund_warning,
      rawStatus: row.raw_status,
      ignored: row.ignored === 1,
      ignoreReason: row.ignore_reason,
      existing: row.existing === 1,
      possibleDuplicate: row.possible_duplicate === 1,
      duplicateOfNote: row.duplicate_of_note,
      legacyLedgerId: row.legacy_ledger_id ?? '',
      legacyLedgerMatch: row.legacy_ledger_match === 1,
      sources: (parseJson<ImportBatchSourceRefDto[]>(row.sources_json) ?? []).map((source) => ({
        ...source,
        source: source.source === 'alipay' ? 'alipay' : 'wechat',
      })),
      noteAlternatives: parseJson<{ fileName: string; note: string }[]>(row.note_alternatives_json) ?? [],
      fileIndex: (parseJson<ImportBatchSourceRefDto[]>(row.sources_json) ?? [])[0]?.fileIndex ?? 0,
      sourceRow: (parseJson<ImportBatchSourceRefDto[]>(row.sources_json) ?? [])[0]?.sourceRow ?? 0,
      conflictGroup: row.conflict_group,
      conflictKind: row.conflict_kind,
      weakDuplicateGroup: row.weak_dup_group,
      ordinal: row.ordinal,
    };
  }

  private insertItems(batchId: string, items: readonly MergedItem[]): void {
    const insert = this.db.prepare(
      `INSERT INTO assistant_import_batch_rows
         (batch_id, item_id, ordinal, ledger_id, identity_kind, canonical_origin, semantic_key, conflict_group, conflict_kind,
          type, amount_cents, source_timestamp, date_label, note, note_alternatives_json, is_refund, refund_warning,
          raw_status, source_category, ignored, ignore_reason, existing, possible_duplicate, duplicate_of_note, comparison_account_id,
          sources_json, weak_dup_group, legacy_ledger_id, legacy_ledger_match)
       VALUES (@batch_id, @item_id, @ordinal, @ledger_id, @identity_kind, @canonical_origin, @semantic_key, @conflict_group, @conflict_kind,
          @type, @amount_cents, @source_timestamp, @date_label, @note, @note_alternatives_json, @is_refund, @refund_warning,
          @raw_status, @source_category, @ignored, @ignore_reason, @existing, @possible_duplicate, @duplicate_of_note, @comparison_account_id,
          @sources_json, @weak_dup_group, @legacy_ledger_id, @legacy_ledger_match)`,
    );
    for (const item of items) {
      insert.run({
        batch_id: batchId,
        item_id: item.itemId,
        ordinal: item.ordinal,
        ledger_id: item.ledgerId,
        identity_kind: item.identityKind,
        canonical_origin: item.canonicalOrigin,
        semantic_key: item.semanticKey,
        conflict_group: item.conflictGroup,
        conflict_kind: item.conflictKind,
        type: item.type,
        amount_cents: item.amountCents,
        source_timestamp: item.sourceTimestamp,
        date_label: item.dateLabel,
        note: item.note,
        note_alternatives_json: jsonText(item.noteAlternatives),
        is_refund: item.isRefund ? 1 : 0,
        refund_warning: item.refundWarning,
        raw_status: item.rawStatus,
        source_category: item.sourceCategory,
        ignored: item.ignored ? 1 : 0,
        ignore_reason: item.ignoreReason,
        existing: item.existing ? 1 : 0,
        possible_duplicate: item.possibleDuplicate ? 1 : 0,
        duplicate_of_note: item.duplicateOfNote,
        comparison_account_id: item.comparisonAccountId,
        sources_json: jsonText(item.sources),
        weak_dup_group: item.weakDuplicateGroup,
        legacy_ledger_id: item.legacyLedgerId,
        legacy_ledger_match: item.legacyLedgerMatch ? 1 : 0,
      });
    }
  }

  private computeSummary(batchId: string): ImportBatchSummaryDto {
    const agg = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN EXISTS (SELECT 1 FROM transactions t WHERE t.id = r.ledger_id) THEN 1 ELSE 0 END), 0) AS existing,
                COALESCE(SUM(ignored), 0) AS ignored,
                COALESCE(SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM transactions t WHERE t.id = r.ledger_id) AND amount_cents > 0 AND COALESCE(conflict_kind, '') NOT IN ('weak_collision', 'ledger_collision') THEN 1 ELSE 0 END), 0) AS importable,
                COALESCE(SUM(CASE WHEN type = 0 THEN amount_cents ELSE 0 END), 0) AS expense,
                COALESCE(SUM(CASE WHEN type = 1 THEN amount_cents ELSE 0 END), 0) AS income,
                COALESCE(SUM(legacy_ledger_match), 0) AS legacy,
                COALESCE(SUM(json_array_length(sources_json)), 0) AS sources,
                MIN(date_label) AS date_from,
                MAX(date_label) AS date_to
           FROM assistant_import_batch_rows r WHERE batch_id = ?`,
      )
      .get(batchId) as {
      total: number;
      existing: number;
      ignored: number;
      importable: number;
      expense: number;
      income: number;
      legacy: number;
      sources: number;
      date_from: string | null;
      date_to: string | null;
    };
    const groups = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT 1 FROM assistant_import_batch_rows WHERE batch_id = ? AND conflict_group IS NOT NULL
            GROUP BY conflict_group)`,
      )
      .get(batchId) as { n: number };
    // A merge keeps every source on ONE stored row, so the group count is the number of rows with
    // more than one source. Grouping stored rows by ledger id would instead count *conflicting*
    // sibling rows as merges (and drops to zero once those are marked), which is the opposite of
    // what the summary claims.
    const merged = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM assistant_import_batch_rows
          WHERE batch_id = ? AND json_array_length(sources_json) > 1`,
      )
      .get(batchId) as { n: number };
    const weak = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM (
           SELECT 1 FROM assistant_import_batch_rows WHERE batch_id = ? AND weak_dup_group IS NOT NULL
            GROUP BY weak_dup_group)`,
      )
      .get(batchId) as { n: number };
    const notices: ImportBatchNoticeDto[] = [];
    const legacyRows = this.db
      .prepare('SELECT item_id FROM assistant_import_batch_rows WHERE batch_id = ? AND legacy_ledger_match = 1 LIMIT 20')
      .all(batchId) as { item_id: string }[];
    for (const row of legacyRows) {
      notices.push({
        code: 'legacy_ledger_match',
        itemId: row.item_id,
        detail: '疑似与历史导入的同一笔交易重复，仅提示，不会自动合并或阻止导入。',
      });
    }
    const batch = this.batchRow(batchId);
    const files = parseJson<ImportBatchFileDto[]>(batch?.files_json ?? '[]') ?? [];
    const failed = files.filter((file) => file.parseStatus === 'failed');
    for (const file of failed) {
      notices.push({
        code: 'file_failed',
        detail: `${file.fileName} 解析失败：${file.error ?? '未知原因'}。请移除或替换该文件后再审核。`,
      });
    }
    return {
      totalItems: agg.total,
      importable: agg.importable,
      existing: agg.existing,
      ignored: agg.ignored,
      mergedGroups: merged.n,
      conflictGroups: groups.n,
      weakDuplicateGroups: weak.n,
      expenseCents: agg.expense,
      incomeCents: agg.income,
      dateFrom: agg.date_from,
      dateTo: agg.date_to,
      legacyLedgerMatches: agg.legacy,
      unparsedFiles: failed.length,
      sourceRecords: agg.sources,
      notices: notices.slice(0, 20),
    };
  }

  /**
   * The committed source budget: one source record per (file, row) reference kept on the batch.
   *
   * Checked at create and rebuild time as well, so the number the summary reports and the number
   * the capacity is checked against cannot drift apart. Note that the 5000 raw-row batch budget
   * already bounds it in practice (each parsed row becomes exactly one source reference), so this
   * guard is a structural invariant rather than a reachable rejection.
   */
  private requireSourceBudget(items: readonly MergedItem[]): void {
    const total = items.reduce((sum, item) => sum + item.sources.length, 0);
    if (total > MERGED_MAX_SOURCES_RECORDS) {
      throw new ImportBatchLimitError(
        `来源记录共 ${total} 条，超出每批 ${MERGED_MAX_SOURCES_RECORDS} 条上限，请拆分文件后重试。`,
      );
    }
  }

  /** Stored snapshot the review binds to: version + catalog hash + every stored row. */
  private computeBaseFingerprint(batchId: string, version: number): string {
    const batch = this.batchRow(batchId);
    return digestOf({
      version,
      categorySetHash: batch?.category_set_hash ?? '',
      files: parseJson<ImportBatchFileDto[]>(batch?.files_json ?? '[]') ?? [],
      rows: this.storedRowProjections(batchId),
    });
  }

  /** Current snapshot identity. Cached eligibility/catalogue columns are intentionally excluded. */
  private computeViewRevision(batchId: string): string {
    const batch = this.batchRow(batchId);
    const existingIds = this.existingIds();
    const liveAccounts = this.db.prepare('SELECT id, name, deleted FROM accounts ORDER BY id').all() as { id: string; name: string; deleted: number }[];
    const accountByName = new Map(liveAccounts.filter((account) => account.deleted === 0).map((account) => [account.name, account.id]));
    const rows = this.storedRowProjections(batchId).map((row) => {
      const sources = row['sources'] as ImportBatchSourceRefDto[];
      const source = sources[0]?.source;
      const accountName = source === 'wechat' ? '微信' : source === 'alipay' ? '支付宝' : null;
      return {
        ...row,
        existing: existingIds.has(String(row['ledgerId'])),
        comparisonAccountId: accountName === null ? null : accountByName.get(accountName) ?? null,
      };
    });
    return digestOf({
      batchId,
      version: batch?.version ?? 0,
      analysisRevision: batch?.analysis_revision ?? 0,
      files: parseJson<ImportBatchFileDto[]>(batch?.files_json ?? '[]') ?? [],
      rows,
      categories: this.liveCategories(),
      accounts: liveAccounts,
      existingIds: [...existingIds].sort(),
    });
  }

  private refreshDerived(batchId: string): void {
    const batch = this.batchRow(batchId);
    if (batch === undefined) return;
    this.writeBatch(batchId, {
      summary_json: jsonText(this.computeSummary(batchId)),
      base_fingerprint: this.computeBaseFingerprint(batchId, batch.version),
      view_revision: this.computeViewRevision(batchId),
    });
  }

  // ── DTOs ──────────────────────────────────────────────────────────────────

  private analysisStateOf(batch: BatchRow): ImportAnalysisState {
    return batch.analyse_state;
  }

  private toDtoWithAnalysis(batch: BatchRow): ImportBatchDto {
    const summary = this.computeSummary(batch.id);
    const suggestions = parseJson<StoredSuggestion[]>(batch.suggestions_json) ?? [];
    let analysed = 0;
    if (batch.analyse_state === 'complete') {
      const agg = this.db
        .prepare("SELECT COUNT(*) AS n FROM assistant_import_batch_rows WHERE batch_id = ? AND ai_status = 'complete'")
        .get(batch.id) as { n: number };
      analysed = agg.n;
    }
    const analysis: ImportBatchAnalysisDto = {
      state: this.analysisStateOf(batch),
      analysisRevision: batch.analysis_revision,
      analysed,
      providerCalls: batch.provider_calls,
      suggestedNewCategories: suggestions.filter((suggestion) => suggestion.origin === 'ai').length,
      message: batch.analyse_message,
    };
    return {
      batchId: batch.id,
      conversationId: batch.conversation_id,
      version: batch.version,
      status: batch.status,
      viewRevision: this.computeViewRevision(batch.id),
      files: parseJson<ImportBatchFileDto[]>(batch.files_json) ?? [],
      summary,
      analysis,
      result: parseJson<ImportBatchResultDto>(batch.result_json),
    };
  }

  private rowDto(
    row: StoredRow,
    existingNow = row.existing === 1,
    comparisonAccountId = row.comparison_account_id,
  ): ImportBatchRowDto {
    const fallbackSuggestion = row.fallback_new_other_suggestion_id;
    return {
      itemId: row.item_id,
      identityKind: row.identity_kind,
      ordinal: row.ordinal,
      conflictGroup: row.conflict_group,
      conflictKind: row.conflict_kind,
      dateLabel: row.date_label,
      sourceTimestamp: row.source_timestamp,
      type: row.type,
      amountCents: row.amount_cents,
      note: row.note,
      noteAlternatives: parseJson<{ fileName: string; note: string }[]>(row.note_alternatives_json) ?? [],
      isRefund: row.is_refund === 1,
      refundWarning: row.refund_warning,
      rawStatus: row.raw_status,
      ignored: row.ignored === 1,
      ignoreReason: row.ignore_reason,
      existing: existingNow,
      possibleDuplicate: row.possible_duplicate === 1,
      duplicateOfNote: row.duplicate_of_note,
      weakDuplicateGroup: row.weak_dup_group,
      legacyLedgerMatch: row.legacy_ledger_match === 1,
      comparisonAccountId,
      sources: parseJson<ImportBatchSourceRefDto[]>(row.sources_json) ?? [],
      fallback: {
        effectiveExistingId: row.fallback_effective_existing_id,
        categoryName: row.fallback_category_name,
        source: row.fallback_source,
        newOtherSuggestionId: fallbackSuggestion,
      },
      ai: {
        status: row.ai_status === 'complete' ? 'complete' : 'none',
        include: row.ai_include === null ? null : row.ai_include === 1,
        reason: row.ai_reason,
        categoryId: row.ai_category_id,
        newSuggestionId: row.ai_new_suggestion_id,
      },
    };
  }

  // ── create ────────────────────────────────────────────────────────────────

  create(conversationId: string, input: CreateImportBatchInput): { batch: ImportBatchDto; created: boolean } {
    new AssistantConversationService(this.db, this.now).get(conversationId);
    const clientRequestId = requireRequestId(input.clientRequestId);
    const hash = requestDigest(input.files, { analyse: input.analyse === true });
    const parsed = this.parseFiles(input.files);
    const { inputs } = this.identityInputs(parsed);
    const merge = mergeRows(inputs, {
      existingIds: this.existingIds(),
      ledgerNotesById: this.legacyLedgerNotes(),
    });
    if (merge.items.length > MERGED_MAX_ITEMS) {
      throw new ImportBatchLimitError(
        `融合后共有 ${merge.items.length} 条记录，超出每批 ${MERGED_MAX_ITEMS} 条上限，请拆分文件后重试。`,
      );
    }
    const collisions = itemIdCollisions(merge.items);
    if (collisions.length > 0) {
      throw new ImportBatchIdentityConflictError('检测到账单标识冲突，已拒绝整批导入以避免合并错误。');
    }
    this.requireSourceBudget(merge.items);

    const batchId = randomUUID();
    this.applySoftDuplicates(merge.items);

    const now = this.now();
    const created = this.withConversationLock(() =>
      this.db.transaction((): { batch: ImportBatchDto; created: boolean } => {
        const replay = this.db
          .prepare('SELECT * FROM assistant_import_batches WHERE conversation_id = ? AND client_request_id = ?')
          .get(conversationId, clientRequestId) as BatchRow | undefined;
        if (replay !== undefined) {
          if (replay.request_hash !== hash) throw new ImportBatchIdempotencyMismatchError();
          return { batch: this.toDtoWithAnalysis(replay), created: false };
        }
        const files = parsed.map((file) => file.meta);
        const categorySetHash = this.categorySetHash();
        this.db
          .prepare(
            `INSERT INTO assistant_import_batches
               (id, conversation_id, client_request_id, request_hash, status, version, analysis_revision,
                view_revision, base_fingerprint, category_set_hash, files_json, summary_json, suggestions_json,
                review_json, provenance_json, result_json, analyse_state, analyse_owner, analyse_lease_until,
                analyse_message, created_at, updated_at)
             VALUES (@id, @conversation_id, @client_request_id, @request_hash, @status, 1, 0,
                @view_revision, @base_fingerprint, @category_set_hash, @files_json, @summary_json, @suggestions_json,
                NULL, @provenance_json, NULL, 'idle', NULL, NULL, NULL, @created_at, @updated_at)`,
          )
          .run({
            id: batchId,
            conversation_id: conversationId,
            client_request_id: clientRequestId,
            request_hash: hash,
            status: 'prepared',
            view_revision: 'pending',
            base_fingerprint: 'pending',
            category_set_hash: categorySetHash,
            files_json: jsonText(files),
            summary_json: jsonText({}),
            suggestions_json: jsonText([]),
            provenance_json: jsonText({ reviewToken: null, fileDigests: [], confirmKey: null }),
            created_at: now,
            updated_at: now,
          });
        this.insertItems(batchId, merge.items);
        // Deterministic per-row fallbacks are written at creation: they never depend on AI, and a
        // later AI failure must not remove them.
        this.ensureFallbacks(batchId);
        this.refreshDerived(batchId);
        const stored = this.batchRow(batchId)!;
        return { batch: this.toDtoWithAnalysis(stored), created: true };
      })(),
    );
    return created;
  }

  // ── reads ─────────────────────────────────────────────────────────────────

  get(conversationId: string, batchId: string): ImportBatchDto {
    return this.db.transaction(() => this.toDtoWithAnalysis(this.requireBatch(conversationId, batchId)))();
  }

  rows(
    conversationId: string,
    batchId: string,
    query: { limit?: unknown; cursor?: unknown; filter?: unknown; includeVersion?: unknown; source?: unknown },
  ): ImportBatchRowsPageDto {
    return this.db.transaction(() => {
      const batch = this.requireBatch(conversationId, batchId);
      const limit = parsePageLimit(query.limit, 50, MERGED_PAGE_MAX);
      const includeVersion = requireIntegerQuery(query.includeVersion, 'includeVersion');
      if (includeVersion !== undefined && includeVersion !== batch.version) {
        throw new ImportBatchStaleVersionError();
      }
      const filter = typeof query.filter === 'string' && query.filter !== '' ? query.filter : 'all';
      const { clause, params } = rowFilterClause(filter);
      const cursor = typeof query.cursor === 'string' && query.cursor !== '' ? query.cursor : null;
      if (cursor !== null) {
        const at = this.db
          .prepare('SELECT ordinal FROM assistant_import_batch_rows WHERE batch_id = ? AND item_id = ?')
          .get(batchId, cursor) as { ordinal: number } | undefined;
        if (at === undefined) throw new ImportBatchStaleVersionError('分页游标已失效，请重新读取列表。');
        params.push(at.ordinal);
      }
      const where = cursor === null ? clause : `${clause}${clause === '' ? '' : ' AND'} ordinal > ?`;
      const rows = this.db
        .prepare(
          `SELECT * FROM assistant_import_batch_rows WHERE batch_id = ? ${where === '' ? '' : `AND ${where}`} ORDER BY ordinal LIMIT ?`,
        )
        .all(batchId, ...params, limit + 1) as StoredRow[];
      const accountByName = new Map(
        (this.db.prepare('SELECT id, name FROM accounts WHERE deleted = 0 ORDER BY id').all() as { id: string; name: string }[])
          .map((account) => [account.name, account.id]),
      );
      const page = rows.slice(0, limit);
      const existingIds = this.existingIds();
      return {
        batchId,
        version: batch.version,
        analysisRevision: batch.analysis_revision,
        viewRevision: this.computeViewRevision(batchId),
        total: parseJson<ImportBatchSummaryDto>(batch.summary_json)?.totalItems ?? page.length,
        items: page.map((row) => {
          const source = (parseJson<ImportBatchSourceRefDto[]>(row.sources_json) ?? [])[0]?.source;
          const accountName = source === 'wechat' ? '微信' : source === 'alipay' ? '支付宝' : null;
          return this.rowDto(row, existingIds.has(row.ledger_id), accountName === null ? null : accountByName.get(accountName) ?? null);
        }),
        nextCursor: rows.length > limit ? (page.at(-1)?.item_id ?? null) : null,
        readAt: this.now(),
      };
    })();
  }

  categories(conversationId: string, batchId: string, includeVersion: unknown): ImportBatchCategoriesDto {
    return this.db.transaction(() => {
      const batch = this.requireBatch(conversationId, batchId);
      const explicitVersion = requireIntegerQuery(includeVersion, 'includeVersion');
      if (explicitVersion !== undefined && explicitVersion !== batch.version) {
        throw new ImportBatchStaleVersionError();
      }
      const suggestions = parseJson<StoredSuggestion[]>(batch.suggestions_json) ?? [];
      const live = this.liveCategories();
      const items: ImportBatchCategorySuggestionDto[] = suggestions.map((suggestion) => {
        const candidates = live.filter(
          (category) =>
            category.name === suggestion.name &&
            category.type === suggestion.type &&
            category.parentId === suggestion.parentId,
        );
        return {
          suggestionId: suggestion.suggestionId,
          origin: suggestion.origin,
          name: suggestion.name,
          type: suggestion.type,
          parentId: suggestion.parentId,
          relatedItemCount: suggestion.relatedItemIds.length,
          relatedItemIds: suggestion.relatedItemIds.slice(0, MERGED_MAX_ITEMS),
          candidates: candidates.map((category) => ({
            categoryId: category.id,
            name: category.name,
            type: category.type,
            parentId: category.parentId,
            isLeaf: true,
          })),
        };
      });
      return {
        batchId,
        version: batch.version,
        analysisRevision: batch.analysis_revision,
        viewRevision: this.computeViewRevision(batchId),
        categories: live,
        items,
        notice: null,
      };
    })();
  }

  /** Read-only ledger comparison for one stored batch row. Never accepts client facts. */
  duplicates(
    conversationId: string,
    batchId: string,
    itemId: string,
    limitInput: unknown,
    cursorInput: unknown,
  ) {
    this.requireBatch(conversationId, batchId);
    const row = this.db
      .prepare('SELECT * FROM assistant_import_batch_rows WHERE batch_id = ? AND item_id = ?')
      .get(batchId, itemId) as StoredRow | undefined;
    if (row === undefined) throw new ImportBatchInvalidError('该账单不在当前批次中，请刷新后重试。');
    const limit = parsePageLimit(limitInput, 20, 50);
    if (
      cursorInput !== undefined &&
      (typeof cursorInput !== 'string' || cursorInput.length === 0 || cursorInput.length > 100)
    ) {
      throw new ImportBatchInvalidError('分页参数无效：cursor 必须是有效账单编号。');
    }
    const accountId = row.comparison_account_id;
    if (accountId === null) {
      return {
        source: { itemId },
        total: 0,
        items: [],
        nextCursor: null,
        readAt: this.now(),
        rationale: '该平台尚无有效账户，无法比对历史账单；这不是无重复的结论。',
      };
    }
    const day = dateLabelToEpoch(row.date_label);
    if (day === null) throw new ImportBatchInvalidError('批次日期无效，请重新上传账单。');
    const end = new Date(day);
    end.setDate(end.getDate() + 1);
    const where = 'account_id = ? AND date >= ? AND date < ? AND type = ? AND amount_cents = ? AND deleted = 0';
    const params = [accountId, day, end.getTime(), row.type, row.amount_cents];
    const cursor = typeof cursorInput === 'string' ? cursorInput : '';
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE ${where}`).get(...params) as { n: number }).n;
    const ids = this.db
      .prepare(`SELECT id FROM transactions WHERE ${where} AND id > ? ORDER BY id LIMIT ?`)
      .all(...params, cursor, limit + 1) as { id: string }[];
    const accounts = this.nameMap('accounts');
    const categories = this.nameMap('categories');
    const items = ids.slice(0, limit).map(({ id }) => {
      const txn = this.db
        .prepare('SELECT id, type, amount_cents, category_id, account_id, date, note, is_refund FROM transactions WHERE id = ?')
        .get(id) as {
        id: string;
        type: number;
        amount_cents: number;
        category_id: string;
        account_id: string;
        date: number;
        note: string;
        is_refund: number;
      };
      return {
        id: txn.id,
        type: txn.type,
        amountCents: txn.amount_cents,
        categoryId: txn.category_id,
        accountId: txn.account_id,
        date: txn.date,
        note: txn.note,
        isRefund: txn.is_refund === 1,
        accountName: accounts.get(txn.account_id) ?? null,
        categoryName: categories.get(txn.category_id) ?? null,
      };
    });
    return {
      source: { itemId },
      total,
      items,
      nextCursor: ids.length > limit ? (items.at(-1)?.id ?? null) : null,
      readAt: this.now(),
      rationale: '同平台账户、服务端本地同日、同类型、同金额，仅为疑似重复线索，不证明是同一笔账。',
    };
  }

  private nameMap(table: 'categories' | 'accounts'): Map<string, string> {
    const map = new Map<string, string>();
    for (const row of this.db.prepare(`SELECT id, name FROM ${table}`).all() as { id: string; name: string }[]) {
      map.set(row.id, row.name);
    }
    return map;
  }

  // ── analysis fences ───────────────────────────────────────────────────────

  /**
   * Writes the analysis fence first (status/revision/owner/lease, clears any review), then the
   * caller aborts the previous reader. The order is what stops a late provider write from
   * landing on a batch that has already moved on.
   */
  beginAnalysis(
    conversationId: string,
    batchId: string,
    owner: string,
  ): { batch: BatchRow; revision: number } {
    const result = this.withConversationLock(() =>
      this.db.transaction((): { batch: BatchRow; revision: number } => {
        const batch = this.requireBatch(conversationId, batchId);
        if (isTerminalBatchStatus(batch.status)) throw new ImportBatchActionStaleError('批次已结束，无法重新分析。');
        const revision = batch.analysis_revision + 1;
        this.writeBatch(batchId, {
          analyse_state: 'running',
          analyse_owner: owner,
          analyse_lease_until: this.now() + MERGED_REVIEW_TTL_SEC * 1000,
          analysis_revision: revision,
          analyse_message: null,
          review_json: null,
          status: batch.status === 'reviewed' ? 'prepared' : batch.status,
          view_revision: this.computeViewRevision(batchId),
        });
        return { batch: this.batchRow(batchId)!, revision };
      })(),
    );
    // Fence is durable now; only then is the previous reader stopped.
    this.abortReaders(batchId);
    return result;
  }

  /**
   * Publishes (or fails) a whole analysis run.
   *
   * Rejects any write whose owner/version/revision no longer matches the fence, so a cancelled
   * or superseded run can never publish. A failure clears every AI-origin proposal but keeps the
   * deterministic `server-fallback` Other proposals, which stay independently approvable.
   */
  publishAnalysis(
    batchId: string,
    owner: string,
    version: number,
    revision: number,
    outcome:
      | {
          readonly state: 'complete';
          readonly recommendations: readonly StoredRecommendation[];
          readonly suggestions: readonly StoredSuggestion[];
          readonly providerCalls: number;
        }
      | {
          readonly state: 'failed';
          readonly message: string;
          readonly providerCalls: number;
        },
  ): boolean {
    return this.withConversationLock(() =>
      this.db.transaction((): boolean => {
        const batch = this.batchRow(batchId);
        if (batch === undefined) return false;
        if (batch.analyse_state !== 'running' || batch.analyse_owner !== owner) return false;
        if (batch.version !== version || batch.analysis_revision !== revision) return false;
        if (isTerminalBatchStatus(batch.status)) return false;

        // Every publication first clears AI-origin proposals; fallback proposals survive.
        const keptFallback = (parseJson<StoredSuggestion[]>(batch.suggestions_json) ?? []).filter(
          (suggestion) => suggestion.origin === 'server-fallback',
        );
        this.db.prepare("DELETE FROM assistant_import_batch_categories WHERE batch_id = ? AND origin = 'ai'").run(batchId);
        this.db
          .prepare(
            `UPDATE assistant_import_batch_rows
                SET ai_status = 'none', ai_include = NULL, ai_reason = NULL, ai_category_id = NULL,
                    ai_new_suggestion_id = NULL
              WHERE batch_id = ?`,
          )
          .run(batchId);

        if (outcome.state === 'complete') {
          for (const suggestion of outcome.suggestions) {
            this.db
              .prepare(
                `INSERT INTO assistant_import_batch_categories
                   (batch_id, suggestion_id, origin, name, type, parent_id, related_item_ids_json)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                batchId,
                suggestion.suggestionId,
                suggestion.origin,
                suggestion.name,
                suggestion.type,
                suggestion.parentId,
                jsonText(suggestion.relatedItemIds),
              );
          }
          const updateRow = this.db.prepare(
            `UPDATE assistant_import_batch_rows
                SET ai_status = 'complete', ai_include = ?, ai_reason = ?, ai_category_id = ?,
                    ai_new_suggestion_id = ?
              WHERE batch_id = ? AND item_id = ?`,
          );
          for (const recommendation of outcome.recommendations) {
            const suggestion = outcome.suggestions.find(
              (candidate) => candidate.suggestionId === recommendation.newSuggestionId,
            );
            if (suggestion !== undefined) {
              this.db
                .prepare(
                  `UPDATE assistant_import_batch_categories SET related_item_ids_json = ?
                    WHERE batch_id = ? AND suggestion_id = ?`,
                )
                .run(jsonText(suggestion.relatedItemIds), batchId, suggestion.suggestionId);
            }
            updateRow.run(
              recommendation.include ? 1 : 0,
              recommendation.reason,
              recommendation.categoryId,
              recommendation.newSuggestionId,
              batchId,
              recommendation.itemId,
            );
          }
        }

        this.writeBatch(batchId, {
          analyse_state: outcome.state,
          analyse_owner: null,
          analyse_lease_until: null,
          analyse_message: outcome.state === 'complete' ? null : outcome.message,
          provider_calls: outcome.providerCalls,
          suggestions_json: jsonText(
            outcome.state === 'complete' ? [...keptFallback, ...outcome.suggestions] : keptFallback,
          ),
          review_json: null,
        });
        this.refreshDerived(batchId);
        return true;
      })(),
    );
  }

  /**
   * Deterministic per-row fallback. Independent of AI: written when the batch is created or
   * rebuilt, and deliberately *not* cleared by an AI failure. When the same-type "其他" leaf does
   * not exist, a `server-fallback` suggestion is published that still requires explicit approval
   * before the confirmation transaction may create it.
   *
   * Must run inside a transaction (it rewrites both the stored suggestions and the rows).
   */
  private ensureFallbacks(batchId: string): void {
    const batch = this.batchRow(batchId);
    if (batch === undefined) return;
    const keptFallback = (parseJson<StoredSuggestion[]>(batch.suggestions_json) ?? []).filter(
      (suggestion) => suggestion.origin === 'server-fallback',
    );
    const live = this.liveCategories();
    const suggestions: StoredSuggestion[] = [];
    const rows = this.db
      .prepare('SELECT item_id, type FROM assistant_import_batch_rows WHERE batch_id = ? ORDER BY ordinal')
      .all(batchId) as { item_id: string; type: number }[];
    const update = this.db.prepare(
      `UPDATE assistant_import_batch_rows
          SET fallback_effective_existing_id = ?, fallback_category_name = ?, fallback_source = ?,
              fallback_new_other_suggestion_id = ?
        WHERE batch_id = ? AND item_id = ?`,
    );
    const byType = new Map<number, StoredSuggestion>();
    let counter = 0;
    for (const row of rows) {
      const desired = row.type === 0 ? '其他' : '其他收入';
      const match = live.find((category) => category.type === row.type && category.name === desired);
      if (match !== undefined) {
        update.run(match.id, match.name, 'keyword', null, batchId, row.item_id);
        continue;
      }
      let suggestion = byType.get(row.type);
      if (suggestion === undefined) {
        counter += 1;
        suggestion = {
          suggestionId: `nc-fallback-${row.type}-${counter}`,
          origin: 'server-fallback',
          name: desired,
          type: row.type,
          parentId: null,
          relatedItemIds: [],
        };
        byType.set(row.type, suggestion);
        suggestions.push(suggestion);
      }
      (suggestion.relatedItemIds as string[]).push(row.item_id);
      update.run(null, desired, 'server-fallback', suggestion.suggestionId, batchId, row.item_id);
    }
    const merged = [
      ...keptFallback.filter((old) => !suggestions.some((next) => next.suggestionId === old.suggestionId)),
      ...suggestions,
    ];
    this.db
      .prepare("DELETE FROM assistant_import_batch_categories WHERE batch_id = ? AND origin = 'server-fallback'")
      .run(batchId);
    for (const suggestion of suggestions) {
      this.db
        .prepare(
          `INSERT INTO assistant_import_batch_categories
             (batch_id, suggestion_id, origin, name, type, parent_id, related_item_ids_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          batchId,
          suggestion.suggestionId,
          suggestion.origin,
          suggestion.name,
          suggestion.type,
          suggestion.parentId,
          jsonText(suggestion.relatedItemIds),
        );
    }
    this.writeBatch(batchId, { suggestions_json: jsonText(merged) });
  }

  // ── mutations: analyse / remove / replace / cancel ────────────────────────

  /** Rebuilds a batch from retransmitted original bytes (remove/replace/analyse). */
  private rebuild(
    _conversationId: string,
    batchId: string,
    files: readonly ImportBatchFileInput[],
  ): {
    files: readonly ImportBatchFileDto[];
    items: readonly MergedItem[];
    idRemap: Record<string, string>;
    droppedDraftItemIds: string[];
    identityUnchangedItemIds: string[];
    replacedWithIdenticalDigest: boolean;
    notices: ImportBatchNoticeDto[];
  } {
    const previous = this.db
      .prepare(
        `SELECT item_id, ledger_id, identity_kind, canonical_origin, semantic_key, note, amount_cents, type,
                source_timestamp, is_refund
           FROM assistant_import_batch_rows WHERE batch_id = ? ORDER BY ordinal`,
      )
      .all(batchId) as {
      item_id: string;
      ledger_id: string;
      identity_kind: 'platform_order' | 'occurrence';
      canonical_origin: string;
      semantic_key: string;
      note: string;
      amount_cents: number;
      type: number;
      source_timestamp: string | null;
      is_refund: number;
    }[];
    const parsed = this.parseFiles(files);
    const { inputs } = this.identityInputs(parsed);
    const merge = mergeRows(inputs, {
      existingIds: this.existingIds(),
      ledgerNotesById: this.legacyLedgerNotes(),
    });
    this.applySoftDuplicates(merge.items);
    if (merge.items.length > MERGED_MAX_ITEMS) {
      throw new ImportBatchLimitError(`融合后共有 ${merge.items.length} 条记录，超出每批 ${MERGED_MAX_ITEMS} 条上限。`);
    }
    // The source budget is part of the same commitment as the item cap: without it a batch that
    // passed creation could only fail much later, during the confirmation re-parse, which is both
    // confusing and the point at which the user believes the import is already reviewed.
    this.requireSourceBudget(merge.items);
    if (itemIdCollisions(merge.items).length > 0) {
      throw new ImportBatchIdentityConflictError('检测到账单标识冲突，已拒绝本次文件变更。');
    }
    const idRemap: Record<string, string> = {};
    const droppedDraftItemIds: string[] = [];
    const identityUnchangedItemIds: string[] = [];
    const notices: ImportBatchNoticeDto[] = [];
    // Draft migration never depends on a file index. A platform order keeps its identity across a
    // re-export (matched by ledger id), so its draft is remapped to the new item id; only a *fact*
    // change drops the draft. An occurrence is matched by its canonical origin (`sha256:sourceRow`).
    const byOrigin = new Map<string, MergedItem>();
    const byLedgerId = new Map<string, MergedItem[]>();
    for (const item of merge.items) {
      for (const source of item.sources) {
        if (!byOrigin.has(source.origin)) byOrigin.set(source.origin, item);
      }
      const bucket = byLedgerId.get(item.ledgerId);
      if (bucket === undefined) byLedgerId.set(item.ledgerId, [item]);
      else bucket.push(item);
    }
    const remapped = new Set<string>();
    const dropped = new Set<string>();
    for (const old of previous) {
      const orderBucket = old.identity_kind === 'platform_order' ? (byLedgerId.get(old.ledger_id) ?? []) : [];
      const next =
        old.identity_kind === 'platform_order'
          ? orderBucket.find((item) => item.semanticKey === old.semantic_key) ?? orderBucket[0]
          : byOrigin.get(old.canonical_origin);
      if (next === undefined) {
        dropped.add(old.item_id);
        continue;
      }
      if (next.itemId !== old.item_id) {
        // The same movement under a new item id: keep the draft, tell the client how to remap it.
        idRemap[old.item_id] = next.itemId;
        remapped.add(old.item_id);
        const sameFacts =
          next.amountCents === old.amount_cents &&
          next.type === old.type &&
          next.sourceTimestamp === old.source_timestamp &&
          (next.isRefund ? 1 : 0) === old.is_refund;
        if (!sameFacts) {
          dropped.add(old.item_id);
          remapped.delete(old.item_id);
          delete idRemap[old.item_id];
          notices.push({
            code: 'identity_facts_changed',
            itemId: next.itemId,
            detail: '订单号未变但金额/日期/退款事实变化，已清除草稿，请重新核对。',
          });
        } else {
          identityUnchangedItemIds.push(next.itemId);
        }
        continue;
      }
      const sameFacts =
        next.amountCents === old.amount_cents &&
        next.type === old.type &&
        next.sourceTimestamp === old.source_timestamp &&
        (next.isRefund ? 1 : 0) === old.is_refund;
      if (sameFacts) identityUnchangedItemIds.push(next.itemId);
      else {
        dropped.add(old.item_id);
        notices.push({
          code: 'identity_facts_changed',
          itemId: next.itemId,
          detail: '订单号未变但金额/日期/退款事实变化，已清除草稿，请重新核对。',
        });
      }
    }
    for (const itemId of dropped) droppedDraftItemIds.push(itemId);
    const beforeDigests = (parseJson<ImportBatchFileDto[]>(this.batchRow(batchId)?.files_json ?? '[]') ?? []).map(
      (file) => file.sha256,
    );
    const afterDigests = parsed.map((file) => file.meta.sha256);
    const replacedWithIdenticalDigest =
      beforeDigests.length === afterDigests.length && beforeDigests.every((digest, index) => digest === afterDigests[index]);
    return {
      files: parsed.map((file) => file.meta),
      items: merge.items,
      idRemap,
      droppedDraftItemIds,
      identityUnchangedItemIds,
      replacedWithIdenticalDigest,
      notices,
    };
  }

  analyse(
    conversationId: string,
    batchId: string,
    input: AnalyseImportBatchInput,
  ): { batch: ImportBatchDto; revision: number; created: boolean } {
    const batch = this.requireBatch(conversationId, batchId);
    if (isTerminalBatchStatus(batch.status)) throw new ImportBatchActionStaleError('批次已结束，无法重新分析。');
    const clientRequestId = requireRequestId(input.clientRequestId);
    const previousFiles = parseJson<ImportBatchFileDto[]>(batch.files_json) ?? [];
    const files = this.normalizeRetransmittedFiles(previousFiles, input.files);
    const hash = requestDigest(files, { operation: 'analyse' });
    // Replay is decided before the consumed-version guard: a retried accepted request returns
    // the stored outcome instead of a spurious stale-version error.
    const existingOp = this.operationRecord(batchId, 'analyse', clientRequestId);
    if (existingOp !== undefined) {
      if (existingOp.request_hash !== hash) throw new ImportBatchIdempotencyMismatchError();
      const latest = this.batchRow(batchId)!;
      return { batch: this.toDtoWithAnalysis(latest), revision: latest.analysis_revision, created: false };
    }
    const rebuilt = this.rebuild(conversationId, batchId, files);

    // Single write transaction: file set + analysis revision + fallbacks move together.
    const applied = this.withConversationLock(() =>
      this.db.transaction((): { revision: number } => {
        const current = this.requireBatch(conversationId, batchId);
        if (isTerminalBatchStatus(current.status)) throw new ImportBatchActionStaleError('批次已结束，无法重新分析。');
        if (current.analyse_state === 'running') {
          throw new ImportBatchActionStaleError('分析仍在进行中，请等待完成或先取消。');
        }
        const revision = current.analysis_revision + 1;
        this.applyRebuild(batchId, rebuilt, current.version, revision);
        const hasFailedFile = rebuilt.files.some((file) => file.parseStatus === 'failed');
        this.writeBatch(batchId, {
          status: current.status === 'reviewed' ? 'prepared' : current.status,
          analyse_state: hasFailedFile ? 'failed' : 'idle',
          analyse_message: hasFailedFile ? '存在解析失败的文件，请移除或替换后再分析。' : null,
          analyse_owner: null,
          analyse_lease_until: null,
          provider_calls: 0,
        });
        this.publishOperation(batchId, 'analyse', clientRequestId, hash, current.version, revision, null);
        return { revision };
      })(),
    );
    // The fence is durable; only now is a previous reader stopped.
    this.abortReaders(batchId);
    return {
      batch: this.toDtoWithAnalysis(this.batchRow(batchId)!),
      revision: applied.revision,
      created: true,
    };
  }

  /** Applies a rebuilt file set: rows replaced, files stored, version/revision bumped. */
  private applyRebuild(
    batchId: string,
    rebuilt: {
      readonly files: readonly ImportBatchFileDto[];
      readonly items: readonly MergedItem[];
    },
    version: number,
    analysisRevision: number,
  ): void {
    this.db.prepare('DELETE FROM assistant_import_batch_rows WHERE batch_id = ?').run(batchId);
    // AI proposals belonged to the *previous* row set. `insertItems` already writes the new rows
    // with `ai_status='none'`, but the suggestion rows in `assistant_import_batch_categories`
    // would survive the rebuild and keep advertising a suggestion no row references any more.
    this.db.prepare("DELETE FROM assistant_import_batch_categories WHERE batch_id = ? AND origin = 'ai'").run(batchId);
    this.insertItems(batchId, rebuilt.items);
    this.writeBatch(batchId, {
      files_json: jsonText(rebuilt.files),
      version,
      analysis_revision: analysisRevision,
      status: 'prepared',
      review_json: null,
      analyse_state: 'idle',
      analyse_message: null,
      analyse_owner: null,
      analyse_lease_until: null,
      provider_calls: 0,
    });
    this.ensureFallbacks(batchId);
    this.refreshDerived(batchId);
  }

  mutateFiles(
    conversationId: string,
    batchId: string,
    kind: 'remove' | 'replace',
    fileIndex: number,
    input: MutateImportBatchInput,
  ): MutationOutcome & { batch: ImportBatchDto } {
    const batch = this.requireBatch(conversationId, batchId);
    if (isTerminalBatchStatus(batch.status)) throw new ImportBatchActionStaleError('批次已结束，无法修改文件。');
    const clientRequestId = requireRequestId(input.clientRequestId);
    const expectedVersion = requireInteger(input.expectedVersion, 'expectedVersion');
    const index = requireInteger(fileIndex, 'fileIndex');
    // The digest covers the accepted payload and the operation, so it can be computed before any
    // guard that reads *current mutable* file state. Key ordering is load-bearing: an accepted
    // request must resolve to its stored outcome even after it changed the file list. Otherwise a
    // removal that committed (e.g. [A,B] -> [A]) and then lost its response could never be replayed
    // — the same index is out of range in the reduced list, index 0 trips the last-file rule, and a
    // larger batch trips the full-remaining-set rule — and the retained `idRemap`/dropped drafts
    // would be unreachable. Only a *new* request is validated against the current files/version.
    if (
      kind === 'remove' &&
      input.targetFileIndex !== undefined &&
      requireInteger(input.targetFileIndex, 'targetFileIndex') !== index
    ) {
      throw new ImportBatchInvalidError('targetFileIndex 必须与路径中的 fileIndex 一致。');
    }
    const hash = requestDigest(input.files, { operation: kind, targetFileIndex: index });
    const existingOp = this.operationRecord(batchId, kind, clientRequestId);
    if (existingOp !== undefined) {
      if (existingOp.request_hash !== hash) throw new ImportBatchIdempotencyMismatchError();
      const stored = parseJson<MutationOutcome>(existingOp.result_json);
      return { batch: this.toDtoWithAnalysis(this.batchRow(batchId)!), ...emptyMutationOutcome(stored) };
    }

    const previousFiles = parseJson<ImportBatchFileDto[]>(batch.files_json) ?? [];
    if (index < 0 || index >= previousFiles.length) throw new ImportBatchInvalidError('fileIndex 不在当前文件范围内。');
    const remaining = kind === 'remove' ? previousFiles.length - 1 : previousFiles.length;
    if (remaining < 1) throw new ImportBatchInvalidError('不能移除最后一个文件。');
    if (input.files.length !== remaining) {
      throw new ImportBatchFileFailedError('请重传变更后的全部剩余文件原始内容，不接受局部补丁。');
    }

    const expectedUntargeted = previousFiles.filter((_, oldIndex) => oldIndex !== index);
    const remainingKeys = new Map<string, number>();
    for (const file of expectedUntargeted) {
      const key = `${file.sha256}\u0000${file.fileName}\u0000${file.source}`;
      remainingKeys.set(key, (remainingKeys.get(key) ?? 0) + 1);
    }
    for (const candidate of input.files) {
      const key = `${sha256Hex(candidate.bytes)}\u0000${candidate.fileName}\u0000${candidate.source}`;
      const count = remainingKeys.get(key) ?? 0;
      if (count > 0) remainingKeys.set(key, count - 1);
    }
    if ([...remainingKeys.values()].some((count) => count !== 0)) {
      throw new ImportBatchFileFailedError('非目标文件必须保留原始字节、文件名与来源。');
    }

    const noop =
      kind === 'replace' &&
      input.files.length === previousFiles.length &&
      input.files.every(
        (file, position) =>
          sha256Hex(file.bytes) === previousFiles[position]?.sha256 &&
          file.fileName === previousFiles[position]?.fileName &&
          file.source === previousFiles[position]?.source,
      );
    const rebuilt = noop ? null : this.rebuild(conversationId, batchId, input.files);
    return this.withConversationLock(() =>
      this.db.transaction((): MutationOutcome & { batch: ImportBatchDto } => {
        const current = this.requireBatch(conversationId, batchId);
        if (isTerminalBatchStatus(current.status)) throw new ImportBatchActionStaleError('批次已结束，无法修改文件。');
        if (current.version !== expectedVersion) throw new ImportBatchStaleVersionError();
        if (current.analyse_state === 'running') throw new ImportBatchActionStaleError('分析进行中，请先取消或等待完成。');
        if (noop || rebuilt === null) {
          const unchanged: MutationOutcome = {
            idRemap: {},
            droppedDraftItemIds: [],
            identityUnchangedItemIds: (
              this.db
                .prepare('SELECT item_id FROM assistant_import_batch_rows WHERE batch_id = ? ORDER BY ordinal')
                .all(batchId) as { item_id: string }[]
            ).map((row) => row.item_id),
            replacedWithIdenticalDigest: true,
            notices: [],
          };
          this.publishOperation(batchId, kind, clientRequestId, hash, current.version, current.analysis_revision, unchanged);
          return { batch: this.toDtoWithAnalysis(this.batchRow(batchId)!), ...unchanged };
        }
        // Identity and draft migration never depend on `fileIndex`, so a pure reorder already
        // yields an empty remap. `replacedWithIdenticalDigest` only reports the byte-level事实.
        const sameDigestSet =
          rebuilt.files.length === previousFiles.length &&
          rebuilt.files.every((file, position) => file.sha256 === previousFiles[position]?.sha256) &&
          rebuilt.files.every((file, position) => file.fileName === previousFiles[position]?.fileName);
        const outcome: MutationOutcome = {
          idRemap: rebuilt.idRemap,
          droppedDraftItemIds: rebuilt.droppedDraftItemIds,
          identityUnchangedItemIds: rebuilt.identityUnchangedItemIds,
          replacedWithIdenticalDigest: sameDigestSet,
          notices: rebuilt.notices,
        };
        this.applyRebuild(batchId, rebuilt, current.version + 1, current.analysis_revision);
        this.publishOperation(
          batchId,
          kind,
          clientRequestId,
          hash,
          current.version + 1,
          current.analysis_revision,
          outcome,
        );
        return { batch: this.toDtoWithAnalysis(this.batchRow(batchId)!), ...outcome };
      })(),
    );
  }

  /**
   * Cancels a batch. The metadata fence is written *first* (status + cleared review + lease),
   * and only then is an in-flight provider reader aborted, so a late provider write can never
   * land on an already-cancelled batch. Cancelling performs zero financial writes.
   */
  cancel(conversationId: string, batchId: string, input: CancelImportBatchInput): ImportBatchDto {
    const clientRequestId = requireRequestId(input.clientRequestId);
    const expectedVersion = requireInteger(input.expectedVersion, 'expectedVersion');
    const hash = requestDigest([], { operation: 'cancel' });
    const existingOp = this.operationRecord(batchId, 'cancel', clientRequestId);
    if (existingOp !== undefined) {
      if (existingOp.request_hash !== hash) throw new ImportBatchIdempotencyMismatchError();
      return this.toDtoWithAnalysis(this.requireBatch(conversationId, batchId));
    }
    const result = this.withConversationLock(() =>
      this.db.transaction((): ImportBatchDto => {
        const batch = this.requireBatch(conversationId, batchId);
        if (batch.status === 'confirmed') throw new ImportBatchActionStaleError('批次已确认，无法取消。');
        // A *new* request against an already finished batch is stale; only the recorded request id
        // replays (handled above), so a client never mistakes "nothing happened" for "cancelled".
        if (isTerminalBatchStatus(batch.status)) throw new ImportBatchActionStaleError('批次已结束，无法再次取消。');
        if (batch.version !== expectedVersion) throw new ImportBatchStaleVersionError();
        const running = batch.analyse_state === 'running';
        this.writeBatch(batchId, {
          status: 'cancelled',
          review_json: null,
          analyse_state: running ? 'failed' : batch.analyse_state,
          analyse_owner: null,
          analyse_lease_until: null,
          analyse_message: running ? '批次已取消，分析中止。' : batch.analyse_message,
        });
        this.publishOperation(batchId, 'cancel', clientRequestId, hash, batch.version, batch.analysis_revision, null);
        this.refreshDerived(batchId);
        return this.toDtoWithAnalysis(this.batchRow(batchId)!);
      })(),
    );
    this.abortReaders(batchId);
    return result;
  }

  /** Archiving a conversation fences every non-terminal batch, then aborts its readers. */
  fenceArchived(conversationId: string): number {
    const ids = this.db
      .prepare(
        `SELECT id FROM assistant_import_batches
          WHERE conversation_id = ? AND status NOT IN ('confirmed', 'cancelled', 'expired', 'failed')`,
      )
      .all(conversationId) as { id: string }[];
    if (ids.length === 0) return 0;
    this.db.transaction(() => {
      for (const { id } of ids) {
        const batch = this.batchRow(id)!;
        this.writeBatch(id, {
          status: 'cancelled',
          review_json: null,
          analyse_state: batch.analyse_state === 'running' ? 'failed' : batch.analyse_state,
          analyse_owner: null,
          analyse_lease_until: null,
          analyse_message: batch.analyse_state === 'running' ? '对话已归档，分析中止。' : batch.analyse_message,
        });
      }
    })();
    for (const { id } of ids) this.abortReaders(id);
    return ids.length;
  }

  /**
   * Adds the advisory "same platform account + local day + type + amount" hint. Shared by the
   * create and rebuild paths so the same bytes always produce the same stored rows — which is what
   * makes the confirmation-time rebuild comparison meaningful.
   */
  private applySoftDuplicates(items: readonly MergedItem[]): void {
    const cache = new Map<string, Map<string, string>>();
    for (const item of items) {
      if (item.existing || item.possibleDuplicate) continue;
      const key = item.comparisonAccountId ?? '';
      let map = cache.get(key);
      if (map === undefined) {
        map = this.softDuplicates(item.comparisonAccountId);
        cache.set(key, map);
      }
      const hit = map.get(`${item.dateLabel}|${item.type}|${item.amountCents}`);
      if (hit !== undefined) {
        item.possibleDuplicate = true;
        item.duplicateOfNote = hit;
      }
    }
  }

  /**
   * Proves that the retransmitted originals still parse to exactly the rows the review was bound
   * to. Any drift (a different parser result, a different catalogue view) is a stale review, so the
   * client re-reads and re-reviews instead of the server quietly rewriting the reviewed set.
   */
  private verifyRebuild(batchId: string, rebuilt: readonly MergedItem[]): void {
    const stored = this.storedRowProjections(batchId);
    const rebuiltProjection = rebuilt.map((item) => this.itemProjection(item));
    if (digestOf(stored) !== digestOf(rebuiltProjection)) {
      throw new ImportBatchActionStaleError('重传文件与已审核的账单内容不一致，请重新核对后再次提交审核。');
    }
  }

  private itemProjection(item: MergedItem): Record<string, unknown> {
    return {
      itemId: item.itemId,
      ledgerId: item.ledgerId,
      identityKind: item.identityKind,
      canonicalOrigin: item.canonicalOrigin,
      conflictGroup: item.conflictGroup,
      conflictKind: item.conflictKind,
      type: item.type,
      amountCents: item.amountCents,
      sourceTimestamp: item.sourceTimestamp,
      dateLabel: item.dateLabel,
      note: item.note,
      rawStatus: item.rawStatus,
      isRefund: item.isRefund,
      ignored: item.ignored,
      ignoreReason: item.ignoreReason,
      existing: item.existing,
      comparisonAccountId: item.comparisonAccountId,
      sources: item.sources,
      possibleDuplicate: item.possibleDuplicate,
      duplicateOfNote: item.duplicateOfNote,
      legacyLedgerMatch: item.legacyLedgerMatch,
      noteAlternatives: item.noteAlternatives,
      weakDuplicateGroup: item.weakDuplicateGroup,
    };
  }

  /** The same projection, read straight from the stored rows in ordinal order. */
  private storedRowProjections(batchId: string): Record<string, unknown>[] {
    const rows = this.db
      .prepare('SELECT * FROM assistant_import_batch_rows WHERE batch_id = ? ORDER BY ordinal')
      .all(batchId) as StoredRow[];
    return rows.map((row) => ({
      itemId: row.item_id,
      ledgerId: row.ledger_id,
      identityKind: row.identity_kind,
      canonicalOrigin: row.canonical_origin,
      conflictGroup: row.conflict_group,
      conflictKind: row.conflict_kind,
      type: row.type,
      amountCents: row.amount_cents,
      sourceTimestamp: row.source_timestamp,
      dateLabel: row.date_label,
      note: row.note,
      rawStatus: row.raw_status,
      isRefund: row.is_refund === 1,
      ignored: row.ignored === 1,
      ignoreReason: row.ignore_reason,
      existing: row.existing === 1,
      comparisonAccountId: row.comparison_account_id,
      sources: parseJson<ImportBatchSourceRefDto[]>(row.sources_json) ?? [],
      possibleDuplicate: row.possible_duplicate === 1,
      duplicateOfNote: row.duplicate_of_note,
      legacyLedgerMatch: row.legacy_ledger_match === 1,
      noteAlternatives: parseJson<{ fileName: string; note: string }[]>(row.note_alternatives_json) ?? [],
      weakDuplicateGroup: row.weak_dup_group,
    }));
  }

  /** True when any stored file failed to parse (analysis and confirmation are both blocked). */
  hasFailedFile(batchId: string): boolean {
    const batch = this.batchRow(batchId);
    if (batch === undefined) return false;
    return (parseJson<ImportBatchFileDto[]>(batch.files_json) ?? []).some((file) => file.parseStatus === 'failed');
  }

  /**
   * Fails a pending analysis without a fence. Used only when the conversation's provider-work
   * lock was taken between the pre-check and the start, where no provider call ever happened;
   * the batch stays fully reviewable manually.
   */
  markAnalysisNotStarted(batchId: string, message: string): void {
    const batch = this.batchRow(batchId);
    if (batch === undefined || batch.analyse_state === 'running') return;
    this.writeBatch(batchId, { analyse_state: 'failed', analyse_message: message, analyse_owner: null, analyse_lease_until: null });
  }

  /**
   * Appends the lightweight batch card (`kind='text'` + additive `content.importBatch`).
   *
   * Audited by `batchId`, so replaying the create request (or any later re-entry into this method
   * for the same batch) cannot append a second card: the conversation would otherwise show one
   * batch twice and a client retry would look like two imports.
   */
  appendCard(conversationId: string, batchId: string, text: string): void {
    const content = this.cardContent(batchId);
    if (content === null) return;
    const conversations = new AssistantConversationService(this.db, this.now);
    if (this.hasBatchCard(conversationId, batchId)) return;
    conversations.appendMessage({
      conversationId,
      role: 'assistant',
      kind: 'text',
      content: { version: 1, text, ...content },
    });
  }

  /** True when this conversation already carries the card for this batch. */
  private hasBatchCard(conversationId: string, batchId: string): boolean {
    const rows = this.db
      .prepare("SELECT content_json FROM assistant_messages WHERE conversation_id = ? AND kind = 'text'")
      .all(conversationId) as { content_json: string }[];
    return rows.some((row) => parseJson<{ importBatch?: { batchId?: unknown } }>(row.content_json)?.importBatch?.batchId === batchId);
  }

  /** Boot recovery: a `running` analysis from a previous process is failed, never resumed. */
  recoverRunning(): number {
    const rows = this.db
      .prepare("SELECT id FROM assistant_import_batches WHERE analyse_state = 'running'")
      .all() as { id: string }[];
    for (const { id } of rows) {
      this.writeBatch(id, {
        analyse_state: 'failed',
        analyse_owner: null,
        analyse_lease_until: null,
        analyse_message: '服务重启，分析已中止，请显式重试。',
      });
    }
    return rows.length;
  }

  private operationRecord(batchId: string, operation: string, clientRequestId: string) {
    return this.db
      .prepare(
        'SELECT * FROM assistant_import_batch_operations WHERE batch_id = ? AND operation = ? AND client_request_id = ?',
      )
      .get(batchId, operation, clientRequestId) as
      | {
          batch_id: string;
          operation: string;
          client_request_id: string;
          request_hash: string;
          accepted_version: number;
          accepted_revision: number;
          result_json: string | null;
          created_at: number;
        }
      | undefined;
  }

  private publishOperation(
    batchId: string,
    operation: 'analyse' | 'remove' | 'replace' | 'cancel',
    clientRequestId: string,
    requestHash: string,
    acceptedVersion: number,
    acceptedRevision: number,
    result: unknown,
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO assistant_import_batch_operations
           (batch_id, operation, client_request_id, request_hash, accepted_version, accepted_revision, result_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(batchId, operation, clientRequestId, requestHash, acceptedVersion, acceptedRevision, jsonText(result), this.now());
  }

  /**
   * Digests of retransmitted originals in *file index* order, or `null` when the indices are not a
   * permutation of `0..n-1`. Confirmation identity is the set of stored file digests by index:
   * comparing the raw array order made a resend of the same files in a different array order look
   * like a different (and therefore refused) payload after an already-confirmed batch.
   */
  private digestsByFileIndex(
    files: readonly { readonly fileIndex: number; readonly bytes: Buffer }[],
  ): string[] | null {
    const byIndex = new Map<number, string>();
    for (const file of files) {
      if (byIndex.has(file.fileIndex)) return null;
      byIndex.set(file.fileIndex, sha256Hex(file.bytes));
    }
    if (byIndex.size !== files.length) return null;
    const out: string[] = [];
    for (let index = 0; index < files.length; index += 1) {
      const digest = byIndex.get(index);
      if (digest === undefined) return null;
      out.push(digest);
    }
    return out;
  }

  /** Retransmitted originals must match the stored file set exactly, in order. */
  private normalizeRetransmittedFiles(
    stored: readonly ImportBatchFileDto[],
    files: readonly { readonly fileIndex: number; readonly bytes: Buffer }[],
  ): ImportBatchFileInput[] {
    if (files.length !== stored.length) throw new ImportBatchActionStaleError('请重传全部剩余文件的原始内容。');
    const out: ImportBatchFileInput[] = [];
    for (const [position, file] of [...files].sort((a, b) => a.fileIndex - b.fileIndex).entries()) {
      const expected = stored[position];
      if (expected === undefined || file.fileIndex !== position) {
        throw new ImportBatchActionStaleError('文件顺序与批次不一致，请重新上传。');
      }
      if (sha256Hex(file.bytes) !== expected.sha256 || file.bytes.byteLength !== expected.sizeBytes) {
        throw new ImportBatchActionStaleError('文件内容与批次不一致，请重新上传。');
      }
      out.push({ fileName: expected.fileName, source: expected.source as 'auto' | PlatformBillSource, bytes: file.bytes });
    }
    return out;
  }

  // ── review ────────────────────────────────────────────────────────────────

  review(conversationId: string, batchId: string, input: ReviewImportBatchInput): ImportBatchReviewResponseDto {
    return this.withConversationLock(() =>
      this.db.transaction((): ImportBatchReviewResponseDto => {
        const batch = this.requireBatch(conversationId, batchId);
        if (isTerminalBatchStatus(batch.status)) throw new ImportBatchActionStaleError('批次已结束，无法提交审核。');
        if (batch.analyse_state === 'running') throw new ImportBatchActionStaleError('分析仍在进行，请稍后再提交审核。');
        if (batch.version !== input.version) throw new ImportBatchStaleVersionError();
        if (batch.analysis_revision !== input.analysisRevision) throw new ImportBatchStaleVersionError();
        if (this.hasFailedFile(batchId)) throw new ImportBatchFileFailedError('存在解析失败的文件，请先移除或替换该文件。');
        const liveViewRevision = this.computeViewRevision(batchId);
        if (liveViewRevision !== input.viewRevision) {
          throw new ImportBatchActionStaleError('账单、账户或分类视图已变化，请重新读取当前账单和分类后再次提交审核。');
        }
        const currentCategories = this.liveCategories();
        const currentCategoryById = new Map(currentCategories.map((category) => [category.id, category]));
        const currentExistingIds = this.existingIds();
        const currentAccountByName = new Map(
          (this.db.prepare('SELECT id, name, deleted FROM accounts ORDER BY id').all() as { id: string; name: string; deleted: number }[])
            .filter((account) => account.deleted === 0)
            .map((account) => [account.name, account.id]),
        );
        const refreshedItems = this.loadStoredItems(batchId).map((item) => {
          const source = item.sources[0]?.source;
          const expectedAccountName = source === 'wechat' ? '微信' : source === 'alipay' ? '支付宝' : null;
          return {
            ...item,
            existing: currentExistingIds.has(item.ledgerId),
            comparisonAccountId: expectedAccountName === null ? null : currentAccountByName.get(expectedAccountName) ?? null,
          };
        });
        const updateEligibility = this.db.prepare(
          'UPDATE assistant_import_batch_rows SET existing = ?, comparison_account_id = ? WHERE batch_id = ? AND item_id = ?',
        );
        for (const item of refreshedItems) {
          updateEligibility.run(item.existing ? 1 : 0, item.comparisonAccountId, batchId, item.itemId);
        }
        const refreshedById = new Map(refreshedItems.map((item) => [item.itemId, item]));
        const suggestions = parseJson<StoredSuggestion[]>(batch.suggestions_json) ?? [];
        const validSuggestionIds = new Set(suggestions.map((suggestion) => suggestion.suggestionId));
        for (const itemId of input.selectedItemIds) {
          const item = refreshedById.get(itemId);
          if (item === undefined) throw new ImportBatchInvalidError(`账单 ${itemId} 不在当前批次中，请刷新后重试。`);
          if (item.existing) throw new ImportBatchInvalidError(`账单 ${itemId} 已存在于账本中，无需再次导入。`);
          const assignment = input.categoryAssignments[itemId];
          if (assignment?.kind === 'existing') {
            const category = currentCategoryById.get(assignment.categoryId);
            if (category === undefined) throw new ImportBatchCategoryRequiredError('所选分类已不可用，请重新选择。');
            if (category.type !== item.type) throw new ImportBatchCategoryConflictError('分类类型与账单收支类型不一致。');
          } else if (assignment?.kind === 'suggestion' && !validSuggestionIds.has(assignment.suggestionId)) {
            throw new ImportBatchCategoryRequiredError('所选新分类建议已失效，请重新读取分类建议。');
          }
        }
        this.writeBatch(batchId, { category_set_hash: digestOf(currentCategories) });
        const validation = this.validateReview(conversationId, batchId, input);
        const reviewToken = randomBytes(32).toString('base64url');
        const reviewSetDigest = digestOf(input);
        const record: ImportBatchReviewRecord = {
          reviewToken,
          expiresAt: this.now() + MERGED_REVIEW_TTL_SEC * 1000,
          version: batch.version,
          analysisRevision: batch.analysis_revision,
          viewRevision: liveViewRevision,
          reviewSetDigest,
          baseFingerprint: this.computeBaseFingerprint(batchId, batch.version),
          categorySetHash: this.categorySetHash(),
          normalized: {
            selectedItemIds: input.selectedItemIds,
            selectedAssignments: validation.selectedAssignments,
            noteOverrides: input.noteOverrides,
            approvedCategories: input.approvedCategories,
            conflictDecisions: input.conflictDecisions,
          },
          financialSummary: validation.financialSummary,
          serverSummaryDigest: digestOf(validation.summary),
        };
        this.writeBatch(batchId, {
          status: 'reviewed',
          review_json: jsonText(record),
          category_set_hash: record.categorySetHash,
          base_fingerprint: record.baseFingerprint,
          view_revision: liveViewRevision,
        });
        return {
          reviewToken,
          version: record.version,
          analysisRevision: record.analysisRevision,
          viewRevision: record.viewRevision,
          expiresInSec: MERGED_REVIEW_TTL_SEC,
          summary: validation.summary,
        };
      })(),
    );
  }

  /**
   * Same validation as confirmation, so a review can never be issued for a set confirm would
   * reject.
   *
   * Returns the *resolved* review set: every selected row gets a concrete assignment, with the
   * server-resolved fallback materialised where the client did not send one. Confirm consumes that
   * resolved set, which is what keeps the two paths in step (previously a review issued for the
   * fallback succeeded while the identical confirm failed with "missing category").
   */
  private validateReview(
    conversationId: string,
    batchId: string,
    input: ReviewImportBatchInput,
  ): {
    financialSummary: ImportBatchReviewRecord['financialSummary'];
    summary: ImportBatchReviewResponseDto['summary'];
    selectedAssignments: Record<string, ImportCategoryAssignment>;
  } {
    const batch = this.requireBatch(conversationId, batchId);
    if (!Array.isArray(input.selectedItemIds)) throw new ImportBatchInvalidError('selectedItemIds 必须是数组。');
    if (input.selectedItemIds.length === 0) throw new ImportBatchInvalidError('请至少选择一条要导入的账单。');
    if (input.selectedItemIds.length > MERGED_MAX_ITEMS) {
      throw new ImportBatchInvalidError(`一次最多确认 ${MERGED_MAX_ITEMS} 条账单。`);
    }
    if (new Set(input.selectedItemIds).size !== input.selectedItemIds.length) {
      throw new ImportBatchInvalidError('selectedItemIds 不能重复。');
    }
    const files = parseJson<ImportBatchFileDto[]>(batch.files_json) ?? [];
    if (files.some((file) => file.parseStatus === 'failed')) {
      throw new ImportBatchFileFailedError('存在解析失败的文件，请先移除或替换该文件。');
    }
    const items = this.loadStoredItems(batchId);
    const byId = new Map(items.map((item) => [item.itemId, item]));
    const selected: MergedItem[] = [];
    for (const itemId of input.selectedItemIds) {
      const item = byId.get(itemId);
      if (item === undefined) throw new ImportBatchInvalidError(`账单 ${itemId} 不在当前批次中，请刷新后重试。`);
      if (item.amountCents <= 0) throw new ImportBatchInvalidError(`账单 ${itemId} 金额无效，不能导入。`);
      if (item.existing) throw new ImportBatchInvalidError(`账单 ${itemId} 已存在于账本中，无需再次导入。`);
      selected.push(item);
    }

    // Conflict constraints: 0 or 1 per fact/ledger collision group, never both weak members.
    // A supplied decision must name a group that exists in this batch, must not be duplicated and
    // must point at a member of that group: an unknown/duplicated decision makes the rule on
    // `conflictGroup` trivially satisfiable by a tampered payload, which would let one member of a
    // fact conflict be booked without the explicit choice the contract requires.
    const knownGroups = new Set<string>();
    for (const item of items) if (item.conflictGroup !== null) knownGroups.add(item.conflictGroup);
    const decisionByGroup = new Map<string, ImportBatchConflictDecision>();
    for (const decision of input.conflictDecisions) {
      if (decisionByGroup.has(decision.conflictGroup)) {
        throw new ImportBatchInvalidError('conflictDecisions 中同一冲突分组不能重复。');
      }
      if (!knownGroups.has(decision.conflictGroup)) {
        throw new ImportBatchInvalidError('冲突分组不属于当前批次，请重新读取后再次提交审核。');
      }
      if (
        decision.chosenItemId !== null &&
        !items.some(
          (item) => item.itemId === decision.chosenItemId && item.conflictGroup === decision.conflictGroup,
        )
      ) {
        throw new ImportBatchInvalidError('冲突选择必须指向该冲突分组中的账单。');
      }
      decisionByGroup.set(decision.conflictGroup, decision);
    }
    const selectedByGroup = new Map<string, MergedItem[]>();
    for (const item of selected) {
      if (item.conflictGroup === null) continue;
      const bucket = selectedByGroup.get(item.conflictGroup);
      if (bucket === undefined) selectedByGroup.set(item.conflictGroup, [item]);
      else bucket.push(item);
    }
    for (const [group, members] of selectedByGroup) {
      const kind = members[0]!.conflictKind;
      if (group.startsWith('lc:') || kind === 'ledger_collision') {
        throw new ImportBatchIdentityConflictError('标识冲突的记录不能导入，请整组排除后重试。');
      }
      if (group.startsWith('wc:') || kind === 'weak_collision') {
        throw new ImportBatchIdentityConflictError('弱标识冲突记录不能导入，请整组排除后重新审核。');
      }
      if (members.length > 1) {
        throw new ImportBatchIdentityConflictError('同一订单号的冲突记录只能保留一条，请先做出选择。');
      }
      const decision = decisionByGroup.get(group);
      if (decision !== undefined && decision.chosenItemId === null) {
        // The decision says "exclude this whole group", so no member may be selected.
        throw new ImportBatchIdentityConflictError('冲突分组已选择整组排除，不能再选入其中任何一条。');
      }
      if (decision !== undefined && decision.chosenItemId !== null && !members.some((item) => item.itemId === decision.chosenItemId)) {
        throw new ImportBatchInvalidError('冲突选择与所选账单不一致，请重新选择。');
      }
    }
    for (const [group, members] of selectedByGroup) {
      if (members.length !== 1) continue;
      const item = members[0]!;
      const groupMembers = items.filter((candidate) => candidate.conflictGroup === group);
      if (groupMembers.length > 1 && !decisionByGroup.has(group)) {
        throw new ImportBatchIdentityConflictError('同一订单号存在事实冲突，请明确选择要导入的来源或整组排除。');
      }
      void item;
    }

    // Assignments: every selected row needs an explicit, resolvable assignment.
    const suggestions = parseJson<StoredSuggestion[]>(batch.suggestions_json) ?? [];
    const suggestionIds = new Set(suggestions.map((suggestion) => suggestion.suggestionId));
    const currentCategories = this.liveCategories();
    const currentCategoryById = new Map(currentCategories.map((category) => [category.id, category]));
    const live = new Set(currentCategories.map((category) => category.id));
    const approved = new Map(input.approvedCategories.map((category) => [category.suggestionId, category]));
    const assignmentOf = new Map<string, { categoryId: string | null; suggestionId: string | null }>();
    /** The resolved set handed back to the caller and stored in the review record. */
    const resolvedAssignments: Record<string, ImportCategoryAssignment> = {};
    for (const item of selected) {
      const assignment = input.categoryAssignments[item.itemId];
      if (assignment === undefined) {
        // The server-resolved fallback is applied only when it still exists as a live bookable
        // leaf of the same type; otherwise the client must choose explicitly.
        const fallbackId = this.fallbackExistingIdFor(batchId, item.itemId);
        if (fallbackId === null) throw new ImportBatchCategoryRequiredError(`请为「${item.note}」选择分类。`);
        assignmentOf.set(item.itemId, { categoryId: fallbackId, suggestionId: null });
        resolvedAssignments[item.itemId] = { kind: 'existing', categoryId: fallbackId };
        continue;
      }
      if (assignment.kind === 'existing') {
        if (!live.has(assignment.categoryId)) throw new ImportBatchCategoryRequiredError('所选分类已不可用，请重新选择。');
        const category = currentCategories.find((candidate) => candidate.id === assignment.categoryId);
        if (category === undefined || category.type !== item.type) {
          throw new ImportBatchCategoryConflictError('分类类型与账单收支类型不一致。');
        }
        assignmentOf.set(item.itemId, { categoryId: assignment.categoryId, suggestionId: null });
        resolvedAssignments[item.itemId] = { kind: 'existing', categoryId: assignment.categoryId };
        continue;
      }
      if (!suggestionIds.has(assignment.suggestionId)) {
        throw new ImportBatchCategoryRequiredError('所选新分类建议已失效，请重新读取分类建议。');
      }
      const suggestion = suggestions.find((candidate) => candidate.suggestionId === assignment.suggestionId)!;
      if (suggestion.type !== item.type) throw new ImportBatchCategoryConflictError('新分类类型与账单收支类型不一致。');
      const approval = approved.get(assignment.suggestionId);
      if (approval === undefined) {
        throw new ImportBatchCategoryRequiredError('使用新分类必须先在审核中明确批准该分类。');
      }
      assignmentOf.set(item.itemId, { categoryId: null, suggestionId: assignment.suggestionId });
      resolvedAssignments[item.itemId] = { kind: 'suggestion', suggestionId: assignment.suggestionId };
    }

    // Approved proposals: only those actually used by a selected row create/reuse anything.
    const usedSuggestionIds = new Set([...assignmentOf.values()].map((value) => value.suggestionId).filter((id): id is string => id !== null));
    const categoryNameBySuggestion = new Map<string, string>();
    for (const suggestionId of usedSuggestionIds) {
      const approval = approved.get(suggestionId);
      if (approval === undefined) throw new ImportBatchCategoryRequiredError('使用新分类必须先在审核中明确批准该分类。');
      const suggestion = suggestions.find((candidate) => candidate.suggestionId === suggestionId)!;
      const name = requireCategoryName(approval.name);
      const parentId = approval.parentId ?? suggestion.parentId;
      if (approval.type !== suggestion.type) throw new ImportBatchCategoryConflictError('新分类类型与审核建议不一致。');
      // Same rule `master-data-service.requireParentId` applies when a user creates a category by
      // hand: only a live expense *root* may be a parent. Without it a confirmation could attach a
      // new expense leaf under an income category (or under a nested one).
      if (parentId !== null) {
        const parent = this.liveCategories().find((category) => category.id === parentId);
        if (parent === undefined || parent.type !== 0 || parent.parentId !== null || approval.type !== 0) {
          throw new ImportBatchCategoryConflictError('新分类的父级必须是有效的支出一级分类。');
        }
      }
      const sameName = this.liveCategories().filter(
        (category) => category.name === name && category.type === approval.type && category.parentId === parentId,
      );
      if (approval.reuseCategoryId !== null) {
        const candidate = currentCategoryById.get(approval.reuseCategoryId);
        if (
          candidate === undefined ||
          candidate.type !== approval.type ||
          candidate.name !== name ||
          candidate.parentId !== parentId ||
          candidate.type === 0 && currentCategories.some((category) => category.parentId === candidate.id)
        ) {
          throw new ImportBatchCategoryConflictError('指定的复用分类不可用或名称不一致，请重新选择。');
        }
      } else if (sameName.length >= 2) {
        throw new ImportBatchCategoryConflictError(`已存在多个同名「${name}」分类，请指定要复用的分类或改名。`);
      }
      categoryNameBySuggestion.set(suggestionId, name);
    }

    const noteOverrides = new Map<string, string>();
    for (const [itemId, note] of Object.entries(input.noteOverrides)) {
      const item = byId.get(itemId);
      if (item === undefined) throw new ImportBatchInvalidError('备注覆盖包含不属于本批次的账单。');
      if (typeof note !== 'string' || note.length > MERGED_MAX_NOTE_CHARS) {
        throw new ImportBatchInvalidError(`备注最多 ${MERGED_MAX_NOTE_CHARS} 个字符。`);
      }
      // Only a selected row can carry an override into the confirmation. A draft kept for a row the
      // user later unselected is dropped here (it has nothing to write); storing it would break the
      // confirm-side assignment check with a confusing "missing category" error instead.
      if (!selected.includes(item)) continue;
      noteOverrides.set(itemId, note);
    }

    let expenseCents = 0;
    let incomeCents = 0;
    let refundIncomeCents = 0;
    const countsBySuggestion = new Map<string, number>();
    for (const assignment of assignmentOf.values()) {
      if (assignment.suggestionId === null) continue;
      countsBySuggestion.set(assignment.suggestionId, (countsBySuggestion.get(assignment.suggestionId) ?? 0) + 1);
    }

    const categoriesToReuseMap = new Map<string, { categoryId: string; name: string; selectedRows: number }>();
    const categoryPlans = new Map<string, { name: string; type: number; createsCategory: boolean }>();
    /** Planned new entities keyed by the identity confirmation itself matches on. */
    const plannedCreations = new Map<string, { name: string; type: number; selectedRows: number }>();

    // Rows assigned straight to an existing category are reuse too — counted as distinct
    // CATEGORY ENTITIES, not per row, so three rows sharing one category report exactly one.
    for (const assignment of assignmentOf.values()) {
      if (assignment.categoryId === null) continue;
      const category = currentCategoryById.get(assignment.categoryId);
      if (category === undefined) continue;
      const previous = categoriesToReuseMap.get(category.id);
      categoriesToReuseMap.set(category.id, {
        categoryId: category.id,
        name: category.name,
        selectedRows: (previous?.selectedRows ?? 0) + 1,
      });
    }

    for (const [suggestionId, count] of countsBySuggestion) {
      const suggestion = suggestions.find((candidate) => candidate.suggestionId === suggestionId)!;
      const approval = approved.get(suggestionId)!;
      const name = categoryNameBySuggestion.get(suggestionId) ?? suggestion.name;
      const parentId = approval.parentId ?? suggestion.parentId;
      const sameNameMatches = currentCategories.filter(
        (category) => category.name === name && category.type === approval.type && category.parentId === parentId,
      );
      const createsCategory = approval.reuseCategoryId === null && sameNameMatches.length !== 1;
      categoryPlans.set(suggestionId, { name, type: approval.type, createsCategory });
      if (approval.reuseCategoryId !== null) {
        const candidate = currentCategories.find((category) => category.id === approval.reuseCategoryId)!;
        const previous = categoriesToReuseMap.get(candidate.id);
        categoriesToReuseMap.set(candidate.id, {
          categoryId: candidate.id,
          name: candidate.name,
          selectedRows: (previous?.selectedRows ?? 0) + count,
        });
      } else if (sameNameMatches.length === 1) {
        const matched = sameNameMatches[0]!;
        const previous = categoriesToReuseMap.get(matched.id);
        categoriesToReuseMap.set(matched.id, {
          categoryId: matched.id,
          name: matched.name,
          selectedRows: (previous?.selectedRows ?? 0) + count,
        });
      } else {
        // Approval names are editable, so two *distinct* suggestions can be renamed onto the SAME
        // planned entity. Confirmation resolves that entity once (the second row finds the category
        // the first one inserted) and reports `categoriesCreated: 1`, so Review must also count
        // distinct planned entities rather than proposals. The identity key is exactly the tuple
        // confirmation matches on: trimmed name, type and parent.
        const entityKey = JSON.stringify([name, approval.type, parentId]);
        const planned = plannedCreations.get(entityKey);
        if (planned === undefined) plannedCreations.set(entityKey, { name, type: approval.type, selectedRows: count });
        else planned.selectedRows += count;
      }
    }
    const categoriesToCreate = [...plannedCreations.values()];
    const categoriesToReuse = [...categoriesToReuseMap.values()];

    const selectedRows: ImportBatchReviewResponseDto['summary']['selectedRows'][number][] = [];
    const filesSelected = new Map<string, number>();
    for (const item of selected) {
      const assignment = assignmentOf.get(item.itemId)!;
      if (item.type === 0) expenseCents += item.amountCents;
      else {
        incomeCents += item.amountCents;
        if (item.isRefund) refundIncomeCents += item.amountCents;
      }
      const firstSource = item.sources[0];
      if (firstSource !== undefined) filesSelected.set(firstSource.fileName, (filesSelected.get(firstSource.fileName) ?? 0) + 1);
      const categoryId = assignment.categoryId;
      const suggestionId = assignment.suggestionId;
      const categoryPlan = suggestionId === null ? null : categoryPlans.get(suggestionId) ?? null;
      const resolvedCategory = categoryId === null ? null : currentCategories.find((category) => category.id === categoryId) ?? null;
      const resolvedNote = noteOverrides.has(item.itemId) ? noteOverrides.get(item.itemId)! : item.note;
      selectedRows.push({
        itemId: item.itemId,
        type: item.type,
        amountCents: item.amountCents,
        categoryId,
        categoryName: resolvedCategory?.name ?? categoryPlan?.name ?? null,
        categoryType: resolvedCategory?.type ?? categoryPlan?.type ?? null,
        suggestionId,
          approvedNewCategoryName: categoryPlan?.createsCategory === true ? categoryPlan.name : null,
          note: resolvedNote,
      });
    }
    const summary: ImportBatchReviewResponseDto['summary'] = {
      selected: selected.length,
      amountCents: expenseCents + incomeCents,
      expenseCents,
      incomeCents,
      refundIncomeCents,
      categoriesToCreate,
      categoriesToReuse,
      selectedRows,
      files: [...filesSelected.entries()].map(([fileName, selectedRows]) => ({ fileName, selectedRows })),
      excluded: items.length - selected.length,
      existing: items.filter((item) => item.existing).length,
      conflicts: items.filter((item) => item.conflictGroup !== null).length,
      counts: {
        total: items.length,
        selected: selected.length,
        notSelected: items.length - selected.length,
        preexisting: items.filter((item) => item.existing).length,
        ruleIgnored: items.filter((item) => item.ignored).length,
        conflictRows: items.filter((item) => item.conflictGroup !== null).length,
        // The protocol does not carry a trusted, persisted user-exclusion bit. Do not infer it from
        // `ignored`, because parser rule reasons and client selection are separate dimensions.
        userExcluded: null,
      },
    };
    return {
      financialSummary: {
        selected: selected.length,
        expenseCents,
        incomeCents,
        refundIncomeCents,
      },
      summary,
      selectedAssignments: resolvedAssignments,
    };
  }

  /** Server-resolved fallback leaf for a stored row, if the row still has one. */
  private fallbackExistingIdFor(batchId: string, itemId: string): string | null {
    const row = this.db
      .prepare('SELECT fallback_effective_existing_id, type FROM assistant_import_batch_rows WHERE batch_id = ? AND item_id = ?')
      .get(batchId, itemId) as { fallback_effective_existing_id: string | null; type: number } | undefined;
    const candidateId = row?.fallback_effective_existing_id ?? null;
    if (candidateId === null || row === undefined) return null;
    const live = this.liveCategories().find((category) => category.id === candidateId);
    return live !== undefined && live.type === row.type ? live.id : null;
  }

  // ── confirm ───────────────────────────────────────────────────────────────

  confirm(
    conversationId: string,
    batchId: string,
    input: ConfirmImportBatchInput,
  ): { batch: ImportBatchDto; result: ImportBatchResultDto; replayed: boolean } {
    const batch = this.requireBatch(conversationId, batchId);
    const reviewToken = typeof input.reviewToken === 'string' ? input.reviewToken : '';
    if (reviewToken === '') throw new ImportBatchInvalidError('reviewToken 不能为空。');
    const expectedVersion = requireInteger(input.expectedVersion, 'expectedVersion');

    // Already confirmed: identical token + identical file digests returns the original result.
    if (batch.status === 'confirmed') {
      const provenance = parseJson<StoredProvenance>(batch.provenance_json);
      if (provenance === null || provenance.reviewToken !== reviewToken) {
        throw new ImportBatchAlreadyConfirmedError();
      }
      const digests = this.digestsByFileIndex(input.files);
      const same =
        digests !== null &&
        provenance.fileDigests.length === digests.length &&
        provenance.fileDigests.every((digest, index) => digest === digests[index]);
      if (!same) throw new ImportBatchAlreadyConfirmedError();
      const stored = parseJson<ImportBatchResultDto>(batch.result_json);
      if (stored === null) throw new ImportBatchAlreadyConfirmedError();
      return { batch: this.toDtoWithAnalysis(batch), result: stored, replayed: true };
    }
    if (isTerminalBatchStatus(batch.status)) throw new ImportBatchActionStaleError('批次已结束，无法确认。');

    const storedFiles = parseJson<ImportBatchFileDto[]>(batch.files_json) ?? [];
    // A failed file blocks confirmation independently of the review record, so the client gets the
    // specific reason instead of a generic "review is stale".
    if (storedFiles.some((file) => file.parseStatus === 'failed')) {
      throw new ImportBatchFileFailedError('存在解析失败的文件，请先移除或替换该文件。');
    }
    // The originals are re-decoded, re-hashed and re-parsed OUTSIDE the write transaction: the
    // CPU-heavy work must not run while holding SQLite's write lock.
    const retransmitted = this.normalizeRetransmittedFiles(storedFiles, input.files);
    this.verifyRebuild(batchId, this.rebuild(conversationId, batchId, retransmitted).items);
    const review = parseJson<ImportBatchReviewRecord>(batch.review_json);
    if (review === null) throw new ImportBatchActionStaleError('请先提交审核，再确认导入。');
    if (review.reviewToken !== reviewToken) throw new ImportBatchActionStaleError('审核已失效，请重新提交审核。');
    if (review.expiresAt < this.now()) throw new ImportBatchActionStaleError('审核已过期，请重新提交审核。');

    return this.withConversationLock(() =>
      this.db.transaction((): { batch: ImportBatchDto; result: ImportBatchResultDto; replayed: boolean } => {
        const current = this.requireBatch(conversationId, batchId);
        if (current.status === 'confirmed') {
          const provenance = parseJson<StoredProvenance>(current.provenance_json);
          const digests = this.digestsByFileIndex(input.files);
          const same =
            provenance !== null &&
            provenance.reviewToken === reviewToken &&
            digests !== null &&
            provenance.fileDigests.length === digests.length &&
            provenance.fileDigests.every((digest, index) => digest === digests[index]);
          if (!same) throw new ImportBatchAlreadyConfirmedError();
          const stored = parseJson<ImportBatchResultDto>(current.result_json);
          if (stored === null) throw new ImportBatchAlreadyConfirmedError();
          return { batch: this.toDtoWithAnalysis(current), result: stored, replayed: true };
        }
        if (isTerminalBatchStatus(current.status)) throw new ImportBatchActionStaleError('批次已结束，无法确认。');
        if (current.version !== expectedVersion) throw new ImportBatchStaleVersionError();
        if (current.analysis_revision !== review.analysisRevision) {
          throw new ImportBatchActionStaleError('分析结果已更新，请重新提交审核。');
        }
        if (this.computeViewRevision(batchId) !== review.viewRevision) {
          throw new ImportBatchActionStaleError('账单、账户或分类视图已变化，请重新读取并提交审核。');
        }
        if (current.category_set_hash !== this.categorySetHash()) {
          throw new ImportBatchActionStaleError('分类目录已变化，请重新读取并提交审核。');
        }
        const baseFingerprint = this.computeBaseFingerprint(batchId, current.version);
        if (baseFingerprint !== review.baseFingerprint) {
          throw new ImportBatchActionStaleError('批次内容已变化，请重新读取并提交审核。');
        }
        const items = this.loadStoredItems(batchId);
        const byId = new Map(items.map((item) => [item.itemId, item]));
        const existingNow = this.existingIds();
        const written: MergedItem[] = [];
        for (const itemId of review.normalized.selectedItemIds) {
          const item = byId.get(itemId);
          if (item === undefined) throw new ImportBatchActionStaleError('所选账单已变化，请重新提交审核。');
          if (existingNow.has(item.ledgerId)) {
            // Selectable at review time, already present now: rebase instead of skipping silently.
            throw new ImportBatchActionStaleError('所选账单已被其他操作写入账本，请重新读取并提交审核。');
          }
          written.push(item);
        }
        const liveCategories = this.liveCategories();
        const accountCache = new Map<string, { id: string; created: boolean }>();
        let accountsCreated = 0;
        const resolveAccount = (source: PlatformBillSource): string => {
          const cached = accountCache.get(source);
          if (cached !== undefined) return cached.id;
          const name = source === 'wechat' ? '微信' : '支付宝';
          const accountType = source === 'wechat' ? 4 : 5;
          const existing = this.db
            .prepare('SELECT id FROM accounts WHERE name = ? AND deleted = 0 ORDER BY sort_order LIMIT 1')
            .get(name) as { id: string } | undefined;
          if (existing !== undefined) {
            accountCache.set(source, { id: existing.id, created: false });
            return existing.id;
          }
          const id = randomUUID();
          this.db
            .prepare(
              `INSERT INTO accounts (id, name, type, initial_balance_cents, sort_order, is_builtin, deleted, updated_at)
               VALUES (?, ?, ?, 0, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM accounts), 0, 0, ?)`,
            )
            .run(id, name, accountType, this.now());
          accountsCreated += 1;
          accountCache.set(source, { id, created: true });
          return id;
        };

        const suggestions = parseJson<StoredSuggestion[]>(current.suggestions_json) ?? [];
        const approvedById = new Map(
          review.normalized.approvedCategories.map((category) => [category.suggestionId, category]),
        );
        const usedSuggestionIds = new Set(
          Object.values(review.normalized.selectedAssignments)
            .map((assignment) => (assignment.kind === 'suggestion' ? assignment.suggestionId : null))
            .filter((id): id is string => id !== null),
        );
        const categoryIdByItem = new Map<string, string>();
        const categoryBySuggestion = new Map<string, string>();
        // Counts are DISTINCT category entities, not rows: three rows sharing one approved new
        // category create exactly one category, and the same entity is never counted as both
        // created and reused. `createdCategoryIds` wins when a later row reuses an entity this
        // confirmation just created.
        const createdCategoryIds = new Set<string>();
        const usedCategoryIds = new Set<string>();
        let categoriesSkippedUnused = 0;
        const sourceCache = new Map<string, PlatformBillSource>();
        const sourceOf = (item: MergedItem): PlatformBillSource => {
          const cached = sourceCache.get(item.itemId);
          if (cached !== undefined) return cached;
          const row = this.db
            .prepare('SELECT sources_json FROM assistant_import_batch_rows WHERE batch_id = ? AND item_id = ?')
            .get(batchId, item.itemId) as { sources_json: string } | undefined;
          const first = parseJson<ImportBatchSourceRefDto[]>(row?.sources_json ?? '[]')?.[0];
          const resolved: PlatformBillSource = first?.source === 'alipay' ? 'alipay' : 'wechat';
          sourceCache.set(item.itemId, resolved);
          return resolved;
        };
        for (const itemId of review.normalized.selectedItemIds) {
          const assignment = review.normalized.selectedAssignments[itemId];
          if (assignment === undefined) {
            // The review record is issued only after every selected row resolved to a concrete
            // assignment, so an absent one means the stored record does not match the row set any
            // more — a stale review, not a client that still has to choose.
            throw new ImportBatchActionStaleError('审核内容与当前账单不一致，请重新提交审核。');
          }
          if (assignment.kind === 'existing') {
            if (!liveCategories.some((category) => category.id === assignment.categoryId)) {
              throw new ImportBatchActionStaleError('所选分类已不可用，请重新提交审核。');
            }
            categoryIdByItem.set(itemId, assignment.categoryId);
            usedCategoryIds.add(assignment.categoryId);
            continue;
          }
          const suggestion = suggestions.find((candidate) => candidate.suggestionId === assignment.suggestionId);
          const approval = approvedById.get(assignment.suggestionId);
          if (suggestion === undefined || approval === undefined) {
            throw new ImportBatchActionStaleError('新分类建议已失效，请重新提交审核。');
          }
          const name = requireCategoryName(approval.name);
          const parentId = approval.parentId ?? suggestion.parentId;
          // Re-validated inside the transaction against the live catalogue (the same rule review
          // applies), so a parent deleted or retyped between review and confirm cannot be used.
          if (parentId !== null) {
            const parent = liveCategories.find((category) => category.id === parentId);
            if (parent === undefined || parent.type !== 0 || parent.parentId !== null || approval.type !== 0) {
              throw new ImportBatchActionStaleError('新分类的父级已不可用，请重新提交审核。');
            }
          }
          const pool = this.liveCategories();
          const sameName = pool.filter(
            (category) => category.name === name && category.type === approval.type && category.parentId === parentId,
          );
          let resolvedId: string;
          if (approval.reuseCategoryId !== null) {
            const candidate = pool.find((category) => category.id === approval.reuseCategoryId);
            if (
              candidate === undefined ||
              candidate.type !== approval.type ||
              candidate.name !== name ||
              candidate.parentId !== parentId
            ) {
              throw new ImportBatchActionStaleError('指定复用的分类已不可用，请重新提交审核。');
            }
            resolvedId = candidate.id;
            usedCategoryIds.add(resolvedId);
          } else if (sameName.length === 1) {
            resolvedId = sameName[0]!.id;
            usedCategoryIds.add(resolvedId);
          } else if (sameName.length >= 2) {
            throw new ImportBatchCategoryConflictError(`已存在多个同名「${name}」分类，请指定要复用的分类或改名。`);
          } else {
            const id = randomUUID();
            this.db
              .prepare(
                `INSERT INTO categories (id, name, type, parent_id, icon, color, sort_order, is_builtin, deleted, updated_at)
                 VALUES (?, ?, ?, ?, 'other', ?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM categories WHERE type = ?), 0, 0, ?)`,
              )
              .run(id, name, approval.type, parentId, 0xff9e9e9e, approval.type, this.now());
            resolvedId = id;
            createdCategoryIds.add(id);
          }
          categoryBySuggestion.set(assignment.suggestionId, resolvedId);
          categoryIdByItem.set(itemId, resolvedId);
        }
        const categoriesCreated = createdCategoryIds.size;
        // Reused is every used category entity that wasn't created in this confirmation.
        const categoriesReused = [...usedCategoryIds].filter((id) => !createdCategoryIds.has(id)).length;
        categoriesSkippedUnused = review.normalized.approvedCategories.filter(
          (approved) => !usedSuggestionIds.has(approved.suggestionId),
        ).length;

        const insert = this.db.prepare(
          `INSERT INTO transactions
             (id, type, amount_cents, category_id, account_id, date, note, tags_json, is_refund, deleted, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, 0, ?)`,
        );
        let expenseCents = 0;
        let incomeCents = 0;
        const at = this.now();
        for (const item of written) {
          const categoryId = categoryIdByItem.get(item.itemId);
          if (categoryId === undefined) throw new ImportBatchCategoryRequiredError('缺少分类选择，请重新提交审核。');
          const date = dateLabelToEpoch(item.dateLabel);
          if (date === null) throw new ImportBatchActionStaleError('账单日期无效，请重新提交审核。');
          const override = review.normalized.noteOverrides[item.itemId];
          const note = override !== undefined ? override : item.note;
          if (note.length > MERGED_MAX_NOTE_CHARS) throw new ImportBatchInvalidError('备注最多 200 个字符。');
          const accountId = resolveAccount(sourceOf(item));
          insert.run(
            item.ledgerId,
            item.type,
            item.amountCents,
            categoryId,
            accountId,
            date,
            note,
            item.isRefund ? 1 : 0,
            at,
          );
          if (item.type === 0) expenseCents += item.amountCents;
          else incomeCents += item.amountCents;
        }

        const result: ImportBatchResultDto = {
          inserted: written.length,
          selected: written.length,
          excluded: items.length - written.length,
          preexisting: items.filter((item) => item.existing).length,
          expenseCents,
          incomeCents,
          accountsCreated,
          categoriesCreated,
          categoriesReused,
          categoriesSkippedUnused,
          warnings: [],
        };
        const provenance: StoredProvenance = {
          reviewToken,
          fileDigests: storedFiles.map((file) => file.sha256),
          confirmKey: digestOf({ reviewToken, files: storedFiles.map((file) => file.sha256) }),
        };
        this.writeBatch(batchId, {
          status: 'confirmed',
          review_json: null,
          provenance_json: jsonText(provenance),
          result_json: jsonText(result),
        });
        // The outcome message is written in the same transaction as the bills, so the chat can
        // never show "imported" for a batch that rolled back. It carries no token and no rows.
        new AssistantConversationService(this.db, this.now).appendMessage({
          conversationId,
          role: 'assistant',
          kind: 'result',
          content: {
            version: 1,
            text:
              `账单导入完成：写入 ${result.inserted} 条，新建分类 ${result.categoriesCreated} 个，` +
              `复用分类 ${result.categoriesReused} 个，未选中 ${result.excluded} 条。`,
            result: {
              version: 1,
              toolName: 'platform-import.prepare',
              summary: `已导入 ${result.inserted} 条账单记录。`,
              data: {
                batchId,
                inserted: result.inserted,
                selected: result.selected,
                excluded: result.excluded,
                preexisting: result.preexisting,
                expenseCents: result.expenseCents,
                incomeCents: result.incomeCents,
                categoriesCreated: result.categoriesCreated,
                categoriesReused: result.categoriesReused,
                categoriesSkippedUnused: result.categoriesSkippedUnused,
              },
            },
          },
        });
        return { batch: this.toDtoWithAnalysis(this.batchRow(batchId)!), result, replayed: false };
      })(),
    );
  }

  /** Batch/card metadata for the assistant message. Never contains rows or the review token. */
  cardContent(batchId: string): Record<string, unknown> | null {
    const batch = this.batchRow(batchId);
    if (batch === undefined) return null;
    const summary = parseJson<ImportBatchSummaryDto>(batch.summary_json) ?? null;
    const suggestions = (parseJson<StoredSuggestion[]>(batch.suggestions_json) ?? []).slice(
      0,
      MERGED_MAX_CATEGORY_SUGGESTIONS,
    );
    return {
      version: 1,
      importBatch: {
        batchId: batch.id,
        conversationId: batch.conversation_id,
        version: batch.version,
        status: batch.status,
        analysisState: batch.analyse_state,
        analysisRevision: batch.analysis_revision,
        viewRevision: batch.view_revision,
        files: (parseJson<ImportBatchFileDto[]>(batch.files_json) ?? []).map((file) => ({
          fileName: file.fileName,
          fileIndex: file.fileIndex,
          source: file.source,
          sizeBytes: file.sizeBytes,
          parseStatus: file.parseStatus,
        })),
        summary: summary === null
          ? null
          : {
              totalItems: summary.totalItems,
              importable: summary.importable,
              existing: summary.existing,
              ignored: summary.ignored,
              expenseCents: summary.expenseCents,
              incomeCents: summary.incomeCents,
              unparsedFiles: summary.unparsedFiles,
            },
        suggestions: suggestions.map((suggestion) => ({
          suggestionId: suggestion.suggestionId,
          origin: suggestion.origin,
          name: suggestion.name,
          type: suggestion.type,
        })),
        notices: (summary?.notices ?? []).slice(0, 20).map((notice) => ({ code: notice.code, detail: notice.detail })),
      },
    };
  }
}

const MERGED_MAX_CATEGORY_SUGGESTIONS = 20;

function requireCategoryName(value: unknown): string {
  if (typeof value !== 'string') throw new ImportBatchInvalidError('分类名称必须是文本。');
  const name = value.trim();
  if (name === '' || name.length > MERGED_MAX_CATEGORY_NAME_CHARS) {
    throw new ImportBatchInvalidError(`分类名称需为 1–${MERGED_MAX_CATEGORY_NAME_CHARS} 个字符。`);
  }
  return name;
}

function parsePageLimit(value: unknown, fallback: number, max: number): number {
  if (value === undefined || value === '') return fallback;
  const raw = typeof value === 'number' ? value : typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(raw) || raw < 1 || raw > max) {
    throw new ImportBatchInvalidError(`分页参数无效：limit 必须是 1–${max} 的整数。`);
  }
  return raw;
}

function rowFilterClause(filter: string): { clause: string; params: unknown[] } {
  switch (filter) {
    case 'all':
      return { clause: '', params: [] };
    case 'importable':
      return {
        clause: "NOT EXISTS (SELECT 1 FROM transactions t WHERE t.id = assistant_import_batch_rows.ledger_id) AND amount_cents > 0 AND COALESCE(conflict_kind, '') NOT IN ('weak_collision', 'ledger_collision')",
        params: [],
      };
    case 'existing':
      return { clause: 'EXISTS (SELECT 1 FROM transactions t WHERE t.id = assistant_import_batch_rows.ledger_id)', params: [] };
    case 'ignored':
      return { clause: 'ignored = 1', params: [] };
    case 'conflict':
      return { clause: 'conflict_group IS NOT NULL', params: [] };
    case 'legacy_pb':
      return { clause: 'legacy_ledger_match = 1', params: [] };
    case 'weak_duplicate':
      return { clause: 'weak_dup_group IS NOT NULL', params: [] };
    default: {
      const match = /^suggestion:(.+)$/.exec(filter);
      if (match !== null) {
        return { clause: 'ai_new_suggestion_id = ? OR fallback_new_other_suggestion_id = ?', params: [match[1], match[1]] };
      }
      throw new ImportBatchInvalidError('filter 取值无效。');
    }
  }
}

function producedTextBytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** Maps every feature budget failure onto the single documented limit error. */
function mapLimitError(error: unknown): Error {
  if (error instanceof ImportBatchLimitError) return error;
  if (error instanceof PlatformBillsLimitError) return new ImportBatchLimitError(error.message);
  if (error instanceof XlsxLimitError) return new ImportBatchLimitError(error.message);
  if (error instanceof DecodeBillLimitError) return new ImportBatchLimitError(error.message);
  if (error instanceof Error) return new ImportBatchLimitError(error.message);
  return new ImportBatchLimitError('账单处理超出资源限制，请拆分文件后重试。');
}

void AiConfigService;
void canonicalJson;
void compareItems;
void identifyRow;
void simpleHash;
void canonicalOrigin;
void legacyLedgerId;
