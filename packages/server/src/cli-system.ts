/** Offline, coordinated recovery bundles. Never replace an existing data directory. */
import { createHash, randomUUID } from 'node:crypto';
import {
  constants,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { verifyBackup } from './cli-db.js';
import { loadConfig } from './config.js';
import { MIGRATIONS } from './db/migrate.js';
import { IDENTITY_SCHEMA_VERSION } from './identity/schema.js';
import { acquireStorageLock, RESTORE_PENDING_FILE } from './storage-lock.js';

interface BundleFile {
  readonly path: string;
  readonly sha256: string;
}
export interface SystemBackupManifest {
  readonly format: 'jizhang-private-ledgers';
  readonly version: 1;
  readonly createdAt: number;
  readonly files: readonly BundleFile[];
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const LEDGER_PATH = new RegExp(`^users/${UUID}/jizhang\\.db$`);
const MANIFEST = 'manifest.json';

function allowedFile(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    (value === 'auth.db' || value === 'jizhang.db' || LEDGER_PATH.test(value))
  );
}

function checkedFile(root: string, relative: string): string {
  if (!allowedFile(relative)) throw new Error('Invalid recovery file path.');
  let current = path.resolve(root);
  if (lstatSync(current).isSymbolicLink())
    throw new Error('Recovery directories cannot be symlinks.');
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    if (lstatSync(current).isSymbolicLink()) throw new Error('Recovery files cannot be symlinks.');
  }
  if (!lstatSync(current).isFile()) throw new Error(`Not a regular database: ${relative}`);
  return current;
}

function digest(file: string): string {
  const hash = createHash('sha256');
  const handle = openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let count: number;
    while ((count = readSync(handle, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, count));
    }
    return hash.digest('hex');
  } finally {
    closeSync(handle);
  }
}

/** A manifest hashes a complete snapshot, not a live file plus untracked WAL state. */
function assertStandaloneSnapshot(file: string): void {
  for (const suffix of ['-wal', '-journal']) {
    const sidecar = `${file}${suffix}`;
    if (
      existsSync(sidecar) &&
      (lstatSync(sidecar).isSymbolicLink() || lstatSync(sidecar).size > 0)
    ) {
      throw new Error('Recovery snapshots must not have untracked SQLite WAL or journal data.');
    }
  }
}

/** Read the frozen identity snapshot, not an unrelated/live mapping. */
function requiredFiles(identityFile: string): string[] {
  const db = new Database(identityFile, { readonly: true, fileMustExist: true });
  try {
    const rows = db.prepare('SELECT user_id, storage_key FROM ledger_bindings').all() as {
      user_id: string;
      storage_key: string;
    }[];
    const users = db.prepare('SELECT id FROM users').all() as { id: string }[];
    if (
      users.length !== rows.length ||
      users.some((user) => !rows.some((row) => row.user_id === user.id))
    ) {
      throw new Error('Identity contains an account without a ledger binding.');
    }
    const files = ['auth.db'];
    for (const row of rows) {
      const relative =
        row.storage_key === 'owner' ? 'jizhang.db' : `users/${row.user_id}/jizhang.db`;
      if (
        (row.storage_key !== 'owner' && row.storage_key !== row.user_id) ||
        !allowedFile(relative)
      ) {
        throw new Error('Invalid identity ledger binding.');
      }
      files.push(relative);
    }
    // Preserve an initialized but not yet bootstrapped original ledger too.
    if (!files.includes('jizhang.db')) files.push('jizhang.db');
    if (new Set(files).size !== files.length) throw new Error('Duplicate identity ledger binding.');
    return files.sort();
  } finally {
    db.close();
  }
}

