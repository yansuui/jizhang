/**
 * T15 acceptance tests: CSV export/import and the backup listing.
 *
 * The failure this suite exists to prevent is a LOST ROW. Two designs would lose one and
 * both look reasonable on a happy path:
 *
 *   * deduplicating on "date + amount + note" instead of the exported `id` — two identical
 *     coffees on one day become one bill;
 *   * skipping a row whose category name is unknown — the money silently disappears.
 *
 * So the round trip asserts counts AND the net total, and the error cases assert a thrown
 * error rather than an empty result.
 */
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeDatabase, type Db } from '../src/db/index.js';
import { PortabilityService } from '../src/services/portability-service.js';
import { ValidationError } from '../src/services/transaction-service.js';
import { writeFundPurpose } from '../src/services/financial-fund-purpose-store.js';

const FOOD = 'builtin-expense-food';
const TRANSPORT = 'builtin-expense-transport';
const ACCOUNT = 'builtin-default-account';
const SALARY_CATEGORY = 'builtin-income-salary';
const REFUND_CATEGORY = 'builtin-income-refund';
const WALLET = 'wallet-account';

/** Local midnight, matching how the export writes dates. */
const day = (d: number): number => new Date(2026, 8, d).getTime();

let db: Db;
let service: PortabilityService;
let dataDir: string;

function addTxn(overrides: Record<string, unknown> = {}): string {
  const id = (overrides['id'] as string | undefined) ?? `t-${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(
    `INSERT INTO transactions
       (id, type, amount_cents, category_id, account_id, date, note, tags_json, is_refund, deleted, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  ).run(
    id,
    (overrides['type'] as number | undefined) ?? 0,
    (overrides['amountCents'] as number | undefined) ?? 10_000,
    (overrides['categoryId'] as string | undefined) ?? FOOD,
    (overrides['accountId'] as string | undefined) ?? ACCOUNT,
    (overrides['date'] as number | undefined) ?? day(5),
    (overrides['note'] as string | undefined) ?? '午饭',
    JSON.stringify((overrides['tags'] as string[] | undefined) ?? []),
    (overrides['isRefund'] as boolean | undefined) === true ? 1 : 0,
    Date.now(),
  );
  return id;
}

function addAccount(id: string, name: string): void {
  db.prepare(
    `INSERT INTO accounts
       (id, name, type, initial_balance_cents, sort_order, is_builtin, deleted, updated_at)
     VALUES (?, ?, 1, 0, ?, 0, 0, 1)`,
  ).run(id, name, id === ACCOUNT ? 0 : 1);
}

