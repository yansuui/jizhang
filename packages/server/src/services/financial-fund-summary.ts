import { createHash } from 'node:crypto';
import { allocateFundIncomeCents, projectFundBalances, validateFinancialRatiosBps, type FundAmounts, type FundCoverage, type FundGrantFact, type FundPurpose, type FundRefundSplitFact, type FundTransactionFact, type FundUnallocatedSalaryFact } from '@jizhang/shared';
import type { Db } from '../db/index.js';
import { canonicalFinancialPayload } from './financial-operation-store.js';
import { fundGrantNeedsReview } from './financial-fund-store.js';
import { financialTransactionToken } from './financial-purpose-store.js';
import { financialCriticalFactsEqual, parseFinancialCriticalFacts, type FinancialCriticalFacts } from './financial-source-lifecycle.js';

/** Lifetime summary. Amounts are integer cents; asOf is the caller's epoch milliseconds.
 * unknownUnallocatedSalaryCount distinguishes absent/invalid amounts from known zero.
 * snapshotToken is a SHA-256 digest of relevant persisted facts, independent of asOf.
 * No date/activity filter is accepted here. Incomplete figures are provisional. */
export interface FundSummaryView {
  readonly contractVersion: 1;
  readonly asOf: number;
  readonly balances: FundAmounts;
  readonly totals: ReturnType<typeof projectFundBalances>['totals'];
  readonly coverage: FundCoverage & { readonly unknownUnallocatedSalaryCount: number };
  readonly snapshotToken: string;
}
type Row = Record<string, unknown>;
const purposes: readonly FundPurpose[] = ['growth', 'reserve', 'essentials', 'joy'];
const positive = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
const safe = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
const text = (n: unknown): n is string => typeof n === 'string' && n.length > 0;
function parse(value: unknown): unknown { try { return typeof value === 'string' ? JSON.parse(value) as unknown : null; } catch { return null; } }
function object(value: unknown): Row | null { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : null; }
function same(a: unknown, b: unknown): boolean { return canonicalFinancialPayload(a) === canonicalFinancialPayload(b); }
function critical(row: Row | undefined): FinancialCriticalFacts | null {
  if (row === undefined || !positive(row['amount_cents']) || (row['type'] !== 0 && row['type'] !== 1) || (row['is_refund'] !== 0 && row['is_refund'] !== 1)) return null;
  return { amountCents: row['amount_cents'], type: row['type'], isRefund: row['is_refund'] === 1 };
}
/** Reads every relevant table in one SQLite snapshot. Throws rather than inventing malformed ledger amounts. */
export function readFundSummary(db: Db, now: number): FundSummaryView {
  if (!safe(now)) throw new Error('Invalid summary asOf');
  return db.transaction(() => {
    const get = (sql: string): Row[] => db.prepare(sql).all() as Row[];
    const salaries = get('SELECT id,amount_cents,date,account_id,deleted FROM salary_records ORDER BY id');
    const grantRows = get('SELECT * FROM financial_fund_grants ORDER BY id');
    const revisions = get('SELECT * FROM financial_fund_grant_revisions ORDER BY grant_id,revision');
    const members = get('SELECT * FROM financial_fund_grant_sources ORDER BY salary_id');
    const txRows = get('SELECT t.id,t.type,t.amount_cents,t.date,t.is_refund,t.deleted,t.category_id,t.account_id,p.purpose,p.revision,p.source FROM transactions t LEFT JOIN financial_fund_purposes p ON p.transaction_id=t.id ORDER BY t.id');
    const splitRows = get('SELECT * FROM financial_refund_splits ORDER BY refund_tx_id,original_tx_id,id');
    const setRows = get('SELECT * FROM financial_refund_split_sets ORDER BY refund_tx_id,revision');
    const issueRows = get('SELECT * FROM financial_fund_migration_issues WHERE status=\'open\' ORDER BY source_kind,source_id,reason');
    const allocationRows = get(`SELECT transaction_id,revision,source_token,amount_cents,ratios_json,targets_json,status
      FROM financial_fund_income_allocations WHERE status='active' ORDER BY transaction_id`);
    const txMap = new Map(txRows.map((r) => [r['id'], r]));
    const salaryMap = new Map(salaries.map((r) => [r['id'], r]));
    const claimed = new Set<unknown>(); const unknown = new Set<string>(); const issueIds = new Set<string>();
    const grants: FundGrantFact[] = [];
    for (const grant of grantRows) {
      const id = grant['id']; const owned = members.filter((m) => m['grant_id'] === id);
      if (!text(id)) throw new Error('Malformed grant identity');
      if (grant['status'] !== 'active') continue;
      let valid = positive(grant['active_revision']);
      const rev = revisions.find((r) => r['grant_id'] === id && r['revision'] === grant['active_revision']);
      let amounts: FundAmounts | undefined;
      try {
        if (!valid || rev === undefined || !positive(rev['source_amount_cents']) || !safe(rev['created_at']) || fundGrantNeedsReview(db, id)) throw new Error('stale');
        const expected = allocateFundIncomeCents(rev['source_amount_cents'], validateFinancialRatiosBps(parse(rev['ratios_json'])));
        const targets = object(parse(rev['targets_json']));
        if (targets === null || purposes.some((p) => targets[p] !== expected[p])) throw new Error('invalid targets');
        let total = 0n;
        for (const member of owned) { if (!positive(member['amount_cents'])) throw new Error('invalid source'); total += BigInt(member['amount_cents']); }
        if (total !== BigInt(rev['source_amount_cents'])) throw new Error('invalid source total');
        amounts = expected;
      } catch { valid = false; }
      if (valid && amounts !== undefined) { grants.push({ grantId: id, amounts }); for (const m of owned) claimed.add(m['salary_id']); }
      else {
        // A missing source still represents unknown funding, not zero.
        if (owned.length === 0) issueIds.add(`grant:${id}`);
        for (const m of owned) if (salaryMap.get(m['salary_id']) === undefined && text(m['salary_id'])) unknown.add(m['salary_id']);
      }
    }
    // A confirmed income allocation replaces the bill's own single-purpose facts: it funds the
    // four purposes by the frozen ratios and stops a refund from also crediting its original.
    const allocatedIncome = new Set<string>();
    for (const row of allocationRows) {
      const id = row['transaction_id'];
      const tx = text(id) ? txMap.get(id) : undefined;
      try {
        if (!text(id) || tx === undefined || !positive(row['revision']) || !positive(row['amount_cents'])) throw new Error('missing');
        if (tx['deleted'] !== 0 || tx['type'] !== 1) throw new Error('not a live income');
        if (!positive(tx['amount_cents']) || tx['amount_cents'] !== row['amount_cents']) throw new Error('amount changed');
        const token = financialTransactionToken({
          id: tx['id'] as string, type: tx['type'] as number, amountCents: tx['amount_cents'] as number,
          categoryId: tx['category_id'] as string, date: tx['date'] as number,
          isRefund: tx['is_refund'] as number, deleted: tx['deleted'] as number, accountId: tx['account_id'] as string,
        });
        if (token !== row['source_token']) throw new Error('source changed');
        const ratios = validateFinancialRatiosBps(parse(row['ratios_json']));
        const expected = allocateFundIncomeCents(row['amount_cents'], ratios);
        const targets = object(parse(row['targets_json']));
        if (targets === null || purposes.some((p) => targets[p] !== expected[p])) throw new Error('invalid targets');
        grants.push({ grantId: `income:${id}`, amounts: expected });
        allocatedIncome.add(id);
      } catch {
        // The stored decision no longer matches its source: report it, never invent a split.
        issueIds.add(`income-allocation:${String(id)}`);
      }
    }
    const unallocated: FundUnallocatedSalaryFact[] = [];    for (const salary of salaries) {
      if (salary['deleted'] === 1 || claimed.has(salary['id'])) continue;
      if (salary['deleted'] !== 0 || !text(salary['id'])) throw new Error('Malformed salary status');
      if (positive(salary['amount_cents'])) unallocated.push({ salaryId: salary['id'], amountCents: salary['amount_cents'] });
      else unknown.add(salary['id']);
    }
    const transactions: FundTransactionFact[] = txRows
      .filter((r) => !allocatedIncome.has(r['id'] as string))
      .map((r) => {
      if (!text(r['id']) || !positive(r['amount_cents']) || !safe(r['date']) || (r['type'] !== 0 && r['type'] !== 1) || (r['is_refund'] !== 0 && r['is_refund'] !== 1) || (r['deleted'] !== 0 && r['deleted'] !== 1)) throw new Error('Malformed transaction');
      const p = r['purpose'];
      if (p !== null && !purposes.includes(p as FundPurpose)) throw new Error('Malformed fund purpose');
      if (p !== null && (!positive(r['revision']) || !text(r['source']))) throw new Error('Malformed purpose revision');
      return { transactionId:r['id'], type:r['type'] === 0 ? 'expense' : 'income', isRefund:r['is_refund'] === 1, amountCents:r['amount_cents'], date:r['date'], purpose:p as FundPurpose | null, purposeStatus:p === null ? 'unresolved' : 'resolved', status:r['deleted'] === 0 ? 'live' : 'deleted' };
    });
    const groups = new Map<unknown, Row[]>();
    for (const row of splitRows) {
      // An allocated refund is funded by ratio instead; its old split must not credit again.
      if (allocatedIncome.has(row['refund_tx_id'] as string)) continue;
      const list = groups.get(row['refund_tx_id']) ?? []; list.push(row); groups.set(row['refund_tx_id'], list);
    }
    const splits: FundRefundSplitFact[] = [];
    for (const [refundId, rows] of groups) {
      const latest = setRows.filter((s) => s['refund_tx_id'] === refundId).at(-1);
      const refund = txMap.get(refundId); const refundFacts = critical(refund);
      const snapshots = rows.map((r) => ({ originalTransactionId:r['original_tx_id'], amountCents:r['amount_cents'] }));
      const facts = { refund: refundFacts, originals: rows.map((r) => ({ transactionId:r['original_tx_id'], facts:critical(txMap.get(r['original_tx_id'])) })) };
      let valid = latest !== undefined && latest['status'] === 'confirmed' && positive(latest['revision']) && same(parse(latest['splits_json']), snapshots) && same(parse(latest['facts_json']), facts);
      for (const row of rows) {
        const orig = txMap.get(row['original_tx_id']); const origFacts = critical(orig);
        const savedOrig = parseFinancialCriticalFacts(String(row['original_facts_json'])); const savedRefund = parseFinancialCriticalFacts(String(row['refund_facts_json']));
        if (row['state'] !== 'active' || row['set_revision'] !== latest?.['revision'] || refund?.['deleted'] !== 0 || orig?.['deleted'] !== 0 || refundFacts === null || origFacts === null || savedOrig === undefined || savedRefund === undefined || !financialCriticalFactsEqual(savedOrig, origFacts) || !financialCriticalFactsEqual(savedRefund, refundFacts)) valid = false;
      }
      for (const row of rows) {
        if (!text(row['id']) || !text(row['refund_tx_id']) || !text(row['original_tx_id']) || !positive(row['amount_cents'])) throw new Error('Malformed refund split');
        splits.push({ splitId:row['id'], refundTransactionId:row['refund_tx_id'], originalTransactionId:row['original_tx_id'], amountCents:row['amount_cents'], validity:valid ? 'valid' : 'invalid' });
      }
    }
    for (const issue of issueRows) {
      const kind = issue['source_kind'];
      // Salary and transaction issues are represented by their current live source, not their archival evidence.
      if (kind === 'salary' || kind === 'transaction' || kind === 'period') continue;
      issueIds.add(`${String(kind)}:${String(issue['source_id'])}:${String(issue['reason'])}`);
    }
    const projection = projectFundBalances({ grants, transactions, refundSplits:splits, unallocatedSalaries:unallocated, issues:[...issueIds].sort() });
    const snapshotToken = createHash('sha256').update(JSON.stringify({ salaries, grantRows, revisions, members, txRows, splitRows, setRows, issues: issueRows, allocationRows })).digest('hex');
    return { contractVersion:1 as const, asOf:now, ...projection, coverage:{ ...projection.coverage, complete:projection.coverage.complete && unknown.size === 0, unknownUnallocatedSalaryCount:unknown.size }, snapshotToken };
  })();
}