function verifyDatabase(file: string, identity: boolean): void {
  const check = verifyBackup(file);
  if (!check.ok) throw new Error(`Invalid backup database: ${check.reason ?? check.integrity}`);
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    for (const table of identity
      ? [
          'identity_migrations',
          'identity_metadata',
          'users',
          'sessions',
          'invitations',
          'ledger_bindings',
          'ledger_provisions',
          'cutout_job_owners',
        ]
      : ['schema_migrations', 'transactions', 'accounts']) {
      if (
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) ===
        undefined
      ) {
        throw new Error(`Backup lacks required table ${table}.`);
      }
    }
    if (identity) {
      const versions = db
        .prepare('SELECT version FROM identity_migrations ORDER BY version')
        .all() as { version: number }[];
      if (
        versions.length !== IDENTITY_SCHEMA_VERSION ||
        versions.some((row, index) => row.version !== index + 1)
      ) {
        throw new Error(
          'Recovery identity schema is incomplete or requires a different server version.',
        );
      }
      const completed = db
        .prepare("SELECT value FROM identity_metadata WHERE key = 'legacy_import_complete'")
        .get() as { value: string } | undefined;
      if (completed?.value !== '1') throw new Error('Recovery identity cutover is incomplete.');
      const owner = db
        .prepare("SELECT value FROM identity_metadata WHERE key = 'original_owner_id'")
        .get() as { value: string } | undefined;
      const ownerBinding = db
        .prepare("SELECT user_id FROM ledger_bindings WHERE storage_key = 'owner'")
        .get() as { user_id: string } | undefined;
      if (owner?.value !== ownerBinding?.user_id)
        throw new Error('Recovery original-owner identity and ledger binding disagree.');
      const userCount = (
        db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }
      ).count;
      if (userCount > 0 && owner === undefined)
        throw new Error('Recovery identity has accounts without an original owner.');
      if (owner !== undefined) {
        const ownerUser = db.prepare('SELECT role FROM users WHERE id = ?').get(owner.value) as
          { role: string } | undefined;
        if (ownerUser?.role !== 'admin')
          throw new Error('Recovery original owner is not an administrator.');
      }
    } else {
      const versions = db
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all() as { version: number }[];
      if (
        versions.length === 0 ||
        versions.some((row, index) => MIGRATIONS[index]?.version !== row.version)
      ) {
        throw new Error(
          'Recovery ledger schema is incomplete or requires a different server version.',
        );
      }
    }
    if ((db.pragma('foreign_key_check') as unknown[]).length !== 0) {
      throw new Error('Backup foreign key check failed.');
    }
  } finally {
    db.close();
  }
}

export function verifySystemBackup(bundleDir: string): SystemBackupManifest {
  const root = path.resolve(bundleDir);
  const manifestFile = path.join(root, MANIFEST);
  if (lstatSync(root).isSymbolicLink() || lstatSync(manifestFile).isSymbolicLink()) {
    throw new Error('Recovery manifest cannot be a symlink.');
  }
  if (lstatSync(manifestFile).size > 4 * 1024 * 1024)
    throw new Error('Recovery manifest is too large.');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as Partial<SystemBackupManifest>;
  if (
    manifest.format !== 'jizhang-private-ledgers' ||
    manifest.version !== 1 ||
    !Number.isSafeInteger(manifest.createdAt) ||
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0
  ) {
    throw new Error('Unsupported or incomplete recovery manifest.');
  }
  const seen = new Set<string>();
  for (const entry of manifest.files) {
    if (
      entry === null ||
      typeof entry !== 'object' ||
      !allowedFile(entry.path) ||
      typeof entry.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(entry.sha256) ||
      seen.has(entry.path)
    ) {
      throw new Error('Invalid or duplicate recovery manifest entry.');
    }
    seen.add(entry.path);
    const file = checkedFile(root, entry.path);
    assertStandaloneSnapshot(file);
    if (digest(file) !== entry.sha256) throw new Error(`Recovery checksum mismatch: ${entry.path}`);
    verifyDatabase(file, entry.path === 'auth.db');
  }
  if (!seen.has('auth.db')) throw new Error('Recovery bundle lacks central identity.');
  const required = requiredFiles(path.join(root, 'auth.db'));
  if (required.length !== seen.size || required.some((file) => !seen.has(file))) {
    throw new Error('Recovery bundle does not match its identity ledger bindings.');
  }
  return manifest as SystemBackupManifest;
}

