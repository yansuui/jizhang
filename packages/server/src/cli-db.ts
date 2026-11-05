/**
 * Consistent backup / restore / verification of the SQLite database.
 *
 *   node dist/cli.js backup   <target-dir> [retain-days]
 *   node dist/cli.js verify   <file.db>
 *   node dist/cli.js restore  <file.db>
 *
 * ## Why this exists instead of a shell script
 *
 * The obvious implementation calls the `sqlite3` CLI, which **is not in this image**
 * (the base is `node:22-bookworm-slim`, and installing it would add a package for one
 * maintenance command). `better-sqlite3` is already a dependency and exposes the same
 * SQLite build, so the backup lives here.
 *
 * ## Why not `cp`
 *
 * The database runs in WAL mode, so recent commits live in the `-wal` sidecar and are
 * NOT in the `.db` file. Copying the `.db` alone yields a stale snapshot — during
 * development that produced an investigation into a bug that did not exist, because
 * the copied file predated the data.
 *
 * `VACUUM INTO` writes a transactionally consistent copy that includes the WAL.
 *
 * A backup that has not been verified is not a backup, so `backup` verifies its own
 * output (integrity check + table count) before reporting success.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ConfigError, loadConfig } from './config.js';
import { acquireStorageLock } from './storage-lock.js';

/** Result of inspecting a candidate backup file. */
interface Verification {
  readonly ok: boolean;
  readonly integrity: string;
  readonly tables: number;
  readonly reason?: string;
}

/**
 * Opens `file` read-only and checks that it is a usable database.
 *
 * Read-only on purpose: verifying a backup must never modify it, and must never
 * create a missing file.
 */
export function verifyBackup(file: string): Verification {
  if (!existsSync(file)) {
    return { ok: false, integrity: 'missing', tables: 0, reason: 'file does not exist' };
  }
  if (statSync(file).size === 0) {
    return { ok: false, integrity: 'empty', tables: 0, reason: 'file is empty' };
  }

  let db: Database.Database | undefined;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const integrityRow = db.prepare('PRAGMA integrity_check').get() as
      { integrity_check: string } | undefined;
    const integrity = integrityRow?.integrity_check ?? 'unknown';

    const tablesRow = db
      .prepare(
        "SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .get() as { c: number };

    if (integrity !== 'ok') {
      return { ok: false, integrity, tables: tablesRow.c, reason: 'integrity_check failed' };
    }
    if (tablesRow.c === 0) {
      return { ok: false, integrity, tables: 0, reason: 'no application tables present' };
    }
    return { ok: true, integrity, tables: tablesRow.c };
  } catch (error) {
    return {
      ok: false,
      integrity: 'unreadable',
      tables: 0,
      reason: (error as Error).message,
    };
  } finally {
    db?.close();
  }
}

/**
 * `jizhang-YYYY-MM-DDTHH-MM-SS-mmm.db`.
 *
 * Built from `Date.now()` rather than `new Date()` so the value is mockable in tests
 * (`vi.spyOn(Date, 'now')`) — the collision guard below is otherwise untestable,
 * since two real backups never land in the same millisecond.
 *
 * `:` and `.` are replaced with `-` so the name is safe on every filesystem and still
 * sorts chronologically as a plain string.
 */
function backupFileName(now = Date.now()): string {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-').replace('Z', '');
  return `jizhang-${stamp}.db`;
}

export interface BackupResult {
  readonly file: string;
  readonly bytes: number;
  readonly tables: number;
  readonly pruned: number;
}

/**
 * Snapshots the live database into `targetDir`.
 *
 * @param retainDays delete archives older than this; 0 disables pruning.
 */
export function createBackup(dbFile: string, targetDir: string, retainDays = 30): BackupResult {
  mkdirSync(targetDir, { recursive: true });

  const target = path.join(targetDir, backupFileName());
  if (existsSync(target)) {
    // Only possible if two backups land in the same second; refusing is safer than
    // overwriting a good archive.
    throw new Error(`Refusing to overwrite an existing backup: ${target}`);
  }

  const db = new Database(dbFile, { fileMustExist: true });
  try {
    // Escape single quotes: `VACUUM INTO` takes a string literal.
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }

  const verification = verifyBackup(target);
  if (!verification.ok) {
    // Do not leave a broken archive behind to be mistaken for a good one later.
    try {
      unlinkSync(target);
    } catch {
      // Best effort.
    }
    throw new Error(
      `Backup verification failed (${verification.reason ?? verification.integrity}); ` +
        'the archive was removed so it cannot be mistaken for a valid one.',
    );
  }

  let pruned = 0;
  if (retainDays > 0) {
    const cutoff = Date.now() - retainDays * 86_400_000;
    for (const name of readdirSync(targetDir)) {
      if (!name.startsWith('jizhang-') || !name.endsWith('.db')) continue;
      const full = path.join(targetDir, name);
      if (full === target) continue;
      try {
        if (statSync(full).mtimeMs < cutoff) {
          unlinkSync(full);
          pruned += 1;
        }
      } catch {
        // A file we cannot stat or remove is not worth failing the backup over.
      }
    }
  }

  return {
    file: target,
    bytes: statSync(target).size,
    tables: verification.tables,
    pruned,
  };
}

/**
 * Replaces the live database with `file`.
 *
 * The WAL sidecars are removed deliberately: they describe the *previous* database,
 * and leaving them next to a restored file is how a restore silently produces a
 * mixture of two databases.
 *
 * Caller must have stopped the server first.
 */
