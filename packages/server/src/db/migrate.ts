/**
 * Versioned migration runner.
 *
 * Contract (parent task T2 PRD R3):
 *   * migrations are applied in array order, only the ones not yet recorded;
 *   * each migration runs in its own transaction — a failure rolls back and the
 *     version is NOT recorded, so the next boot retries it;
 *   * the database file is backed up before the first migration of a run;
 *   * re-running is a no-op (parent `implement.md` risk check R2).
 *
 * Kept deliberately small: this is a single-user SQLite app where migrations are
 * rare, so a full framework would be more surface area than value.
 */
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Db } from './index.js';
import { MIGRATION_001_INIT } from './migrations/001-init.js';
import { MIGRATION_002_RECURRING } from './migrations/002-recurring.js';
import { MIGRATION_003_SALARY_ACCOUNT } from './migrations/003-salary-account.js';
import { MIGRATION_004_TRANSFERS } from './migrations/004-transfers.js';
import { MIGRATION_005_REFUND_LINKS } from './migrations/005-refund-links.js';
import { MIGRATION_006_REFUND_INCOME } from './migrations/006-refund-income.js';
import { MIGRATION_007_CATEGORY_HIERARCHY } from './migrations/007-category-hierarchy.js';
import { MIGRATION_008_AI_ORGANIZATION_AUDIT } from './migrations/008-ai-organization-audit.js';
import { MIGRATION_009_ASSISTANT } from './migrations/009-assistant.js';
import { MIGRATION_010_ITEM_ASSETS } from './migrations/010-item-assets.js';
import { MIGRATION_011_ASSISTANT_GENERATIONS } from './migrations/011-assistant-generations.js';
import { MIGRATION_012_IMPORT_BATCHES } from './migrations/012-import-batches.js';
import { MIGRATION_013_TAG_HIERARCHY, backfillTagCatalog } from './migrations/013-tag-hierarchy.js';
import { MIGRATION_014_AI_ANALYSIS_RUNS } from './migrations/014-ai-analysis-runs.js';
import { MIGRATION_015_AI_TEMPLATE_PROPOSALS } from './migrations/015-ai-template-proposals.js';
import { MIGRATION_016_AI_ORGANIZATION_OPERATIONS } from './migrations/016-ai-organization-operations.js';
import { MIGRATION_017_AI_ORGANIZATION_PROGRESS } from './migrations/017-ai-organization-progress.js';
import { MIGRATION_018_AI_ORGANIZATION_CHECKPOINTS } from './migrations/018-ai-organization-checkpoints.js';
import { MIGRATION_019_FINANCIAL_EXECUTION } from './migrations/019-financial-execution.js';
import { MIGRATION_020_MANUAL_GOAL_PROGRESS } from './migrations/020-manual-goal-progress.js';
import { MIGRATION_021_FOUR_PURPOSE_FUNDS, backfillFourPurposeFunds } from './migrations/021-four-purpose-funds.js';
import { MIGRATION_022_TEMPLATE_TAGS, backfillTemplateTags } from './migrations/022-template-tags.js';
import { MIGRATION_023_ASSISTANT_TRACE } from './migrations/023-assistant-trace.js';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly run?: (db: Db) => void;
}

/**
 * Every migration, in application order. Append new entries at the end and never
 * reorder or renumber existing ones.
 */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'init', sql: MIGRATION_001_INIT },
  { version: 2, name: 'recurring', sql: MIGRATION_002_RECURRING },
  { version: 3, name: 'salary-account', sql: MIGRATION_003_SALARY_ACCOUNT },
  { version: 4, name: 'transfers', sql: MIGRATION_004_TRANSFERS },
  { version: 5, name: 'refund-links', sql: MIGRATION_005_REFUND_LINKS },
  { version: 6, name: 'refund-income', sql: MIGRATION_006_REFUND_INCOME },
  { version: 7, name: 'category-hierarchy', sql: MIGRATION_007_CATEGORY_HIERARCHY },
  { version: 8, name: 'ai-organization-audit', sql: MIGRATION_008_AI_ORGANIZATION_AUDIT },
  { version: 9, name: 'assistant', sql: MIGRATION_009_ASSISTANT },
  { version: 10, name: 'item-assets', sql: MIGRATION_010_ITEM_ASSETS },
  { version: 11, name: 'assistant-generations', sql: MIGRATION_011_ASSISTANT_GENERATIONS },
  { version: 12, name: 'import-batches', sql: MIGRATION_012_IMPORT_BATCHES },
  { version: 13, name: 'tag-hierarchy', sql: MIGRATION_013_TAG_HIERARCHY, run: backfillTagCatalog },
  { version: 14, name: 'ai-analysis-runs', sql: MIGRATION_014_AI_ANALYSIS_RUNS },
  { version: 15, name: 'ai-template-proposals', sql: MIGRATION_015_AI_TEMPLATE_PROPOSALS },
  { version: 16, name: 'ai-organization-operations', sql: MIGRATION_016_AI_ORGANIZATION_OPERATIONS },
  { version: 17, name: 'ai-organization-progress', sql: MIGRATION_017_AI_ORGANIZATION_PROGRESS },
  { version: 18, name: 'ai-organization-checkpoints', sql: MIGRATION_018_AI_ORGANIZATION_CHECKPOINTS },
  { version: 19, name: 'financial-execution', sql: MIGRATION_019_FINANCIAL_EXECUTION },
  { version: 20, name: 'manual-goal-progress', sql: MIGRATION_020_MANUAL_GOAL_PROGRESS },
  { version: 21, name: 'four-purpose-funds', sql: MIGRATION_021_FOUR_PURPOSE_FUNDS, run: backfillFourPurposeFunds },
  // 22 retires the allocation-template surface without deleting its rows: each template
  // name is folded into the tag catalog so the meaning survives as a bill label.
  { version: 22, name: 'template-tags', sql: MIGRATION_022_TEMPLATE_TAGS, run: backfillTemplateTags },
  // 23 stores bounded per-step execution metadata for a generation. It is diagnostic only:
  // it never holds model reasoning, provider bodies, prompts or credentials.
  { version: 23, name: 'assistant-trace', sql: MIGRATION_023_ASSISTANT_TRACE },
];

