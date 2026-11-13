import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { initializeDatabase, type Db } from '../src/db/index.js';
import { SESSION_COOKIE } from '../src/plugins/auth.js';
import { AuthService } from '../src/services/auth-service.js';
import { FinancialFundService } from '../src/services/financial-fund-service.js';
import { readFundSummary } from '../src/services/financial-fund-summary.js';
import { financialTransactionToken } from '../src/services/financial-purpose-store.js';
import { replaceFinancialRefundSplits } from '../src/services/financial-source-lifecycle.js';

const NOW = 1700000000000;

let db: Db;
beforeEach(() => { db = new Database(':memory:'); initializeDatabase(db, null); });
afterEach(() => db.close());

function income(id: string, amountCents: number, refund = 0, accountId = 'a', date = 1): string {
  db.prepare(`INSERT INTO transactions
    (id,type,amount_cents,category_id,account_id,date,note,tags_json,is_refund,deleted,updated_at)
    VALUES (?,1,?,'c',?,?,'','[]',?,0,1)`).run(id, amountCents, accountId, date, refund);
  return tokenOf(id, amountCents, refund, accountId, date);
}

function expense(id: string, amountCents: number, purpose: string | null = null): void {
  db.prepare(`INSERT INTO transactions
    (id,type,amount_cents,category_id,account_id,date,note,tags_json,is_refund,deleted,updated_at)
    VALUES (?,0,?,'c','a',1,'','[]',0,0,1)`).run(id, amountCents);
  if (purpose !== null) db.prepare("INSERT INTO financial_fund_purposes VALUES (?,?,1,'explicit','{}')").run(id, purpose);
}

function tokenOf(id: string, amountCents: number, refund: number, accountId: string, date: number): string {
  return financialTransactionToken({
    id, type: 1, amountCents, categoryId: 'c', date, isRefund: refund, deleted: 0, accountId,
  });
}

function service(): FinancialFundService {
  return new FinancialFundService(db, { now: () => NOW, serverTimeZone: 'UTC' });
}

function allocate(transactionId: string, token: string, revision = 0, operationId: string = randomUUID()) {
  service().allocateIncome({
    operationId, transactionId, expectedTransactionToken: token, expectedFundConfigRevision: revision,
  }, 'user');
  return operationId;
}

