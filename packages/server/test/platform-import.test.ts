/**
 * WeChat / Alipay platform bill import against the real 2026-09 export shapes.
 *
 * Contract under test:
 *   * GBK Alipay bytes and UTF-8 WeChat CSV both land
 *   * neutral / 不计收支 / 理财 / 信用借还 rows are ignored; refunded originals and actual refund income remain bookable
 *   * 微信/支付宝 accounts are created on first import
 *   * re-import is idempotent (stable platform order ids)
 *   * dry-run writes nothing
 *   * the native transactions CSV import path stays untouched
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeDatabase, type Db } from '../src/db/index.js';
import { PortabilityService } from '../src/services/portability-service.js';
import { ValidationError } from '../src/services/transaction-service.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const wechatText = readFileSync(join(fixturesDir, 'wechat-bill-sample.csv'));
const alipayGbk = readFileSync(join(fixturesDir, 'alipay-bill-sample.csv'));
const alipayUtf8 = readFileSync(join(fixturesDir, 'alipay-bill-sample.utf8.csv'), 'utf8');

let db: Db;
let service: PortabilityService;
let dataDir: string;

function liveTxnCount(): number {
  return (
    db.prepare('SELECT COUNT(*) AS c FROM transactions WHERE deleted = 0').get() as { c: number }
  ).c;
}

function findAccountByName(name: string): { id: string; type: number; deleted: number } | undefined {
  return db
    .prepare('SELECT id, type, deleted FROM accounts WHERE name = ?')
    .get(name) as { id: string; type: number; deleted: number } | undefined;
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initializeDatabase(db, null);
  dataDir = mkdtempSync(join(tmpdir(), 'jizhang-platform-import-'));
  service = new PortabilityService(db, { dataDir });
});

afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('importPlatformBills — WeChat UTF-8 CSV', () => {
  it('imports bookable rows, creates the 微信 account, ignores neutral and preserves real refunds', () => {
    const result = service.importPlatformBills(wechatText, { source: 'auto' });

    expect(result.source).toBe('wechat');
    expect(result.total).toBe(34);
    expect(result.ignored).toBe(8);
    expect(result.importable).toBe(26);
    expect(result.inserted).toBe(26);
    expect(result.skipped).toBe(0);
    expect(result.accountsCreated).toBe(1);

    const account = findAccountByName('微信');
    expect(account).toBeDefined();
    expect(account?.type).toBe(4); // ACCOUNT_TYPE_WECHAT
    expect(account?.deleted).toBe(0);

    expect(liveTxnCount()).toBe(26);

    // Idempotent re-import
    const again = service.importPlatformBills(wechatText, { source: 'wechat' });
    expect(again.inserted).toBe(0);
    expect(again.skipped).toBe(26);
    expect(liveTxnCount()).toBe(26);
  });

  it('dry-run reports counts without writing, and returns a preview table', () => {
    const preview = service.importPlatformBills(wechatText, { source: 'auto', dryRun: true });
    expect(preview.dryRun).toBe(true);
    expect(preview.inserted).toBe(26);
    expect(preview.selected).toBe(26);
    expect(preview.accountsCreated).toBe(1);
    expect(preview.rows).toHaveLength(34);
    const importablePreview = preview.rows.filter((r) => !r.ignored && !r.alreadyExists);
    expect(importablePreview).toHaveLength(26);
    expect(importablePreview[0]?.categoryName).toBeTruthy();
    expect(liveTxnCount()).toBe(0);
    expect(findAccountByName('微信')).toBeUndefined();
  });

  it('honours selectedIds: only the chosen subset is written', () => {
    const preview = service.importPlatformBills(wechatText, { source: 'auto', dryRun: true });
    const candidates = preview.rows.filter((r) => !r.ignored && !r.alreadyExists);
    const first = candidates[0];
    const third = candidates[2];
    expect(first).toBeDefined();
    expect(third).toBeDefined();

    const result = service.importPlatformBills(wechatText, {
      source: 'wechat',
      selectedIds: [first!.id, third!.id],
    });
    expect(result.inserted).toBe(2);
    expect(result.selected).toBe(2);
    expect(liveTxnCount()).toBe(2);

    const ids = (
      db.prepare('SELECT id FROM transactions WHERE deleted = 0').all() as { id: string }[]
    ).map((r) => r.id);
    expect(ids).toContain(first!.id);
    expect(ids).toContain(third!.id);
  });

  it('applies categoryOverrides on confirm', () => {
    const preview = service.importPlatformBills(wechatText, { source: 'auto', dryRun: true });
    const expenseRow = preview.rows.find((r) => !r.ignored && r.type === 0);
    expect(expenseRow).toBeDefined();

    service.importPlatformBills(wechatText, {
      source: 'wechat',
      selectedIds: [expenseRow!.id],
      categoryOverrides: { [expenseRow!.id]: '娱乐' },
    });

    const row = db
      .prepare(
        `SELECT c.name AS category_name FROM transactions t
           JOIN categories c ON c.id = t.category_id
          WHERE t.id = ?`,
      )
      .get(expenseRow!.id) as { category_name: string };
    expect(row.category_name).toBe('娱乐');
  });

  it('empty selectedIds writes nothing', () => {
    const result = service.importPlatformBills(wechatText, {
      source: 'wechat',
      selectedIds: [],
    });
    expect(result.inserted).toBe(0);
    expect(result.selected).toBe(0);
    expect(liveTxnCount()).toBe(0);
  });

  it('allows an ignored row (e.g. transfer/topup) to be explicitly selected and imported', () => {
    const preview = service.importPlatformBills(wechatText, { source: 'auto', dryRun: true });
    const ignoredRow = preview.rows.find((r) => r.ignored && r.amountCents > 0 && !r.alreadyExists);
    expect(ignoredRow).toBeDefined();

    const result = service.importPlatformBills(wechatText, {
      source: 'wechat',
      selectedIds: [ignoredRow!.id],
    });
    expect(result.inserted).toBe(1);
    expect(result.selected).toBe(1);
    expect(liveTxnCount()).toBe(1);

    const imported = db
      .prepare('SELECT id, amount_cents FROM transactions WHERE id = ?')
      .get(ignoredRow!.id) as { id: string; amount_cents: number } | undefined;
    expect(imported).toBeDefined();
    expect(imported!.amount_cents).toBe(ignoredRow!.amountCents);
  });
});

describe('importPlatformBills — soft duplicate (hand-entered bill)', () => {
  it('flags same account+date+type+amount already in the ledger', () => {
    db.prepare(
      `INSERT INTO accounts (id, name, type, initial_balance_cents, sort_order, is_builtin, deleted, updated_at)
       VALUES ('acc-alipay', '支付宝', 3, 0, 1, 0, 0, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO transactions
         (id, type, amount_cents, category_id, account_id, date, note, tags_json, is_refund, deleted, updated_at)
       VALUES ('manual-meituan-14', 0, 1400, 'builtin-expense-other', 'acc-alipay',
               ?, '跑腿', '[]', 0, 0, ?)`,
    ).run(new Date(2026, 8, 15).getTime(), Date.now());

    const preview = service.importPlatformBills(alipayGbk, { source: 'alipay', dryRun: true });
    const meituan = preview.rows.find((r) => r.counterparty === '美团' && !r.ignored);
    expect(meituan).toBeDefined();
    expect(meituan?.alreadyExists).toBe(false);
    expect(meituan?.possibleDuplicate).toBe(true);
    expect(meituan?.duplicateOfNote).toBe('跑腿');

    const pupu = preview.rows.find((r) => r.counterparty === '朴朴超市' && !r.ignored);
    expect(pupu?.possibleDuplicate).toBe(false);
  });
});

describe('importPlatformBills — Alipay GBK bytes', () => {
  it('decodes GBK and imports only the three bookable rows', () => {
    const result = service.importPlatformBills(alipayGbk, { source: 'auto' });

    expect(result.source).toBe('alipay');
    expect(result.encoding).toBe('gbk');
    expect(result.total).toBe(14);
    expect(result.importable).toBe(3);
    expect(result.inserted).toBe(3);
    expect(result.ignored).toBe(11);
    expect(result.accountsCreated).toBe(1);

    const account = findAccountByName('支付宝');
    expect(account?.type).toBe(3); // ACCOUNT_TYPE_ALIPAY

    const rows = db
      .prepare(
        `SELECT t.id, t.type, t.amount_cents, t.note, a.name AS account_name, c.name AS category_name
           FROM transactions t
           JOIN accounts a ON a.id = t.account_id
           JOIN categories c ON c.id = t.category_id
          WHERE t.deleted = 0`,
      )
      .all() as {
      id: string;
      type: number;
      amount_cents: number;
      note: string;
      account_name: string;
      category_name: string;
    }[];

    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.account_name === '支付宝')).toBe(true);

    const pupu = rows.find((r) => r.id === 'ali-2026091623001449281404290055');
    expect(pupu).toBeDefined();
    expect(pupu?.type).toBe(0);
    expect(pupu?.amount_cents).toBe(6627);
    expect(pupu?.category_name).toBe('购物');

    const income = rows.find((r) => r.type === 1);
    expect(income?.amount_cents).toBe(13);

    const again = service.importPlatformBills(alipayGbk, { source: 'auto' });
    expect(again.inserted).toBe(0);
    expect(again.skipped).toBe(3);
    expect(liveTxnCount()).toBe(3);
  });

  it('accepts already-decoded UTF-8 Alipay text', () => {
    const result = service.importPlatformBills(alipayUtf8, { source: 'alipay' });
    expect(result.encoding).toBe('utf-8');
    expect(result.inserted).toBe(3);
  });
});

describe('importPlatformBills — error and coexistence', () => {
  it('rejects unrecognised text when source is auto', () => {
    expect(() => service.importPlatformBills('not a bill', { source: 'auto' })).toThrow(
      ValidationError,
    );
  });

  it('does not break the native CSV import path', () => {
    service.importPlatformBills(alipayGbk, { source: 'alipay' });
    const accounts = db.prepare('SELECT name FROM accounts WHERE deleted = 0').all() as {
      name: string;
    }[];
    const categories = db
      .prepare('SELECT name, type FROM categories WHERE deleted = 0')
      .all() as { name: string; type: number }[];

    const accountName = '默认账户';
    const expenseCat = categories.find((c) => c.name === '其他' && c.type === 0)?.name;
    const csv = [
      'id,date,type,amount,category,account,note,tags,isRefund',
      `native-1,2026-09-01,expense,12.50,${expenseCat},${accountName},午饭,,false`,
    ].join('\n');

    const result = service.importTransactionsCsv(csv);
    expect(result.inserted).toBe(1);
    expect(liveTxnCount()).toBe(4);
    expect(accounts.some((a) => a.name === accountName)).toBe(true);
  });
});

describe('strict assistant review compatibility', () => {
  it('preserves complete untouched source notes, explicit clearing and refund identity independent of chosen category name', () => {
    const text = readFileSync(join(fixturesDir, 'refund-review.csv'), 'utf8');
    const preview = service.importPlatformBills(text, { dryRun: true, strictCategories: true });
    const purchase = preview.rows.find((r) => r.id === 'wx-review-purchase')!;
    const refund = preview.rows.find((r) => r.id === 'wx-review-refund')!;
    const result = service.importPlatformBills(text, { strictCategories: true, selectedIds: [purchase.id, refund.id], categoryIds: { [purchase.id]: 'builtin-expense-food', [refund.id]: 'builtin-income-other' }, noteOverrides: { [refund.id]: '' } });
    expect(result.inserted).toBe(2);
    expect(result.categoriesCreated).toBe(0);
    expect(db.prepare('SELECT note, is_refund FROM transactions WHERE id = ?').get(purchase.id)).toEqual({ note: purchase.note, is_refund: 0 });
    expect(db.prepare('SELECT note, is_refund FROM transactions WHERE id = ?').get(refund.id)).toEqual({ note: '', is_refund: 1 });
  });
  it('rejects deleted, wrong-type and parent categories without creating/restoring categories or partially importing', () => {
    const text = readFileSync(join(fixturesDir, 'refund-review.csv'), 'utf8');
    const selectedIds = ['wx-review-purchase', 'wx-review-missing'];
    db.prepare("INSERT INTO categories (id, name, type, parent_id, icon, color, deleted, updated_at) VALUES ('review-child','child',0,'builtin-expense-food','x',0,0,0)").run();
    for (const id of ['builtin-expense-food', 'builtin-income-other', 'missing']) {
      expect(() => service.importPlatformBills(text, { strictCategories: true, selectedIds, categoryIds: Object.fromEntries(selectedIds.map((row) => [row, id])) })).toThrow(ValidationError);
      expect(liveTxnCount()).toBe(0);
    }
    db.prepare("UPDATE categories SET deleted = 1 WHERE id = 'review-child'").run();
    db.prepare("UPDATE categories SET deleted = 1 WHERE id = 'builtin-expense-food'").run();
    expect(() => service.importPlatformBills(text, { strictCategories: true, selectedIds, categoryIds: Object.fromEntries(selectedIds.map((row) => [row, 'builtin-expense-food'])) })).toThrow(ValidationError);
    expect(liveTxnCount()).toBe(0);
  });
  it('rejects empty/oversized selections and rows outside the displayed 200 without hidden writes', () => {
    const header = '交易时间,交易类型,交易对方,商品,收/支,金额(元),当前状态,交易单号';
    const text = [header, ...Array.from({ length: 205 }, (_, i) => `2026-09-12,商户消费,测试商户,商品,支出,10,支付成功,bound-${i}`)].join(String.fromCharCode(10));
    for (const selectedIds of [[], ['wx-bound-200'], Array.from({ length: 101 }, (_, i) => `wx-bound-${i}`)]) {
      expect(() => service.importPlatformBills(text, { strictCategories: true, selectedIds, categoryIds: Object.fromEntries(selectedIds.map((id) => [id, 'builtin-expense-food'])) })).toThrow(ValidationError);
      expect(liveTxnCount()).toBe(0);
    }
  });
});

describe('read-only duplicate candidates use the existing local-day heuristic', () => {
  it('paginates every match, including empty notes and refund identity, labels deleted references and reads current changes', () => {
    db.prepare(`INSERT INTO accounts (id, name, type, initial_balance_cents, sort_order, is_builtin, deleted, updated_at)
      VALUES ('comparison-account', '支付宝', 3, 0, 1, 0, 0, 1)`).run();
    const date = new Date(2026, 8, 15, 23, 59).getTime();
    const insert = db.prepare(`INSERT INTO transactions
      (id, type, amount_cents, category_id, account_id, date, note, tags_json, is_refund, deleted, updated_at)
      VALUES (?, ?, ?, 'builtin-expense-other', ?, ?, ?, '[]', ?, ?, 1)`);
    insert.run('a', 0, 1400, 'comparison-account', date, '', 0, 0);
    insert.run('b', 0, 1400, 'comparison-account', date, '完整备注'.repeat(100), 0, 0);
    insert.run('wrong-type', 1, 1400, 'comparison-account', date, '', 1, 0);
    insert.run('wrong-day', 0, 1400, 'comparison-account', new Date(2026, 8, 16).getTime(), '', 0, 0);
    insert.run('wrong-amount', 0, 1401, 'comparison-account', date, '', 0, 0);
    insert.run('wrong-account', 0, 1400, 'builtin-default-account', date, '', 0, 0);
    insert.run('deleted', 0, 1400, 'comparison-account', date, '', 0, 1);
    const preview = service.importPlatformBills(alipayGbk, { source: 'alipay', dryRun: true });
    const row = preview.rows.find((r) => r.counterparty === '美团' && !r.ignored)!;
    expect(row).toMatchObject({ possibleDuplicate: true, duplicateOfNote: '', comparisonAccountId: 'comparison-account' });
    const source = { ...row };
    db.prepare("UPDATE accounts SET deleted = 1 WHERE id = 'comparison-account'").run();
    db.prepare("UPDATE categories SET deleted = 1 WHERE id = 'builtin-expense-other'").run();
    const before = db.serialize();
    const first = service.duplicateCandidates(source, '1', undefined, 123);
    expect(first).toMatchObject({ total: 2, nextCursor: 'a', readAt: 123 });
    expect(first.items[0]).toMatchObject({ id: 'a', note: '', accountName: '支付宝', categoryName: '其他', isRefund: false });
    const second = service.duplicateCandidates(source, '1', first.nextCursor);
    expect(second.items.map((item) => item.id)).toEqual(['b']);
    expect(second.items[0]?.note).toBe('完整备注'.repeat(100));
    expect(second.nextCursor).toBeNull();
    const refund = service.duplicateCandidates({ ...source, type: 1 }, undefined, undefined);
    expect(refund.items[0]).toMatchObject({ id: 'wrong-type', isRefund: true });
    // Compare every byte without expanding the SQLite image into JS assertion nodes.
    expect(db.serialize().equals(before)).toBe(true);
    db.prepare("UPDATE transactions SET deleted = 1 WHERE id = 'a'").run();
    const afterCursorDeletion = service.duplicateCandidates(source, '1', first.nextCursor);
    expect(afterCursorDeletion).toMatchObject({ total: 1, nextCursor: null });
    expect(afterCursorDeletion.items.map((item) => item.id)).toEqual(['b']);
    db.prepare("UPDATE transactions SET deleted = 1 WHERE id IN ('a', 'b')").run();
    expect(service.duplicateCandidates(source, undefined, undefined)).toMatchObject({ total: 0, items: [], nextCursor: null });
  });
  it('refuses absent legacy facts or impossible local dates rather than inferring client facts', () => {
    expect(() => service.duplicateCandidates({ dateLabel: '2026-09-15', type: 0, amountCents: 100 }, undefined, undefined)).toThrow(/重新上传/);
    expect(() => service.duplicateCandidates({ comparisonAccountId: null, dateLabel: '2026-02-30', type: 0, amountCents: 100 }, undefined, undefined)).toThrow(/日期无效/);
  });
});
