import { allocateFundIncomeCents, DEFAULT_FINANCIAL_RATIOS_BPS, validateFinancialRatiosBps, type FundRatiosBps } from '@jizhang/shared';
import type { Db } from '../db/index.js';
import { FinancialInvalidError, FinancialRevisionConflictError, FinancialSourceChangedError, FinancialUnavailableError } from './financial-errors.js';
import { readFundSummary, type FundSummaryView } from './financial-fund-summary.js';
import { reviewLegacyFundGrant, type LegacyFundGrantReviewResult } from './financial-fund-review.js';
import { requireFinancialOperationId, runFinancialOperation } from './financial-operation-store.js';
import {
  INCOME_ALLOCATION_RESOURCE,
  allocateIncome as allocateFundIncome,
  parseAllocateIncomeBody,
  readIncomeAllocation,
  type FundIncomeAllocationResponse,
  type FundIncomeAllocationView,
} from './financial-fund-income-allocation.js';
import {
  DEFAULT_PAGE_SIZE,
  FINANCIAL_LIMITS,
  nextFinancialRevision,
  requireObject,
  requireSafeInteger,
  requireTimeZone,
  rethrowSharedError,
  salarySourceToken,
} from './financial-planning-types.js';

/** Bounded, content-free issue identity returned to the client. */
export interface FundIssueView {
  readonly sourceKind: string;
  readonly sourceId: string;
  readonly reason: string;
  readonly status: string;
  readonly source?: { readonly salaryId: string; readonly amountCents: number; readonly date: number; readonly accountId: string; readonly sourceToken: string };
}
export interface FundIssuePage {
  readonly contractVersion: 1;
  readonly items: readonly FundIssueView[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}
export interface FundCapabilities {
  readonly contractVersion: 1;
  readonly purposes: readonly string[];
  readonly amountUnit: 'integer-cents';
  readonly maxSafeAmount: number;
  readonly ratiosBpsTotal: 10000;
  readonly accountingPeriods: false;
  readonly moduleBudgets: false;
  readonly legacyBudgetsReadOnly: false;
  readonly features: {
    readonly config: true;
    readonly summary: true;
    readonly migrationIssues: true;
    readonly legacyGrantReview: true;
    readonly unclaimedSalaryReview: true;
    readonly incomeAllocation: true;
    readonly activity: false;
    readonly ratioChangeIsProspective: true;
  };
  readonly limits: typeof FINANCIAL_LIMITS;
  readonly serverTimeZone: string;
}
export interface FundReviewResponse {
  readonly contractVersion: 1;
  readonly grant: LegacyFundGrantReviewResult;
}

export interface FundConfigView {
  readonly revision: number;
  readonly ratiosBps: FundRatiosBps;
  readonly timeZone: string;
  readonly updatedAt: number | null;
}
export interface FundConfigResponse {
  readonly contractVersion: 1;
  readonly config: FundConfigView;
}
export interface FundConfigWrite {
  readonly ratiosBps: FundRatiosBps;
  readonly timeZone: string;
  readonly operationId: string;
  readonly expectedRevision: number;
}

/** Prospective fund config; historical grants are not changed by this service. */
export class FinancialFundService {
  private readonly now: () => number;
  private readonly serverTimeZone: string;
  constructor(private readonly db: Db, options: { now?: (() => number) | undefined; serverTimeZone?: string | undefined } = {}) {
    this.now = options.now ?? (() => Date.now());
    this.serverTimeZone = options.serverTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  }
  getConfig(): FundConfigResponse {
    const invalidIssue = this.db.prepare(`SELECT 1 FROM financial_fund_migration_issues
      WHERE source_kind IN ('config','fund-config') AND reason='invalid-current-config' AND status='open' LIMIT 1`).get();
    if (invalidIssue !== undefined) throw new FinancialUnavailableError();
    const row = this.db.prepare('SELECT revision,ratios_json,time_zone,created_at FROM financial_fund_config_revisions ORDER BY revision DESC LIMIT 1').get() as
      { revision: number; ratios_json: string; time_zone: string; created_at: number } | undefined;
    try {
      if (row === undefined) return { contractVersion: 1, config: { revision: 0, ratiosBps: DEFAULT_FINANCIAL_RATIOS_BPS, timeZone: requireTimeZone(this.serverTimeZone), updatedAt: null } };
      if (!Number.isSafeInteger(row.revision) || row.revision < 1 || !Number.isSafeInteger(row.created_at) || row.created_at < 0) throw new Error('Invalid configuration metadata');
      return { contractVersion: 1, config: { revision: row.revision, ratiosBps: validateFinancialRatiosBps(JSON.parse(row.ratios_json)), timeZone: requireTimeZone(row.time_zone), updatedAt: row.created_at } };
    } catch {
      throw new FinancialUnavailableError();
    }
  }
  updateConfig(raw: unknown, actorId: string): FundConfigResponse {
    const body = requireObject(raw, 'The request body must be an object.');
    const operationId = requireFinancialOperationId(body['operationId']);
    const now = this.now();
    return runFinancialOperation<FundConfigResponse>(this.db, {
      operationId, actorId, method: 'PUT', resource: '/api/v1/financial-funds/config', canonicalPayload: body, now,
    }, () => {
      const expectedRevision = requireSafeInteger(body['expectedRevision'], 'expectedRevision', 0);
      let ratios: FundRatiosBps;
      try { ratios = validateFinancialRatiosBps(body['ratiosBps']); } catch (error) { rethrowSharedError(error); }
      const timeZone = requireTimeZone(body['timeZone']);
      if (Object.keys(body).some((key) => !['operationId', 'expectedRevision', 'ratiosBps', 'timeZone'].includes(key))) throw new FinancialInvalidError('Unknown configuration field.');
      const current = this.getConfig().config;
      if (current.revision !== expectedRevision) throw new FinancialRevisionConflictError('The fund configuration changed. Reload it before saving.');
      const revision = nextFinancialRevision(current.revision);
      this.db.prepare('INSERT INTO financial_fund_config_revisions VALUES (?,?,?,?,?,?)').run(revision, JSON.stringify(ratios), timeZone, actorId, operationId, now);
      return { statusCode: 200, response: { contractVersion: 1, config: { revision, ratiosBps: ratios, timeZone, updatedAt: now } } };
    }).response;
  }