describe('income allocation (non-salary income joins the four purposes)', () => {
  it('splits a recorded income by the current ratios without creating a salary record', () => {
    const token = income('i', 10000);
    const before = readFundSummary(db, NOW).coverage;
    expect(before.unassignedTransactionCount).toBe(1);
    expect(before.complete).toBe(false);

    const response = service().allocateIncome({
      operationId: randomUUID(), transactionId: 'i', expectedTransactionToken: token, expectedFundConfigRevision: 0,
    }, 'user');

    expect(response.contractVersion).toBe(1);
    expect(response.allocation).toMatchObject({
      transactionId: 'i', revision: 1, amountCents: 10000,
      targets: { growth: 2500, reserve: 1500, essentials: 5000, joy: 1000 },
    });
    const summary = readFundSummary(db, NOW);
    expect(summary.totals.funded).toEqual({ growth: 2500, reserve: 1500, essentials: 5000, joy: 1000 });
    expect(summary.balances.essentials).toBe(5000);
    expect(summary.coverage).toMatchObject({ complete: true, unassignedTransactionCount: 0 });
    // The money is funded, not salary: the salary history must stay empty.
    expect(db.prepare('SELECT COUNT(*) AS n FROM salary_records').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM financial_fund_grants').get()).toEqual({ n: 0 });
  });

  it('funds a refund by ratio and stops it crediting the original expense', () => {
    expense('e', 12000, 'essentials');
    const token = income('r', 3000, 1);
    replaceFinancialRefundSplits(db, {
      refundTxId: 'r', splits: [{ originalTransactionId: 'e', amountCents: 3000 }],
      refundFacts: { amountCents: 3000, type: 1, isRefund: true },
      originalFacts: [{ transactionId: 'e', facts: { amountCents: 12000, type: 0, isRefund: false } }],
      operationId: null, now: 1,
    });
    expect(readFundSummary(db, NOW).coverage).toMatchObject({ invalidRefundCount: 0, complete: true });
    expect(readFundSummary(db, NOW).totals.refunded.essentials).toBe(3000);

    allocate('r', token);

    const summary = readFundSummary(db, NOW);
    // The split no longer credits 日常必要; the refund funds all four purposes instead.
    expect(summary.totals.refunded.essentials).toBe(0);
    expect(summary.totals.funded).toEqual({ growth: 750, reserve: 450, essentials: 1500, joy: 300 });
    expect(summary.balances.essentials).toBe(1500 - 12000);
    expect(summary.coverage).toMatchObject({ invalidRefundCount: 0, unresolvedRefundCents: 0, complete: true });
  });

  it('replays the same operation id without writing a second revision', () => {
    const token = income('i', 10000);
    const first = service().allocateIncome({
      operationId: '6f1c1f4e-0d1a-4a86-9a3e-1f4f0f8f5a10', transactionId: 'i',
      expectedTransactionToken: token, expectedFundConfigRevision: 0,
    }, 'user');
    const replay = service().allocateIncome({
      operationId: '6f1c1f4e-0d1a-4a86-9a3e-1f4f0f8f5a10', transactionId: 'i',
      expectedTransactionToken: token, expectedFundConfigRevision: 0,
    }, 'user');
    expect(replay).toEqual(first);
    expect(db.prepare('SELECT COUNT(*) AS n FROM financial_fund_income_allocation_revisions').get()).toEqual({ n: 1 });
  });

  it('rejects an expense, a stale source token and a stale configuration revision', () => {
    expense('e', 1000, null);
    const token = income('i', 10000);
    expect(() => allocate('e', token)).toThrowError(expect.objectContaining({ code: 'FINANCIAL_INVALID' }));
    expect(() => allocate('i', 'wrong-token')).toThrowError(expect.objectContaining({ code: 'FINANCIAL_SOURCE_CHANGED' }));
    expect(() => allocate('i', token, 7)).toThrowError(expect.objectContaining({ code: 'FINANCIAL_REVISION_CONFLICT' }));
    expect(() => allocate('missing', token)).toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  it('clears a previous single purpose so one bill is not counted twice', () => {
    const token = income('i', 10000);
    db.prepare("INSERT INTO financial_fund_purposes VALUES ('i','joy',1,'explicit','{}')").run();
    expect(readFundSummary(db, NOW).totals.income.joy).toBe(10000);

    allocate('i', token);

    const summary = readFundSummary(db, NOW);
    expect(summary.totals.income.joy).toBe(0);
    expect(summary.totals.funded.joy).toBe(1000);
    expect(db.prepare("SELECT purpose FROM financial_fund_purposes WHERE transaction_id='i'").get()).toEqual({ purpose: null });
  });

  it('reallocates after an amount change and keeps both revisions', () => {
    const token = income('i', 10000);
    allocate('i', token);
    const changed = income2Amount('i', 20000);
    const before = readFundSummary(db, NOW);
    // The stored decision no longer matches its source: coverage reports it, nothing is invented.
    expect(before.totals.funded.essentials).toBe(0);
    expect(before.coverage.issueCount).toBe(1);

    const response = service().allocateIncome({
      operationId: randomUUID(), transactionId: 'i', expectedTransactionToken: changed, expectedFundConfigRevision: 0,
    }, 'user');

    expect(response.allocation.revision).toBe(2);
    expect(response.allocation.targets.essentials).toBe(10000);
    expect(db.prepare('SELECT COUNT(*) AS n FROM financial_fund_income_allocation_revisions').get()).toEqual({ n: 2 });
    expect(readFundSummary(db, NOW).coverage.issueCount).toBe(0);
  });
});

function income2Amount(id: string, amountCents: number): string {
  db.prepare('UPDATE transactions SET amount_cents=? WHERE id=?').run(amountCents, id);
  return tokenOf(id, amountCents, 0, 'a', 1);
}

describe('income allocation API', () => {
  let app: FastifyInstance;
  let headers: Record<string, string>;
  beforeEach(async () => {
    const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', JIZHANG_USERNAME: 'tester', JIZHANG_PASSWORD_HASH: 'unused', DATA_DIR: './data' });
    const auth = new AuthService(db, { sessionTtlDays: config.sessionTtlDays, now: () => NOW });
    await auth.setPassword('tester', 'correct horse battery staple');
    app = buildApp({ config, db, authService: auth, secureCookies: false, now: () => NOW });
    await app.ready();
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { 'x-requested-with': 'fetch' }, payload: { username: 'tester', password: 'correct horse battery staple' } });
    const cookie = login.cookies.find((item) => item.name === SESSION_COOKIE);
    headers = { cookie: `${SESSION_COOKIE}=${cookie!.value}`, 'x-requested-with': 'fetch' };
  });
  afterEach(async () => { await app.close(); });

  it('requires authentication and CSRF, then exposes the decision on the bill', async () => {
    const token = income('i', 10000);
    const body = { operationId: randomUUID(), transactionId: 'i', expectedTransactionToken: token, expectedFundConfigRevision: 0 };
    expect((await app.inject({ method: 'POST', url: '/api/v1/financial-funds/income-allocations', headers: { 'x-requested-with': 'fetch' }, payload: body })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/v1/financial-funds/income-allocations', headers: { cookie: headers['cookie']! }, payload: body })).statusCode).toBe(403);

    const created = await app.inject({ method: 'POST', url: '/api/v1/financial-funds/income-allocations', headers, payload: body });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ contractVersion: 1, allocation: { transactionId: 'i', revision: 1 } });

    const bill = await app.inject({ method: 'GET', url: '/api/v1/transactions/i', headers });
    expect(bill.statusCode).toBe(200);
    expect(bill.json()).toMatchObject({ id: 'i', fundIncomeAllocated: true, fundPurpose: null });

    const read = await app.inject({ method: 'GET', url: '/api/v1/financial-funds/income-allocations/i', headers });
    expect(read.json()).toMatchObject({ contractVersion: 1, allocation: { transactionId: 'i' } });
    expect(JSON.stringify(created.json())).not.toContain('salary');

    const summary = await app.inject({ method: 'GET', url: '/api/v1/financial-funds/summary', headers });
    expect(summary.json().coverage.complete).toBe(true);
    expect(summary.json().balances.essentials).toBe(5000);
  });
});
