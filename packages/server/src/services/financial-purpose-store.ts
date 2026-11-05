/**
 * Bill-purpose override storage shared by the legacy transaction write path and
 * the new financial-planning read/write paths.
 *
 * The two columns on `transactions` are deliberately small facts:
 *
 * - `financial_purpose` is `NULL` when the bill has no explicit override;
 * - `financial_purpose_revision` is `0` until an override is written at least
 *   once. Every effective change appends one `financial_bill_purpose_events`
 *   row with that revision, so the history survives a hard purge of the bill.
 *
 * A no-op write (same value as the current one) keeps the revision unchanged
 * and appends nothing. That matters for idempotent retries and for PATCHes that
 * only touch unrelated bill fields: a purpose field omitted from a request is
 * "leave it alone", not "clear it".
 *
 * This module never imports `transaction-service.ts` (that service imports this
 * one). Errors come from `financial-errors.ts` for the same reason.
 */
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { TYPE_EXPENSE, type SpendingPurpose } from '@jizhang/shared';
import type { Db } from '../db/index.js';
import {
  FinancialInvalidError,
  FinancialNotFoundError,
  FinancialRevisionConflictError,
  FinancialUnavailableError,
} from './financial-errors.js';

/** The real stored facts for one bill's explicit purpose. */
export interface BillPurposeFacts {
  readonly transactionId: string;
  readonly financialPurpose: SpendingPurpose | null;
  readonly revision: number;
}

/** Reasons an override event may be written for. */
export type BillPurposeWriteReason =
  | 'explicit-override'
  | 'explicit-edit'
  | 'cleared'
  | 'create'
  | 'type-change';

export interface WriteBillPurposeOverrideInput {
  readonly transactionId: string;
  readonly purpose: SpendingPurpose | null;
  /** The revision the caller read before deciding to change it; 0 on create. */
  readonly expectedRevision: number;
  readonly reason: BillPurposeWriteReason;
  readonly operationId: string | null;
  readonly actorId: string | null;
  readonly now: number;
}

export interface WriteBillPurposeOverrideResult {
  readonly revision: number;
  readonly financialPurpose: SpendingPurpose | null;
}

interface PurposeRow {
  readonly type: number;
  readonly deleted: number;
  readonly financial_purpose: string | null;
  readonly financial_purpose_revision: number;
}

interface FactsRow {
  readonly id: string;
  readonly financial_purpose: string | null;
  readonly financial_purpose_revision: number;
}

const PURPOSE_VALUES: readonly SpendingPurpose[] = ['essentials', 'joy'];

/** Parses a wire/stored purpose, rejecting every other value. */
export function parseFinancialPurpose(value: unknown): SpendingPurpose | null {
  if (value === null) return null;
  if (typeof value === 'string' && (PURPOSE_VALUES as readonly string[]).includes(value)) {
    return value as SpendingPurpose;
  }
  throw new FinancialInvalidError(
    "financialPurpose must be null, 'essentials' or 'joy'.",
  );
}

/** Stored facts are an internal invariant: corruption is 503, never a 400 guess. */
function readStoredPurpose(value: unknown): SpendingPurpose | null {
  if (value === null) return null;
  if (typeof value === 'string' && (PURPOSE_VALUES as readonly string[]).includes(value)) {
    return value as SpendingPurpose;
  }
  throw new FinancialUnavailableError();
}

function readStoredRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new FinancialUnavailableError();
  }
  return value;
}

/** Returns the raw override facts, or `undefined` when the bill does not exist. */
export function readBillPurposeFacts(db: Db, transactionId: string): BillPurposeFacts | undefined {
  const row = db
    .prepare(
      'SELECT id, financial_purpose, financial_purpose_revision FROM transactions WHERE id = ?',
    )
    .get(transactionId) as FactsRow | undefined;
  if (row === undefined) return undefined;
  return {
    transactionId: row.id,
    financialPurpose: readStoredPurpose(row.financial_purpose),
    revision: readStoredRevision(row.financial_purpose_revision),
  };
}

/**
 * Writes the override + one audit event, assuming the caller's transaction.
 *
 * `expectedRevision` is a CAS guard: a stale value is a conflict, not a silent
 * last-writer-wins overwrite. The row is read inside the same transaction as the
 * update, so a concurrent purpose write cannot slip between the check and the
 * write on this single-writer SQLite database.
 */
