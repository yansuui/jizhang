import type { Db } from '../index.js';

/**
 * Non-salary income can join the four-purpose split without becoming a salary record.
 *
 * A salary grant is owned by `salary_records`; this table owns the same decision for one
 * income transaction (wage-like or not, refund or not). The active row is the current
 * decision and the revision table keeps every confirmation, mirroring the grant tables.
 * Nothing is backfilled: an existing income stays unresolved until the user confirms it.
 */
export const MIGRATION_026_INCOME_ALLOCATIONS = `
CREATE TABLE financial_fund_income_allocations (
  transaction_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  source_token TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  ratios_json TEXT NOT NULL,
  targets_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE financial_fund_income_allocation_revisions (
  transaction_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  ratios_json TEXT NOT NULL,
  targets_json TEXT NOT NULL,
  source_token TEXT NOT NULL,
  actor_id TEXT,
  operation_id TEXT,
  created_at INTEGER NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY(transaction_id, revision)
);
`;

/** No backfill: an unconfirmed income must stay visibly unresolved rather than be guessed. */
export function backfillIncomeAllocations(_db: Db): void {}