interface AppliedRow {
  readonly version: number;
  readonly name: string;
  readonly applied_at: number;
}

export interface MigrateResult {
  readonly applied: readonly number[];
  readonly alreadyApplied: readonly number[];
  /** Path of the pre-migration backup, when one was taken. */
  readonly backupPath: string | null;
}

/** Creates `schema_migrations` if absent. Safe to call on every boot. */
function ensureMigrationTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT    NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
}

function appliedVersions(db: Db): Set<number> {
  const rows = db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[];
  return new Set(rows.map((row) => row.version));
}

/**
 * Copies the database file to `DATA_DIR/backups/jizhang-<ISO-ish>.db`.
 *
 * Uses SQLite's own `.backup` rather than a filesystem copy: in WAL mode the
 * `-wal` sidecar may hold committed data the main file does not have yet, so a
 * plain copy can silently lose the most recent transactions (design.md §7.4).
 * Returns `null` when there is no database file yet (a fresh install).
 */
export function backupDatabase(db: Db, dataDir: string): string | null {
  const backupsDir = path.join(dataDir, 'backups');
  mkdirSync(backupsDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
  const target = path.join(backupsDir, `jizhang-${stamp}.db`);

  // VACUUM INTO writes a consistent snapshot of the live database, including
  // anything still sitting in the WAL. It fails if the target exists, which is
  // fine: the timestamp makes collisions effectively impossible.
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);

  return existsSync(target) ? target : null;
}

/** Row count of a table, or 0 when the table does not exist yet. */
function tableRowCount(db: Db, table: string): number {
  const exists = db
    .prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { x: number } | undefined;
  if (exists === undefined) return 0;
  const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as {
    c: number;
  };
  return row.c;
}

/**
 * Applies every pending migration. Idempotent.
 *
 * @param dataDir directory that holds the database file; backups go to
 *   `<dataDir>/backups`. Pass `null` to skip the backup (tests only).
 */
export function runMigrations(db: Db, dataDir: string | null, migrations: readonly Migration[] = MIGRATIONS): MigrateResult {
  ensureMigrationTable(db);

  const done = appliedVersions(db);
  const pending = migrations.filter((migration) => !done.has(migration.version));

  if (pending.length === 0) {
    return {
      applied: [],
      alreadyApplied: migrations.map((m) => m.version),
      backupPath: null,
    };
  }

  // Back up only when this database has already been migrated before, i.e. it
  // holds real data that a bad migration could destroy. A fresh install has
  // nothing to lose, and must not litter DATA_DIR/backups on first boot.
  //
  // Note: "is the file non-empty?" is NOT a valid test here — opening the
  // database already writes a header (the WAL pragma alone does), so a brand new
  // file looks non-empty immediately.
  const isUpgrade = done.size > 0;
  const backupPath = dataDir !== null && isUpgrade ? backupDatabase(db, dataDir) : null;

  const applied: number[] = [];
  const record = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );

  for (const migration of pending) {
    // better-sqlite3's `transaction` wraps its function in BEGIN/COMMIT and rolls
    // back on throw, which is exactly the contract we want per migration.
    const apply = db.transaction(() => {
      db.exec(migration.sql);
      migration.run?.(db);
      record.run(migration.version, migration.name, Date.now());
    });
    apply();
    applied.push(migration.version);
  }

  return {
    applied,
    alreadyApplied: [...done].sort((a, b) => a - b),
    backupPath,
  };
}

/** Diagnostics for tests and the startup log. */
export function migrationStatus(db: Db): {
  applied: AppliedRow[];
  pending: number[];
  tables: string[];
} {
  ensureMigrationTable(db);
  const applied = db
    .prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version')
    .all() as AppliedRow[];
  const done = new Set(applied.map((row) => row.version));
  const tables = (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((row) => row.name);

  return {
    applied,
    pending: MIGRATIONS.filter((m) => !done.has(m.version)).map((m) => m.version),
    tables,
  };
}

export { tableRowCount };
