import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSystemBackup, restoreSystemBackup, verifySystemBackup } from '../src/cli-system.js';
import { runDatabaseCommand } from '../src/cli-db.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { closeDatabase, initializeDatabase, openDatabase } from '../src/db/index.js';
import { openIdentityStore } from '../src/identity/store.js';
import {
  acquireStorageLock,
  RESTORE_PENDING_FILE,
  STORAGE_LOCK_FILE,
} from '../src/storage-lock.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, copyFileSync: vi.fn(actual.copyFileSync) };
});

let root: string;
let config: AppConfig;
const password = 'correct horse battery staple';

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'jizhang-system-'));
  config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    JIZHANG_USERNAME: 'owner',
    JIZHANG_PASSWORD_HASH: 'unused',
    DATA_DIR: path.join(root, 'data'),
  });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function provision(): Promise<{ ownerId: string; memberId: string; memberToken: string }> {
  const db = openDatabase(config);
  initializeDatabase(db, null);
  const identity = openIdentityStore({ config, legacyDb: db });
  try {
    const ownerId = await identity.bootstrapPassword('owner', password);
    const invitation = identity.createInvitation(ownerId);
    const member = await identity.register('member', password, invitation.code);
    const login = await identity.authService.login('member', password);
    if (!login.ok) throw new Error('Fixture login failed.');
    db.prepare(
      "UPDATE accounts SET name = 'Original owner account' WHERE id = (SELECT id FROM accounts LIMIT 1)",
    ).run();
    const memberLedger = new Database(identity.getLedger(member.id)!.dbFile);
    try {
      memberLedger
        .prepare(
          "UPDATE accounts SET name = 'Private member account' WHERE id = (SELECT id FROM accounts LIMIT 1)",
        )
        .run();
    } finally {
      memberLedger.close();
    }
    return { ownerId, memberId: member.id, memberToken: login.token };
  } finally {
    identity.close();
    closeDatabase(db);
  }
}

function refreshDigest(bundle: string, relative: string): void {
  const file = path.join(bundle, 'manifest.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8')) as {
    files: { path: string; sha256: string }[];
  };
  manifest.files.find((entry) => entry.path === relative)!.sha256 = createHash('sha256')
    .update(readFileSync(path.join(bundle, relative)))
    .digest('hex');
  writeFileSync(file, JSON.stringify(manifest));
}