  /** Honest capability advertisement: unimplemented fund features stay false. */
  capabilities(): FundCapabilities {
    return {
      contractVersion: 1,
      purposes: ['growth', 'reserve', 'essentials', 'joy'],
      amountUnit: 'integer-cents',
      maxSafeAmount: Number.MAX_SAFE_INTEGER,
      ratiosBpsTotal: 10000,
      accountingPeriods: false,
      moduleBudgets: false,
      legacyBudgetsReadOnly: false,
      features: {
        config: true,
        summary: true,
        migrationIssues: true,
        legacyGrantReview: true,
        unclaimedSalaryReview: true,
        incomeAllocation: true,
        activity: false,
        ratioChangeIsProspective: true,
      },
      limits: FINANCIAL_LIMITS,
      serverTimeZone: this.getConfig().config.timeZone,
    };
  }

  /** Lifetime balances are independent of any activity window. */
  getSummary(): FundSummaryView {
    return readFundSummary(this.db, this.now());
  }

  /**
   * Splits one non-salary income (including a refund) by the current ratios.
   *
   * This never writes `salary_records`: the decision belongs to the transaction, so the
   * income does not appear in the salary history while still joining the four purposes.
   */
  allocateIncome(raw: unknown, actorId: string): FundIncomeAllocationResponse {
    const body = parseAllocateIncomeBody(raw);
    const now = this.now();
    return runFinancialOperation<FundIncomeAllocationResponse>(this.db, {
      operationId: body.operationId,
      actorId,
      method: 'POST',
      resource: INCOME_ALLOCATION_RESOURCE,
      canonicalPayload: body,
      now,
    }, () => {
      const config = this.getConfig().config;
      return {
        statusCode: 200,
        response: allocateFundIncome(this.db, {
          transactionId: body.transactionId,
          expectedTransactionToken: body.expectedTransactionToken,
          expectedFundConfigRevision: body.expectedFundConfigRevision,
          operationId: body.operationId,
          actorId,
          now,
        }, config.ratiosBps, config.revision),
      };
    }).response;
  }

  /** `null` when the income was never confirmed; the caller shows the allocation entry point. */
  getIncomeAllocation(transactionId: string): { contractVersion: 1; allocation: FundIncomeAllocationView | null } {
    if (!transactionId.trim()) throw new FinancialInvalidError('transactionId is required.');
    return { contractVersion: 1, allocation: readIncomeAllocation(this.db, transactionId) ?? null };
  }

