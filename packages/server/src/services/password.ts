/**
 * Password hashing and session tokens.
 *
 * Contract (T3 PRD R1/R3):
 *   * Passwords are stored only as argon2id hashes; plaintext never reaches the
 *     database, a log line, or an error message.
 *   * A session token is 32 random bytes. The database stores only its SHA-256,
 *     so a database leak does not hand over usable sessions (design.md §3).
 *   * Session expiry is a pure function of a supplied clock, so tests do not sleep.
 *
 * Uses `@node-rs/argon2`: a prebuilt native binding with no install script, unlike
 * the `argon2` package which compiles through node-gyp or prebuild-install. That
 * matters here because pnpm 10 skips dependency build scripts unless they are
 * listed in `onlyBuiltDependencies` — one less native build to keep working in the
 * image (see `.trellis/spec/backend/quality-guidelines.md`).
 */
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

/**
 * Minimum password length. Single-user self-hosted app, so no character-class
 * rules — length is what actually helps, and arbitrary rules push people toward
 * worse passwords.
 */
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;

/**
 * Argon2 options.
 *
 * No `algorithm` is passed on purpose: `@node-rs/argon2` already defaults to
 * Argon2id, and its `Algorithm` member is an ambient `const enum` that TypeScript
 * refuses to read under `verbatimModuleSyntax` (the repo's setting). Relying on
 * the documented default avoids a cast and a magic number; the test suite asserts
 * the produced hash starts with `$argon2id$` so a default change cannot slip past.
 * Remaining parameters are the library's OWASP-aligned defaults.
 */
const ARGON_OPTIONS = {} as const;

export class PasswordPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasswordPolicyError';
  }
}

/** Throws `PasswordPolicyError` when the password is unusable. */
export function assertPasswordAcceptable(password: string): void {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new PasswordPolicyError(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`,
    );
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new PasswordPolicyError(
      `Password must be at most ${MAX_PASSWORD_LENGTH} characters long.`,
    );
  }
}

/**
 * Hashes a password for storage. Throws on a too-short password so a weak
 * credential cannot be persisted by accident.
 */
export async function hashPassword(password: string): Promise<string> {
  assertPasswordAcceptable(password);
  return argonHash(password, ARGON_OPTIONS);
}

/**
 * Verifies a password against a stored hash.
 *
 * Returns `false` (never throws) for a malformed stored hash: a corrupt row must
 * read as "wrong password", not crash the login route.
 */
export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  if (typeof storedHash !== 'string' || storedHash === '') return false;
  if (typeof password !== 'string' || password === '') return false;
  try {
    return await argonVerify(storedHash, password);
  } catch {
    return false;
  }
}

/** A freshly generated session token (the value that goes into the cookie). */
export interface GeneratedToken {
  /** Sent to the client. Never stored. */
  readonly token: string;
  /** Stored in `sessions.token_hash`. */
  readonly tokenHash: string;
}

/** 32 bytes of CSPRNG output, base64url-encoded (43 characters). */
export function generateSessionToken(): GeneratedToken {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashSessionToken(token) };
}

/** SHA-256 hex digest of a session token. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Constant-time comparison of two hex digests.
 *
 * Not on the normal lookup path — that is a primary-key hit on `token_hash` — but
 * kept for callers that already hold both digests and must not leak timing.
 */
export function digestsEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Milliseconds in a day, for TTL arithmetic. */
export const MS_PER_DAY = 86_400_000;

/** Absolute expiry for a session created at `nowMs` with `ttlDays`. */
export function sessionExpiry(nowMs: number, ttlDays: number): number {
  return nowMs + ttlDays * MS_PER_DAY;
}

/** Whether a session is expired at `nowMs`. */
export function isExpired(expiresAtMs: number, nowMs: number): boolean {
  return expiresAtMs <= nowMs;
}

/** Random id for a user row (UUID v4 via the platform CSPRNG). */
export function newUserId(): string {
  return randomUUID();
}
