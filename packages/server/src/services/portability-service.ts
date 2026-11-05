/**
 * Data portability: CSV export/import and the backup listing (T15).
 *
 * ## Why the file is CSV and not a database dump
 *
 * `cli.js backup` already snapshots the whole database, and that is the right format for
 * restoration. It is useless for the other two things a person wants: checking their
 * figures in Excel, and moving their ledger somewhere new. A binary SQLite file fails
 * both, so this module produces text a spreadsheet can open.
 *
 * ## Three decisions worth knowing before changing anything here
 *
 * 1. **Deduplication keys on the exported `id`.** A natural key (date + amount + note)
 *    would treat two identical coffees on one day as one bill and drop a real row. Losing
 *    data is the one failure this feature must not have.
 * 2. **Import is all-or-nothing, in one transaction.** Failures here almost always mean
 *    the file is wrong, not that row 37 happens to be wrong, and a half-imported ledger is
 *    harder to reason about than a rejected one.
 * 3. **An unknown category or account name fails the import** rather than being created on
 *    the fly or the row being skipped. Silently inventing master data would pollute a
 *    table the user curates, and silently dropping a row would lose money.
 *
 * Encoding is UTF-8 **with a BOM**: without it Windows Excel decodes the bytes using the
 * local code page and every Chinese character is garbage. `packages/shared/src/csv.ts`
 * owns the escaping rules.
 */
import { randomUUID } from 'node:crypto';
import { TagCatalogService } from './tag-catalog-service.js';
import { basename, join } from 'node:path';
import { mkdirSync, readdirSync, statSync } from 'node:fs';
import {
  encodeCsvWithBom,
  formatCents,
  paletteSlot,
  parseCsvWithHeader,
  parsePlatformBills,
  ACCOUNT_TYPE_ALIPAY,
  ACCOUNT_TYPE_WECHAT,
  CATEGORY_TYPE_INCOME,
  type CsvRow,
  type FundPurpose,
  type PlatformBillSource,
} from '@jizhang/shared';
import { createBackup } from '../cli-db.js';
import type { Db } from '../db/index.js';
import { decodeBillFile } from './bill-decode.js';
import { parseFundPurpose, TransactionService, ValidationError } from './transaction-service.js';
import { writeFundPurpose } from './financial-fund-purpose-store.js';
import { writeBillPurposeOverride } from './financial-purpose-store.js';

/** The columns of the transactions export. Order is the file's contract. */
export const TRANSACTION_COLUMNS = [
  'id',
  'date',
  'type',
  'amount',
  'category',
  'account',
  'note',
  'tags',
  'isRefund',
  'fundPurpose',
] as const;

/** Legacy CSV exports predate the optional purpose evidence column. */
const OPTIONAL_TRANSACTION_COLUMNS: readonly string[] = ['fundPurpose'];

/**
 * The columns of the salaries export.
 *
 * `account` mirrors the transactions export: a salary now lands in an account, and a
 * CSV-only backup that dropped that column would not be able to say where the money went.
 * The file is export-only (there is no salary importer), so extending it is additive.
 */
export const SALARY_COLUMNS = ['id', 'date', 'amount', 'account', 'note', 'allocations'] as const;
export const RECURRING_COLUMNS = [
  'id',
  'name',
  'type',
  'amount',
  'category',
  'frequency',
  'anchorDate',
  'nextDueDate',
  'enabled',
  'hasOlderDue',
] as const;
export const TRANSFER_COLUMNS = ['id', 'date', 'amount', 'from', 'to', 'note'] as const;

export interface ImportResult {
  /** Rows inserted by this call. */
  readonly inserted: number;
  /** Rows already present, matched by `id`. */
  readonly skipped: number;
  /** Data rows read from the file. */
  readonly total: number;
  /**
   * Rows whose CSV carried no purpose evidence and were therefore left explicitly
   * unassigned. They are not an error: older files simply never recorded a purpose.
   */
  readonly unassignedPurpose?: number;
}

/** One platform bill row as shown in the import preview table. */
export interface PlatformImportRowDto {
  readonly id: string;
  readonly dateLabel: string;
  readonly comparisonAccountId: string | null;
  readonly externalId: string | null;
  /** 0 expense, 1 income — before ignore rules. */
  readonly type: number;
  readonly amountCents: number;
  readonly note: string;
  readonly isRefund: boolean;
  readonly refundWarning: string | null;
  readonly rawStatus: string;
  readonly counterparty: string;
  readonly sourceCategory: string;
  /** Keyword-suggested category name; the client may override before confirm. */
  readonly categoryName: string;
  readonly accountName: string;
  readonly ignored: boolean;
  readonly ignoreReason: string | null;
  /** True when a transaction with this id already exists (will be skipped). */
  readonly alreadyExists: boolean;
  /**
   * Soft match: same platform account + local date + type + amount already in the
   * ledger under a *different* id (typically a hand-entered bill). Still importable,
   * but the UI defaults these to unchecked.
   */
  readonly possibleDuplicate: boolean;
  /** Note of the first matching ledger row, for the preview hint. */
  readonly duplicateOfNote: string | null;
}