  /** Bounded archival issue queue; never presented as current coverage by itself. */
  listIssues(rawLimit: unknown, rawOffset: unknown): FundIssuePage {    const limit = parsePaging(rawLimit, 'limit', DEFAULT_PAGE_SIZE);
    const offset = parsePaging(rawOffset, 'offset', 0, Number.MAX_SAFE_INTEGER);
    return this.db.transaction(() => {
      const total = (this.db.prepare('SELECT COUNT(*) AS c FROM financial_fund_migration_issues').get() as { c: number }).c;
      const rows = this.db.prepare(`SELECT source_kind, source_id, reason, status FROM financial_fund_migration_issues
        ORDER BY source_kind, source_id, reason LIMIT ? OFFSET ?`).all(limit, offset) as
        { source_kind: string; source_id: string; reason: string; status: string }[];
      const salaryOf = this.db.prepare(`SELECT s.id,s.amount_cents,s.date,s.account_id,s.deleted FROM salary_records s
        WHERE s.id=? AND NOT EXISTS (SELECT 1 FROM financial_fund_grant_sources f WHERE f.salary_id=s.id)`);
      return {
        contractVersion: 1 as const,
        items: rows.map((row): FundIssueView => {
          const issue = { sourceKind: row.source_kind, sourceId: row.source_id, reason: row.reason, status: row.status };
          if (row.source_kind !== 'salary' || row.reason !== 'unallocated' || row.status !== 'open') return issue;
          const salary = salaryOf.get(row.source_id) as { id: string; amount_cents: number; date: number; account_id: string; deleted: number } | undefined;
          if (salary === undefined || salary.deleted !== 0 || !Number.isSafeInteger(salary.amount_cents) || salary.amount_cents <= 0 ||
              !Number.isSafeInteger(salary.date) || salary.date < 0 || typeof salary.account_id !== 'string' || !salary.account_id.trim()) return issue;
          return { ...issue, source: { salaryId: salary.id, amountCents: salary.amount_cents, date: salary.date,
            accountId: salary.account_id, sourceToken: salarySourceToken(salary) } };
        }),
        total, limit, offset,
      };
    })();
  }

  /** A grantId reconfirms an aggregate; its absence claims exactly one salary. */
  reviewGrant(raw: unknown, actorId: string): FundReviewResponse {
    const body = requireObject(raw, 'The request body must be an object.');
    if (!Object.hasOwn(body, 'grantId')) return this.reviewUnclaimedSalary(body, actorId);
    if (Object.keys(body).some((key) => !['operationId', 'grantId', 'expectedRevision', 'ratiosBps', 'sources'].includes(key))) {
      throw new FinancialInvalidError('Unknown review field.');
    }
    const sources = body['sources'];
    if (!Array.isArray(sources)) throw new FinancialInvalidError('sources must be an array.');
    const result = reviewLegacyFundGrant(
      this.db,
      {
        actorId,
        operationId: String(body['operationId'] ?? ''),
        grantId: String(body['grantId'] ?? ''),
        expectedRevision: body['expectedRevision'] as number,
        ratiosBps: body['ratiosBps'] as FundRatiosBps,
        sources: sources as readonly { salaryId: string; expectedSourceToken: string }[],
      },
      this.now(),
      // Persist the HTTP body, not the bare grant, so a lost response is recoverable.
      (grant) => ({ contractVersion: 1, grant }),
    );
    return this.replayableReview(result);
  }