export function writeBillPurposeOverride(
  db: Db,
  input: WriteBillPurposeOverrideInput,
): WriteBillPurposeOverrideResult {
  if (typeof input.transactionId !== 'string' || input.transactionId.trim() === '') {
    throw new FinancialInvalidError('transactionId is required.');
  }
  const purpose = parseFinancialPurpose(input.purpose);
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new FinancialInvalidError(
      'expectedRevision must be a non-negative safe integer.',
    );
  }
  if (!Number.isSafeInteger(input.now) || input.now < 0) {
    throw new FinancialInvalidError('now must be an epoch-millisecond timestamp.');
  }

  const run = db.transaction((): WriteBillPurposeOverrideResult => {
    const row = db
      .prepare(
        `SELECT type, deleted, financial_purpose, financial_purpose_revision
           FROM transactions
          WHERE id = ?`,
      )
      .get(input.transactionId) as PurposeRow | undefined;

    if (row === undefined) {
      throw new FinancialNotFoundError('Transaction not found.');
    }
    if (purpose !== null && (row.type !== TYPE_EXPENSE || row.deleted !== 0)) {
      throw new FinancialInvalidError(
        'A financial purpose can only be set on a live expense.',
      );
    }

    const currentRevision = readStoredRevision(row.financial_purpose_revision);
    const currentPurpose = readStoredPurpose(row.financial_purpose);
    if (currentRevision !== input.expectedRevision) {
      throw new FinancialRevisionConflictError(
        'The financial purpose revision is stale. Reload the bill and retry.',
      );
    }

    // Same value: keep revision and history untouched. This is the retry/no-op
    // path, not a mutation.
    if (currentPurpose === purpose) {
      return { revision: currentRevision, financialPurpose: purpose };
    }

    // A revision is a JSON-safe integer everywhere else in the financial
    // domain. Refuse to wrap into an unsafe/duplicate number instead of
    // silently corrupting the CAS basis.
    if (currentRevision >= Number.MAX_SAFE_INTEGER) {
      throw new FinancialUnavailableError();
    }
    const nextRevision = currentRevision + 1;
    db.prepare(
      `UPDATE transactions
          SET financial_purpose = ?, financial_purpose_revision = ?
        WHERE id = ?`,
    ).run(purpose, nextRevision, input.transactionId);

    db.prepare(
      `INSERT INTO financial_bill_purpose_events
         (id, transaction_id, revision, purpose, reason, operation_id, actor_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      input.transactionId,
      nextRevision,
      purpose,
      input.reason,
      input.operationId,
      input.actorId,
      input.now,
    );

    return { revision: nextRevision, financialPurpose: purpose };
  });

  return run();
}

/** Contract alias: the raw read helper named in the Phase 1 integration contract. */
export const getFinancialPurpose = readBillPurposeFacts;
/** Contract alias: the raw write helper named in the Phase 1 integration contract. */
export const applyFinancialPurpose = writeBillPurposeOverride;

/** A transaction row in the shape the source-token hash consumes. */
export interface FinancialTransactionTokenRow {
  readonly id: string;
  readonly type: number;
  readonly amountCents: number;
  readonly categoryId: string;
  readonly accountId: string;
  readonly date: number;
  readonly isRefund: boolean | number;
  readonly deleted: boolean | number;
}

function flag(value: boolean | number): number {
  return value === true || value === 1 ? 1 : 0;
}

/**
 * Stable fingerprint of the facts that make a transaction a financial source.
 *
 * Deliberately excludes `updatedAt`, notes and tags: a note edit must not
 * invalidate a confirmed refund split. Amount, type, category, date, account,
 * refund flag and deletion do change the meaning of the source, so they are
 * included.
 * The format is versioned (`financial-transaction-v1`) and fixed-key so the
 * same facts always produce the same SHA-256 regardless of object key order.
 */
export function financialTransactionToken(row: FinancialTransactionTokenRow): string {
  const material = JSON.stringify([
    'financial-transaction-v1',
    String(row.id),
    Number(row.type),
    Number(row.amountCents),
    String(row.categoryId),
    Number(row.date),
    flag(row.isRefund),
    flag(row.deleted),
    String(row.accountId),
  ]);
  return createHash('sha256').update(material, 'utf8').digest('hex');
}

/**
 * Compatibility fallback for legacy single-ledger fixtures. Production private
 * ledgers contain no credentials: tenant service graphs must supply the immutable
 * session user through `TransactionServiceOptions.actorId`, including nested tools.
 */
export function resolveFinancialActorId(db: Db): string {
  const row = db.prepare('SELECT id FROM users ORDER BY created_at, id LIMIT 1').get() as
    | { id: string }
    | undefined;
  if (row === undefined) {
    throw new FinancialInvalidError('No local user account exists for this operation.');
  }
  return row.id;
}