describe('coordinated multi-user recovery', () => {
  it('restores every mapped ledger and credential at a new location, invalidating sessions', async () => {
    const { ownerId, memberId, memberToken } = await provision();
    const bundle = createSystemBackup(config.dataDir, path.join(root, 'archives'));
    expect(verifySystemBackup(bundle).files).toHaveLength(3);
    const destination = path.join(root, 'recovered');
    restoreSystemBackup(bundle, destination);
    const restored = {
      ...config,
      dataDir: destination,
      dbFile: path.join(destination, 'jizhang.db'),
    };
    const db = openDatabase(restored);
    const identity = openIdentityStore({ config: restored, legacyDb: db });
    try {
      expect(identity.authService.findUserByUsername('owner')?.id).toBe(ownerId);
      expect(identity.authService.findUserByUsername('member')?.id).toBe(memberId);
      expect(identity.authService.resolveSession(memberToken)).toBeUndefined();
      expect((await identity.authService.login('member', password)).ok).toBe(true);
      expect(
        db.prepare("SELECT 1 FROM accounts WHERE name = 'Original owner account'").get(),
      ).toBeDefined();
      const memberDb = new Database(identity.getLedger(memberId)!.dbFile, { readonly: true });
      try {
        expect(
          memberDb.prepare("SELECT 1 FROM accounts WHERE name = 'Private member account'").get(),
        ).toBeDefined();
        expect(
          memberDb.prepare("SELECT 1 FROM accounts WHERE name = 'Original owner account'").get(),
        ).toBeUndefined();
      } finally {
        memberDb.close();
      }
    } finally {
      identity.close();
      closeDatabase(db);
    }
    expect(existsSync(path.join(destination, RESTORE_PENDING_FILE))).toBe(false);
    expect(verifySystemBackup(bundle).files).toHaveLength(3);
  });

  it('refuses snapshots while a cooperating server or writer holds storage', async () => {
    await provision();
    const release = acquireStorageLock(config.dataDir);
    try {
      expect(() => createSystemBackup(config.dataDir, path.join(root, 'archives'))).toThrow(
        /locked/,
      );
    } finally {
      release();
    }
  });

  it('detects a missing ledger and corruption before touching a restore destination', async () => {
    await provision();
    const bundle = createSystemBackup(config.dataDir, path.join(root, 'archives'));
    const ledger = verifySystemBackup(bundle).files.find((entry) =>
      entry.path.startsWith('users/'),
    )!;
    writeFileSync(path.join(bundle, ledger.path), 'corruption');
    const destination = path.join(root, 'restore');
    expect(() => restoreSystemBackup(bundle, destination)).toThrow(/checksum/);
    expect(existsSync(destination)).toBe(false);
    const manifest = JSON.parse(readFileSync(path.join(bundle, 'manifest.json'), 'utf8')) as {
      files: { path: string }[];
    };
    manifest.files = manifest.files.filter((entry) => entry.path !== ledger.path);
    writeFileSync(path.join(bundle, 'manifest.json'), JSON.stringify(manifest));
    expect(() => verifySystemBackup(bundle)).toThrow(/bindings/);
  });

  it('rejects path traversal and never overwrites an existing data directory', async () => {
    await provision();
    const bundle = createSystemBackup(config.dataDir, path.join(root, 'archives'));
    const original = readFileSync(config.dbFile);
    expect(() => restoreSystemBackup(bundle, config.dataDir)).toThrow(/empty directory/);
    expect(readFileSync(config.dbFile).equals(original)).toBe(true);
    const manifest = JSON.parse(readFileSync(path.join(bundle, 'manifest.json'), 'utf8')) as {
      files: { path: string }[];
    };
    manifest.files[0]!.path = '../auth.db';
    writeFileSync(path.join(bundle, 'manifest.json'), JSON.stringify(manifest));
    expect(() => verifySystemBackup(bundle)).toThrow(/manifest entry/);
  });

  it.each(['newer-schema', 'missing-table', 'missing-owner-marker'] as const)(
    'rejects %s identity snapshots before restore starts',
    async (failure) => {
      await provision();
      const bundle = createSystemBackup(config.dataDir, path.join(root, 'archives'));
      const db = new Database(path.join(bundle, 'auth.db'));
      try {
        if (failure === 'newer-schema')
          db.exec('INSERT INTO identity_migrations(version, applied_at) VALUES (2, 1)');
        if (failure === 'missing-table') db.exec('DROP TABLE ledger_provisions');
        if (failure === 'missing-owner-marker')
          db.exec("DELETE FROM identity_metadata WHERE key = 'original_owner_id'");
      } finally {
        db.close();
      }
      refreshDigest(bundle, 'auth.db');
      const destination = path.join(root, 'restore');
      expect(() => restoreSystemBackup(bundle, destination)).toThrow(/schema|table|owner/i);
      expect(existsSync(destination)).toBe(false);
    },
  );

  it('rejects an untracked WAL beside a hashed recovery snapshot', async () => {
    await provision();
    const bundle = createSystemBackup(config.dataDir, path.join(root, 'archives'));
    writeFileSync(path.join(bundle, 'auth.db-wal'), 'untracked changes');
    expect(() => verifySystemBackup(bundle)).toThrow(/WAL|journal/i);
  });

  it('retains a blocking marker after a copy interruption, without altering the original data', async () => {
    await provision();
    const bundle = createSystemBackup(config.dataDir, path.join(root, 'archives'));
    const original = readFileSync(config.dbFile);
    const destination = path.join(root, 'failed-restore');
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    vi.mocked(copyFileSync)
      .mockImplementationOnce(actual.copyFileSync)
      .mockImplementationOnce(() => {
        throw new Error('Simulated disk interruption');
      });
    try {
      expect(() => restoreSystemBackup(bundle, destination)).toThrow(/interruption/);
    } finally {
      vi.mocked(copyFileSync).mockReset();
    }
    expect(existsSync(path.join(destination, 'auth.db'))).toBe(true);
    expect(existsSync(path.join(destination, RESTORE_PENDING_FILE))).toBe(true);
    expect(existsSync(path.join(destination, STORAGE_LOCK_FILE))).toBe(false);
    expect(() => acquireStorageLock(destination)).toThrow(/incomplete restore/);
    expect(readFileSync(config.dbFile).equals(original)).toBe(true);
    expect(verifySystemBackup(bundle).files).toHaveLength(3);
  });
});

describe('storage ownership', () => {
  it('locks legacy CLI commands before detecting multi-user storage and always releases on rejection', async () => {
    await provision();
    vi.stubEnv('DATA_DIR', config.dataDir);
    vi.stubEnv('JIZHANG_USERNAME', 'owner');
    vi.stubEnv('JIZHANG_PASSWORD_HASH', 'unused');
    vi.stubEnv('NODE_ENV', 'test');
    const release = acquireStorageLock(config.dataDir);
    try {
      await expect(runDatabaseCommand('backup', [path.join(root, 'archives')])).rejects.toThrow(
        /locked/,
      );
      await expect(runDatabaseCommand('restore', [path.join(root, 'unused.db')])).rejects.toThrow(
        /locked/,
      );
      release();
      await expect(runDatabaseCommand('backup', [path.join(root, 'archives')])).rejects.toThrow(
        /multi-user/,
      );
      await expect(runDatabaseCommand('restore', [path.join(root, 'unused.db')])).rejects.toThrow(
        /multi-user/,
      );
      expect(existsSync(path.join(config.dataDir, STORAGE_LOCK_FILE))).toBe(false);
    } finally {
      release();
      vi.unstubAllEnvs();
    }
  });

  it('is exclusive, releases idempotently, and does not delete a replacement lock', () => {
    const release = acquireStorageLock(config.dataDir);
    expect(() => acquireStorageLock(config.dataDir)).toThrow(/locked/);
    writeFileSync(
      path.join(config.dataDir, STORAGE_LOCK_FILE),
      JSON.stringify({ token: 'replacement' }),
    );
    expect(release).toThrow(/ownership changed/);
    expect(existsSync(path.join(config.dataDir, STORAGE_LOCK_FILE))).toBe(true);
    rmSync(path.join(config.dataDir, STORAGE_LOCK_FILE));
    const next = acquireStorageLock(config.dataDir);
    next();
    next();
  });

  it('blocks startup after an interrupted restore', () => {
    const release = acquireStorageLock(config.dataDir);
    release();
    writeFileSync(path.join(config.dataDir, RESTORE_PENDING_FILE), 'pending');
    expect(() => acquireStorageLock(config.dataDir)).toThrow(/incomplete restore/);
  });
});