export function restoreBackup(file: string, dbFile: string): void {
  const verification = verifyBackup(file);
  if (!verification.ok) {
    throw new Error(
      `Refusing to restore ${file}: ${verification.reason ?? verification.integrity}`,
    );
  }

  // Keep the current database aside: a restore is exactly when a rollback matters.
  if (existsSync(dbFile)) {
    const safety = `${dbFile}.before-restore-${Date.now()}`;
    copyFileSync(dbFile, safety);
    process.stdout.write(`[jizhang] Current database copied to ${safety}\n`);
  }

  copyFileSync(file, dbFile);
  for (const sidecar of [`${dbFile}-wal`, `${dbFile}-shm`]) {
    if (existsSync(sidecar)) {
      unlinkSync(sidecar);
      process.stdout.write(`[jizhang] Removed stale sidecar ${sidecar}\n`);
    }
  }
}

const USAGE = `Usage: node dist/cli.js <command> [args]

Commands:
  set-password                  Create or rotate the single login account.
  backup <dir> [retain-days]    Snapshot the database into <dir> (default retain 30).
  verify <file.db>              Check that a backup file is a usable database.
  restore <file.db>             Replace the live database with a backup.
                                Stop the server first.

Environment: reads the same variables as the server (see .env.example).`;

function resolveDatabasePath(): { dbFile: string; dataDir: string; port: number } {
  try {
    const config = loadConfig();
    return { dbFile: config.dbFile, dataDir: config.dataDir, port: config.port };
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`\n[jizhang] Configuration error\n\n${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

function runBackup(args: string[]): void {
  const targetDir = args[0];
  if (targetDir === undefined) {
    console.error('[jizhang] backup needs a target directory.\n');
    console.log(USAGE);
    process.exitCode = 1;
    return;
  }

  const retainDays = args[1] === undefined ? 30 : Number(args[1]);
  if (!Number.isFinite(retainDays) || retainDays < 0) {
    console.error('[jizhang] retain-days must be a non-negative number.\n');
    process.exitCode = 1;
    return;
  }

  const { dbFile, dataDir } = resolveDatabasePath();
  const releaseStorage = acquireStorageLock(dataDir);
  try {
    if (existsSync(path.join(dataDir, 'auth.db'))) {
      throw new Error(
        'This is a multi-user deployment. Stop all writers and use backup-all <dir> for a complete recovery bundle. Personal snapshots are available through each account’s /backups API.',
      );
    }
    if (!existsSync(dbFile)) {
      console.error(`[jizhang] No database at ${dbFile} — nothing to back up.\n`);
      process.exitCode = 1;
      return;
    }

    const result = createBackup(dbFile, path.resolve(targetDir), retainDays);
    console.log(
      `[jizhang] Backup ok: ${result.file}\n` +
        `          ${result.tables} tables, ${(result.bytes / 1024).toFixed(1)} KiB` +
        (result.pruned > 0 ? `, pruned ${result.pruned} old archive(s)` : ''),
    );
  } finally {
    releaseStorage();
  }
}

function runVerify(args: string[]): void {
  const file = args[0];
  if (file === undefined) {
    console.error('[jizhang] verify needs a file.\n');
    process.exitCode = 1;
    return;
  }

  const result = verifyBackup(path.resolve(file));
  if (result.ok) {
    console.log(`[jizhang] ${file} is a valid database (${result.tables} tables).`);
    return;
  }
  console.error(`[jizhang] ${file} is NOT a usable database: ${result.reason ?? result.integrity}`);
  process.exitCode = 1;
}

/**
 * Refuses to restore while the server is answering requests.
 *
 * Checks the HTTP health endpoint rather than trying to take a SQLite write lock: in
 * WAL mode a write lock can be acquired while the server is running (readers and one
 * writer coexist), so a lock probe would happily proceed and then have the running
 * process hold an open handle to a file that was just replaced underneath it.
 */
async function serverIsRunning(port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}

async function runRestore(args: string[]): Promise<void> {
  const file = args[0];
  if (file === undefined) {
    console.error('[jizhang] restore needs a file.\n');
    process.exitCode = 1;
    return;
  }

  const { dbFile, dataDir, port } = resolveDatabasePath();
  const releaseStorage = acquireStorageLock(dataDir);
  try {
    if (existsSync(path.join(dataDir, 'auth.db'))) {
      throw new Error(
        'Single-file restore cannot restore a multi-user deployment. Use restore-all <bundle> <new-empty-dir>; the current data directory is preserved.',
      );
    }

    if (await serverIsRunning(port)) {
      console.error(
        '[jizhang] The server is still answering on port ' +
          `${port} — stop it first, or the restore will pull the database out from ` +
          'under a running process.\n' +
          '          With Docker:  docker compose stop\n' +
          '          Then re-run this command (docker compose run --rm jizhang node packages/server/dist/cli.js restore ...).',
      );
      process.exitCode = 1;
      return;
    }

    restoreBackup(path.resolve(file), dbFile);
    console.log(`[jizhang] Restored ${file} -> ${dbFile}`);
    console.log('[jizhang] Start the server again and check /api/v1/health.');
  } finally {
    releaseStorage();
  }
}

export async function runDatabaseCommand(command: string, args: string[]): Promise<boolean> {
  switch (command) {
    case 'backup':
      runBackup(args);
      return true;
    case 'verify':
      runVerify(args);
      return true;
    case 'restore':
      await runRestore(args);
      return true;
    default:
      return false;
  }
}

export { USAGE as DATABASE_USAGE };
