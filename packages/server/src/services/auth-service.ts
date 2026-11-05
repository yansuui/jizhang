/**
 * Authentication service: identities, sessions, and per-user password changes.
 *
 * Contract (T3 PRD R1-R4):
 *   * public account creation belongs to the invitation/identity store;
 *   * a wrong username and a wrong password are indistinguishable to the caller,
 *     so the API never reveals whether the account is configured (PRD AC3);
 *   * changing a password invalidates that user's sessions only;
 *   * expiry is driven by an injectable clock so tests never sleep.
 *
 * All functions take `Db` explicitly; none of them import Fastify.
 */
import type { Db } from '../db/index.js';
import {
  generateSessionToken,
  hashPassword,
  hashSessionToken,
  isExpired,
  newUserId,
  sessionExpiry,
  verifyPassword,
} from './password.js';

export interface UserRow {
  readonly id: string;
  readonly username: string;
  readonly password_hash: string;
  readonly created_at: number;
  readonly updated_at: number;
  /** Absent only in the legacy ledger schema used by isolated compatibility tests. */
  readonly role?: 'admin' | 'member';
  readonly status?: 'active' | 'disabled';
}

export interface SessionRow {
  readonly token_hash: string;
  readonly user_id: string;
  readonly created_at: number;
  readonly expires_at: number;
}

/** Why an authentication attempt failed, for logging only — never for the client. */
export type LoginFailureReason = 'no-user' | 'wrong-password' | 'malformed-hash';

export type LoginResult =
  | {
      readonly ok: true;
      readonly userId: string;
      readonly username: string;
      /** Send to the client as the cookie value. */
      readonly token: string;
      readonly expiresAtMs: number;
    }
  | { readonly ok: false; readonly reason: LoginFailureReason };

export interface AuthServiceOptions {
  /** Session lifetime in days (config `SESSION_TTL_DAYS`). */
  readonly sessionTtlDays: number;
  /** Injectable clock; defaults to `Date.now`. */
  readonly now?: () => number;
  /** Central users must be created with an explicit ledger binding by IdentityStore. */
  readonly centralIdentity?: boolean;
}

let dummyHash: Promise<string> | undefined;
async function verifyMissingUserPassword(password: string): Promise<void> {
  dummyHash ??= hashPassword(generateSessionToken().token);
  await verifyPassword(await dummyHash, password);
}

export class AuthService {
  private readonly db: Db;
  private readonly ttlDays: number;
  private readonly now: () => number;
  private readonly centralIdentity: boolean;

  constructor(db: Db, options: AuthServiceOptions) {
    this.db = db;
    this.ttlDays = options.sessionTtlDays;
    this.now = options.now ?? (() => Date.now());
    this.centralIdentity = options.centralIdentity ?? false;
  }

  /** An existing account, or `undefined` when the username is unknown. */
  findUserByUsername(username: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as
      UserRow | undefined;
  }

