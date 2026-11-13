/**
 * T2 acceptance tests: schema, migration semantics, seeding idempotency, PRAGMAs.
 *
 * Migrations and seeding are driven in memory (fast, isolated). The PRAGMA tests
 * need a real file because WAL is not available for `:memory:` databases.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SEED_ACCOUNT,
  SEED_CATEGORIES,
  SEED_TEMPLATE,
  SEED_UPDATED_AT_MS,
  paletteSlot,
} from '@jizhang/shared';
import {
  closeDatabase,
  initializeDatabase,
  openDatabase,
  seedDatabase,
  type Db,
} from '../src/db/index.js';
import { migrationStatus, MIGRATIONS, runMigrations, type Migration } from '../src/db/migrate.js';
import { loadConfig } from '../src/config.js';

const EXPECTED_TABLES = [
  'asset_item_photos',
  'asset_items',
  'accounts',
  'budget_allocations',
  'budget_templates',
  'categories',
  'salary_records',
  'schema_migrations',
  'sessions',
  'settings',
  'transactions',
  'transfers',
  'tags',
  'users',
];

let db: Db;
const tempDirs: string[] = [];

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
});

afterEach(() => {
  closeDatabase(db);
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function countRows(table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as {
    c: number;
  };
  return row.c;
}

describe('migrations', () => {
  it('025 preserves old CSV confirmation receipts without inventing a new completion timestamp', () => {
    runMigrations(db, null, MIGRATIONS.filter((migration) => migration.version < 25));
    const result = JSON.stringify({ inserted: 2, skipped: 0, total: 2 });
    db.prepare('INSERT INTO assistant_csv_previews(id,request_id,request_hash,kind,file_hash,fingerprint,preview_json,result_json,expires_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run('legacy-csv', 'legacy-request', 'request-hash', 'transactions', 'file-hash', 'fingerprint', '{}', result, 1000);
    expect(runMigrations(db, null).applied).toEqual([25, 26]);
    expect(db.prepare('SELECT result_json,confirmed_at FROM assistant_csv_previews WHERE id=?').get('legacy-csv')).toEqual({ result_json: result, confirmed_at: null });
    expect(runMigrations(db, null).applied).toEqual([]);
  });
  it('013 creates tag indexes and idempotently backfills live and deleted names without changing JSON bytes', () => {
    const migrations = MIGRATIONS.filter((entry) => entry.version < 13);
    for (const migration of migrations) db.exec(migration.sql);
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL
    )`);
    const record = db.prepare('INSERT INTO schema_migrations (version,name,applied_at) VALUES (?,?,?)');
    for (const migration of migrations) record.run(migration.version,migration.name,1);
    const insert = db.prepare(`INSERT INTO transactions
      (id,type,amount_cents,category_id,account_id,date,note,tags_json,is_refund,deleted,updated_at)
      VALUES (?,0,100,'category','builtin-default-account',1,'',?,0,?,1)`);
    const raw = '["one","😀"]';
    insert.run('tag-live',raw,0);
    insert.run('tag-deleted','["old"]',1);
    insert.run('tag-malformed','{invalid',0);

    runMigrations(db,null);
    const names = (db.prepare('SELECT name FROM tags ORDER BY name').all() as {name:string}[]).map((row)=>row.name);
    expect(names).toEqual(['old','one','😀']);
    expect((db.prepare('SELECT tags_json FROM transactions WHERE id=?').get('tag-live') as {tags_json:string}).tags_json).toBe(raw);
    const indexes=(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='tags'").all() as {name:string}[]).map((row)=>row.name);
    expect(indexes).toContain('tags_active_name');
    expect(indexes).toContain('tags_parent_id');
    expect(() => runMigrations(db,null)).not.toThrow();
    expect(countRows('tags')).toBe(3);
  });
  it('AC1 creates every table on an empty database', () => {
    runMigrations(db, null);

    const { tables } = migrationStatus(db);
    for (const table of EXPECTED_TABLES) {
      expect(tables).toContain(table);
    }
  });

  it('AC3 records each migration exactly once', () => {
    runMigrations(db, null);
    runMigrations(db, null);
    runMigrations(db, null);

    const rows = db
      .prepare('SELECT version, COUNT(*) AS c FROM schema_migrations GROUP BY version')
      .all() as { version: number; c: number }[];

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.c).toBe(1);
    }
  });

  /**
   * Migration 003 adds a NOT NULL column to a table that already has rows. The reason no
   * backfill pass exists is that SQLite fills existing rows from the constant `DEFAULT`, so
   * this test drives the real upgrade path: apply only migrations 1 and 2, record a salary
   * the way the old code did, then migrate.
   */
  it('003 backfills account_id on pre-existing salary rows and makes it required', () => {
    const init = MIGRATIONS.find((entry) => entry.version === 1);
    const recurring = MIGRATIONS.find((entry) => entry.version === 2);
    expect(init).toBeDefined();
    expect(recurring).toBeDefined();
    if (init === undefined || recurring === undefined) return;

    // A database as it existed before 003: migrations 1 and 2 applied and recorded.
    db.exec(init.sql);
    db.exec(recurring.sql);
    db.exec(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version    INTEGER PRIMARY KEY,
         name       TEXT    NOT NULL,
         applied_at INTEGER NOT NULL
       )`,
    );
    const record = db.prepare(
      'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
    );
    record.run(1, init.name, 1);
    record.run(2, recurring.name, 1);

    db.prepare(
      `INSERT INTO accounts (id, name, type, initial_balance_cents, sort_order, is_builtin, deleted, updated_at)
       VALUES ('builtin-default-account', '默认账户', 0, 0, 0, 1, 0, 1)`,
    ).run();
    // No account_id column yet — exactly what the old code wrote.
    db.prepare(
      `INSERT INTO salary_records (id, amount_cents, date, note, deleted, updated_at)
       VALUES ('old-salary', 500000, 1000, '记于 003 之前', 0, 1)`,
    ).run();

    runMigrations(db, null);

    const preserved = db
      .prepare('SELECT amount_cents, account_id FROM salary_records WHERE id = ?')
      .get('old-salary') as { amount_cents: number; account_id: string };
    // The money is untouched and the row lands on the account it was always implicitly
    // associated with.
    expect(preserved.amount_cents).toBe(500000);
    expect(preserved.account_id).toBe('builtin-default-account');

    const columns = db.prepare('PRAGMA table_info(salary_records)').all() as {
      name: string;
      notnull: number;
      dflt_value: string | null;
    }[];
    const accountId = columns.find((column) => column.name === 'account_id');
    expect(accountId?.notnull).toBe(1);
    expect(accountId?.dflt_value).toBe("'builtin-default-account'");
  });

  /**
   * Migration 006 rewrites every expense-typed refund row to income under the new 退款
   * category. This drives the real upgrade path: apply migrations 1–5, write refund rows
   * the way the old code did (type = 0), then migrate.
   */
  it('006 rewrites old expense-typed refunds to income under the 退款 category', () => {
    // A database as it existed before 006: migrations 1–5 applied and recorded.
    const through5 = MIGRATIONS.filter((entry) => entry.version <= 5);
    expect(through5).toHaveLength(5);
    db.exec(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version    INTEGER PRIMARY KEY,
         name       TEXT    NOT NULL,
         applied_at INTEGER NOT NULL
       )`,
    );
    const record = db.prepare(
      'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
    );
    for (const entry of through5) {
      db.exec(entry.sql);
      record.run(entry.version, entry.name, 1);
    }

    db.prepare(
      `INSERT INTO accounts (id, name, type, initial_balance_cents, sort_order, is_builtin, deleted, updated_at)
       VALUES ('builtin-default-account', '默认账户', 0, 0, 0, 1, 0, 1)`,
    ).run();

    // One expense original, one live refund, one trashed refund — all written the
    // way the old model did: type = 0 with is_refund = 1.
    const insertTxn = db.prepare(
      `INSERT INTO transactions
         (id, type, amount_cents, category_id, account_id, date, note, tags_json, is_refund, deleted, updated_at)
       VALUES (?, ?, ?, 'builtin-expense-food', 'builtin-default-account', 1000, '', '[]', ?, ?, 1)`,
    );
    insertTxn.run('original-1', 0, 100_000, 0, 0);
    insertTxn.run('refund-live', 0, 30_000, 1, 0);
    insertTxn.run('refund-trashed', 0, 20_000, 1, 1);
    db.prepare(
      `INSERT INTO refund_links (id, refund_tx_id, original_tx_id, created_at)
       VALUES ('link-1', 'refund-live', 'original-1', 1)`,
    ).run();

    runMigrations(db, null);

    // Both refund rows are now income under 退款 — including the trashed one.
    for (const id of ['refund-live', 'refund-trashed']) {
      const row = db.prepare('SELECT type, category_id FROM transactions WHERE id = ?').get(id) as {
        type: number;
        category_id: string;
      };
      expect(row.type).toBe(1);
      expect(row.category_id).toBe('builtin-income-refund');
    }
    // The original stays an expense, and the link survives.
    const original = db.prepare('SELECT type FROM transactions WHERE id = ?').get('original-1') as {
      type: number;
    };
    expect(original.type).toBe(0);
    expect(countRows('refund_links')).toBe(1);

    // The category was created exactly as the seed describes it.
    const category = db
      .prepare('SELECT name, type, color, sort_order, is_builtin FROM categories WHERE id = ?')
      .get('builtin-income-refund') as {
      name: string;
      type: number;
      color: number;
      sort_order: number;
      is_builtin: number;
    };
    expect(category.name).toBe('退款');
    expect(category.type).toBe(1);
    expect(category.color).toBe(paletteSlot(9).argb);
    expect(category.sort_order).toBe(2);
    expect(category.is_builtin).toBe(1);

    // Re-running is a no-op — no duplicate category.
    runMigrations(db, null);
    expect(
      db.prepare('SELECT COUNT(*) AS c FROM categories WHERE id = ?').get('builtin-income-refund'),
    ).toMatchObject({ c: 1 });
  });

  it('006 creates the 退款 category on a fresh database and updates no rows', () => {
    runMigrations(db, null);
    const row = db
      .prepare('SELECT name, type FROM categories WHERE id = ?')
      .get('builtin-income-refund') as { name: string; type: number };
    expect(row.name).toBe('退款');
    expect(row.type).toBe(1);
    expect(
      db.prepare('SELECT COUNT(*) AS c FROM transactions WHERE is_refund = 1').get(),
    ).toMatchObject({ c: 0 });
  });

  /**
   * Migration 004 adds the transfers table. It is purely additive: an older database simply
   * gains an empty table, and older code that does not know it exists is unaffected (which is
   * what makes rollback safe without a down migration).
   */
  it('004 adds transfers with the indexes the account drill-down needs', () => {
    runMigrations(db, null);

    const columns = (
      db.prepare('PRAGMA table_info(transfers)').all() as { name: string }[]
    ).map((column) => column.name);
    expect(columns).toEqual([
      'id',
      'from_account_id',
      'to_account_id',
      'amount_cents',
      'date',
      'note',
      'deleted',
      'updated_at',
    ]);

    const indexes = (
      db.prepare('PRAGMA index_list(transfers)').all() as { name: string }[]
    ).map((index) => index.name);
    for (const expected of ['idx_transfer_date', 'idx_transfer_from', 'idx_transfer_to']) {
      expect(indexes).toContain(expected);
    }

    // An account's balance is derived from live rows, so the index the balance query relies on
    // has to be usable by SQLite rather than merely declared.
    const plan = db
      .prepare('EXPLAIN QUERY PLAN SELECT * FROM transfers WHERE deleted = 0')
      .all() as { detail: string }[];
    expect(plan.map((row) => row.detail).join(' ')).toContain('idx_transfer_date');
  });

  it('R2 re-running is a no-op that reports nothing pending', () => {
    const first = runMigrations(db, null);
    expect(first.applied.length).toBeGreaterThan(0);

    const second = runMigrations(db, null);
    expect(second.applied).toEqual([]);
    expect(second.backupPath).toBeNull();
    expect(migrationStatus(db).pending).toEqual([]);
  });

  it('AC6 a failing migration rolls back and is not recorded', () => {
    runMigrations(db, null);
    const before = countRows('schema_migrations');

    // Simulate a broken migration by hand: the runner's transaction must undo the
    // partial DDL and keep the version out of schema_migrations.
    expect(() => {
      db.transaction(() => {
        db.exec('CREATE TABLE should_not_survive (id TEXT)');
        throw new Error('boom');
      })();
    }).toThrow('boom');

    expect(countRows('schema_migrations')).toBe(before);
    const { tables } = migrationStatus(db);
    expect(tables).not.toContain('should_not_survive');

    // The database is still usable afterwards.
    const rerun = runMigrations(db, null);
    expect(rerun.applied).toEqual([]);
  });

  it('AC6 rolls back a migration whose TS run hook throws and never records it', () => {
    runMigrations(db, null);
    const before = countRows('schema_migrations');
    const failing: Migration = {
      version: 99,
      name: 'failing-run-hook',
      sql: 'CREATE TABLE should_not_survive_run_hook (id TEXT)',
      run() {
        throw new Error('boom-run-hook');
      },
    };

    expect(() => runMigrations(db, null, [failing])).toThrow('boom-run-hook');

    expect(countRows('schema_migrations')).toBe(before);
    const { tables } = migrationStatus(db);
    expect(tables).not.toContain('should_not_survive_run_hook');
  });

  it('AC5 does not litter backups on a fresh install', () => {
    const dir = makeTempDir('jizhang-t2-fresh-');
    const config = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      JIZHANG_USERNAME: 'u',
      JIZHANG_PASSWORD_HASH: 'h',
      DATA_DIR: dir,
    });

    const fileDb = openDatabase(config);
    try {
      const first = initializeDatabase(fileDb, config.dataDir);
      expect(first.migrations.applied).toContain(1);
      // Nothing to lose on a brand new database, so no snapshot is taken.
      expect(first.migrations.backupPath).toBeNull();
      expect(existsSync(path.join(config.dataDir, 'backups'))).toBe(false);
    } finally {
      closeDatabase(fileDb);
    }
  });

  it('AC5 backs up an already-migrated database before a new migration runs', () => {
    const dir = makeTempDir('jizhang-t2-backup-');
    const config = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      JIZHANG_USERNAME: 'u',
      JIZHANG_PASSWORD_HASH: 'h',
      DATA_DIR: dir,
    });

    // First boot: schema + seed, no backup.
    const firstDb = openDatabase(config);
    try {
      initializeDatabase(firstDb, config.dataDir);
    } finally {
      closeDatabase(firstDb);
    }

    // Second boot with a fresh connection, as a restart would do: migrations are
    // already applied, so this is again a no-op.
    const secondDb = openDatabase(config);
    try {
      const second = initializeDatabase(secondDb, config.dataDir);
      expect(second.migrations.applied).toEqual([]);
      expect(second.migrations.backupPath).toBeNull();
    } finally {
      closeDatabase(secondDb);
    }

    // Now simulate a new release shipping one more migration: the pre-migration
    // snapshot is what makes a bad upgrade recoverable. Injecting it into the
    // live array is the only way to observe the backup without shipping a fake
    // migration in the product code.
    //
    // The version is derived from the real list rather than hard-coded: a literal
    // collides the moment the product ships that version, and the collision surfaces
    // as a confusing `applied` assertion rather than as "this probe is stale".
    const thirdDb = openDatabase(config);
    try {
      const mutable = MIGRATIONS as unknown as Migration[];
      const probeVersion = Math.max(...MIGRATIONS.map((entry) => entry.version)) + 1;
      const injected: Migration = {
        version: probeVersion,
        name: 'test-only-probe',
        sql: 'CREATE TABLE t2_probe (id TEXT PRIMARY KEY);',
      };
      mutable.push(injected);
      try {
        const third = initializeDatabase(thirdDb, config.dataDir);

        expect(third.migrations.applied).toContain(probeVersion);
        expect(third.migrations.backupPath).not.toBeNull();
        const backupPath = third.migrations.backupPath as string;
        expect(existsSync(backupPath)).toBe(true);

        const backups = readdirSync(path.join(config.dataDir, 'backups'));
        expect(backups).toHaveLength(1);
        expect(backups[0]).toMatch(/^jizhang-.*\.db$/);

        // The backup must be a usable database, not a truncated copy.
        const restored = new Database(backupPath, { readonly: true });
        try {
          const tables = (
            restored
              .prepare("SELECT name FROM sqlite_master WHERE type='table'")
              .all() as { name: string }[]
          ).map((row) => row.name);
          expect(tables).toContain('transactions');
          expect(tables).toContain('categories');
          // ...and it must predate the migration it protected against.
          expect(tables).not.toContain('t2_probe');
        } finally {
          restored.close();
        }
      } finally {
        mutable.pop();
      }
    } finally {
      closeDatabase(thirdDb);
    }
  });
});