/** Result of a WeChat/Alipay platform bill import (or dry-run). */
export interface PlatformImportResult {
  readonly source: PlatformBillSource;
  readonly dryRun: boolean;
  readonly inserted: number;
  readonly skipped: number;
  readonly ignored: number;
  /** All data rows seen, including ignored ones. */
  readonly total: number;
  /** Rows that passed the platform ignore rules (may still be skipped as duplicates). */
  readonly importable: number;
  /** Importable + not-yet-existing + in the selection — what confirm will write. */
  readonly selected: number;
  readonly accountsCreated: number;
  readonly categoriesCreated: number;
  readonly dateFrom: string | null;
  readonly dateTo: string | null;
  /** Expense/income totals for the *selected* set (not the whole file). */
  readonly expenseCents: number;
  readonly incomeCents: number;
  readonly encoding: string;
  readonly warnings: string[];
  /** Full preview table (ignored + importable) for the UI. */
  readonly rows: readonly PlatformImportRowDto[];
}

export interface PlatformImportOptions {
  /** Assistant-only strict existing-ID review; legacy name import remains unchanged. */
  readonly strictCategories?: boolean;
  readonly categoryIds?: Readonly<Record<string, string>>;
  readonly noteOverrides?: Readonly<Record<string, string>>;
  readonly source?: 'auto' | PlatformBillSource;
  readonly dryRun?: boolean;
  readonly fileName?: string;
  /**
   * When omitted/null → import every importable non-duplicate row.
   * When an array (including empty) → import only ids in the set.
   */
  readonly selectedIds?: readonly string[] | null;
  /** Per-row category name overrides, keyed by platform row id. */
  readonly categoryOverrides?: Readonly<Record<string, string>>;
}

export interface BackupFileDto {
  /** File name only — never the host path, which is both useless here and a leak. */
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly createdAtMs: number;
}

export interface PortabilityServiceOptions {
  readonly dataDir: string;
  readonly dbFile?: string | undefined;
  readonly actorId?: string | undefined;
  readonly now?: (() => number) | undefined;
}

