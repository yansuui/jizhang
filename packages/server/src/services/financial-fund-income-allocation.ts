/**
 * 非工资收入的四用途分配。
 *
 * 工资按比例拆分的前提是 `salary_records` + `financial_fund_grants`;普通收入与退款只是
 * `transactions` 里的一行,过去只能带单一用途,退款则回补原支出用途。这里为**一笔收入
 * 交易**保存"按确认当时比例拆成四份"的决定,它是交易自己的事实,不是工资:
 *
 * - 不写 `salary_records`,因此不会出现在工资记录 / `/salaries`;
 * - 计入汇总的 `funded`,与工资分配的展示口径一致;
 * - 一旦确认,汇总不再把它当作"未归类收入",退款也不再回补原支出用途(避免同一笔钱
 *   既按比例分四份、又抵掉原支出)。
 *
 * 与 grant 一样,确认时冻结比例与四项目标金额;之后修改默认比例不会重算历史记录。
 */
import {
  allocateFundIncomeCents,
  validateFinancialRatiosBps,
  type FundAmounts,
  type FundRatiosBps,
} from '@jizhang/shared';
import type { Db } from '../db/index.js';
import {
  FinancialInvalidError,
  FinancialNotFoundError,
  FinancialRevisionConflictError,
  FinancialSourceChangedError,
} from './financial-errors.js';
import { requireSafeInteger } from './financial-planning-types.js';
import { requireFinancialOperationId } from './financial-operation-store.js';
import { financialTransactionToken } from './financial-purpose-store.js';
import { writeFundPurpose } from './financial-fund-purpose-store.js';

export interface FundIncomeAllocationView {
  readonly transactionId: string;
  readonly revision: number;
  readonly amountCents: number;
  readonly ratiosBps: FundRatiosBps;
  readonly targets: FundAmounts;
  readonly createdAt: number;
}

export interface FundIncomeAllocationResponse {
  readonly contractVersion: 1;
  readonly allocation: FundIncomeAllocationView;
}

interface AllocationRow {
  readonly transaction_id: string;
  readonly revision: number;
  readonly source_token: string;
  readonly amount_cents: number;
  readonly ratios_json: string;
  readonly targets_json: string;
  readonly status: string;
  readonly created_at: number;
}

interface IncomeTransactionRow {
  readonly id: string;
  readonly type: number;
  readonly amount_cents: number;
  readonly category_id: string;
  readonly account_id: string;
  readonly date: number;
  readonly is_refund: number;
  readonly deleted: number;
}

export const INCOME_ALLOCATION_RESOURCE = '/api/v1/financial-funds/income-allocations';

function transactionToken(row: IncomeTransactionRow): string {
  return financialTransactionToken({
    id: row.id,
    type: row.type,
    amountCents: row.amount_cents,
    categoryId: row.category_id,
    date: row.date,
    isRefund: row.is_refund,
    deleted: row.deleted,
    accountId: row.account_id,
  });
}

function view(row: AllocationRow): FundIncomeAllocationView {
  const ratios = validateFinancialRatiosBps(JSON.parse(row.ratios_json) as unknown);
  const expected = allocateFundIncomeCents(row.amount_cents, ratios);
  const stored = JSON.parse(row.targets_json) as Record<string, unknown>;
  for (const purpose of ['growth', 'reserve', 'essentials', 'joy'] as const) {
    if (stored[purpose] !== expected[purpose]) throw new FinancialInvalidError('Stored allocation targets are invalid.');
  }
  return {
    transactionId: row.transaction_id,
    revision: row.revision,
    amountCents: row.amount_cents,
    ratiosBps: ratios,
    targets: expected,
    createdAt: row.created_at,
  };
}

/** Immutable read of one allocation; `undefined` when the income was never confirmed. */
export function readIncomeAllocation(db: Db, transactionId: string): FundIncomeAllocationView | undefined {
  const row = db
    .prepare(`SELECT transaction_id,revision,source_token,amount_cents,ratios_json,targets_json,status,created_at
      FROM financial_fund_income_allocations WHERE transaction_id=? AND status='active'`)
    .get(transactionId) as AllocationRow | undefined;
  if (row === undefined) return undefined;
  try {
    return view(row);
  } catch {
    throw new FinancialInvalidError('The saved income allocation cannot be read.');
  }
}

export interface AllocateIncomeInput {
  readonly transactionId: string;
  readonly expectedTransactionToken: string;
  readonly expectedFundConfigRevision: number;
  readonly operationId: string;
  readonly actorId: string;
  readonly now: number;
}

/**
 * Confirms (or reconfirms) the ratio split for one income transaction.
 *
 * A retry that finds an existing allocation for the same source token is a no-op: the
 * stored decision is returned, so a lost response cannot double-allocate.
 */