describe('PRAGMAs (AC4)', () => {
  it('uses WAL on a file-backed database and enforces foreign keys', () => {
    const dir = makeTempDir('jizhang-t2-pragma-');
    const config = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      JIZHANG_USERNAME: 'u',
      JIZHANG_PASSWORD_HASH: 'h',
      DATA_DIR: dir,
    });

    const fileDb = openDatabase(config);
    try {
      expect(fileDb.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(fileDb.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(fileDb.pragma('busy_timeout', { simple: true })).toBe(5000);
    } finally {
      closeDatabase(fileDb);
    }
  });

  it('rejects a child row whose parent does not exist', () => {
    runMigrations(db, null);
    expect(() =>
      db
        .prepare(
          'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
        )
        .run('hash', 'no-such-user', 0, 0),
    ).toThrow(/FOREIGN KEY/i);
  });
});

describe('seeding', () => {
  it('AC1 inserts the preset categories, default account and default template', () => {
    initializeDatabase(db, null);

    expect(countRows('categories')).toBe(SEED_CATEGORIES.length);
    expect(countRows('accounts')).toBe(1);
    expect(countRows('budget_templates')).toBe(1);

    const expense = db
      .prepare('SELECT COUNT(*) AS c FROM categories WHERE type = 0')
      .get() as { c: number };
    const income = db
      .prepare('SELECT COUNT(*) AS c FROM categories WHERE type = 1')
      .get() as { c: number };
    expect(expense.c).toBe(6);
    expect(income.c).toBe(3);
  });

  it('AC2 seeding twice does not duplicate anything', () => {
    initializeDatabase(db, null);
    const first = {
      categories: countRows('categories'),
      accounts: countRows('accounts'),
      templates: countRows('budget_templates'),
    };

    const second = seedDatabase(db);
    const third = seedDatabase(db);

    expect(second).toEqual({
      categoriesInserted: 0,
      accountsInserted: 0,
      templatesInserted: 0,
    });
    expect(third.categoriesInserted).toBe(0);

    expect(countRows('categories')).toBe(first.categories);
    expect(countRows('accounts')).toBe(first.accounts);
    expect(countRows('budget_templates')).toBe(first.templates);
  });

  it('a user rename of a preset row survives re-seeding', () => {
    initializeDatabase(db, null);
    db.prepare('UPDATE categories SET name = ?, updated_at = ? WHERE id = ?').run(
      '吃饭',
      Date.now(),
      'builtin-expense-food',
    );

    seedDatabase(db);

    const row = db
      .prepare('SELECT name FROM categories WHERE id = ?')
      .get('builtin-expense-food') as { name: string };
    expect(row.name).toBe('吃饭');
  });

  it('seeds rows with the sentinel updated_at so real edits always win', () => {
    initializeDatabase(db, null);
    const row = db
      .prepare('SELECT updated_at FROM categories WHERE id = ?')
      .get('builtin-expense-food') as { updated_at: number };
    expect(row.updated_at).toBe(SEED_UPDATED_AT_MS);
  });

  it('marks seeded rows as builtin and not deleted', () => {
    initializeDatabase(db, null);
    const bad = db
      .prepare('SELECT COUNT(*) AS c FROM categories WHERE is_builtin = 0 OR deleted <> 0')
      .get() as { c: number };
    expect(bad.c).toBe(0);
  });

  it('stores the default account with the stable builtin id', () => {
    initializeDatabase(db, null);
    const row = db
      .prepare('SELECT name, is_builtin FROM accounts WHERE id = ?')
      .get(SEED_ACCOUNT.id) as { name: string; is_builtin: number } | undefined;
    expect(row).toBeDefined();
    expect(row?.is_builtin).toBe(1);
  });

  it('stores the template modules as JSON with categoryId and ratio', () => {
    initializeDatabase(db, null);
    const row = db
      .prepare('SELECT is_default, modules_json FROM budget_templates WHERE id = ?')
      .get(SEED_TEMPLATE.id) as
      | { is_default: number; modules_json: string }
      | undefined;

    expect(row).toBeDefined();
    expect(row?.is_default).toBe(1);

    const modules = JSON.parse(row?.modules_json ?? '[]') as {
      categoryId: string;
      ratio: number;
    }[];
    expect(modules.length).toBe(SEED_TEMPLATE.modules.length);
    expect(modules.map((m) => m.categoryId)).toEqual(
      SEED_TEMPLATE.modules.map((m) => m.categoryId),
    );
    const sum = modules.reduce((acc, m) => acc + m.ratio, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(0.0001);
  });

  it('every template module references a seeded category', () => {
    initializeDatabase(db, null);
    for (const module of SEED_TEMPLATE.modules) {
      const found = db
        .prepare('SELECT 1 AS x FROM categories WHERE id = ?')
        .get(module.categoryId) as { x: number } | undefined;
      expect(found, `missing category ${module.categoryId}`).toBeDefined();
    }
  });
});

describe('schema shape', () => {
  it('every business table carries the soft-delete column', () => {
    runMigrations(db, null);
    for (const table of [
      'categories',
      'accounts',
      'transactions',
      'salary_records',
      'budget_allocations',
      'budget_templates',
    ]) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as {
        name: string;
      }[];
      expect(columns.map((c) => c.name), table).toContain('deleted');
    }
  });

  it('transactions default to an empty tag list and not-a-refund', () => {
    runMigrations(db, null);
    db.prepare(
      `INSERT INTO transactions (id, type, amount_cents, category_id, account_id, date, updated_at)
       VALUES ('t1', 0, 1999, 'builtin-expense-food', 'builtin-default-account', 0, 0)`,
    ).run();

    const row = db
      .prepare('SELECT tags_json, is_refund FROM transactions WHERE id = ?')
      .get('t1') as { tags_json: string; is_refund: number };
    expect(row.tags_json).toBe('[]');
    expect(row.is_refund).toBe(0);
  });

  it('does not materialise budget balances (the engine is real-time)', () => {
    runMigrations(db, null);
    const columns = db.prepare('PRAGMA table_info(budget_allocations)').all() as {
      name: string;
    }[];
    const names = columns.map((c) => c.name);
    expect(names).not.toContain('remaining_cents');
    expect(names).not.toContain('carryover_pool_cents');
  });
});
