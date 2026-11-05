import type { Db } from '../db/index.js';

export const IDENTITY_SCHEMA_VERSION = 1;

/** Identity schema has its own journal; never run ledger migrations against this file. */
const INITIAL_SCHEMA = `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
CREATE TABLE ledger_bindings (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  storage_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE identity_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  used_at INTEGER,
  used_by TEXT REFERENCES users(id)
);
CREATE INDEX idx_invitations_created ON invitations(created_at DESC);
CREATE TABLE ledger_provisions (user_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
CREATE TABLE cutout_job_owners (
  job_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);
`;

export function initializeIdentitySchema(db: Db): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS identity_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)',
  );
  const versions = db.prepare('SELECT version FROM identity_migrations ORDER BY version').all() as {
    version: number;
  }[];
  if (versions.some(({ version }) => version > IDENTITY_SCHEMA_VERSION)) {
    throw new Error(
      'Identity database was created by a newer server; restore the matching server version.',
    );
  }
  if (!versions.some(({ version }) => version === 1)) {
    db.transaction(() => {
      db.exec(INITIAL_SCHEMA);
      db.prepare('INSERT INTO identity_migrations(version, applied_at) VALUES (1, ?)').run(
        Date.now(),
      );
    })();
  }
}