export function createSystemBackup(dataDir: string, targetDir: string): string {
  const root = path.resolve(dataDir);
  const release = acquireStorageLock(root);
  try {
    const identity = checkedFile(root, 'auth.db');
    const bundle = path.resolve(targetDir, `jizhang-system-${Date.now()}-${randomUUID()}`);
    mkdirSync(bundle, { recursive: true, mode: 0o700 });
    const files: BundleFile[] = [];
    const snapshot = (relative: string): void => {
      const source = checkedFile(root, relative);
      const target = path.join(bundle, ...relative.split('/'));
      mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      const db = new Database(source, { fileMustExist: true });
      try {
        db.prepare('VACUUM INTO ?').run(target);
      } finally {
        db.close();
      }
      verifyDatabase(target, relative === 'auth.db');
      files.push({ path: relative, sha256: digest(target) });
    };
    verifyDatabase(identity, true);
    snapshot('auth.db');
    for (const relative of requiredFiles(path.join(bundle, 'auth.db'))) {
      if (relative !== 'auth.db') snapshot(relative);
    }
    const manifest: SystemBackupManifest = {
      format: 'jizhang-private-ledgers',
      version: 1,
      createdAt: Date.now(),
      files,
    };
    writeFileSync(path.join(bundle, MANIFEST), JSON.stringify(manifest, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    verifySystemBackup(bundle);
    return bundle;
  } finally {
    release();
  }
}

export function restoreSystemBackup(bundleDir: string, targetDir: string): void {
  const manifest = verifySystemBackup(bundleDir);
  const target = path.resolve(targetDir);
  if (
    existsSync(target) &&
    (lstatSync(target).isSymbolicLink() || readdirSync(target).length !== 0)
  ) {
    throw new Error(
      'Restore destination must be a new or empty directory; existing data is never overwritten.',
    );
  }
  const release = acquireStorageLock(target);
  const marker = path.join(target, RESTORE_PENDING_FILE);
  try {
    writeFileSync(marker, 'Incomplete restore; do not start the server.\n', {
      flag: 'wx',
      mode: 0o600,
    });
    for (const entry of manifest.files) {
      const source = checkedFile(bundleDir, entry.path);
      assertStandaloneSnapshot(source);
      if (digest(source) !== entry.sha256)
        throw new Error('Recovery source changed during restore.');
      const destination = path.join(target, ...entry.path.split('/'));
      mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      copyFileSync(source, destination, constants.COPYFILE_EXCL);
      if (digest(destination) !== entry.sha256) throw new Error('Restored checksum mismatch.');
      verifyDatabase(destination, entry.path === 'auth.db');
    }
    const identity = new Database(path.join(target, 'auth.db'), { fileMustExist: true });
    try {
      identity.exec('DELETE FROM sessions');
    } finally {
      identity.close();
    }
    unlinkSync(marker);
  } finally {
    release();
  }
}

export function runSystemCommand(command: string, args: string[]): boolean {
  if (!['backup-all', 'verify-all', 'restore-all'].includes(command)) return false;
  try {
    const source = args[0];
    if (source === undefined) throw new Error(`${command} needs a directory argument.`);
    if (command === 'backup-all') {
      const result = createSystemBackup(loadConfig().dataDir, source);
      console.log(`[jizhang] Complete recovery bundle: ${result}`);
      console.log(
        '[jizhang] Preserve the matching JIZHANG_AI_ENCRYPTION_KEY separately; it is not stored in the bundle.',
      );
    } else if (command === 'verify-all') {
      const manifest = verifySystemBackup(source);
      console.log(`[jizhang] Verified ${manifest.files.length} databases and identity bindings.`);
    } else {
      const target = args[1];
      if (target === undefined)
        throw new Error('restore-all needs a new/empty destination directory.');
      restoreSystemBackup(source, target);
      console.log(
        `[jizhang] Restored into ${path.resolve(target)}; sessions invalidated. Set DATA_DIR and preserve the matching JIZHANG_AI_ENCRYPTION_KEY before starting.`,
      );
    }
  } catch (error) {
    console.error(`[jizhang] ${(error as Error).message}`);
    process.exitCode = 1;
  }
  return true;
}