/** `"2026-09-11"` in LOCAL time — the same convention the app's date inputs use. */
function dateOnlyLabel(epochMs: number): string {
  const date = new Date(epochMs);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

/**
 * Parses `"2026-09-11"` back to local midnight.
 *
 * Component-by-component, NOT `new Date(string)`: the string form is parsed as UTC, which
 * shifts every date by a day for anyone not on UTC. That bug has appeared in this project
 * before, which is why the parsing lives here rather than inline.
 */
function parseDateLabel(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(year, month - 1, day);
  // Rejects "2026-02-31", which `new Date` would silently roll into March.
  if (date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date.getTime();
}

/** `"19.99"` → `1999`. Rejects anything that is not a non-negative decimal. */
function parseAmountToCents(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '' || !/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const cents = Math.round(Number(trimmed) * 100);
  return Number.isFinite(cents) ? cents : null;
}

export class PortabilityService {
  private readonly db: Db;
  private readonly dataDir: string;
  private readonly dbFile: string;
  private readonly actorId: string | null;

  constructor(db: Db, options: PortabilityServiceOptions) {
    this.db = db;
    this.dataDir = options.dataDir;
    this.dbFile = options.dbFile ?? db.name;
    this.actorId = options.actorId ?? null;
  }

  /** Current, read-only heuristic matches. Facts must come from a stored preview, not the client. */
  duplicateCandidates(source: Record<string, unknown>, limitInput: unknown, cursorInput: unknown, readAt = Date.now()) {
    const limit = limitInput === undefined ? 20 : typeof limitInput === 'string' && /^[1-9]\d*$/.test(limitInput) ? Number(limitInput) : NaN;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50 || (cursorInput !== undefined && (typeof cursorInput !== 'string' || cursorInput.length === 0 || cursorInput.length > 100))) {
      throw new ValidationError('分页参数无效：limit 为1–50，cursor 为有效账单编号。');
    }
    if (!Object.hasOwn(source, 'comparisonAccountId') || typeof source['dateLabel'] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(source['dateLabel']) || (source['type'] !== 0 && source['type'] !== 1) || typeof source['amountCents'] !== 'number' || !Number.isSafeInteger(source['amountCents']) || source['amountCents'] <= 0 || (source['comparisonAccountId'] !== null && typeof source['comparisonAccountId'] !== 'string')) {
      throw new ValidationError('旧预览缺少对比事实，请重新上传账单并预览。');
    }
    const [year, month, day] = source['dateLabel'].split('-').map(Number);
    const start = new Date(year!, month! - 1, day!);
    if (start.getFullYear() !== year || start.getMonth() !== month! - 1 || start.getDate() !== day) throw new ValidationError('预览日期无效，请重新上传账单并预览。');
    const end = new Date(year!, month! - 1, day! + 1);
    const where = 'account_id = ? AND date >= ? AND date < ? AND type = ? AND amount_cents = ? AND deleted = 0';
    const params = [source['comparisonAccountId'], start.getTime(), end.getTime(), source['type'], source['amountCents']];
    const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE ${where}`).get(...params) as { n: number }).n;
    const ids = this.db.prepare(`SELECT id FROM transactions WHERE ${where} AND id > ? ORDER BY id LIMIT ?`).all(...params, cursorInput ?? '', limit + 1) as { id: string }[];
    const accounts = this.nameMap('accounts');
    const categories = this.nameMap('categories');
    const transactions = new TransactionService(this.db);
    const items = ids.slice(0, limit).map(({ id }) => {
      const row = transactions.getById(id)!;
      return { ...row, accountName: accounts.get(row.accountId) ?? null, categoryName: categories.get(row.categoryId) ?? null };
    });
    return { source, total, items, nextCursor: ids.length > limit ? items.at(-1)?.id ?? null : null, readAt, rationale: '同平台账户、服务端本地同日、同类型、同金额，仅为疑似重复线索，不证明是同一笔账。' };
  }

  /** `<dataDir>/backups`, matching what `cli.js backup` writes to by default. */
  private backupsDir(): string {
    return join(this.dataDir, 'backups');
  }

  // ── export ─────────────────────────────────────────────────────────────────

  private nameMap(table: 'categories' | 'accounts'): Map<string, string> {
    const map = new Map<string, string>();
    // Soft-deleted rows are included: a historical bill must still be labelled with the
    // category it was filed under, exactly as the budget page does.
    for (const row of this.db.prepare(`SELECT id, name FROM ${table}`).all() as {
      id: string;
      name: string;
    }[]) {
      map.set(row.id, row.name);
    }
    return map;
  }

  exportTransactionsCsv(): string {
    const categories = this.nameMap('categories');
    const accounts = this.nameMap('accounts');
    const rows: CsvRow[] = [[...TRANSACTION_COLUMNS]];

    const query = this.db
      .prepare(
        `SELECT t.id, t.type, t.amount_cents, t.category_id, t.account_id, t.date, t.note, t.tags_json, t.is_refund,
                p.purpose AS fund_purpose
           FROM transactions t
           LEFT JOIN financial_fund_purposes p ON p.transaction_id = t.id
          WHERE t.deleted = 0
          ORDER BY t.date, t.updated_at, t.id`,
      )
      .all() as {
      id: string;
      type: number;
      amount_cents: number;
      category_id: string;
      account_id: string;
      date: number;
      note: string;
      tags_json: string;
      is_refund: number;
      fund_purpose: string | null;
    }[];

    for (const row of query) {
      let tags: string[] = [];
      try {
        const decoded: unknown = JSON.parse(row.tags_json);
        if (Array.isArray(decoded)) tags = decoded.filter((t): t is string => typeof t === 'string');
      } catch {
        // A malformed tag blob must not abort an export.
        tags = [];
      }

      rows.push([
        row.id,
        dateOnlyLabel(row.date),
        // Human-readable rather than 0/1: this file is meant to be read.
        row.type === 0 ? 'expense' : 'income',
        // Always a non-negative magnitude; direction comes from type + isRefund, which is
        // what keeps the net-expense rule reproducible outside the app.
        formatCents(row.amount_cents),
        categories.get(row.category_id) ?? row.category_id,
        accounts.get(row.account_id) ?? row.account_id,
        row.note,
        // `|` rather than a comma: a comma would need quoting and is harder to read here.
        tags.join('|'),
        row.is_refund === 1 ? 'true' : 'false',
        row.fund_purpose ?? '',
      ]);
    }

    return encodeCsvWithBom(rows);
  }

  exportSalariesCsv(): string {
    const accounts = this.nameMap('accounts');
    const rows: CsvRow[] = [[...SALARY_COLUMNS]];
    const salaries = this.db
      .prepare(
        'SELECT id, amount_cents, date, note, account_id FROM salary_records WHERE deleted = 0 ORDER BY date, id',
      )
      .all() as {
      id: string;
      amount_cents: number;
      date: number;
      note: string;
      account_id: string;
    }[];

    for (const salary of salaries) {
      const allocation = this.db
        .prepare(
          'SELECT allocations_json FROM budget_allocations WHERE salary_record_id = ? AND deleted = 0',
        )
        .get(salary.id) as { allocations_json: string } | undefined;

      rows.push([
        salary.id,
        dateOnlyLabel(salary.date),
        formatCents(salary.amount_cents),
        // Names, not ids: the file is meant to be read by a person, and a UUID cannot be
        // checked by eye. Same rule as the transactions export.
        accounts.get(salary.account_id) ?? salary.account_id,
        salary.note,
        allocation?.allocations_json ?? '',
      ]);
    }

    return encodeCsvWithBom(rows);
  }

  exportRecurringCsv(): string {
    const categories = this.nameMap('categories');
    const rows: CsvRow[] = [[...RECURRING_COLUMNS]];
    const rules = this.db
      .prepare('SELECT * FROM recurring_rules WHERE deleted = 0 ORDER BY rowid')
      .all() as {
      id: string;
      name: string;
      type: number;
      amount_cents: number;
      category_id: string;
      frequency: string;
      anchor_date: number;
      next_due_date: number;
      enabled: number;
      has_older_due: number;
    }[];

    for (const rule of rules) {
      rows.push([
        rule.id,
        rule.name,
        rule.type === 0 ? 'expense' : 'income',
        formatCents(rule.amount_cents),
        categories.get(rule.category_id) ?? rule.category_id,
        rule.frequency,
        dateOnlyLabel(rule.anchor_date),
        dateOnlyLabel(rule.next_due_date),
        rule.enabled === 1 ? 'true' : 'false',
        rule.has_older_due === 1 ? 'true' : 'false',
      ]);
    }

    return encodeCsvWithBom(rows);
  }

  exportTransfersCsv(): string {
    const accounts = this.nameMap('accounts');
    const rows: CsvRow[] = [[...TRANSFER_COLUMNS]];
    const transfers = this.db
      .prepare(
        `SELECT id, from_account_id, to_account_id, amount_cents, date, note
           FROM transfers
          WHERE deleted = 0
          ORDER BY date, updated_at, id`,
      )
      .all() as {
      id: string;
      from_account_id: string;
      to_account_id: string;
      amount_cents: number;
      date: number;
      note: string;
    }[];

    for (const transfer of transfers) {
      rows.push([
        transfer.id,
        dateOnlyLabel(transfer.date),
        formatCents(transfer.amount_cents),
        accounts.get(transfer.from_account_id) ?? transfer.from_account_id,
        accounts.get(transfer.to_account_id) ?? transfer.to_account_id,
        transfer.note,
      ]);
    }

    return encodeCsvWithBom(rows);
  }

  // ── import ─────────────────────────────────────────────────────────────────

  /**
   * Imports a transactions CSV produced by `exportTransactionsCsv`.
   *
   * All-or-nothing. A validation failure on any row rejects the whole file with the row
   * number and reason, so the user can fix the file rather than reconcile a partial import.
   */
  importTransactionsCsv(csvText: string): ImportResult {
    let parsed;
    try {
      parsed = parseCsvWithHeader(csvText);
    } catch (error) {
      throw new ValidationError(
        `The file could not be read as CSV: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const missing = TRANSACTION_COLUMNS.filter(
      (column) => !OPTIONAL_TRANSACTION_COLUMNS.includes(column) && !parsed.header.includes(column),
    );
    if (missing.length > 0) {
      throw new ValidationError(
        `The file is missing required column(s): ${missing.join(', ')}. ` +
          'Export a file from this app to see the expected header.',
      );
    }

    const categories = new Map<string, string>();
    for (const row of this.db.prepare('SELECT id, name FROM categories WHERE deleted = 0').all() as {
      id: string;
      name: string;
    }[]) {
      // Names are not unique in the schema, so the first wins; a duplicate name would make
      // the mapping ambiguous, which is why the export writes names the user can verify.
      if (!categories.has(row.name)) categories.set(row.name, row.id);
    }
    const accounts = new Map<string, string>();
    for (const row of this.db.prepare('SELECT id, name FROM accounts WHERE deleted = 0').all() as {
      id: string;
      name: string;
    }[]) {
      if (!accounts.has(row.name)) accounts.set(row.name, row.id);
    }

    // The 退款 income category, resolved once for the whole file: first by the stable id
    // the seed writes, then by name among live income categories (covers a user rename).
    // Old-model exports (type=expense + isRefund=true) are rewritten to point at it —
    // importing one as-is would create a row the new model can never produce and that
    // contributes 0 to BOTH aggregates, so the money would vanish.
    const refundById = this.db
      .prepare("SELECT id FROM categories WHERE id = 'builtin-income-refund' AND deleted = 0")
      .get() as { id: string } | undefined;
    const refundCategoryRow =
      refundById ??
      (this.db
        .prepare("SELECT id FROM categories WHERE name = '退款' AND type = 1 AND deleted = 0")
        .get() as { id: string } | undefined);
    const refundCategoryId = refundCategoryRow?.id ?? null;

    const existingIds = new Set(
      (this.db.prepare('SELECT id FROM transactions').all() as { id: string }[]).map((r) => r.id),
    );

    interface Pending {
      readonly id: string;
      readonly type: number;
      readonly amountCents: number;
      readonly categoryId: string;
      readonly accountId: string;
      readonly date: number;
      readonly note: string;
      readonly tags: string[];
      readonly isRefund: boolean;
      readonly fundPurpose: FundPurpose | null;
    }

    const pendingRows: Pending[] = [];
    let skipped = 0;

    parsed.records.forEach((record, index) => {
      // 1-based, and +1 for the header row, so the number matches what a spreadsheet shows.
      const line = index + 2;
      const id = (record['id'] ?? '').trim();
      if (id === '') throw new ValidationError(`Line ${line}: id is empty.`);

      if (existingIds.has(id)) {
        skipped += 1;
        return;
      }

      const date = parseDateLabel(record['date'] ?? '');
      if (date === null) {
        throw new ValidationError(
          `Line ${line}: date must be YYYY-MM-DD (got "${record['date'] ?? ''}").`,
        );
      }

      const typeLabel = (record['type'] ?? '').trim();
      if (typeLabel !== 'expense' && typeLabel !== 'income') {
        throw new ValidationError(
          `Line ${line}: type must be expense or income (got "${typeLabel}").`,
        );
      }

      const amountCents = parseAmountToCents(record['amount'] ?? '');
      if (amountCents === null || amountCents <= 0) {
        throw new ValidationError(
          `Line ${line}: amount must be a positive number with at most 2 decimals (got "${record['amount'] ?? ''}").`,
        );
      }

      const categoryName = (record['category'] ?? '').trim();
      const categoryId = categories.get(categoryName);
      if (categoryId === undefined) {
        // Not created on the fly and not skipped: the user names it, so the user can fix it.
        throw new ValidationError(
          `Line ${line}: unknown category "${categoryName}". Create it first, or correct the file.`,
        );
      }

      const accountName = (record['account'] ?? '').trim();
      const accountId = accounts.get(accountName);
      if (accountId === undefined) {
        throw new ValidationError(
          `Line ${line}: unknown account "${accountName}". Create it first, or correct the file.`,
        );
      }

      const refundLabel = (record['isRefund'] ?? '').trim().toLowerCase();
      if (refundLabel !== 'true' && refundLabel !== 'false' && refundLabel !== '') {
        throw new ValidationError(
          `Line ${line}: isRefund must be true or false (got "${record['isRefund'] ?? ''}").`,
        );
      }

      const tags = (record['tags'] ?? '')
        .split('|')
        .map((tag) => tag.trim())
        .filter((tag) => tag !== '');

      // Pre-refund-reform exports wrote refunds as expense-typed rows. Normalise them
      // to the new model (income + 退款), consistent with migration 006: the original
      // expense category is deliberately lost there too. Rows exported after the
      // reform (income + isRefund=true) pass through untouched.
      let rowType = typeLabel === 'expense' ? 0 : 1;
      let rowCategoryId = categoryId;
      if (typeLabel === 'expense' && refundLabel === 'true') {
        if (refundCategoryId === null) {
          throw new ValidationError(
            `Line ${line}: this file was exported before refunds became income, and ` +
              'the 退款 category does not exist. Restore or create it first.',
          );
        }
        rowType = 1;
        rowCategoryId = refundCategoryId;
      }

      const purposeInput = (record['fundPurpose'] ?? '').trim();
      let fundPurpose: FundPurpose | null;
      try { fundPurpose = parseFundPurpose(purposeInput === '' ? null : purposeInput); }
      catch { throw new ValidationError(`Line ${line}: fundPurpose must be growth, reserve, essentials, joy, or empty.`); }
      if (refundLabel === 'true' && fundPurpose !== null) {
        throw new ValidationError(`Line ${line}: refund purpose must come from confirmed original transactions.`);
      }

      pendingRows.push({
        id,
        type: rowType,
        amountCents,
        categoryId: rowCategoryId,
        accountId,
        date,
        note: record['note'] ?? '',
        tags,
        isRefund: refundLabel === 'true',
        fundPurpose,
      });
    });

    // ONE transaction: either the whole file lands or none of it does.
    const at = Date.now();
    const insert = this.db.prepare(
      `INSERT INTO transactions
         (id, type, amount_cents, category_id, account_id, date, note, tags_json, is_refund, deleted, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    );
    const insertMany = this.db.transaction((rows: readonly Pending[]) => {
      const catalog = new TagCatalogService(this.db, () => at);
      for (const row of rows) {
        for (const tag of row.tags) catalog.ensureTag(this.db, tag, at);
        insert.run(
          row.id,
          row.type,
          row.amountCents,
          row.categoryId,
          row.accountId,
          row.date,
          row.note,
          JSON.stringify(row.tags),
          row.isRefund ? 1 : 0,
          at,
        );
        if (row.fundPurpose !== null) {
          writeFundPurpose(this.db, row.id, row.fundPurpose, this.actorId, null, at, true);
          if (row.type === 0 && (row.fundPurpose === 'essentials' || row.fundPurpose === 'joy')) {
            writeBillPurposeOverride(this.db, {
              transactionId: row.id, purpose: row.fundPurpose, expectedRevision: 0,
              reason: 'create', operationId: null, actorId: this.actorId, now: at,
            });
          }
        }
      }
    });
    insertMany(pendingRows);

    return { inserted: pendingRows.length, skipped, total: parsed.records.length };
  }

  /**
   * Imports a transfers CSV produced by `exportTransfersCsv`.
   *
   * Follows the same all-or-nothing contract as the transactions importer: a bad row
   * rejects the whole file instead of applying a partial ledger. Account names must
   * match live accounts and the two sides of one transfer must differ.
   */
  importTransfersCsv(csvText: string): ImportResult {
    let parsed;
    try {
      parsed = parseCsvWithHeader(csvText);
    } catch (error) {
      throw new ValidationError(
        `The file could not be read as CSV: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const missing = TRANSFER_COLUMNS.filter((column) => !parsed.header.includes(column));
    if (missing.length > 0) {
      throw new ValidationError(
        `The file is missing required column(s): ${missing.join(', ')}. ` +
          'Export a file from this app to see the expected header.',
      );
    }

    const accounts = new Map<string, string>();
    for (const row of this.db.prepare('SELECT id, name FROM accounts WHERE deleted = 0').all() as {
      id: string;
      name: string;
    }[]) {
      if (!accounts.has(row.name)) accounts.set(row.name, row.id);
    }

    const existingIds = new Set(
      (this.db.prepare('SELECT id FROM transfers').all() as { id: string }[]).map((r) => r.id),
    );

    interface Pending {
      readonly id: string;
      readonly fromAccountId: string;
      readonly toAccountId: string;
      readonly amountCents: number;
      readonly date: number;
      readonly note: string;
    }

    const pendingRows: Pending[] = [];
    let skipped = 0;

    parsed.records.forEach((record, index) => {
      const line = index + 2;
      const id = (record['id'] ?? '').trim();
      if (id === '') throw new ValidationError(`Line ${line}: id is empty.`);

      if (existingIds.has(id)) {
        skipped += 1;
        return;
      }

      const date = parseDateLabel(record['date'] ?? '');
      if (date === null) {
        throw new ValidationError(
          `Line ${line}: date must be YYYY-MM-DD (got "${record['date'] ?? ''}").`,
        );
      }

      const amountCents = parseAmountToCents(record['amount'] ?? '');
      if (amountCents === null || amountCents <= 0) {
        throw new ValidationError(
          `Line ${line}: amount must be a positive number with at most 2 decimals (got "${record['amount'] ?? ''}").`,
        );
      }

      const fromName = (record['from'] ?? '').trim();
      const fromAccountId = accounts.get(fromName);
      if (fromAccountId === undefined) {
        throw new ValidationError(
          `Line ${line}: unknown account "${fromName}". Create it first, or correct the file.`,
        );
      }

      const toName = (record['to'] ?? '').trim();
      const toAccountId = accounts.get(toName);
      if (toAccountId === undefined) {
        throw new ValidationError(
          `Line ${line}: unknown account "${toName}". Create it first, or correct the file.`,
        );
      }

      if (fromAccountId === toAccountId) {
        throw new ValidationError(
          `Line ${line}: a transfer needs two different accounts (both are "${fromName}").`,
        );
      }

      pendingRows.push({
        id,
        fromAccountId,
        toAccountId,
        amountCents,
        date,
        note: record['note'] ?? '',
      });
    });

    const at = Date.now();
    const insert = this.db.prepare(
      `INSERT INTO transfers
         (id, from_account_id, to_account_id, amount_cents, date, note, deleted, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
    );
    const insertMany = this.db.transaction((rows: readonly Pending[]) => {
      for (const row of rows) {
        insert.run(
          row.id,
          row.fromAccountId,
          row.toAccountId,
          row.amountCents,
          row.date,
          row.note,
          at,
        );
      }
    });
    insertMany(pendingRows);

    return { inserted: pendingRows.length, skipped, total: parsed.records.length };
  }

  /**
   * Imports a WeChat or Alipay platform bill export.
   *
   * Deliberately different from `importTransactionsCsv`:
   *   * **Lenient row-level ignore** — 提现/理财/不计收支/失败 rows are reported, not fatal.
   *   * **Auto-creates** the 微信 / 支付宝 account when missing (user decision for this feature).
   *   * **Keyword coarse categorisation** — wrong category falls to 其他/其他收入; the user
   *     can override per row before confirm (`categoryOverrides`) or re-file after import.
   *   * **Encoding** — GBK Alipay CSV and WeChat xlsx are decoded server-side via `bill-decode`.
   *   * **Idempotent** — platform order ids become stable `wx-*` / `ali-*` transaction ids.
   *   * **Selection** — `selectedIds` limits the write to a subset of the preview table.
   */
  importPlatformBills(
    payload: Buffer | string,
    options: PlatformImportOptions = {},
  ): PlatformImportResult {
    const dryRun = options.dryRun === true;
    const warnings: string[] = [];
    const selectedIds = options.selectedIds;
    const overrides = options.categoryOverrides ?? {};

    let text: string;
    let encoding = 'utf-8';
    if (typeof payload === 'string') {
      text = payload;
    } else if (payload.length === 0) {
      throw new ValidationError('账单文件为空。');
    } else {
      const decoded = decodeBillFile(payload, options.fileName);
      text = decoded.text;
      encoding = decoded.encoding;
    }

    let parsed;
    try {
      parsed = parsePlatformBills(text, options.source ?? 'auto');
    } catch (error) {
      throw new ValidationError(
        error instanceof Error ? error.message : '无法解析该账单文件。',
      );
    }

    const accountType =
      parsed.source === 'wechat' ? ACCOUNT_TYPE_WECHAT : ACCOUNT_TYPE_ALIPAY;
    const accountName = parsed.source === 'wechat' ? '微信' : '支付宝';

    const existingIds = new Set(
      (this.db.prepare('SELECT id FROM transactions').all() as { id: string }[]).map((r) => r.id),
    );

    // Soft-duplicate index: live rows on the target platform account, keyed by
    // local-date|type|amount. Catches hand-entered bills the platform id cannot see.
    const softDup = new Map<string, string>();
    const liveAccountId = (
      this.db
        .prepare(
          'SELECT id FROM accounts WHERE name = ? AND deleted = 0 ORDER BY sort_order LIMIT 1',
        )
        .get(accountName) as { id: string } | undefined
    )?.id;
    if (liveAccountId !== undefined) {
      const ledger = this.db
        .prepare(
          `SELECT date, type, amount_cents, note FROM transactions
            WHERE account_id = ? AND deleted = 0`,
        )
        .all(liveAccountId) as {
        date: number;
        type: number;
        amount_cents: number;
        note: string;
      }[];
      for (const item of ledger) {
        const date = new Date(item.date);
        const label = [
          date.getFullYear(),
          String(date.getMonth() + 1).padStart(2, '0'),
          String(date.getDate()).padStart(2, '0'),
        ].join('-');
        const key = `${label}|${item.type}|${item.amount_cents}`;
        if (!softDup.has(key)) softDup.set(key, item.note);
      }
    }

    const previewRows: PlatformImportRowDto[] = parsed.rows.map((row) => {
      const alreadyExists = existingIds.has(row.id);
      const softKey = `${row.dateLabel}|${row.type}|${row.amountCents}`;
      const dupNote = alreadyExists ? null : (softDup.get(softKey) ?? null);
      return {
        id: row.id,
        dateLabel: row.dateLabel,
        comparisonAccountId: liveAccountId ?? null,
        externalId: row.externalId,
        type: row.type,
        amountCents: row.amountCents,
        note: row.note,
        isRefund: row.isRefund,
        refundWarning: row.refundWarning,
        rawStatus: row.rawStatus,
        counterparty: row.counterparty,
        sourceCategory: row.sourceCategory,
        categoryName: row.categoryName,
        accountName: row.accountName,
        ignored: row.ignored,
        ignoreReason: row.ignoreReason,
        alreadyExists,
        possibleDuplicate: dupNote !== null,
        duplicateOfNote: dupNote,
      };
    });

    /** Effective category name after the client's per-row override. */
    const effectiveCategory = (row: (typeof parsed.rows)[number]): string => {
      const override = overrides[row.id];
      if (typeof override === 'string' && override.trim() !== '') return override.trim();
      return row.categoryName;
    };

    // Candidate write set: platform-importable, not already in the ledger, and selected.
    const importableRows = parsed.rows.filter((row) => {
      if (row.amountCents <= 0) return false;
      if (existingIds.has(row.id)) return false;
      if (selectedIds !== undefined && selectedIds !== null) {
        return selectedIds.includes(row.id);
      }
      return !row.ignored;
    });

    const strict = options.strictCategories === true;
    const reviewedCategories = new Map<string, string>();
    if (strict) {
      const visible = parsed.rows.slice(0, 200);
      if (selectedIds !== null && selectedIds !== undefined) {
        if (selectedIds.length > 100 || new Set(selectedIds).size !== selectedIds.length || selectedIds.some((id) => !visible.some((r) => r.id === id && !existingIds.has(id) && r.amountCents > 0))) {
          throw new ValidationError('请选择当前预览中最多100条有效且未导入的账单。');
        }
      }
      if (!dryRun && (!selectedIds || selectedIds.length === 0)) throw new ValidationError('必须显式选择账单。');
      for (const id of Object.keys(options.categoryIds ?? {})) {
        if (!visible.some((r) => r.id === id)) throw new ValidationError('分类覆盖行不属于当前预览。');
      }
      for (const [id, note] of Object.entries(options.noteOverrides ?? {})) {
        if (!visible.some((r) => r.id === id) || typeof note !== 'string' || note.length > 200) throw new ValidationError('备注覆盖无效（最多200字符）。');
      }
      for (const row of importableRows) {
        const id = options.categoryIds?.[row.id];
        if (id === undefined && dryRun && !selectedIds) continue;
        const category = this.db.prepare('SELECT id, type FROM categories WHERE id = ? AND deleted = 0').get(id ?? '') as { id: string; type: number } | undefined;
        const child = category?.type === 0 && this.db.prepare('SELECT id FROM categories WHERE parent_id = ? AND deleted = 0 LIMIT 1').get(id);
        if (!category || category.type !== row.type || child) throw new ValidationError('请为所选账单选择有效的同类型现有叶分类。');
        reviewedCategories.set(row.id, category.id);
      }
    }

    // Category names actually needed for the write set (after overrides).
    const categoryPlan = new Map<string, { name: string; type: number }>();
    for (const row of importableRows) {
      const name = effectiveCategory(row);
      categoryPlan.set(`${row.type}:${name}`, { name, type: row.type });
    }

    // Dry-run resolves names without writing; write path runs everything in one transaction.
    const resolve = (): {
      accountId: string;
      accountsCreated: number;
      categoriesCreated: number;
      categoryIds: Map<string, string>;
    } => {
      let categoriesCreated = 0;
      const account = this.ensureNamedAccount(accountName, accountType, dryRun);
      const accountsCreated = account.created ? 1 : 0;
      const categoryIds = new Map<string, string>();
      for (const [key, plan] of strict ? [] : categoryPlan) {
        const ensured = this.ensureNamedCategory(plan.name, plan.type, dryRun);
        categoryIds.set(key, ensured.id);
        if (ensured.created) categoriesCreated += 1;
      }
      return { accountId: account.id, accountsCreated, categoriesCreated, categoryIds };
    };

    let insertable = 0;
    let skipped = 0;
    let expenseCents = 0;
    let incomeCents = 0;
    const pending: {
      id: string;
      type: number;
      amountCents: number;
      categoryId: string;
      note: string;
      date: number;
      isRefund: boolean;
    }[] = [];

    const runWrite = this.db.transaction((): {
      accountId: string;
      accountsCreated: number;
      categoriesCreated: number;
    } => {
      const resolved = resolve();
      insertable = 0;
      skipped = 0;
      expenseCents = 0;
      incomeCents = 0;
      pending.length = 0;

      // Duplicates that were selected still count as skipped for the user.
      if (selectedIds !== undefined && selectedIds !== null) {
        for (const id of selectedIds) {
          if (existingIds.has(id)) skipped += 1;
        }
      } else {
        for (const row of parsed.rows) {
          if (!row.ignored && row.amountCents > 0 && existingIds.has(row.id)) skipped += 1;
        }
      }

      for (const row of importableRows) {
        const date = parseDateLabel(row.dateLabel);
        if (date === null) {
          if (strict) throw new ValidationError('所选账单日期无效，请重新预览。');
          warnings.push(`跳过无法解析日期的行：${row.dateLabel}`);
          continue;
        }
        const type = row.type;
        const name = effectiveCategory(row);
        const categoryId = strict ? reviewedCategories.get(row.id) : resolved.categoryIds.get(`${type}:${name}`);
        if (categoryId === undefined) {
          if (strict && dryRun && !selectedIds) continue;
          warnings.push(`缺少分类「${name}」，跳过：${row.note}`);
          continue;
        }
        insertable += 1;
        if (type === 1) incomeCents += row.amountCents;
        else expenseCents += row.amountCents;
        pending.push({
          id: row.id,
          type,
          amountCents: row.amountCents,
          categoryId,
          note: options.noteOverrides?.[row.id] ?? row.note,
          date,
          isRefund: row.isRefund,
        });
      }

      if (dryRun) {
        return {
          accountId: resolved.accountId,
          accountsCreated: resolved.accountsCreated,
          categoriesCreated: resolved.categoriesCreated,
        };
      }

      const at = Date.now();
      const insert = this.db.prepare(
        `INSERT INTO transactions
           (id, type, amount_cents, category_id, account_id, date, note, tags_json, is_refund, deleted, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      );
      for (const item of pending) {
        insert.run(
          item.id,
          item.type,
          item.amountCents,
          item.categoryId,
          resolved.accountId,
          item.date,
          item.note,
          JSON.stringify([]),
          item.isRefund ? 1 : 0,
          at,
        );
      }
      return {
        accountId: resolved.accountId,
        accountsCreated: resolved.accountsCreated,
        categoriesCreated: resolved.categoriesCreated,
      };
    });

    const resolved = runWrite();

    return {
      source: parsed.source,
      dryRun,
      inserted: dryRun ? insertable : pending.length,
      skipped,
      ignored: parsed.ignored,
      total: parsed.total,
      importable: parsed.importable,
      selected: insertable,
      accountsCreated: resolved.accountsCreated,
      categoriesCreated: resolved.categoriesCreated,
      dateFrom: parsed.dateFrom,
      dateTo: parsed.dateTo,
      expenseCents,
      incomeCents,
      encoding,
      warnings,
      rows: previewRows,
    };
  }

  /** Live account by name, else restore a soft-deleted twin, else insert. */
  private ensureNamedAccount(
    name: string,
    type: number,
    dryRun: boolean,
  ): { id: string; created: boolean } {
    const live = this.db
      .prepare('SELECT id FROM accounts WHERE name = ? AND deleted = 0 ORDER BY sort_order LIMIT 1')
      .get(name) as { id: string } | undefined;
    if (live !== undefined) return { id: live.id, created: false };

    const soft = this.db
      .prepare('SELECT id FROM accounts WHERE name = ? AND deleted = 1 ORDER BY sort_order LIMIT 1')
      .get(name) as { id: string } | undefined;
    if (soft !== undefined) {
      if (!dryRun) {
        this.db
          .prepare('UPDATE accounts SET deleted = 0, updated_at = ? WHERE id = ?')
          .run(Date.now(), soft.id);
      }
      return { id: soft.id, created: false };
    }

    if (dryRun) return { id: `dry-run-account-${name}`, created: true };

    const id = randomUUID();
    const max = (
      this.db.prepare('SELECT MAX(sort_order) AS m FROM accounts').get() as { m: number | null }
    ).m;
    this.db
      .prepare(
        `INSERT INTO accounts (id, name, type, initial_balance_cents, sort_order, is_builtin, deleted, updated_at)
         VALUES (?, ?, ?, 0, ?, 0, 0, ?)`,
      )
      .run(id, name, type, (max ?? -1) + 1, Date.now());
    return { id, created: true };
  }

  /** Live category by name+type, else restore soft-deleted, else insert a custom row. */
  private ensureNamedCategory(
    name: string,
    type: number,
    dryRun: boolean,
  ): { id: string; created: boolean } {
    const live = this.db
      .prepare(
        'SELECT id FROM categories WHERE name = ? AND type = ? AND deleted = 0 ORDER BY sort_order LIMIT 1',
      )
      .get(name, type) as { id: string } | undefined;
    if (live !== undefined) return { id: live.id, created: false };

    const soft = this.db
      .prepare(
        'SELECT id FROM categories WHERE name = ? AND type = ? AND deleted = 1 ORDER BY sort_order LIMIT 1',
      )
      .get(name, type) as { id: string } | undefined;
    if (soft !== undefined) {
      if (!dryRun) {
        this.db
          .prepare('UPDATE categories SET deleted = 0, updated_at = ? WHERE id = ?')
          .run(Date.now(), soft.id);
      }
      return { id: soft.id, created: false };
    }

    if (dryRun) return { id: `dry-run-category-${type}-${name}`, created: true };

    const id = randomUUID();
    const max = (
      this.db
        .prepare('SELECT MAX(sort_order) AS m FROM categories WHERE type = ?')
        .get(type) as { m: number | null }
    ).m;
    const color = (type === CATEGORY_TYPE_INCOME ? paletteSlot(8) : paletteSlot(6)).argb;
    this.db
      .prepare(
        `INSERT INTO categories (id, name, type, icon, color, sort_order, is_builtin, deleted, updated_at)
         VALUES (?, ?, ?, 'other', ?, ?, 0, 0, ?)`,
      )
      .run(id, name, type, color, (max ?? -1) + 1, Date.now());
    return { id, created: true };
  }

  // ── backups ────────────────────────────────────────────────────────────────

  /**
   * Lists existing archives, newest first.
   *
   * Returns file names only. The host path is not useful to a client that cannot read the
   * filesystem, and exposing it leaks deployment detail.
   */
  listBackups(): BackupFileDto[] {
    const dir = this.backupsDir();
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      // No backups yet is a normal state, not an error.
      return [];
    }

    return entries
      .filter((name) => name.endsWith('.db'))
      .map((name) => {
        const stats = statSync(join(dir, name));
        return {
          fileName: basename(name),
          sizeBytes: stats.size,
          createdAtMs: stats.mtimeMs,
        };
      })
      .sort((a, b) => b.createdAtMs - a.createdAtMs);
  }

  /** Takes an archive and returns the new entry. Reuses the CLI's own backup routine. */
  createBackupNow(): BackupFileDto {
    const dir = this.backupsDir();
    mkdirSync(dir, { recursive: true });

    const result = createBackup(this.dbFile, dir, 30);

    const stats = statSync(result.file);
    return {
      fileName: basename(result.file),
      sizeBytes: stats.size,
      createdAtMs: stats.mtimeMs,
    };
  }
}
