/**
 * Transaction service: create / read / update / soft-delete, plus the filtered
 * list query.
 *
 * Contract (T4 PRD):
 *   * money arrives as integer cents and never as a float (AC4);
 *   * tags are normalised through `services/tags.ts` so the de-duplication rule
 *     exists in exactly one place (AC6);
 *   * `isRefund` is a cross-cutting flag on an INCOME row, not an expense — it
 *     marks money that came back in (退款/还款/AA 收款) and links back to the
 *     original expense(s) it offsets; refunds count as income (AC7, revised).
 *     live categories must also match the transaction type; client filters are not trusted.
 *   * deletes are soft: the row stays, `deleted` flips (AC3);
 *   * a keyword search escapes `%` and `_`, so a note containing `%` is matched
 *     literally instead of matching everything (AC9).
 *
 * The net-expense arithmetic itself lives in `@jizhang/shared` — this module must
 * not re-implement it.
 */
import {
  expenseContribution,
  incomeContribution,
  TYPE_EXPENSE,
  TYPE_INCOME,
  type FundPurpose,
  type SpendingPurpose,
  type Transaction,
} from '@jizhang/shared';
import { createHash, randomUUID } from 'node:crypto';
import type { Db } from '../db/index.js';
import { normaliseTags, parseTagsJson, serialiseTags } from './tags.js';
import { TagCatalogService } from './tag-catalog-service.js';
import {
  FinancialInvalidError,
  FinancialRevisionConflictError,
  FinancialSourceChangedError,
} from './financial-errors.js';
import { runFinancialOperation } from './financial-operation-store.js';
import {
  financialTransactionToken,
  parseFinancialPurpose,
  resolveFinancialActorId,
  writeBillPurposeOverride,
} from './financial-purpose-store.js';
import { invalidateFinancialRefundSources } from './financial-source-lifecycle.js';
import { assertFundPurposeRevision, writeFundPurpose } from './financial-fund-purpose-store.js';
import { ConflictError, NotFoundError, ValidationError } from './transaction-errors.js';
import type {
  CreateTransactionInput,
  PreparedTransactionInput,
  RefundDetail,
  RefundSummary,
  TransactionDto,
  UpdateTransactionInput,
} from './transaction-types.js';

export { ConflictError, NotFoundError, ValidationError } from './transaction-errors.js';
export type {
  CreateTransactionInput,
  PreparedTransactionInput,
  RefundDetail,
  RefundSummary,
  TransactionDto,
  UpdateTransactionInput,
} from './transaction-types.js';

/** Row shape of the `transactions` table. */
interface TransactionRow {
  readonly id: string;
  readonly type: number;
  readonly amount_cents: number;
  readonly category_id: string;
  readonly account_id: string;
  readonly date: number;
  readonly note: string;
  readonly tags_json: string;
  readonly is_refund: number;
  readonly deleted: number;
  readonly financial_purpose: string | null;
  readonly financial_purpose_revision: number;
  readonly fund_purpose?: FundPurpose | null;
  readonly fund_purpose_revision?: number | null;
  readonly fund_purpose_source?: string | null;
  readonly updated_at: number;
}

function toDto(
  row: TransactionRow,
  refundLinkedTxIds?: string[],
  refundSummary?: RefundSummary,
  refundDetails?: RefundDetail[],
): TransactionDto {
  return {
    id: row.id,
    type: row.type,
    amountCents: row.amount_cents,
    categoryId: row.category_id,
    accountId: row.account_id,
    date: row.date,
    note: row.note,
    tags: parseTagsJson(row.tags_json),
    isRefund: row.is_refund === 1,
    financialPurpose: row.financial_purpose as SpendingPurpose | null,
    financialPurposeRevision: row.financial_purpose_revision,
    fundPurpose: row.fund_purpose ?? null,
    fundPurposeRevision: row.fund_purpose_revision ?? 0,
    fundPurposeStatus: row.fund_purpose == null ? 'unresolved' : 'resolved',
    fundPurposeSource: row.fund_purpose_source ?? 'unresolved',
    refundLinkedTxIds,
    refundSummary,
    refundDetails,
    updatedAt: row.updated_at,
  };
}

// Scalar subqueries keep the ledger scope and row cardinality unchanged.
const FUND_COLUMNS = `(SELECT purpose FROM financial_fund_purposes WHERE transaction_id=transactions.id) AS fund_purpose,
  (SELECT revision FROM financial_fund_purposes WHERE transaction_id=transactions.id) AS fund_purpose_revision,
  (SELECT source FROM financial_fund_purposes WHERE transaction_id=transactions.id) AS fund_purpose_source`;

function hasFundPurpose(input: UpdateTransactionInput): boolean {
  return Object.prototype.hasOwnProperty.call(input, 'fundPurpose') && input.fundPurpose !== undefined;
}

export function parseFundPurpose(value: unknown): FundPurpose | null {
  if (value === null || value === 'growth' || value === 'reserve' || value === 'essentials' || value === 'joy') return value;
  throw new FinancialInvalidError("fundPurpose must be null, 'growth', 'reserve', 'essentials' or 'joy'.");
}

function requestedFundPurpose(input: CreateTransactionInput): FundPurpose | null | undefined {
  const canonical = hasFundPurpose(input) ? parseFundPurpose(input.fundPurpose) : undefined;
  const legacy = hasFinancialPurpose(input) ? parseFinancialPurpose(input.financialPurpose) : undefined;
  if (canonical !== undefined && legacy !== undefined && canonical !== legacy) {
    throw new FinancialInvalidError('fundPurpose and financialPurpose conflict.');
  }
  return canonical !== undefined ? canonical : legacy;
}

/** Earliest plausible transaction date: 2000-01-01. Guards absurd input. */
const MIN_DATE_MS = Date.UTC(2000, 0, 1);
/** One day of slack past "now" absorbs client clock skew and timezone edges. */
const FUTURE_SLACK_MS = 86_400_000;

function requireIntegerCents(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ValidationError(
      `${field} must be an integer number of cents (got ${JSON.stringify(value)}). ` +
        'Convert yuan to cents with Math.round(value * 100) on the client.',
    );
  }
  if (value <= 0) {
    throw new ValidationError(`${field} must be greater than zero.`);
  }
  return value;
}

function requireType(value: unknown): number {
  if (value !== TYPE_EXPENSE && value !== TYPE_INCOME) {
    throw new ValidationError('type must be 0 (expense) or 1 (income).');
  }
  return value;
}

/**
 * Requires a non-empty string. Exported because "a required reference is missing" is the
 * same validation wherever it appears (a bill's category, a salary's account), and a second
 * copy would eventually word the error differently for the same mistake.
 */