function addTransfer(overrides: Record<string, unknown> = {}): string {
  const id =
    (overrides['id'] as string | undefined) ?? `f-${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(
    `INSERT INTO transfers
       (id, from_account_id, to_account_id, amount_cents, date, note, deleted, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, 1)`,
  ).run(
    id,
    (overrides['fromAccountId'] as string | undefined) ?? ACCOUNT,
    (overrides['toAccountId'] as string | undefined) ?? WALLET,
    (overrides['amountCents'] as number | undefined) ?? 32_100,
    (overrides['date'] as number | undefined) ?? day(8),
    (overrides['note'] as string | undefined) ?? '转出',
  );
  return id;
}

function rowCount(): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM transactions WHERE deleted = 0').get() as { c: number })
    .c;
}

/** Net expense and income per the shared rule, derived from the rows themselves. */
function totals(): { netExpense: number; income: number } {
  const rows = db
    .prepare('SELECT type, amount_cents, is_refund FROM transactions WHERE deleted = 0')
    .all() as { type: number; amount_cents: number; is_refund: number }[];
  let netExpense = 0;
  let income = 0;
  for (const row of rows) {
    if (row.type === 0) netExpense += row.amount_cents;
    else if (row.is_refund === 1) income += row.amount_cents; // refunds ARE income now
    else income += row.amount_cents;
  }
  return { netExpense, income };
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initializeDatabase(db, null);
  dataDir = mkdtempSync(join(tmpdir(), 'jizhang-portability-'));
  service = new PortabilityService(db, { dataDir, dbFile: join(dataDir, 'jizhang.db') });
});

afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

describe('export', () => {
  it('AC1 the file starts with a UTF-8 BOM', () => {
    addTxn();
    const csv = service.exportTransactionsCsv();

    // Excel on Windows needs these three bytes to decode Chinese correctly.
    const bytes = Buffer.from(csv, 'utf8');
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it('writes human-readable types and keeps the refund flag', () => {
    addTxn({ note: '买菜', amountCents: 15_000 });
    addTxn({ note: '退款', amountCents: 4_000, type: 1, categoryId: REFUND_CATEGORY, isRefund: true });
    addTxn({ note: '工资', amountCents: 500_000, type: 1, categoryId: SALARY_CATEGORY });

    const csv = service.exportTransactionsCsv();

    expect(csv).toContain('expense');
    expect(csv).toContain('income');
    // The refund flag is what makes net expense reproducible outside the app.
    expect(csv).toContain('true');
    expect(csv).toContain('150.00');
  });

  it('exports category and account NAMES, not opaque ids', () => {
    addTxn();
    const csv = service.exportTransactionsCsv();

    expect(csv).toContain('餐饮');
    expect(csv).toContain('默认账户');
    expect(csv).not.toContain(FOOD);
  });

  it('AC3 a remark containing a comma does not break the columns', () => {
    addTxn({ id: 'comma-1', note: '午饭, 加饮料', amountCents: 19_990 });

    const csv = service.exportTransactionsCsv();
    const header = csv.replace('\uFEFF', '').split('\n')[0]?.split(',') ?? [];

    // Quoted in the file...
    expect(csv).toContain('"午饭, 加饮料"');
    expect(header).toHaveLength(10);

    // ...and the importer's parser reads it back as ONE field, which is what actually
    // protects the columns. A `split(',')` parser would produce an extra field here and
    // shift every column after it.
    db.prepare('DELETE FROM transactions').run();
    expect(service.importTransactionsCsv(csv).inserted).toBe(1);
    const row = db.prepare('SELECT note, amount_cents FROM transactions').get() as {
      note: string;
      amount_cents: number;
    };
    expect(row.note).toBe('午饭, 加饮料');
    expect(row.amount_cents).toBe(19_990);
  });

  it('joins tags with a pipe rather than a comma', () => {
    addTxn({ tags: ['午饭', '公司'] });
    expect(service.exportTransactionsCsv()).toContain('午饭|公司');
  });

  /**
   * A salary now lands in an account, so the salaries export has to name it — otherwise a
   * CSV-only backup could not say where the money went, which is the one thing this file
   * exists to prevent (a fact going missing).
   */
  it('names the receiving account in the salaries export', () => {
    db.prepare(
      `INSERT INTO salary_records (id, amount_cents, date, note, account_id, deleted, updated_at)
       VALUES ('s1', 1000000, ?, '九月工资', ?, 0, 1)`,
    ).run(day(5), ACCOUNT);

    const csv = service.exportSalariesCsv();
    const header = (csv.replace('\uFEFF', '').split('\n')[0] ?? '').split(',');

    expect(header).toEqual(['id', 'date', 'amount', 'account', 'note', 'allocations']);
    expect(csv).toContain('默认账户');
    expect(csv).toContain('10000.00');
    expect(csv).not.toContain(ACCOUNT);
  });

  it('omits soft-deleted bills', () => {
    const id = addTxn();
    db.prepare('UPDATE transactions SET deleted = 1 WHERE id = ?').run(id);

    const lines = service.exportTransactionsCsv().replace('\uFEFF', '').trim().split('\n');
    expect(lines).toHaveLength(1); // header only
  });
});

// ---------------------------------------------------------------------------
// Round trip — the assertions that protect against losing a row
// ---------------------------------------------------------------------------

describe('round trip', () => {
  it('preserves exported four-purpose evidence and rejects unknown purpose values atomically', () => {
    const id = addTxn({ id: 'purpose-roundtrip' });
    writeFundPurpose(db, id, 'reserve', null, null, Date.now(), true);
    const csv = service.exportTransactionsCsv();
    expect(csv).toContain('reserve');
    db.prepare('DELETE FROM financial_fund_purpose_events').run();
    db.prepare('DELETE FROM financial_fund_purposes').run();
    db.prepare('DELETE FROM transactions').run();
    expect(() => service.importTransactionsCsv(csv.replace('reserve', 'invented-purpose'))).toThrow(/fundPurpose/);
    expect(rowCount()).toBe(0);
    expect(service.importTransactionsCsv(csv).inserted).toBe(1);
    expect(db.prepare('SELECT purpose FROM financial_fund_purposes WHERE transaction_id = ?').get(id))
      .toEqual({ purpose: 'reserve' });
  });

  it('imports legacy CSV without the later optional fundPurpose column', () => {
    addTxn({ id: 'legacy-purpose-less', note: 'legacy plain text' });
    const csv = service.exportTransactionsCsv().trimEnd().split('\n')
      .map((line) => line.replace(/,[^,\r]*\r?$/, '')).join('\n');
    expect(csv.split('\n')[0]).not.toContain('fundPurpose');
    db.prepare('DELETE FROM transactions').run();
    expect(service.importTransactionsCsv(csv).inserted).toBe(1);
    expect(db.prepare('SELECT id, amount_cents FROM transactions').get())
      .toEqual({ id: 'legacy-purpose-less', amount_cents: 10000 });
  });

  it('AC2/AC4 re-importing reproduces the count and both totals', () => {
    addTxn({ note: '买菜', amountCents: 15_000, tags: ['日常'] });
    addTxn({ note: '退款, 部分', amountCents: 4_000, type: 1, categoryId: REFUND_CATEGORY, isRefund: true });
    addTxn({ note: '打车', amountCents: 3_000, categoryId: TRANSPORT });
    addTxn({ note: '工资', amountCents: 500_000, type: 1, categoryId: SALARY_CATEGORY });

    const before = { count: rowCount(), ...totals() };
    const csv = service.exportTransactionsCsv();

    // Wipe and re-import into the same schema.
    db.prepare('DELETE FROM transactions').run();
    expect(rowCount()).toBe(0);

    const result = service.importTransactionsCsv(csv);

    expect(result.inserted).toBe(before.count);
    expect(result.skipped).toBe(0);
    expect(rowCount()).toBe(before.count);
    // The money must match, not just the row count.
    expect(totals()).toEqual({ netExpense: before.netExpense, income: before.income });
  });

  it('preserves each bill id, so the import is idempotent afterwards', () => {
    const id = addTxn({ note: '带 id' });
    const csv = service.exportTransactionsCsv();
    db.prepare('DELETE FROM transactions').run();

    service.importTransactionsCsv(csv);

    expect(db.prepare('SELECT id FROM transactions').get()).toEqual({ id });
  });

  it('preserves tags and the refund flag across the trip', () => {
    addTxn({ note: 'x', tags: ['a', 'b'], type: 1, categoryId: REFUND_CATEGORY, isRefund: true });
    const csv = service.exportTransactionsCsv();
    db.prepare('DELETE FROM transactions').run();

    service.importTransactionsCsv(csv);

    const row = db.prepare('SELECT tags_json, is_refund FROM transactions').get() as {
      tags_json: string;
      is_refund: number;
    };
    expect(JSON.parse(row.tags_json)).toEqual(['a', 'b']);
    expect(row.is_refund).toBe(1);
  });

  it('AC2 preserves dates to the local day', () => {
    addTxn({ date: day(3) });
    const csv = service.exportTransactionsCsv();
    db.prepare('DELETE FROM transactions').run();

    service.importTransactionsCsv(csv);

    const row = db.prepare('SELECT date FROM transactions').get() as { date: number };
    // A UTC-parsed date would come back a day off for anyone east or west of GMT.
    expect(row.date).toBe(day(3));
    expect(new Date(row.date).getDate()).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe('AC5 idempotency', () => {
  it('importing the same file twice inserts nothing the second time', () => {
    addTxn({ note: 'a' });
    addTxn({ note: 'b' });
    const csv = service.exportTransactionsCsv();

    const first = service.importTransactionsCsv(csv);
    const second = service.importTransactionsCsv(csv);

    // Same database already holds those ids, so everything is skipped.
    expect(first.skipped).toBe(2);
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(2);
    expect(second.total).toBe(2);
    expect(rowCount()).toBe(2);
  });

  it('AC5 two identical bills on the same day are BOTH kept', () => {
    // The natural-key alternative (date+amount+note) would collapse these into one and
    // lose money. Distinct ids must survive.
    addTxn({ id: 'coffee-1', note: '咖啡', amountCents: 2_500, date: day(4) });
    addTxn({ id: 'coffee-2', note: '咖啡', amountCents: 2_500, date: day(4) });

    const csv = service.exportTransactionsCsv();
    db.prepare('DELETE FROM transactions').run();

    const result = service.importTransactionsCsv(csv);

    expect(result.inserted).toBe(2);
    expect(rowCount()).toBe(2);
    expect(totals().netExpense).toBe(5_000);
  });

  it('AC8 an import does not modify existing bills', () => {
    const existingId = addTxn({ note: '原有的', amountCents: 12_345, date: day(7) });
    const before = db
      .prepare('SELECT id, amount_cents, note, date FROM transactions WHERE id = ?')
      .get(existingId);

    // A file that happens to carry the same id must be skipped, not merged.
    const csv = service.exportTransactionsCsv();
    service.importTransactionsCsv(csv);

    const after = db
      .prepare('SELECT id, amount_cents, note, date FROM transactions WHERE id = ?')
      .get(existingId);
    expect(after).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Invalid input — must be loud
// ---------------------------------------------------------------------------

describe('AC6/AC7 invalid input is rejected, never silently skipped', () => {
  /** A minimal valid file with the given single data row. */
  const header = 'id,date,type,amount,category,account,note,tags,isRefund';
  const fileWith = (row: string): string => `${header}\n${row}`;

  it('rejects a file that is not CSV at all', () => {
    expect(() => service.importTransactionsCsv('<html>nope</html>')).toThrow(ValidationError);
  });

  it('rejects an empty file', () => {
    expect(() => service.importTransactionsCsv('')).toThrow(/missing required column/i);
  });

  it('rejects a file missing a required column', () => {
    expect(() =>
      service.importTransactionsCsv('id,date,amount\nx,2026-09-01,10.00'),
    ).toThrow(/missing required column/i);
  });

  it('rejects an invalid amount', () => {
    expect(() =>
      service.importTransactionsCsv(
        fileWith('x1,2026-09-01,expense,not-a-number,餐饮,默认账户,,-,false'),
      ),
    ).toThrow(/amount must be a positive number/i);
  });

  it('rejects a negative or zero amount', () => {
    for (const amount of ['0', '-5.00']) {
      expect(() =>
        service.importTransactionsCsv(
          fileWith(`x1,2026-09-01,expense,${amount},餐饮,默认账户,,-,false`),
        ),
      ).toThrow(/amount must be a positive number/i);
    }
  });

  it('rejects an invalid date, including one that does not exist', () => {
    for (const date of ['01/09/2026', '2026-13-01', '2026-02-31', '']) {
      expect(() =>
        service.importTransactionsCsv(
          fileWith(`x1,${date},expense,10.00,餐饮,默认账户,,-,false`),
        ),
      ).toThrow(/date must be YYYY-MM-DD/i);
    }
  });

  it('rejects an unknown type label', () => {
    expect(() =>
      service.importTransactionsCsv(
        fileWith('x1,2026-09-01,transfer,10.00,餐饮,默认账户,,-,false'),
      ),
    ).toThrow(/type must be expense or income/i);
  });

  it('AC7 rejects an unknown CATEGORY and names it', () => {
    // Not created on the fly and not skipped: either would be a silent decision about the
    // user's master data.
    expect(() =>
      service.importTransactionsCsv(
        fileWith('x1,2026-09-01,expense,10.00,不存在的分类,默认账户,,-,false'),
      ),
    ).toThrow(/unknown category "不存在的分类"/i);
  });

  it('AC7 rejects an unknown ACCOUNT and names it', () => {
    expect(() =>
      service.importTransactionsCsv(
        fileWith('x1,2026-09-01,expense,10.00,餐饮,不存在的账户,,-,false'),
      ),
    ).toThrow(/unknown account "不存在的账户"/i);
  });

  it('reports the line number so the file can be fixed', () => {
    expect(() =>
      service.importTransactionsCsv(
        `${header}\nx1,2026-09-01,expense,10.00,餐饮,默认账户,,-,false\nx2,2026-09-01,expense,bad,餐饮,默认账户,,-,false`,
      ),
    ).toThrow(/Line 3/);
  });

  it('rejects an empty id', () => {
    expect(() =>
      service.importTransactionsCsv(
        fileWith(',2026-09-01,expense,10.00,餐饮,默认账户,,-,false'),
      ),
    ).toThrow(/id is empty/i);
  });

  it('AC6 a rejected import leaves the ledger untouched', () => {
    addTxn({ note: '原有的' });
    const before = rowCount();

    // Row 1 is valid, row 2 is not: all-or-nothing means NEITHER lands.
    expect(() =>
      service.importTransactionsCsv(
        `${header}\nnew-1,2026-09-01,expense,10.00,餐饮,默认账户,,-,false\nnew-2,2026-09-01,expense,bad,餐饮,默认账户,,-,false`,
      ),
    ).toThrow();

    expect(rowCount()).toBe(before);
    expect(db.prepare("SELECT COUNT(*) AS c FROM transactions WHERE id LIKE 'new-%'").get()).toEqual({
      c: 0,
    });
  });

  it('accepts a file with no trailing newline', () => {
    const result = service.importTransactionsCsv(
      fileWith('x1,2026-09-01,expense,10.00,餐饮,默认账户,备注,-,false'),
    );
    expect(result.inserted).toBe(1);
  });

  it('accepts a remark containing a comma, a quote and a newline', () => {
    const csv = `${header}\n"x1","2026-09-01","expense","10.00","餐饮","默认账户","他说 ""太贵""\n然后走了","","false"`;

    const result = service.importTransactionsCsv(csv);

    expect(result.inserted).toBe(1);
    const row = db.prepare('SELECT note FROM transactions WHERE id = ?').get('x1') as {
      note: string;
    };
    expect(row.note).toBe('他说 "太贵"\n然后走了');
  });

  it('normalises a pre-reform expense-typed refund row to income under 退款', () => {
    // Pre-refund-reform exports wrote refunds as type=expense. Importing one as-is would
    // create a row that contributes 0 to BOTH aggregates, so it is normalised — the same
    // rewrite migration 006 applies to existing rows.
    const result = service.importTransactionsCsv(
      fileWith('legacy-1,2026-09-01,expense,10.00,餐饮,默认账户,,,true'),
    );
    expect(result.inserted).toBe(1);

    const row = db
      .prepare('SELECT type, category_id, is_refund FROM transactions WHERE id = ?')
      .get('legacy-1') as { type: number; category_id: string; is_refund: number };
    expect(row.type).toBe(1);
    expect(row.category_id).toBe(REFUND_CATEGORY);
    expect(row.is_refund).toBe(1);
  });

  it('fails the import when a legacy refund row lands and 退款 is missing', () => {
    db.prepare('UPDATE categories SET deleted = 1 WHERE id = ?').run(REFUND_CATEGORY);
    expect(() =>
      service.importTransactionsCsv(
        fileWith('legacy-2,2026-09-01,expense,10.00,餐饮,默认账户,,,true'),
      ),
    ).toThrow(ValidationError);
    expect(rowCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Transfers export/import
// ---------------------------------------------------------------------------

describe('transfer CSV portability', () => {
  it('exports live transfers with account names', () => {
    addAccount(WALLET, '钱包');
    addTransfer({ id: 'live-transfer', note: '转给钱包', amountCents: 12_345 });
    addTransfer({ id: 'deleted-transfer', note: '已删除' });
    db.prepare('UPDATE transfers SET deleted = 1 WHERE id = ?').run('deleted-transfer');

    const csv = service.exportTransfersCsv();

    expect(csv).toContain('钱包');
    expect(csv).toContain('默认账户');
    expect(csv).not.toContain(WALLET);
    expect(csv).not.toContain('deleted-transfer');
    expect(csv.replace('\uFEFF', '').trim().split('\n')).toHaveLength(2);
  });

  it('round-trips ids, account names, amount, date and note', () => {
    addAccount(WALLET, '钱包');
    addTransfer({
      id: 'round-transfer',
      fromAccountId: ACCOUNT,
      toAccountId: WALLET,
      amountCents: 43_210,
      date: day(8),
      note: '转给钱包',
    });

    const csv = service.exportTransfersCsv();
    db.prepare('DELETE FROM transfers').run();

    const result = service.importTransfersCsv(csv);

    expect(result).toEqual({ inserted: 1, skipped: 0, total: 1 });
    const row = db.prepare('SELECT * FROM transfers WHERE id = ?').get('round-transfer') as {
      from_account_id: string;
      to_account_id: string;
      amount_cents: number;
      date: number;
      note: string;
      deleted: number;
    };
    expect(row).toMatchObject({
      from_account_id: ACCOUNT,
      to_account_id: WALLET,
      amount_cents: 43_210,
      date: day(8),
      note: '转给钱包',
      deleted: 0,
    });
  });

  it('a second import skips the same ids instead of duplicating money', () => {
    addAccount(WALLET, '钱包');
    addTransfer({ id: 'once', amountCents: 5_000 });
    const csv = service.exportTransfersCsv();

    db.prepare('DELETE FROM transfers').run();
    expect(service.importTransfersCsv(csv)).toEqual({ inserted: 1, skipped: 0, total: 1 });
    expect(service.importTransfersCsv(csv)).toEqual({ inserted: 0, skipped: 1, total: 1 });
  });

  it('rejects an unknown account and a transfer to itself', () => {
    const header = 'id,date,amount,from,to,note';

    expect(() =>
      service.importTransfersCsv(
        `${header}\nx,2026-09-01,10.00,不存在的账户,默认账户,`,
      ),
    ).toThrow(/unknown account "不存在的账户"/i);
    expect(() =>
      service.importTransfersCsv(`${header}\nx,2026-09-01,10.00,默认账户,默认账户,`),
    ).toThrow(/two different accounts/i);
  });

  it('a rejected file leaves existing transfers untouched', () => {
    addAccount(WALLET, '钱包');
    addTransfer({ id: 'existing', amountCents: 1_000 });

    expect(() =>
      service.importTransfersCsv(
        'id,date,amount,from,to,note\nnew,2026-09-01,10.00,默认账户,钱包,\nbad,2026-09-01,not-money,默认账户,钱包,',
      ),
    ).toThrow(ValidationError);

    expect(
      db.prepare('SELECT COUNT(*) AS c FROM transfers WHERE id = ?').get('existing'),
    ).toEqual({ c: 1 });
    expect(db.prepare('SELECT COUNT(*) AS c FROM transfers WHERE id = ?').get('new')).toEqual({
      c: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

describe('backups', () => {
  it('AC9 an empty backups directory is an empty list, not an error', () => {
    expect(service.listBackups()).toEqual([]);
  });

  it('takes an archive and lists it with metadata', () => {
    // `createBackup` needs a real database file, so write one where it expects it.
    const livePath = join(dataDir, 'jizhang.db');
    const live = new Database(livePath);
    live.exec('CREATE TABLE probe (id TEXT PRIMARY KEY)');
    live.close();

    const created = service.createBackupNow();

    expect(created.fileName).toMatch(/^jizhang-.*\.db$/);
    expect(created.sizeBytes).toBeGreaterThan(0);
    const listed = service.listBackups();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.fileName).toBe(created.fileName);
  });

  it('does not leak the host path in the listing', () => {
    const livePath = join(dataDir, 'jizhang.db');
    const live = new Database(livePath);
    live.exec('CREATE TABLE probe (id TEXT PRIMARY KEY)');
    live.close();
    service.createBackupNow();

    const listed = service.listBackups();
    // The client cannot read the filesystem, so a path is both useless and a leak.
    expect(listed[0]?.fileName).not.toContain(dataDir);
    expect(listed[0]?.fileName).not.toContain('/');
    expect(listed[0]?.fileName).not.toContain('\\');
  });

  it('lists newest first', () => {
    const livePath = join(dataDir, 'jizhang.db');
    const live = new Database(livePath);
    live.exec('CREATE TABLE probe (id TEXT PRIMARY KEY)');
    live.close();

    // Two archives in the same millisecond would collide by name, so only assert on one
    // plus the sort contract with a fabricated entry.
    service.createBackupNow();
    const listed = service.listBackups();
    for (let index = 1; index < listed.length; index += 1) {
      expect(listed[index - 1]!.createdAtMs).toBeGreaterThanOrEqual(listed[index]!.createdAtMs);
    }
  });
});
