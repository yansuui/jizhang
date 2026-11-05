import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config.js';
import { closeDatabase, initializeDatabase, openDatabase, type Db } from '../db/index.js';
import { AuthService, type UserRow } from '../services/auth-service.js';
import {
  generateSessionToken,
  hashPassword,
  hashSessionToken,
  MS_PER_DAY,
} from '../services/password.js';
import { IdentityError, invalidInvitation } from './errors.js';
import { initializeIdentitySchema } from './schema.js';

export interface LedgerBinding {
  readonly userId: string;
  readonly dbFile: string;
  readonly dataDir: string;
}

export interface Invitation {
  readonly id: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly status: 'active' | 'used' | 'expired' | 'revoked';
  readonly usedAt: number | null;
}

interface InvitationRow {
  id: string;
  code_hash: string;
  created_by: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  used_at: number | null;
}

export interface IdentityStoreOptions {
  readonly config: AppConfig;
  /** Initialized original ledger; its lifecycle belongs to the caller. */
  readonly legacyDb: Db;
  readonly now?: () => number;
  /** Deterministic fault injection at durable boundaries; never supplied by production. */
  readonly provisionCheckpoint?: (phase: 'reserved' | 'initialized' | 'committed') => void;
}

const MEMBER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const USERNAME = /^[a-zA-Z0-9_.-]{3,64}$/;
export const IDENTITY_DB_FILENAME = 'auth.db';

/** Separate authoritative identity database and immutable ledger bindings. */
export class IdentityStore {
  readonly db: Db;
  readonly authService: AuthService;
  readonly dbFile: string;
  private readonly config: AppConfig;
  private readonly now: () => number;
  private readonly checkpoint: IdentityStoreOptions['provisionCheckpoint'];

  constructor(options: IdentityStoreOptions) {
    this.config = options.config;
    this.now = options.now ?? Date.now;
    this.checkpoint = options.provisionCheckpoint;
    this.dbFile = path.join(this.config.dataDir, IDENTITY_DB_FILENAME);
    this.db = openDatabase({ ...this.config, dbFile: this.dbFile });
    try {
      // Identity activation/consumption is the durable authority across ledger files.
      this.db.pragma('synchronous = FULL');
      initializeIdentitySchema(this.db);
      this.authService = new AuthService(this.db, {
        sessionTtlDays: this.config.sessionTtlDays,
        now: this.now,
        centralIdentity: true,
      });
      this.migrateOwner(options.legacyDb);
      this.recoverProvisions();
    } catch (error) {
      closeDatabase(this.db);
      throw error;
    }
  }

  private metadata(key: string): string | undefined {
    return (
      this.db.prepare('SELECT value FROM identity_metadata WHERE key = ?').get(key) as
        { value: string } | undefined
    )?.value;
  }