export function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${field} is required.`);
  }
  return value.trim();
}

function requireTimestamp(value: unknown, field: string, nowMs: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError(`${field} must be an epoch-millisecond timestamp.`);
  }
  if (value < MIN_DATE_MS) {
    throw new ValidationError(`${field} is before the year 2000.`);
  }
  if (value > nowMs + FUTURE_SLACK_MS) {
    throw new ValidationError(`${field} is in the future.`);
  }
  return value;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

/** Present-and-not-undefined is different from "explicitly null" (clear). */
function hasFinancialPurpose(input: UpdateTransactionInput): boolean {
  return (
    Object.prototype.hasOwnProperty.call(input, 'financialPurpose') &&
    input.financialPurpose !== undefined
  );
}

function requireOperationId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new FinancialInvalidError('operationId must be a UUID.');
  }
  return value;
}

function requireExpectedPurposeRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new FinancialInvalidError(
      'expectedFinancialPurposeRevision must be a non-negative safe integer.',
    );
  }
  return value;
}

function requireExpectedTransactionToken(value: unknown): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new FinancialInvalidError('expectedTransactionToken must be a SHA-256 hex string.');
  }
  return value;
}

/** The pre-image facts that guard a financial-purpose PATCH. */
function financialTokenFor(dto: TransactionDto): string {
  return financialTransactionToken({
    id: dto.id,
    type: dto.type,
    amountCents: dto.amountCents,
    categoryId: dto.categoryId,
    accountId: dto.accountId,
    date: dto.date,
    isRefund: dto.isRefund,
    deleted: false,
  });
}

/** `%` and `_` are LIKE wildcards; a literal search must escape them. */
export function escapeLikePattern(input: string): string {
  return input.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export interface ListTransactionsQuery {
  readonly from?: number | undefined;
  readonly to?: number | undefined;
  readonly type?: number | undefined;
  readonly categoryId?: string | undefined;
  readonly accountId?: string | undefined;
  readonly tag?: string | undefined;
  readonly tagId?: string | undefined;
  readonly q?: string | undefined;
  readonly search?: string | undefined;
  readonly includeDeleted?: boolean | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
  /** Optional gross expense guard for a complete category-statistics drilldown scope. */
  readonly expectedExpenseCents?: number | undefined;
  readonly expectedExpenseCount?: number | undefined;
}

export interface ListTransactionsResult {
  readonly items: TransactionDto[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly searchVersion?: 1;
  readonly searchRevision?: string;
}

export interface DailySummaryQuery extends ListTransactionsQuery {
  readonly timeZone?: string | undefined;
}

export interface DailySummaryItem {
  readonly day: string;
  expenseCents: number;
  incomeCents: number;
  count: number;
}

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 500;
/** Bounds the synchronous full-result revision computed for each search page. */
export const MAX_SEARCH_ROWS = 10_000;
export const MAX_SEARCH_TEXT_BYTES = 16 * 1024 * 1024;

export interface TransactionServiceOptions {
  /** Injectable clock, so date validation is deterministic in tests. */
  readonly now?: () => number;
  /**
   * Explicit actor for financial-operation replay. Normal route construction
   * omits it and the service resolves the single local user from the database.
   */
  readonly actorId?: string;
}

/**
 * Rejects a reference to an account that is missing or soft-deleted.
 *
 * Module-level and exported rather than a private method because three writers now need
 * exactly this rule: a bill, a salary and a recurring rule. The project's convention is one
 * implementation per rule (`spec/backend/quality-guidelines.md`: "One aggregation rule, one
 * implementation"), and a second copy of this lookup is how a stale client would end up able
 * to file money against an account the user has deleted.
 */
export function assertAccountUsable(db: Db, accountId: string): void {
  const row = db
    .prepare('SELECT 1 AS x FROM accounts WHERE id = ? AND deleted = 0')
    .get(accountId) as { x: number } | undefined;
  if (row === undefined) {
    throw new ValidationError(`Unknown or deleted account: ${accountId}`);
  }
}

export class TransactionService {
  private readonly db: Db;
  private readonly now: () => number;
  private readonly actorId: string | undefined;

  constructor(db: Db, options: TransactionServiceOptions = {}) {
    this.db = db;
    this.now = options.now ?? (() => Date.now());
    this.actorId = options.actorId;
  }

  /** Production injects the tenant actor; legacy single-ledger fixtures may resolve locally. */
  private resolveActorId(): string {
    return this.actorId ?? resolveFinancialActorId(this.db);
  }

  /** Returns the ids of refunds linked TO this original expense (reverse lookup). */
  getRefundsForExpense(originalTxId: string): string[] {
    const rows = this.db
      .prepare('SELECT refund_tx_id FROM refund_links WHERE original_tx_id = ? ORDER BY created_at')
      .all(originalTxId) as { refund_tx_id: string }[];
    return rows.map((row) => row.refund_tx_id);
  }

  /** Sum of refund amounts linked to an original expense, plus how many there are. */
  getRefundSummary(originalTxId: string): RefundSummary {
    const rows = this.db
      .prepare(
        `SELECT t.amount_cents AS amount
           FROM refund_links rl
           JOIN transactions t ON t.id = rl.refund_tx_id
          WHERE rl.original_tx_id = ? AND t.deleted = 0`,
      )
      .all(originalTxId) as { amount: number }[];
    const totalRefundCents = rows.reduce((sum, row) => sum + row.amount, 0);
    return { totalRefundCents, refundCount: rows.length };
  }

  /** Forward-view rows for the refunds linked to an original expense. */
  getRefundDetails(originalTxId: string): RefundDetail[] {
    const rows = this.db
      .prepare(
        `SELECT t.id, t.amount_cents, t.date, t.note, t.updated_at
           FROM refund_links rl
           JOIN transactions t ON t.id = rl.refund_tx_id
          WHERE rl.original_tx_id = ? AND t.deleted = 0
          ORDER BY rl.created_at`,
      )
      .all(originalTxId) as {
      id: string;
      amount_cents: number;
      date: number;
      note: string;
      updated_at: number;
    }[];
    return rows.map((row) => ({
      id: row.id,
      amountCents: row.amount_cents,
      date: row.date,
      note: row.note,
      updatedAt: row.updated_at,
    }));
  }

  /** Rejects a reference to a category that is missing or soft-deleted (AC10). */
  private assertCategoryUsable(categoryId: string, expectedType?: number): void {
    const row = this.db
      .prepare('SELECT type FROM categories WHERE id = ? AND deleted = 0')
      .get(categoryId) as { type: number } | undefined;
    if (row === undefined) {
      throw new ValidationError(`Unknown or deleted category: ${categoryId}`);
    }
    if (expectedType !== undefined && row.type !== expectedType) {
      throw new ValidationError('The selected category does not match the transaction type.');
    }
    const child = this.db
      .prepare('SELECT 1 AS x FROM categories WHERE parent_id = ? AND deleted = 0 LIMIT 1')
      .get(categoryId) as { x: number } | undefined;
    if (child !== undefined) {
      throw new ValidationError(
        'A parent category cannot be selected for a bill. Choose a child category.',
      );
    }
  }

  /** Delegates to the module-level rule so there is exactly one implementation. */
  private assertAccountUsable(accountId: string): void {
    assertAccountUsable(this.db, accountId);
  }

  /**
   * Checks that a category and an account may be referenced, without writing anything.
   *
   * Exposed so other writers (recurring rules) enforce exactly the same rule as a bill
   * does, instead of each re-implementing the two lookups and drifting. The transaction
   * type is included so category-type mismatches are rejected before either writer commits.
   */
  assertReferencesUsable(type: number, categoryId: string, accountId: string): void {
    this.assertCategoryUsable(categoryId, requireType(type));
    this.assertAccountUsable(accountId);
  }

  /** Returns the ids of original expenses linked to a refund transaction. */
  private getRefundLinks(refundTxId: string): string[] {
    const rows = this.db
      .prepare('SELECT original_tx_id FROM refund_links WHERE refund_tx_id = ? ORDER BY rowid')
      .all(refundTxId) as { original_tx_id: string }[];
    return rows.map((row) => row.original_tx_id);
  }

  /** Removes existing links for a refund and inserts the validated set. */
  private replaceRefundLinks(
    refundTxId: string,
    originalTxIds: readonly string[],
    nowMs: number,
  ): void {
    this.db.prepare('DELETE FROM refund_links WHERE refund_tx_id = ?').run(refundTxId);
    if (originalTxIds.length === 0) return;
    const insert = this.db.prepare(
      'INSERT INTO refund_links (id, refund_tx_id, original_tx_id, created_at) VALUES (?, ?, ?, ?)',
    );
    for (const originalTxId of originalTxIds) {
      insert.run(randomUUID(), refundTxId, originalTxId, nowMs);
    }
  }

  /**
   * Validates that each linked id is a live, non-refund expense.
   * Returns the de-duplicated id list so the caller stores a clean set.
   */
  private validateRefundLinks(originalTxIds: readonly string[], selfId?: string): string[] {
    if (originalTxIds.length === 0) return [];
    const unique = [...new Set(originalTxIds)];
    if (selfId !== undefined && unique.includes(selfId)) {
      throw new ValidationError('A refund cannot link to itself.');
    }
    const placeholders = unique.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT id, type, is_refund, deleted FROM transactions WHERE id IN (${placeholders})`,
      )
      .all(...unique) as {
      id: string;
      type: number;
      is_refund: number;
      deleted: number;
    }[];
    const found = new Map(rows.map((row) => [row.id, row]));
    for (const id of unique) {
      const row = found.get(id);
      if (row === undefined) throw new ValidationError(`Linked transaction not found: ${id}`);
      if (row.deleted === 1) throw new ValidationError(`Linked transaction is deleted: ${id}`);
      if (row.type !== TYPE_EXPENSE)
        throw new ValidationError(`Linked transaction must be an expense: ${id}`);
      if (row.is_refund === 1)
        throw new ValidationError(`Linked transaction must not be a refund: ${id}`);
    }
    return unique;
  }

  getById(id: string, includeDeleted = false): TransactionDto | undefined {
    const row = this.db
      .prepare(`SELECT transactions.*, ${FUND_COLUMNS} FROM transactions WHERE id = ?${includeDeleted ? '' : ' AND deleted = 0'}`)
      .get(id) as TransactionRow | undefined;
    if (row === undefined) return undefined;
    if (row.is_refund === 1) {
      return toDto(row, this.getRefundLinks(id));
    }
    // For a non-refund expense, attach the reverse-view: how much has been
    // refunded against it. Only expense originals carry this summary — refunds
    // (income-typed) show their linked originals instead, and plain income
    // has nothing to offset.
    if (row.type === TYPE_EXPENSE) {
      const summary = this.getRefundSummary(id);
      if (summary.refundCount > 0) {
        return toDto(row, undefined, summary, this.getRefundDetails(id));
      }
    }
    return toDto(row);
  }

  /**
   * The raw `deleted` flag, or `undefined` when no such row exists.
   *
   * `undefined` and `0` must stay distinguishable: "no such bill" and "this bill is
   * still live" are different answers, and folding them together is how a typo would
   * silently hard-delete the wrong thing.
   */
  private deletedFlag(id: string): number | undefined {
    const row = this.db.prepare('SELECT deleted FROM transactions WHERE id = ?').get(id) as
      { deleted: number } | undefined;
    return row?.deleted;
  }

  /**
   * Requires the row to exist and be live; throws `NotFoundError` otherwise, so
   * routes can let the error handler render a 404.
   */
  getByIdOrThrow(id: string): TransactionDto {
    const found = this.getById(id);
    if (found === undefined) throw new NotFoundError();
    return found;
  }

  /**
   * Validates a prospective bill without inserting it. Assistant confirmation cards use this
   * method so preparing a write cannot accidentally create a ledger row.
   */
  prepareCreate(input: CreateTransactionInput): PreparedTransactionInput {
    const type = requireType(input.type);
    const amountCents = requireIntegerCents(input.amountCents, 'amountCents');
    const categoryId = requireNonEmptyString(input.categoryId, 'categoryId');
    const accountId = requireNonEmptyString(input.accountId, 'accountId');
    const date = requireTimestamp(input.date, 'date', this.now());
    const note = typeof input.note === 'string' ? input.note : '';
    const tags = normaliseTags(Array.isArray(input.tags) ? input.tags : []);

    // A refund only makes sense on an income: money that came back in is recorded
    // in the income tab and counts as +income (AC7, revised — supersedes the old
    // "refund is a negative expense" rule from T4 PRD R5).
    const isRefund = input.isRefund === true;
    if (isRefund && type !== TYPE_INCOME) {
      throw new ValidationError('isRefund can only be set on an income (type 1).');
    }

    // `undefined` means the old writer omitted the field; `null` means an
    // explicit "no override". Neither may carry a non-null value on income.
    const fundPurpose = requestedFundPurpose(input) ?? null;
    if (isRefund && hasFundPurpose(input) && fundPurpose !== null) {
      throw new FinancialInvalidError('Refund purpose comes from confirmed original transactions.');
    }
    const financialPurpose = input.financialPurpose !== undefined
      ? parseFinancialPurpose(input.financialPurpose)
      : type === TYPE_EXPENSE && (fundPurpose === 'essentials' || fundPurpose === 'joy')
        ? fundPurpose : null;
    if (financialPurpose !== null && type !== TYPE_EXPENSE) {
      throw new FinancialInvalidError(
        'A financial purpose can only be set on an expense.',
      );
    }

    this.assertCategoryUsable(categoryId, type);
    this.assertAccountUsable(accountId);

    const linkedIds = Array.isArray(input.refundLinkedTxIds)
      ? input.refundLinkedTxIds.filter(
          (v): v is string => typeof v === 'string',
        )
      : [];
    const refundLinkedTxIds = isRefund ? this.validateRefundLinks(linkedIds) : [];
    return {
      type,
      amountCents,
      categoryId,
      accountId,
      date,
      note,
      tags,
      isRefund,
      refundLinkedTxIds,
      financialPurpose,
      fundPurpose,
    };
  }

  create(input: CreateTransactionInput, id?: string): TransactionDto {
    const purposeProvided = hasFinancialPurpose(input) || hasFundPurpose(input);
    if (input.operationId !== undefined && !purposeProvided) {
      throw new FinancialInvalidError(
        'operationId is only supported on a create that carries financialPurpose or fundPurpose.',
      );
    }

    if (input.operationId !== undefined) {
      const operationId = requireOperationId(input.operationId);
      const nowMs = this.now();
      const actorId = this.resolveActorId();
      const result = runFinancialOperation(
        this.db,
        {
          operationId,
          actorId,
          method: 'POST',
          resource: '/api/v1/transactions',
          canonicalPayload: this.createReplayPayload(input, id),
          now: nowMs,
        },
        () => ({
          statusCode: 201,
          response: this.createInternal(input, id, nowMs, operationId, actorId),
        }),
      );
      return result.response;
    }

    const write = this.db.transaction((): TransactionDto =>
      this.createInternal(input, id, this.now(), null, null),
    );
    return write();
  }

  /** The ledger insert + purpose override, always inside one caller transaction. */
  private createInternal(
    input: CreateTransactionInput,
    id: string | undefined,
    nowMs: number,
    operationId: string | null,
    actorId: string | null,
  ): TransactionDto {
    const prepared = this.prepareCreate(input);

    const rowId = id ?? randomUUID();
    const catalog = new TagCatalogService(this.db, () => nowMs);
    for (const tag of prepared.tags) catalog.ensureTag(this.db, tag, nowMs);
    this.db
      .prepare(
        `INSERT INTO transactions
           (id, type, amount_cents, category_id, account_id, date, note, tags_json, is_refund, deleted, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(
        rowId,
        prepared.type,
        prepared.amountCents,
        prepared.categoryId,
        prepared.accountId,
        prepared.date,
        prepared.note,
        serialiseTags(prepared.tags),
        prepared.isRefund ? 1 : 0,
        nowMs,
      );

    if (prepared.isRefund) {
      const validated = this.validateRefundLinks(prepared.refundLinkedTxIds, rowId);
      if (validated.length > 0) {
        this.replaceRefundLinks(rowId, validated, nowMs);
      }
    }

    if (prepared.financialPurpose !== null) {
      writeBillPurposeOverride(this.db, {
        transactionId: rowId,
        purpose: prepared.financialPurpose,
        expectedRevision: 0,
        reason: 'create',
        operationId,
        actorId: actorId ?? this.resolveActorId(),
        now: nowMs,
      });
    }

    if (hasFundPurpose(input) || hasFinancialPurpose(input)) {
      writeFundPurpose(this.db, rowId, prepared.fundPurpose, actorId ?? this.resolveActorId(), operationId, nowMs, hasFundPurpose(input));
    }

    return this.getByIdOrThrow(rowId);
  }

  /** Canonical replay payload for a purpose-bearing create (no generated id). */
  private createReplayPayload(
    input: CreateTransactionInput,
    id: string | undefined,
  ): Record<string, unknown> {
    return {
      id: id ?? null,
      type: input.type,
      amountCents: input.amountCents,
      categoryId: input.categoryId,
      accountId: input.accountId,
      date: input.date,
      note: input.note,
      tags: input.tags,
      isRefund: input.isRefund,
      refundLinkedTxIds: input.refundLinkedTxIds,
      financialPurpose: input.financialPurpose,
      fundPurpose: input.fundPurpose,
    };
  }

  /**
   * Validates a prospective PATCH without writing.
   *
   * The assistant preview used `prepareCreate` on a merged DTO before; that
   * cannot express "changing the type to income clears an override". This
   * method mirrors the real update semantics exactly and returns the same
   * `PreparedTransactionInput` shape as `prepareCreate`.
   */
  prepareUpdate(id: string, input: UpdateTransactionInput): PreparedTransactionInput {
    return this.computeUpdate(id, input, this.now()).next;
  }

  /**
   * Partial update. Only the keys present in `input` are changed.
   *
   * `isRefund` is special-cased: flipping it on an expense row is rejected, and
   * clearing it is always allowed. An explicit `financialPurpose` additionally
   * requires an operationId + purpose-revision + transaction-token guard; an
   * omitted purpose preserves the existing override, while an expense→income
   * type change clears it with an audit event.
   */
  update(id: string, input: UpdateTransactionInput): TransactionDto {
    const purposeProvided = hasFinancialPurpose(input) || hasFundPurpose(input);
    if (
      !purposeProvided &&
      (input.operationId !== undefined ||
        input.expectedFinancialPurposeRevision !== undefined ||
        input.expectedFundPurposeRevision !== undefined ||
        input.expectedTransactionToken !== undefined)
    ) {
      throw new FinancialInvalidError(
        'Purpose guards and operationId require an explicit financialPurpose or fundPurpose.',
      );
    }

    if (!purposeProvided) {
      const nowMs = this.now();
      const write = this.db.transaction((): TransactionDto =>
        this.writeUpdate(id, input, nowMs, false, null, null),
      );
      return write();
    }

    const operationId = requireOperationId(input.operationId);
    const nowMs = this.now();
    const actorId = this.resolveActorId();
    const result = runFinancialOperation(
      this.db,
      {
        operationId,
        actorId,
        method: 'PATCH',
        resource: `/api/v1/transactions/${id}`,
        canonicalPayload: this.updateReplayPayload(id, input),
        now: nowMs,
      },
      () => ({
        statusCode: 200,
        response: this.writeUpdate(id, input, nowMs, true, operationId, actorId),
      }),
    );
    return result.response;
  }

  /** Canonical replay payload for a purpose-bearing PATCH. */
  private updateReplayPayload(
    id: string,
    input: UpdateTransactionInput,
  ): Record<string, unknown> {
    return {
      id,
      type: input.type,
      amountCents: input.amountCents,
      categoryId: input.categoryId,
      accountId: input.accountId,
      date: input.date,
      note: input.note,
      tags: input.tags,
      isRefund: input.isRefund,
      refundLinkedTxIds: input.refundLinkedTxIds,
      financialPurpose: input.financialPurpose,
      fundPurpose: input.fundPurpose,
      expectedFundPurposeRevision: input.expectedFundPurposeRevision,
      expectedFinancialPurposeRevision: input.expectedFinancialPurposeRevision,
      expectedTransactionToken: input.expectedTransactionToken,
    };
  }

  /** Computes the next validated row without writing it. */
  private computeUpdate(
    id: string,
    input: UpdateTransactionInput,
    nowMs: number,
  ): { current: TransactionDto; next: PreparedTransactionInput } {
    const current = this.getByIdOrThrow(id);

    const nextType = input.type === undefined ? current.type : requireType(input.type);
    const nextAmount =
      input.amountCents === undefined
        ? current.amountCents
        : requireIntegerCents(input.amountCents, 'amountCents');
    const nextCategory =
      input.categoryId === undefined
        ? current.categoryId
        : requireNonEmptyString(input.categoryId, 'categoryId');
    const nextAccount =
      input.accountId === undefined
        ? current.accountId
        : requireNonEmptyString(input.accountId, 'accountId');
    const nextDate =
      input.date === undefined ? current.date : requireTimestamp(input.date, 'date', nowMs);
    const nextNote = input.note === undefined ? current.note : input.note;
    if (typeof nextNote !== 'string') {
      throw new ValidationError('note must be a string.');
    }
    const nextTags =
      input.tags === undefined
        ? current.tags
        : normaliseTags(Array.isArray(input.tags) ? input.tags : []);
    const nextIsRefund = input.isRefund === undefined ? current.isRefund : input.isRefund === true;

    if (nextIsRefund && nextType !== TYPE_INCOME) {
      throw new ValidationError('isRefund can only be set on an income (type 1).');
    }

    // An omitted purpose preserves the current override, except that an
    // expense→income transition must clear it. An explicit null also clears.
    const requested = requestedFundPurpose(input);
    const nextFundPurpose = requested === undefined ? current.fundPurpose : requested;
    if (nextIsRefund && hasFundPurpose(input) && requested !== null && requested !== undefined) {
      throw new FinancialInvalidError('Refund purpose comes from confirmed original transactions.');
    }
    let nextPurpose = current.financialPurpose;
    if (hasFinancialPurpose(input)) {
      nextPurpose = parseFinancialPurpose(input.financialPurpose);
    } else if (hasFundPurpose(input)) {
      nextPurpose = nextType === TYPE_EXPENSE && (nextFundPurpose === 'essentials' || nextFundPurpose === 'joy') ? nextFundPurpose : null;
    } else if (nextType !== TYPE_EXPENSE) {
      nextPurpose = null;
    }
    if (nextPurpose !== null && nextType !== TYPE_EXPENSE) {
      throw new FinancialInvalidError(
        'A financial purpose can only be set on an expense.',
      );
    }

    if (nextCategory !== current.categoryId || nextType !== current.type) {
      this.assertCategoryUsable(nextCategory, nextType);
    }
    if (nextAccount !== current.accountId) this.assertAccountUsable(nextAccount);

    let nextLinkedIds: string[];
    if (!nextIsRefund) {
      nextLinkedIds = [];
    } else if (Array.isArray(input.refundLinkedTxIds)) {
      const linkedIds = (input.refundLinkedTxIds as readonly unknown[]).filter(
        (v): v is string => typeof v === 'string',
      );
      nextLinkedIds = this.validateRefundLinks(linkedIds, id);
    } else {
      nextLinkedIds = current.isRefund ? (current.refundLinkedTxIds ?? []) : [];
    }

    return {
      current,
      next: {
        type: nextType,
        amountCents: nextAmount,
        categoryId: nextCategory,
        accountId: nextAccount,
        date: nextDate,
        note: nextNote,
        tags: nextTags,
        isRefund: nextIsRefund,
        refundLinkedTxIds: nextLinkedIds,
        financialPurpose: nextPurpose,
        fundPurpose: nextFundPurpose,
      },
    };
  }

  /** Writes a validated update; the caller owns the transaction. */
  private writeUpdate(
    id: string,
    input: UpdateTransactionInput,
    nowMs: number,
    explicitPurpose: boolean,
    operationId: string | null,
    actorId: string | null,
  ): TransactionDto {
    const { current, next } = this.computeUpdate(id, input, nowMs);

    if (explicitPurpose) {
      if (hasFinancialPurpose(input)) {
        const expectedRevision = requireExpectedPurposeRevision(input.expectedFinancialPurposeRevision);
        if (current.financialPurposeRevision !== expectedRevision) {
          throw new FinancialRevisionConflictError('The financial purpose revision is stale. Reload the bill and retry.');
        }
      }
      assertFundPurposeRevision(
        { revision: current.fundPurposeRevision, source: current.fundPurposeSource },
        input.expectedFundPurposeRevision,
        hasFundPurpose(input) ? 'canonical' : 'legacy',
      );
      const expectedToken = requireExpectedTransactionToken(input.expectedTransactionToken);
      if (financialTokenFor(current) !== expectedToken) {
        throw new FinancialSourceChangedError(
          'The bill changed since the purpose editor loaded it. Reload and retry.',
        );
      }
    }

    const catalog = new TagCatalogService(this.db, () => nowMs);
    for (const tag of next.tags) catalog.ensureTag(this.db, tag, nowMs);
    this.db
      .prepare(
        `UPDATE transactions
            SET type = ?, amount_cents = ?, category_id = ?, account_id = ?,
                date = ?, note = ?, tags_json = ?, is_refund = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(
        next.type,
        next.amountCents,
        next.categoryId,
        next.accountId,
        next.date,
        next.note,
        serialiseTags(next.tags),
        next.isRefund ? 1 : 0,
        nowMs,
        id,
      );

    // Refund links: cleared when not a refund; replaced when the caller
    // provides them; left untouched when the caller omits them on a row
    // that is already a refund.
    if (!next.isRefund) {
      this.replaceRefundLinks(id, [], nowMs);
    } else if (Array.isArray(input.refundLinkedTxIds)) {
      this.replaceRefundLinks(id, next.refundLinkedTxIds, nowMs);
    }

    // Amount/type/refund-flag changes invalidate every durable split set that
    // mentions this bill. Category/date/purpose edits are resolved at read time
    // and deliberately do not destroy a confirmed split.
    const invalidationReason =
      next.type !== current.type || next.isRefund !== current.isRefund
        ? 'type-change'
        : next.amountCents !== current.amountCents
          ? 'amount-change'
          : null;
    if (invalidationReason !== null) {
      invalidateFinancialRefundSources(this.db, {
        transactionIds: [id],
        reason: invalidationReason,
        operationId,
        now: nowMs,
      });
    }

    const needsPurposeWrite =
      explicitPurpose || (current.financialPurpose !== null && next.type !== TYPE_EXPENSE);
    const auditActorId = needsPurposeWrite ? (actorId ?? this.resolveActorId()) : null;

    if (explicitPurpose) {
      writeBillPurposeOverride(this.db, {
        transactionId: id,
        purpose: next.financialPurpose,
        expectedRevision: current.financialPurposeRevision,
        reason: next.financialPurpose === null ? 'cleared' : 'explicit-override',
        operationId,
        actorId: auditActorId,
        now: nowMs,
      });
    } else if (current.financialPurpose !== null && next.type !== TYPE_EXPENSE) {
      writeBillPurposeOverride(this.db, {
        transactionId: id,
        purpose: null,
        expectedRevision: current.financialPurposeRevision,
        reason: 'type-change',
        operationId,
        actorId: auditActorId,
        now: nowMs,
      });
    }

    if (explicitPurpose) {
      writeFundPurpose(this.db, id, next.fundPurpose, auditActorId, operationId, nowMs, hasFundPurpose(input));
    }

    return this.getByIdOrThrow(id);
  }

  /**
   * Soft delete. The row stays in the table with `deleted = 1` (AC3).
   *
   * Refund links are removed as part of the same transaction. A link to an expense that
   * is no longer live cannot be meaningfully traced in the live UI, and a link from a
   * refund that is in the trash should not still point at a live expense.
   */
  softDelete(id: string): void {
    this.getByIdOrThrow(id);
    const nowMs = this.now();
    const run = this.db.transaction((): void => {
      this.db
        .prepare('UPDATE transactions SET deleted = 1, updated_at = ? WHERE id = ?')
        .run(nowMs, id);
      this.db
        .prepare('DELETE FROM refund_links WHERE refund_tx_id = ? OR original_tx_id = ?')
        .run(id, id);
      // Durable split sets are independent of refund_links: invalidate the
      // whole set while the row still exists, in this same transaction.
      invalidateFinancialRefundSources(this.db, {
        transactionIds: [id],
        reason: 'delete',
        now: nowMs,
      });
    });
    run();
  }

  /**
   * Restores a soft-deleted row. Used by the trash view and by tests.
   *
   * Idempotent by design: asking to restore a row that is already live returns it
   * unchanged. It must return EARLY rather than re-running the UPDATE, because the
   * UPDATE also bumps `updated_at`, and `updated_at` is the tie-breaker in the list
   * ordering (`ORDER BY date DESC, updated_at DESC`). Re-stamping a live row would make
   * it silently jump position in the list, which is a state change the caller never
   * asked for.
   */
  restore(id: string): TransactionDto {
    const deleted = this.deletedFlag(id);
    if (deleted === undefined) throw new NotFoundError();
    if (deleted === 0) return this.getByIdOrThrow(id);

    const nowMs = this.now();
    const run = this.db.transaction((): TransactionDto => {
      this.db
        .prepare('UPDATE transactions SET deleted = 0, updated_at = ? WHERE id = ?')
        .run(nowMs, id);
      // Restore never revives a previously invalidated split set; the hook is
      // still called for audit symmetry and to catch any active stale set.
      invalidateFinancialRefundSources(this.db, {
        transactionIds: [id],
        reason: 'restore',
        now: nowMs,
      });
      return this.getByIdOrThrow(id);
    });
    return run();
  }

  /**
   * Hard delete — the one sanctioned exception to "business rows are only soft-deleted"
   * (see `database-guidelines.md`).
   *
   * Only ever acts on a row that is ALREADY soft-deleted, so a hard delete can only ever
   * follow a deliberate trip through the trash. A live row is a conflict, not a
   * not-found: the two mean different things to the caller and must not be collapsed.
   *
   * Refund links are removed first: this row may be the refund or the original, and
   * leaving the link would let a hard-deleted id linger in `refund_links`.
   */
  purge(id: string): void {
    const deleted = this.deletedFlag(id);
    if (deleted === undefined) throw new NotFoundError();
    if (deleted === 0) {
      throw new ConflictError(
        'Only bills in the recycle bin can be permanently deleted. Delete it first, then purge it.',
      );
    }

    const nowMs = this.now();
    const run = this.db.transaction((): void => {
      // Purge is a tombstone/detach, not a silent disappearance: the durable
      // split set gets a purged audit and its executable rows are removed.
      invalidateFinancialRefundSources(this.db, {
        transactionIds: [id],
        reason: 'purge',
        now: nowMs,
      });
      this.db
        .prepare('DELETE FROM refund_links WHERE refund_tx_id = ? OR original_tx_id = ?')
        .run(id, id);
      this.db.prepare('DELETE FROM transactions WHERE id = ?').run(id);
    });
    run();
  }

  /** Restores every soft-deleted row. Returns how many came back. */
  restoreAll(): number {
    const nowMs = this.now();
    const run = this.db.transaction((): number => {
      const ids = (
        this.db.prepare('SELECT id FROM transactions WHERE deleted = 1').all() as {
          id: string;
        }[]
      ).map((row) => row.id);
      if (ids.length === 0) return 0;
      const changed = this.db
        .prepare('UPDATE transactions SET deleted = 0, updated_at = ? WHERE deleted = 1')
        .run(nowMs).changes;
      invalidateFinancialRefundSources(this.db, {
        transactionIds: ids,
        reason: 'restore',
        now: nowMs,
      });
      return changed;
    });
    return run();
  }

  /** Permanently deletes every soft-deleted row. Returns how many are gone. */
  purgeAll(): number {
    const nowMs = this.now();
    const run = this.db.transaction((): number => {
      const ids = (
        this.db.prepare('SELECT id FROM transactions WHERE deleted = 1').all() as {
          id: string;
        }[]
      ).map((row) => row.id);
      if (ids.length > 0) {
        // Tombstone/detach every affected split set before the rows disappear.
        invalidateFinancialRefundSources(this.db, {
          transactionIds: ids,
          reason: 'purge',
          now: nowMs,
        });
        // A subquery keeps the parameter count constant for any table size;
        // binding every deleted id here would hit SQLite's variable limit.
        this.db
          .prepare(
            `DELETE FROM refund_links
                WHERE refund_tx_id IN (SELECT id FROM transactions WHERE deleted = 1)
                   OR original_tx_id IN (SELECT id FROM transactions WHERE deleted = 1)`,
          )
          .run();
      }
      return this.db.prepare('DELETE FROM transactions WHERE deleted = 1').run().changes;
    });
    return run();
  }

  /**
   * Deleted rows only, most recently deleted first.
   *
   * The ordering key is `updated_at`, used as a proxy for the deletion time: a row in
   * the trash is not editable, and `softDelete` stamps `updated_at` when it flips the
   * flag. That is why this deliberately does NOT reuse `list()`'s
   * `ORDER BY date DESC, updated_at DESC` — in the trash you want the thing you just
   * deleted at the top, not the bill with the newest transaction date.
   */
  listDeleted(limit = MAX_PAGE_SIZE, offset = 0): TransactionDto[] {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), MAX_PAGE_SIZE);
    const rows = this.db
      .prepare(
        `SELECT transactions.*, ${FUND_COLUMNS} FROM transactions
          WHERE deleted = 1
          ORDER BY updated_at DESC, id
         LIMIT ? OFFSET ?`,
      )
      .all(safeLimit, Math.max(0, Math.trunc(offset))) as TransactionRow[];
    return rows.map((row) => toDto(row));
  }

  /** Number of rows currently in the trash, for the "will delete N" confirmation. */
  countDeleted(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS c FROM transactions WHERE deleted = 1')
      .get() as { c: number };
    return row.c;
  }

  /**
   * Total gross expense across the given rows, in cents.
   *
   * Delegates to the shared rule rather than re-deriving it: `TransactionDto` is
   * structurally compatible with the shared `Transaction` shape for the fields the
   * rule reads.
   */
  netExpenseCents(items: readonly TransactionDto[]): number {
    return items.reduce(
      (sum, item) => sum + expenseContribution(item as unknown as Transaction),
      0,
    );
  }

  /** Total income across the given rows (refunds included — they are income). */
  incomeCents(items: readonly TransactionDto[]): number {
    return items.reduce((sum, item) => sum + incomeContribution(item as unknown as Transaction), 0);
  }

  /** One predicate builder for paged rows and complete daily summaries. */
  private listPredicates(query: ListTransactionsQuery): {
    whereSql: string;
    params: (string | number)[];
  } {
    const where: string[] = [];
    const params: (string | number)[] = [];

    if (query.includeDeleted !== true) {
      where.push('deleted = 0');
    }
    if (query.from !== undefined) {
      where.push('date >= ?');
      params.push(query.from);
    }
    if (query.to !== undefined) {
      where.push('date < ?');
      params.push(query.to);
    }
    if (query.type !== undefined) {
      where.push('type = ?');
      params.push(query.type);
    }
    if (query.categoryId !== undefined) {
      where.push('category_id = ?');
      params.push(query.categoryId);
    }
    if (query.accountId !== undefined) {
      where.push('account_id = ?');
      params.push(query.accountId);
    }
    if (query.tagId !== undefined) {
      const catalog = new TagCatalogService(this.db);
      const selected = catalog.getById(query.tagId);
      if (!selected) return { whereSql: 'WHERE 0', params: [] };
      const names = [selected.name, ...catalog.childrenOf(selected.id).map((child) => child.name)];
      where.push(`(${names.map(() => "tags_json LIKE ? ESCAPE '\\'").join(' OR ')})`);
      for (const name of names) params.push(`%"${escapeLikePattern(name)}"%`);
    }
    if (query.tag !== undefined && query.tag.trim() !== '') {
      // Tags are a JSON array of names. Matching the quoted name keeps "food" from
      // matching a tag named "seafood".
      where.push("tags_json LIKE ? ESCAPE '\\'");
      params.push(`%"${escapeLikePattern(query.tag.trim())}"%`);
    }
    if (query.q !== undefined && query.q.trim() !== '') {
      where.push("note LIKE ? ESCAPE '\\'");
      params.push(`%${escapeLikePattern(query.q.trim())}%`);
    }

    if (query.search !== undefined && query.search.trim() !== '') {
      // SQLite lower folds ASCII only. instr is literal and preserves embedded NULs,
      // unlike LIKE, which treats NUL as the end of either string.
      // Decode array elements, not the JSON serialization (which escapes quotes and slashes).
      // Malformed/non-array legacy JSON contributes no tags, just like parseTagsJson.
      const term = query.search.trim();
      where.push(`(instr(lower(note), lower(?)) > 0
        OR EXISTS (SELECT 1 FROM categories c WHERE c.id = transactions.category_id AND instr(lower(c.name), lower(?)) > 0)
        OR EXISTS (SELECT 1 FROM accounts a WHERE a.id = transactions.account_id AND instr(lower(a.name), lower(?)) > 0)
        OR EXISTS (SELECT 1 FROM json_each(CASE
          WHEN json_valid(tags_json) THEN CASE WHEN json_type(tags_json) = 'array' THEN tags_json ELSE '[]' END
          ELSE '[]' END) tag WHERE tag.type = 'text' AND instr(lower(tag.value), lower(?)) > 0)
        OR instr(printf('%d.%02d', amount_cents / 100, amount_cents % 100), lower(?)) > 0)`);
      params.push(term, term, term, term, term);
    }

    return { whereSql: where.length > 0 ? `WHERE ${where.join(' AND ')}` : '', params };
  }

  /** Check the exact matching scope before hashing or materialising any result rows. */
  private preflightSearch(whereSql: string, params: (string | number)[]): number {
    // CAST to BLOB counts UTF-8 bytes, including embedded NULs. Keep these fields
    // aligned with the variable-length TEXT columns in transactions / snapshot rows.
    const scope = this.db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(
      length(CAST(id AS BLOB)) + length(CAST(category_id AS BLOB)) +
      length(CAST(account_id AS BLOB)) + length(CAST(note AS BLOB)) +
      length(CAST(tags_json AS BLOB)) + COALESCE(length(CAST(financial_purpose AS BLOB)), 0)
    ), 0) AS text_bytes FROM transactions ${whereSql}`).get(...params) as { count: number; text_bytes: number };
    if (scope.count > MAX_SEARCH_ROWS || scope.text_bytes > MAX_SEARCH_TEXT_BYTES) {
      throw new ValidationError('搜索结果过多或文本过大，请缩小月份、账户或关键词范围后重试。');
    }
    return scope.count;
  }

  /** Stream a deterministic snapshot including the refund summary exposed in list DTOs. */
  private searchSnapshotRows(whereSql: string, params: (string | number)[]): IterableIterator<unknown> {
    return this.db.prepare(`SELECT transactions.*, ${FUND_COLUMNS},
      (SELECT json_array(COUNT(*), COALESCE(SUM(refund.amount_cents), 0))
         FROM refund_links link JOIN transactions refund ON refund.id = link.refund_tx_id AND refund.deleted = 0
        WHERE link.original_tx_id = transactions.id) AS search_refund_summary
      FROM transactions ${whereSql}
      ORDER BY date DESC, updated_at DESC, transactions.id ASC`).iterate(...params);
  }

  /** Complete live ordinary-transaction totals; salaries and transfers are separate tables. */
  dailySummary(query: DailySummaryQuery): { items: DailySummaryItem[]; searchVersion?: 1; searchRevision?: string } {
    const { from, to, timeZone } = query;
    if (
      from === undefined || to === undefined ||
      !Number.isSafeInteger(from) || !Number.isSafeInteger(to) ||
      Math.abs(from) > 8_640_000_000_000_000 || Math.abs(to) > 8_640_000_000_000_000 ||
      from >= to || to - from > 32 * 86_400_000
    ) {
      throw new ValidationError('请提供有效的 from/to 毫秒时间戳，范围须为 [from,to) 且不超过 32 天。');
    }
    if (typeof timeZone !== 'string' || timeZone.trim() === '' || /^[+-]/.test(timeZone)) {
      throw new ValidationError('请提供有效的 IANA timeZone 时区名称。');
    }
    let formatter: Intl.DateTimeFormat;
    try {
      formatter = new Intl.DateTimeFormat('en-US', {
        timeZone, calendar: 'iso8601', numberingSystem: 'latn',
        year: 'numeric', month: '2-digit', day: '2-digit',
      });
    } catch {
      throw new ValidationError('请提供有效的 IANA timeZone 时区名称。');
    }

    const readSummary = (): { items: DailySummaryItem[]; searchVersion?: 1; searchRevision?: string } => {
      const { whereSql, params } = this.listPredicates({ ...query, includeDeleted: false });
      const searching = Boolean(query.search?.trim());
      if (searching) this.preflightSearch(whereSql, params);
      const hash = searching ? createHash('sha256') : undefined;
      const rows = searching
        ? this.searchSnapshotRows(whereSql, params)
        : this.db.prepare(`SELECT * FROM transactions ${whereSql}`).iterate(...params);
      const days = new Map<string, DailySummaryItem>();
      for (const raw of rows) {
        hash?.update(`${JSON.stringify(raw)}\n`);
        const row = raw as TransactionRow;
        const parts = formatter.formatToParts(row.date);
        const part = (type: Intl.DateTimeFormatPartTypes): string =>
          parts.find((value) => value.type === type)!.value;
        const day = `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`;
        const item = days.get(day) ?? { day, expenseCents: 0, incomeCents: 0, count: 0 };
        const transaction = toDto(row);
        item.expenseCents += expenseContribution(transaction);
        item.incomeCents += incomeContribution(transaction);
        if (!Number.isSafeInteger(item.expenseCents) || !Number.isSafeInteger(item.incomeCents)) {
          throw new ValidationError('当日汇总金额超出安全整数范围，无法准确计算。');
        }
        item.count++;
        days.set(day, item);
      }
      return {
        items: [...days.values()].sort((a, b) => b.day.localeCompare(a.day)),
        ...(hash ? { searchVersion: 1 as const, searchRevision: hash.digest('hex') } : {}),
      };
    };
    return query.search?.trim() ? this.db.transaction(readSummary)() : readSummary();
  }

  /** Filtered, paginated list. Newest first; newest-edited first within a day. */
  list(query: ListTransactionsQuery = {}): ListTransactionsResult {
    const hasExpectedCents = query.expectedExpenseCents !== undefined;
    const hasExpectedCount = query.expectedExpenseCount !== undefined;
    if (hasExpectedCents !== hasExpectedCount) {
      throw new ValidationError('expectedExpenseCents and expectedExpenseCount must be supplied together.');
    }
    if (hasExpectedCents) {
      if (
        !Number.isSafeInteger(query.expectedExpenseCents) || query.expectedExpenseCents! < 0 ||
        !Number.isSafeInteger(query.expectedExpenseCount) || query.expectedExpenseCount! < 0 ||
        query.type !== TYPE_EXPENSE || query.categoryId === undefined || query.includeDeleted === true ||
        query.from === undefined || query.to === undefined || !Number.isSafeInteger(query.from) ||
        !Number.isSafeInteger(query.to) || query.from >= query.to ||
        query.tag !== undefined || query.tagId !== undefined || query.q !== undefined || query.search !== undefined
      ) {
        throw new ValidationError('Expense total guards require exact non-negative totals and an exact live expense category/date scope.');
      }
    }
    const limit = Math.min(
      Math.max(Math.trunc(query.limit ?? DEFAULT_PAGE_SIZE), 1),
      MAX_PAGE_SIZE,
    );
    const offset = Math.max(Math.trunc(query.offset ?? 0), 0);

    const readPage = (): ListTransactionsResult => {
      const { whereSql, params } = this.listPredicates(query);
      const searching = Boolean(query.search?.trim());
      let searchRevision: string | undefined;
      let total: number;
      if (searching) {
        total = this.preflightSearch(whereSql, params);
        const hash = createHash('sha256');
        for (const row of this.searchSnapshotRows(whereSql, params)) hash.update(`${JSON.stringify(row)}\n`);
        searchRevision = hash.digest('hex');
      } else if (query.expectedExpenseCents !== undefined && query.expectedExpenseCount !== undefined) {
        // C3 drilldown sends the summary produced just before it starts paging. Check
        // both row count and gross cents inside the same SQLite read transaction as
        // the page, so an edit between the summary and a page never pairs old money
        // with new rows. Android deliberately does not sum page amounts itself.
        const scope = this.db
          .prepare(
            `SELECT COUNT(*) AS count, COALESCE(SUM(amount_cents), 0) AS expense_cents
               FROM transactions ${whereSql}`,
          )
          .get(...params) as { count: number; expense_cents: number };
        if (
          scope.count !== query.expectedExpenseCount ||
          scope.expense_cents !== query.expectedExpenseCents
        ) {
          throw new ConflictError('统计后支出账单已变化，明细读取已中止，请返回统计刷新后重试。');
        }
        total = scope.count;
      } else {
        const totalRow = this.db
          .prepare(`SELECT COUNT(*) AS c FROM transactions ${whereSql}`)
          .get(...params) as { c: number };
        total = totalRow.c;
      }

      const rows = this.db
        .prepare(
          `SELECT transactions.*, ${FUND_COLUMNS} FROM transactions ${whereSql}
            ORDER BY date DESC, updated_at DESC${searching ? ', id ASC' : ''}
            LIMIT ? OFFSET ?`,
        )
        .all(...params, limit, offset) as TransactionRow[];

      return {
        items: this.withRefundSummaries(rows),
        total,
        limit,
        offset,
        ...(searchRevision !== undefined ? { searchVersion: 1 as const, searchRevision } : {}),
      };
    };

    if (query.search?.trim() || (query.expectedExpenseCents !== undefined && query.expectedExpenseCount !== undefined)) {
      return this.db.transaction(readPage)();
    }
    return readPage();
  }

  /**
   * Batch-attaches refund summaries to non-refund expense rows in a list result.
   *
   * A single GROUP BY query covers all expenses in the page, so the list endpoint
   * stays at two queries total regardless of how many rows have refunds.
   */
  private withRefundSummaries(rows: TransactionRow[]): TransactionDto[] {
    const expenseIds = rows
      .filter((row) => row.type === TYPE_EXPENSE && row.is_refund !== 1)
      .map((row) => row.id);

    if (expenseIds.length === 0) {
      return rows.map((row) => toDto(row));
    }

    const placeholders = expenseIds.map(() => '?').join(',');
    const summaryRows = this.db
      .prepare(
        `SELECT rl.original_tx_id AS id,
                COUNT(*)          AS refund_count,
                SUM(t.amount_cents) AS total_refund
           FROM refund_links rl
           JOIN transactions t ON t.id = rl.refund_tx_id AND t.deleted = 0
          WHERE rl.original_tx_id IN (${placeholders})
          GROUP BY rl.original_tx_id`,
      )
      .all(...expenseIds) as { id: string; refund_count: number; total_refund: number }[];

    const summaryMap = new Map<string, RefundSummary>();
    for (const row of summaryRows) {
      summaryMap.set(row.id, {
        totalRefundCents: row.total_refund,
        refundCount: row.refund_count,
      });
    }

    return rows.map((row) => {
      const summary = summaryMap.get(row.id);
      if (summary !== undefined) {
        return toDto(row, undefined, summary);
      }
      return toDto(row);
    });
  }

  /** Distinct tag names with usage counts, most used first (feeds T7). */
  listTags(includeDeleted = false): { name: string; count: number }[] {
    const rows = this.db
      .prepare(`SELECT tags_json FROM transactions ${includeDeleted ? '' : 'WHERE deleted = 0'}`)
      .all() as { tags_json: string }[];

    const counts = new Map<string, number>();
    for (const row of rows) {
      for (const tag of parseTagsJson(row.tags_json)) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }

    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }
}