  private reviewUnclaimedSalary(body: Record<string, unknown>, actorId: string): FundReviewResponse {
    const operationId = requireFinancialOperationId(body['operationId']);
    const now = this.now();
    return this.replayableReview(runFinancialOperation<unknown>(this.db, {
      operationId, actorId, method: 'POST', resource: '/api/v1/financial-funds/grants/review', canonicalPayload: body, now,
    }, () => {
      if (!actorId.trim() || !Number.isSafeInteger(now) || now < 0 ||
          Object.keys(body).some((key) => !['operationId', 'expectedRevision', 'ratiosBps', 'sources'].includes(key))) {
        throw new FinancialInvalidError('Invalid review identity or fields.');
      }
      const expectedRevision = requireSafeInteger(body['expectedRevision'], 'expectedRevision', 0);
      let ratios: FundRatiosBps;
      try { ratios = validateFinancialRatiosBps(body['ratiosBps']); } catch (error) { rethrowSharedError(error); }
      const refs = body['sources'];
      if (!Array.isArray(refs) || refs.length !== 1) throw new FinancialInvalidError('Exactly one salary source is required.');
      const ref = requireObject(refs[0], 'A salary source is required.');
      if (Object.keys(ref).some((key) => !['salaryId', 'expectedSourceToken'].includes(key)) ||
          typeof ref['salaryId'] !== 'string' || !ref['salaryId'].trim() ||
          typeof ref['expectedSourceToken'] !== 'string' || !ref['expectedSourceToken'].trim()) {
        throw new FinancialInvalidError('The salary source must include its current token.');
      }
      if (this.getConfig().config.revision !== expectedRevision) throw new FinancialRevisionConflictError('The fund configuration changed. Reload it before reviewing.');
      const salaryId = ref['salaryId'];
      const salary = this.db.prepare('SELECT id,amount_cents,date,account_id,deleted FROM salary_records WHERE id=?').get(salaryId) as
        { id: string; amount_cents: number; date: number; account_id: string; deleted: number } | undefined;
      if (salary === undefined || salary.deleted !== 0 || !Number.isSafeInteger(salary.amount_cents) || salary.amount_cents <= 0 ||
          !Number.isSafeInteger(salary.date) || salary.date < 0 || typeof salary.account_id !== 'string' || !salary.account_id.trim() ||
          salarySourceToken(salary) !== ref['expectedSourceToken'] ||
          this.db.prepare('SELECT 1 FROM financial_fund_grant_sources WHERE salary_id=?').get(salaryId) ||
          this.db.prepare("SELECT 1 FROM financial_fund_grants WHERE (origin_kind='salary' AND origin_ref=?) OR id=?").get(salaryId, `salary:${salaryId}`)) {
        throw new FinancialSourceChangedError('The salary source changed or is already claimed; refresh the review.');
      }
      const source = { salaryId, amountCents: salary.amount_cents, date: salary.date, accountId: salary.account_id,
        sourceToken: salarySourceToken(salary), confirmedAt: now };
      const grantId = `salary:${salaryId}`;
      const targets = allocateFundIncomeCents(salary.amount_cents, ratios);
      this.db.prepare("INSERT INTO financial_fund_grants VALUES (?,'salary',?,1,'active')").run(grantId, salaryId);
      this.db.prepare("INSERT INTO financial_fund_grant_revisions VALUES (?,1,?,?,?,?,?,?,?,'historical-salary-review')")
        .run(grantId, salary.amount_cents, JSON.stringify(ratios), JSON.stringify(targets), JSON.stringify([source]), actorId, operationId, now);
      this.db.prepare("INSERT INTO financial_fund_grant_sources VALUES (?,?,?,?,?,?,'active')")
        .run(salaryId, grantId, source.sourceToken, salary.amount_cents, salary.date, salary.account_id);
      this.db.prepare("UPDATE financial_fund_migration_issues SET status='resolved' WHERE source_kind='salary' AND source_id=? AND reason='unallocated' AND status='open'").run(salaryId);
      // Store the complete HTTP body: a lost response must be recoverable byte-for-byte
      // through the operation lookup, not as a bare grant the caller has to re-wrap.
      const review = { contractVersion: 1 as const, grant: { grantId, revision: 1, sourceAmountCents: salary.amount_cents, ratiosBps: ratios, targets, sources: [source] } };
      return { statusCode: 200, response: review };
    }));
  }

  /**
   * Normalises a stored review response.
   *
   * Operations committed before the envelope fix hold the bare grant. They are
   * returned exactly as stored (never rewritten in place), wrapped only for the
   * response so old and new records both satisfy the documented contract.
   */
  private replayableReview(result: { statusCode: number; response: unknown }): FundReviewResponse {
    const stored = result.response;
    if (stored !== null && typeof stored === 'object' && 'contractVersion' in stored && 'grant' in stored) {
      return stored as FundReviewResponse;
    }
    return { contractVersion: 1, grant: stored as LegacyFundGrantReviewResult };
  }
}

/** Bounded integer paging; rejects unsafe, fractional and out-of-range values. */
function parsePaging(raw: unknown, field: string, fallback: number, maximum: number = FINANCIAL_LIMITS.pageSize): number {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    throw new FinancialInvalidError(`${field} must be a single integer value.`);
  }
  const parsed = typeof raw === 'string' ? Number(raw) : raw;
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw new FinancialInvalidError(`${field} must be an integer between 0 and ${maximum}.`);
  }
  if (field === 'limit' && parsed < 1) throw new FinancialInvalidError(`limit must be at least 1.`);
  return parsed;
}