  private migrateOwner(legacyDb: Db): void {
    const legacyUsers = legacyDb.prepare('SELECT * FROM users').all() as UserRow[];
    if (this.metadata('legacy_import_complete') === undefined) {
      if (this.authService.hasUser())
        throw new Error('Identity migration is incomplete; refusing to infer ledger ownership.');
      if (
        legacyUsers.length > 1 ||
        (legacyUsers[0] !== undefined && legacyUsers[0].username !== this.config.username)
      ) {
        throw new Error(
          'Legacy ledger ownership is ambiguous. Set JIZHANG_USERNAME to its sole existing account before upgrading.',
        );
      }
      const owner = legacyUsers[0];
      let snapshot: string | undefined;
      if (owner !== undefined) {
        const backupDir = path.join(this.config.dataDir, '.identity-migration-backups');
        mkdirSync(backupDir, { recursive: true, mode: 0o700 });
        snapshot = path.join(backupDir, `legacy-${randomUUID()}.db`);
        legacyDb.prepare('VACUUM INTO ?').run(snapshot);
        const backup = openDatabase({ ...this.config, dbFile: snapshot });
        try {
          if (backup.pragma('quick_check', { simple: true }) !== 'ok')
            throw new Error('Legacy identity backup failed verification.');
          const saved = backup.prepare('SELECT id, password_hash FROM users').get() as
            UserRow | undefined;
          if (saved?.id !== owner.id || saved.password_hash !== owner.password_hash)
            throw new Error('Legacy identity backup does not match the owner.');
        } finally {
          closeDatabase(backup);
        }
      }
      this.db.transaction(() => {
        if (owner !== undefined) {
          this.db
            .prepare(
              "INSERT INTO users(id, username, password_hash, role, status, created_at, updated_at) VALUES (?, ?, ?, 'admin', 'active', ?, ?)",
            )
            .run(owner.id, owner.username, owner.password_hash, owner.created_at, owner.updated_at);
          this.db
            .prepare(
              "INSERT INTO ledger_bindings(user_id, storage_key, created_at) VALUES (?, 'owner', ?)",
            )
            .run(owner.id, this.now());
          this.db
            .prepare("INSERT INTO identity_metadata(key, value) VALUES ('original_owner_id', ?)")
            .run(owner.id);
        }
        if (snapshot !== undefined)
          this.db
            .prepare("INSERT INTO identity_metadata(key, value) VALUES ('legacy_snapshot', ?)")
            .run(path.relative(this.config.dataDir, snapshot));
        this.db
          .prepare(
            "INSERT INTO identity_metadata(key, value) VALUES ('legacy_import_complete', '1')",
          )
          .run();
      })();
    }

    // A crash after central commit but before this cleanup is recoverable. Sessions
    // deliberately expire during the cutover, so stale legacy cookies cannot revive.
    const ownerId = this.metadata('original_owner_id');
    if (legacyUsers.some((user) => user.id !== ownerId)) {
      throw new Error(
        'Unexpected legacy credentials after identity cutover. Stop older server processes and repair the deployment.',
      );
    }
    if (ownerId !== undefined && this.getLedger(ownerId) === undefined)
      throw new Error('Original owner ledger binding is missing.');
    legacyDb.transaction(() => {
      legacyDb.prepare('DELETE FROM sessions').run();
      legacyDb.prepare('DELETE FROM users').run();
    })();
  }

  private memberDirectory(userId: string): string {
    if (!MEMBER_ID.test(userId)) throw new Error('Invalid internal ledger storage identifier.');
    const root = path.resolve(this.config.dataDir, 'users');
    const directory = path.resolve(root, userId);
    if (path.dirname(directory) !== root) throw new Error('Ledger path escaped its storage root.');
    return directory;
  }

  getLedger(userId: string): LedgerBinding | undefined {
    const row = this.db
      .prepare('SELECT storage_key FROM ledger_bindings WHERE user_id = ?')
      .get(userId) as { storage_key: string } | undefined;
    if (row === undefined) return undefined;
    if (row.storage_key === 'owner') {
      return { userId, dbFile: this.config.dbFile, dataDir: this.config.dataDir };
    }
    if (row.storage_key !== userId) throw new Error('Invalid ledger binding.');
    const dataDir = this.memberDirectory(row.storage_key);
    return { userId, dataDir, dbFile: path.join(dataDir, 'jizhang.db') };
  }

  listLedgers(): LedgerBinding[] {
    const rows = this.db.prepare('SELECT user_id FROM ledger_bindings ORDER BY user_id').all() as {
      user_id: string;
    }[];
    return rows.map((row) => {
      const binding = this.getLedger(row.user_id);
      if (binding === undefined) throw new Error('Ledger binding disappeared during enumeration.');
      return binding;
    });
  }