  findUserById(userId: string): UserRow | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow | undefined;
  }

  /** True once an account exists (i.e. the CLI has been run). */
  hasUser(): boolean {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM users').get() as {
      c: number;
    };
    return row.c > 0;
  }

  /**
   * Updates an account; legacy isolated databases also support initial creation.
   *
   * Always deletes existing sessions: rotating the password must not leave a
   * previously-issued cookie working (PRD AC7). Returns the user id.
   */
  async setPassword(username: string, plainPassword: string): Promise<string> {
    const passwordHash = await hashPassword(plainPassword);
    const nowMs = this.now();
    const existing = this.findUserByUsername(username);
    if (existing === undefined && this.centralIdentity) {
      throw new Error('Create the initial account with IdentityStore.bootstrapPassword.');
    }

    const run = this.db.transaction((): string => {
      let userId: string;
      if (existing === undefined) {
        userId = newUserId();
        this.db
          .prepare(
            `INSERT INTO users (id, username, password_hash, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(userId, username, passwordHash, nowMs, nowMs);
      } else {
        userId = existing.id;
        this.db
          .prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
          .run(passwordHash, nowMs, userId);
      }

      // Password rotation must leave unrelated users' sessions intact.
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
      return userId;
    });

    return run();
  }

  /**
   * Verifies credentials and, on success, opens a session.
   *
   * The caller must not branch on `reason` for the HTTP response — it exists so
   * the server log can distinguish an unconfigured account from a bad password.
   */
  async login(username: string, password: string): Promise<LoginResult> {
    const user = this.findUserByUsername(username);
    if (user === undefined || user.status === 'disabled') {
      // Perform comparable Argon2 work for missing/disabled identities as well.
      await verifyMissingUserPassword(password);
      return { ok: false, reason: 'no-user' };
    }

    const valid = await verifyPassword(user.password_hash, password);
    const currentUser = this.findUserById(user.id);
    if (
      !valid ||
      currentUser?.password_hash !== user.password_hash ||
      currentUser.status === 'disabled'
    ) {
      return { ok: false, reason: 'wrong-password' };
    }

    return this.createSession(user.id);
  }

  /** Internal trusted entry point after verified login or invitation registration. */
  createSession(userId: string): LoginResult {
    const user = this.findUserById(userId);
    if (user === undefined || user.status === 'disabled') return { ok: false, reason: 'no-user' };
    const { token, tokenHash } = generateSessionToken();
    const nowMs = this.now();
    const expiresAtMs = sessionExpiry(nowMs, this.ttlDays);

    this.db
      .prepare(
        `INSERT INTO sessions (token_hash, user_id, created_at, expires_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(tokenHash, user.id, nowMs, expiresAtMs);

    return { ok: true, userId: user.id, username: user.username, token, expiresAtMs };
  }

  /**
   * Resolves a cookie token to a live session, or `undefined`.
   *
   * Expired rows are deleted on the way out, so the table does not accumulate
   * dead sessions in a long-running container.
   */
  resolveSession(token: string): { userId: string; expiresAtMs: number } | undefined {
    if (typeof token !== 'string' || token === '') return undefined;

    const row = this.db
      .prepare('SELECT * FROM sessions WHERE token_hash = ?')
      .get(hashSessionToken(token)) as SessionRow | undefined;
    if (row === undefined) return undefined;
    const user = this.findUserById(row.user_id);
    if (user === undefined || user.status === 'disabled') return undefined;

    if (isExpired(row.expires_at, this.now())) {
      this.deleteSession(token);
      return undefined;
    }

    return { userId: row.user_id, expiresAtMs: row.expires_at };
  }

  /** Deletes one session (logout). No-op when the token is unknown. */
  deleteSession(token: string): void {
    if (typeof token !== 'string' || token === '') return;
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashSessionToken(token));
  }

  /**
   * Changes the password after verifying the current one.
   *
   * Returns `false` when the current password is wrong. On success every session
   * is removed, including the caller's — the route then clears the cookie, so the
   * user is asked to log in again (PRD AC7).
   */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<boolean> {
    const user = this.db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as
      UserRow | undefined;
    if (user === undefined || user.status === 'disabled') return false;

    const valid = await verifyPassword(user.password_hash, currentPassword);
    if (!valid) return false;

    const passwordHash = await hashPassword(newPassword);
    const nowMs = this.now();

    const run = this.db.transaction((): boolean => {
      const result = this.db
        .prepare(
          'UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ? AND password_hash = ?',
        )
        .run(passwordHash, nowMs, userId, user.password_hash);
      if (result.changes !== 1) return false;
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
      return true;
    });
    return run();
  }

  /** Housekeeping: drop every expired session. Returns how many were removed. */
  purgeExpiredSessions(): number {
    const info = this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(this.now());
    return info.changes;
  }

  /** Session count, used by tests and diagnostics. */
  countSessions(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as {
      c: number;
    };
    return row.c;
  }
}
