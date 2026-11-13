import { createHash } from 'node:crypto';
import { dateOnly } from '@jizhang/shared';
import type { Db } from '../db/index.js';
import type { AssistantJsonObject } from './assistant-types.js';

/** Only these ledger tables participate. Auth, provider credentials, chat and run progress never do. */
const BUSINESS_TABLES = [
  'accounts', 'categories', 'tags', 'transactions', 'refund_links', 'salary_records', 'transfers',
  'budget_allocations', 'budget_templates', 'recurring_rules', 'recurring_occurrences', 'asset_items',
  'financial_config_revisions', 'financial_mapping_revisions', 'financial_periods', 'financial_period_revisions',
  'financial_period_sources', 'financial_refund_splits', 'financial_refund_split_sets', 'financial_bill_purpose_events',
  'financial_fund_config_revisions', 'financial_fund_grants', 'financial_fund_grant_revisions', 'financial_fund_grant_sources',
  'financial_fund_purposes', 'financial_fund_purpose_events', 'financial_fund_migration_issues',
  'financial_fund_income_allocations', 'financial_fund_income_allocation_revisions',
  'manual_goal_openings', 'manual_goal_entries', 'manual_goal_state', 'ai_organization_audit', 'ai_organization_operations',
] as const;

/** Conservative CAS over private business facts. Stream hashing avoids a giant model-facing snapshot. */
export function assistantBusinessFingerprint(db: Db, name: string, args: AssistantJsonObject, now: number): string {
  const hash = createHash('sha256').update(name).update(JSON.stringify(args));
  if (name === 'recurring.generate') hash.update(String(dateOnly(now)));
  for (const table of BUSINESS_TABLES) {
    hash.update(table);
    for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).iterate()) hash.update(JSON.stringify(row));
  }
  hash.update(JSON.stringify(db.prepare("SELECT * FROM settings WHERE key IN ('financial.plan.v1','budget.cycle_start_day') ORDER BY key").all()));
  return hash.digest('hex');
}