  /** Bootstrap is an operator-only action; public registration never chooses an administrator. */
  async bootstrapPassword(username: string, password: string): Promise<string> {
    const existing = this.authService.findUserByUsername(username);
    if (existing !== undefined) return this.authService.setPassword(username, password);
    if (this.authService.hasUser() || username !== this.config.username) {
      throw new Error(
        'Account does not exist. Only the configured initial administrator can be bootstrapped.',
      );
    }
    const passwordHash = await hashPassword(password);
    return this.db.transaction(() => {
      if (this.authService.hasUser()) throw new Error('Initial administrator was already created.');
      const userId = randomUUID();
      const now = this.now();
      this.db
        .prepare(
          "INSERT INTO users(id, username, password_hash, role, status, created_at, updated_at) VALUES (?, ?, ?, 'admin', 'active', ?, ?)",
        )
        .run(userId, username, passwordHash, now, now);
      this.db
        .prepare(
          "INSERT INTO ledger_bindings(user_id, storage_key, created_at) VALUES (?, 'owner', ?)",
        )
        .run(userId, now);
      this.db
        .prepare("INSERT INTO identity_metadata(key, value) VALUES ('original_owner_id', ?)")
        .run(userId);
      return userId;
    })();
  }

  requireAdministrator(userId: string): void {
    const user = this.authService.findUserById(userId);
    if (user?.role !== 'admin' || user.status !== 'active') {
      throw new IdentityError(403, 'FORBIDDEN', 'Administrator permission is required.');
    }
  }

  private invitationDto(row: InvitationRow): Invitation {
    return {
      id: row.id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      status:
        row.used_at !== null
          ? 'used'
          : row.revoked_at !== null
            ? 'revoked'
            : row.expires_at <= this.now()
              ? 'expired'
              : 'active',
      usedAt: row.used_at,
    };
  }

  listInvitations(userId: string): Invitation[] {
    this.requireAdministrator(userId);
    const rows = this.db
      .prepare(
        `SELECT * FROM invitations WHERE created_by = ? AND (
          (used_at IS NULL AND revoked_at IS NULL AND expires_at > ?) OR id IN (
            SELECT id FROM invitations WHERE created_by = ?
            ORDER BY created_at DESC, id DESC LIMIT 100
          )
        ) ORDER BY created_at DESC, id DESC LIMIT 200`,
      )
      .all(userId, this.now(), userId) as InvitationRow[];
    return rows.map((row) => this.invitationDto(row));
  }