export function allocateIncome(
  db: Db,
  input: AllocateIncomeInput,
  currentRatios: FundRatiosBps,
  currentRevision: number,
): FundIncomeAllocationResponse {
  if (!Number.isSafeInteger(input.now) || input.now < 0) throw new FinancialInvalidError('Invalid allocation time.');
  if (!input.actorId.trim()) throw new FinancialInvalidError('Invalid actor.');
  if (currentRevision !== input.expectedFundConfigRevision) {
    throw new FinancialRevisionConflictError('The fund configuration changed. Reload it before allocating.');
  }
  const ratios = validateFinancialRatiosBps(currentRatios);
  const row = db
    .prepare('SELECT id,type,amount_cents,category_id,account_id,date,is_refund,deleted FROM transactions WHERE id=?')
    .get(input.transactionId) as IncomeTransactionRow | undefined;
  if (row === undefined || row.deleted !== 0) throw new FinancialNotFoundError('Income transaction not found.');
  if (row.type !== 1) throw new FinancialInvalidError('Only income can be allocated across the four purposes.');
  if (transactionToken(row) !== input.expectedTransactionToken) {
    throw new FinancialSourceChangedError('The income changed since it was loaded. Reload and retry.');
  }
  if (!Number.isSafeInteger(row.amount_cents) || row.amount_cents <= 0 ||
      row.amount_cents > Number.MAX_SAFE_INTEGER) {
    throw new FinancialInvalidError('The income amount cannot be allocated.');
  }

  const existing = db
    .prepare(`SELECT transaction_id,revision,source_token,amount_cents,ratios_json,targets_json,status,created_at
      FROM financial_fund_income_allocations WHERE transaction_id=?`)
    .get(input.transactionId) as AllocationRow | undefined;
  if (existing !== undefined && existing.source_token === input.expectedTransactionToken) {
    return { contractVersion: 1, allocation: view(existing) };
  }

  const targets = allocateFundIncomeCents(row.amount_cents, ratios);
  const revision = (existing?.revision ?? 0) + 1;
  if (!Number.isSafeInteger(revision) || revision < 1) throw new FinancialInvalidError('Allocation revision is exhausted.');
  db.prepare(`INSERT INTO financial_fund_income_allocations
    (transaction_id,revision,source_token,amount_cents,ratios_json,targets_json,status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,'active',?,?) ON CONFLICT(transaction_id) DO UPDATE SET
    revision=excluded.revision,source_token=excluded.source_token,amount_cents=excluded.amount_cents,
    ratios_json=excluded.ratios_json,targets_json=excluded.targets_json,status='active',updated_at=excluded.updated_at`)
    .run(input.transactionId, revision, input.expectedTransactionToken, row.amount_cents,
      JSON.stringify(ratios), JSON.stringify(targets), input.now, input.now);
  db.prepare(`INSERT INTO financial_fund_income_allocation_revisions
    (transaction_id,revision,amount_cents,ratios_json,targets_json,source_token,actor_id,operation_id,created_at,reason)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(input.transactionId, revision, row.amount_cents, JSON.stringify(ratios), JSON.stringify(targets),
      input.expectedTransactionToken, input.actorId, input.operationId, input.now, 'income-allocation');
  // A single-purpose assignment would contradict the split; clear it (audited) so the bill
  // no longer reports one purpose while the balance is split across four.
  writeFundPurpose(db, input.transactionId, null, input.actorId, input.operationId, input.now, false);
  return {
    contractVersion: 1,
    allocation: {
      transactionId: input.transactionId,
      revision,
      amountCents: row.amount_cents,
      ratiosBps: ratios,
      targets,
      createdAt: input.now,
    },
  };
}

/** Validates the HTTP body before the replayable operation runs. */
export function parseAllocateIncomeBody(raw: unknown): {
  transactionId: string;
  expectedTransactionToken: string;
  expectedFundConfigRevision: number;
  operationId: string;
} {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new FinancialInvalidError('The request body must be an object.');
  }
  const body = raw as Record<string, unknown>;
  const known = ['operationId', 'transactionId', 'expectedTransactionToken', 'expectedFundConfigRevision'];
  if (Object.keys(body).some((key) => !known.includes(key))) {
    throw new FinancialInvalidError('Unknown allocation field.');
  }
  const transactionId = body['transactionId'];
  if (typeof transactionId !== 'string' || !transactionId.trim()) {
    throw new FinancialInvalidError('transactionId is required.');
  }
  const expectedTransactionToken = body['expectedTransactionToken'];
  if (typeof expectedTransactionToken !== 'string' || !expectedTransactionToken.trim()) {
    throw new FinancialInvalidError('expectedTransactionToken is required.');
  }
  return {
    transactionId: transactionId.trim(),
    expectedTransactionToken: expectedTransactionToken.trim(),
    expectedFundConfigRevision: requireSafeInteger(body['expectedFundConfigRevision'], 'expectedFundConfigRevision', 0),
    operationId: requireFinancialOperationId(body['operationId']),
  };
}