  createInvitation(userId: string): { invitation: Invitation; code: string } {
    this.requireAdministrator(userId);
    const now = this.now();
    const pending = this.db
      .prepare(
        'SELECT COUNT(*) AS count FROM invitations WHERE created_by = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?',
      )
      .get(userId, now) as { count: number };
    if (pending.count >= 100)
      throw new IdentityError(
        429,
        'RATE_LIMITED',
        'Revoke an unused invitation before creating another.',
      );
    const { token: code, tokenHash } = generateSessionToken();
    const row: InvitationRow = {
      id: randomUUID(),
      code_hash: tokenHash,
      created_by: userId,
      created_at: now,
      expires_at: now + 7 * MS_PER_DAY,
      revoked_at: null,
      used_at: null,
    };
    this.db
      .prepare(
        'INSERT INTO invitations(id, code_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(row.id, tokenHash, userId, now, row.expires_at);
    return { invitation: this.invitationDto(row), code };
  }

  revokeInvitation(userId: string, id: string): void {
    this.requireAdministrator(userId);
    const row = this.db
      .prepare('SELECT * FROM invitations WHERE id = ? AND created_by = ?')
      .get(id, userId) as InvitationRow | undefined;
    if (row === undefined) throw new IdentityError(404, 'NOT_FOUND', 'Invitation was not found.');
    if (row.used_at !== null)
      throw new IdentityError(409, 'INVITATION_USED', 'This invitation has already been used.');
    this.db
      .prepare('UPDATE invitations SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?')
      .run(this.now(), id);
  }

  private activeInvitation(code: string): InvitationRow {
    const row = this.db
      .prepare('SELECT * FROM invitations WHERE code_hash = ?')
      .get(hashSessionToken(code)) as InvitationRow | undefined;
    if (
      row === undefined ||
      row.used_at !== null ||
      row.revoked_at !== null ||
      row.expires_at <= this.now()
    )
      throw invalidInvitation();
    const issuer = this.authService.findUserById(row.created_by);
    if (issuer?.role !== 'admin' || issuer.status !== 'active') throw invalidInvitation();
    return row;
  }

  /** Provision first; activate identity + consume invite in ONE central transaction. */
  async register(
    usernameInput: unknown,
    passwordInput: unknown,
    codeInput: unknown,
  ): Promise<UserRow> {
    if (typeof usernameInput !== 'string' || !USERNAME.test(usernameInput.trim())) {
      throw new IdentityError(
        400,
        'VALIDATION',
        'Username must contain 3–64 letters, digits, dots, underscores or hyphens.',
      );
    }
    if (typeof passwordInput !== 'string')
      throw new IdentityError(400, 'VALIDATION', 'Password is required.');
    if (
      typeof codeInput !== 'string' ||
      codeInput.length > 128 ||
      !/^[A-Za-z0-9_-]{43}$/.test(codeInput.trim())
    )
      throw invalidInvitation();
    const username = usernameInput.trim();
    const code = codeInput.trim();
    this.activeInvitation(code);
    if (this.authService.findUserByUsername(username) !== undefined)
      throw new IdentityError(409, 'USERNAME_TAKEN', 'Username is already in use.');
    const passwordHash = await hashPassword(passwordInput);
    // Recheck after the asynchronous, expensive operation before touching disk.
    this.activeInvitation(code);
    if (this.authService.findUserByUsername(username) !== undefined)
      throw new IdentityError(409, 'USERNAME_TAKEN', 'Username is already in use.');
    const userId = randomUUID();
    const directory = this.memberDirectory(userId);
    this.db
      .prepare('INSERT INTO ledger_provisions(user_id, created_at) VALUES (?, ?)')
      .run(userId, this.now());
    try {
      this.checkpoint?.('reserved');
      mkdirSync(path.dirname(directory), { recursive: true, mode: 0o700 });
      mkdirSync(directory, { mode: 0o700 });
      const ledger = openDatabase({
        ...this.config,
        dataDir: directory,
        dbFile: path.join(directory, 'jizhang.db'),
      });
      try {
        initializeDatabase(ledger, null);
        if (ledger.pragma('quick_check', { simple: true }) !== 'ok')
          throw new Error('New ledger failed verification.');
      } finally {
        closeDatabase(ledger);
      }
      this.checkpoint?.('initialized');
      this.db.transaction(() => {
        const invitation = this.activeInvitation(code);
        if (this.authService.findUserByUsername(username) !== undefined)
          throw new IdentityError(409, 'USERNAME_TAKEN', 'Username is already in use.');
        const now = this.now();
        this.db
          .prepare(
            "INSERT INTO users(id, username, password_hash, role, status, created_at, updated_at) VALUES (?, ?, ?, 'member', 'active', ?, ?)",
          )
          .run(userId, username, passwordHash, now, now);
        this.db
          .prepare('INSERT INTO ledger_bindings(user_id, storage_key, created_at) VALUES (?, ?, ?)')
          .run(userId, userId, now);
        const result = this.db
          .prepare(
            'UPDATE invitations SET used_at = ?, used_by = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?',
          )
          .run(now, userId, invitation.id, now);
        if (result.changes !== 1) throw invalidInvitation();
        this.db.prepare('DELETE FROM ledger_provisions WHERE user_id = ?').run(userId);
      })();
      this.checkpoint?.('committed');
    } catch (error) {
      this.cleanupProvision(userId);
      throw error;
    }
    const user = this.authService.findUserById(userId);
    if (user === undefined) throw new Error('Provisioned identity is missing.');
    return user;
  }

  private cleanupProvision(userId: string): void {
    // Never remove a directory after its central activation committed, even if
    // the response was interrupted. The new account can recover through login.
    if (this.getLedger(userId) !== undefined) return;
    const directory = this.memberDirectory(userId);
    if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
    this.db.prepare('DELETE FROM ledger_provisions WHERE user_id = ?').run(userId);
  }

  private recoverProvisions(): void {
    const pending = this.db.prepare('SELECT user_id FROM ledger_provisions').all() as {
      user_id: string;
    }[];
    for (const row of pending) this.cleanupProvision(row.user_id);
  }

  close(): void {
    closeDatabase(this.db);
  }
}

export function openIdentityStore(options: IdentityStoreOptions): IdentityStore {
  return new IdentityStore(options);
}
