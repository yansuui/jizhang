import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { closeDatabase, initializeDatabase, openDatabase, type Db } from '../src/db/index.js';
import {
  openIdentityStore,
  type IdentityStore,
  type IdentityStoreOptions,
} from '../src/identity/store.js';
import { AuthRequestLimiter } from '../src/identity/request-limiter.js';
import { AuthService } from '../src/services/auth-service.js';
import { hashSessionToken, MS_PER_DAY } from '../src/services/password.js';
import { SESSION_COOKIE } from '../src/plugins/auth.js';

const PASSWORD = 'private-account-password';
const CSRF = { 'x-requested-with': 'fetch' };
let directory: string;
let config: AppConfig;
let legacy: Db;
let identity: IdentityStore | undefined;
let app: FastifyInstance | undefined;
let ownerId: string;
let clock: number;

beforeEach(async () => {
  directory = mkdtempSync(path.join(os.tmpdir(), 'jizhang-identity-'));
  config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATA_DIR: directory,
    JIZHANG_USERNAME: 'owner',
    JIZHANG_PASSWORD_HASH: 'unused',
  });
  legacy = openDatabase(config);
  initializeDatabase(legacy, null);
  ownerId = await new AuthService(legacy, { sessionTtlDays: 30 }).setPassword('owner', PASSWORD);
  clock = 1_800_000_000_000;
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  identity?.close();
  identity = undefined;
  closeDatabase(legacy);
  rmSync(directory, { recursive: true, force: true });
});

function open(extra: Partial<IdentityStoreOptions> = {}): IdentityStore {
  identity = openIdentityStore({ config, legacyDb: legacy, now: () => clock, ...extra });
  return identity;
}

async function http(): Promise<{
  store: IdentityStore;
  app: FastifyInstance;
  ownerCookie: string;
}> {
  const store = open();
  app = buildApp({ config, db: legacy, identityStore: store, secureCookies: false });
  await app.ready();
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: CSRF,
    payload: { username: 'owner', password: PASSWORD },
  });
  expect(login.statusCode).toBe(200);
  const ownerCookie = login.cookies.find((cookie) => cookie.name === SESSION_COOKIE)?.value;
  if (ownerCookie === undefined) throw new Error('Missing owner cookie');
  return { store, app, ownerCookie };
}

describe('identity cutover', () => {
  it('preserves owner identity and ledger rows, expires legacy sessions, and never reimports stale credentials', async () => {
    legacy
      .prepare(
        "UPDATE categories SET name = 'Owner custom category' WHERE id = (SELECT id FROM categories LIMIT 1)",
      )
      .run();
    const categories = legacy.prepare('SELECT * FROM categories ORDER BY id').all();
    const oldLogin = await new AuthService(legacy, { sessionTtlDays: 30 }).login('owner', PASSWORD);
    expect(oldLogin.ok).toBe(true);
    let store = open();
    expect(store.authService.findUserById(ownerId)).toMatchObject({
      username: 'owner',
      role: 'admin',
    });
    expect(store.getLedger(ownerId)).toEqual({
      userId: ownerId,
      dbFile: config.dbFile,
      dataDir: config.dataDir,
    });
    expect(legacy.prepare('SELECT * FROM categories ORDER BY id').all()).toEqual(categories);
    expect(legacy.prepare('SELECT * FROM users').all()).toEqual([]);
    expect(legacy.prepare('SELECT * FROM sessions').all()).toEqual([]);
    if (oldLogin.ok) expect(store.authService.resolveSession(oldLogin.token)).toBeUndefined();
    const metadata = store.db
      .prepare("SELECT value FROM identity_metadata WHERE key = 'legacy_snapshot'")
      .get() as { value: string };
    expect(existsSync(path.join(directory, metadata.value))).toBe(true);
    await store.authService.setPassword('owner', 'changed-owner-password');
    store.close();
    store = open();
    store.close();
    store = open();
    expect((await store.authService.login('owner', PASSWORD)).ok).toBe(false);
    expect((await store.authService.login('owner', 'changed-owner-password')).ok).toBe(true);
    expect(legacy.prepare('SELECT * FROM categories ORDER BY id').all()).toEqual(categories);
  });

  it('rejects ambiguous legacy ownership before changing credentials', async () => {
    await new AuthService(legacy, { sessionTtlDays: 30 }).setPassword('unexpected', PASSWORD);
    expect(() => open()).toThrow(/ambiguous/i);
    expect(legacy.prepare('SELECT id FROM users').all()).toHaveLength(2);
  });

  it('bootstraps only the configured initial administrator; later username changes do not rebind the ledger', async () => {
    legacy.prepare('DELETE FROM users').run();
    const store = open();
    await expect(store.bootstrapPassword('other', PASSWORD)).rejects.toThrow(/configured/i);
    const id = await store.bootstrapPassword('owner', PASSWORD);
    expect(store.authService.findUserById(id)?.role).toBe('admin');
    store.close();
    const reopened = open({ config: { ...config, username: 'changed-environment-name' } });
    expect(reopened.getLedger(id)?.dbFile).toBe(config.dbFile);
    await expect(reopened.bootstrapPassword('changed-environment-name', PASSWORD)).rejects.toThrow(
      /does not exist/i,
    );
  });

  it('recovers unreachable provisional directories and never removes an activated account', async () => {
    let store = open();
    const pending = randomUUID();
    const pendingDir = path.join(directory, 'users', pending);
    mkdirSync(pendingDir, { recursive: true });
    store.db
      .prepare('INSERT INTO ledger_provisions(user_id, created_at) VALUES (?, ?)')
      .run(pending, clock);
    const invited = await store.register('member', PASSWORD, store.createInvitation(ownerId).code);
    const activatedDir = store.getLedger(invited.id)?.dataDir;
    store.close();
    store = open();
    expect(existsSync(pendingDir)).toBe(false);
    expect(existsSync(activatedDir!)).toBe(true);
    expect(store.db.prepare('SELECT * FROM ledger_provisions').all()).toEqual([]);
  });
});

describe('invitation transactions', () => {
  it('keeps every outstanding invitation revocable when recent history fills the list', () => {
    const store = open();
    const outstanding = store.createInvitation(ownerId);
    const insert = store.db.prepare(
      'INSERT INTO invitations(id, code_hash, created_by, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    store.db.transaction(() => {
      for (let index = 1; index <= 110; index += 1) {
        insert.run(
          randomUUID(),
          hashSessionToken(`history-${index}`),
          ownerId,
          clock + index,
          clock + MS_PER_DAY,
          clock + index,
        );
      }
    })();
    const listed = store.listInvitations(ownerId);
    expect(listed.length).toBeLessThanOrEqual(200);
    expect(listed.find((entry) => entry.id === outstanding.invitation.id)?.status).toBe('active');
    store.revokeInvitation(ownerId, outstanding.invitation.id);
    expect(store.listInvitations(ownerId).some((entry) => entry.status === 'active')).toBe(false);
  });

  it('consumes a code exactly once under concurrent redemptions and starts an empty private ledger', async () => {
    const store = open();
    const invite = store.createInvitation(ownerId);
    const outcomes = await Promise.allSettled([
      store.register('alice', PASSWORD, invite.code),
      store.register('bob', PASSWORD, invite.code),
    ]);
    const winners = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    expect(winners).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    expect(store.listLedgers()).toHaveLength(2);
    expect(store.listInvitations(ownerId)[0]?.status).toBe('used');
    const winner = winners[0];
    if (winner?.status !== 'fulfilled') throw new Error('No winner');
    const member = winner.value;
    expect(member.role).toBe('member');
    const binding = store.getLedger(member.id)!;
    const ledger = openDatabase({ ...config, ...binding });
    try {
      expect(ledger.prepare('SELECT * FROM users').all()).toEqual([]);
      expect(ledger.prepare('SELECT * FROM transactions').all()).toEqual([]);
      expect(ledger.prepare('SELECT id FROM categories').all().length).toBeGreaterThan(0);
    } finally {
      closeDatabase(ledger);
    }
    const stored = store.db.prepare('SELECT code_hash FROM invitations').get() as {
      code_hash: string;
    };
    expect(stored.code_hash).toBe(hashSessionToken(invite.code));
    expect(JSON.stringify(store.listInvitations(ownerId))).not.toContain(invite.code);
  });

  it('preserves valid codes after username collision or weak password', async () => {
    const store = open();
    const { code } = store.createInvitation(ownerId);
    await expect(store.register('owner', PASSWORD, code)).rejects.toMatchObject({
      code: 'USERNAME_TAKEN',
    });
    await expect(store.register('member', 'tiny', code)).rejects.toThrow(/at least/i);
    expect(store.listInvitations(ownerId)[0]?.status).toBe('active');
    expect((await store.register('member', PASSWORD, code)).role).toBe('member');
  });

  it('rejects expired, revoked, invalid and disabled-issuer invitations', async () => {
    const store = open();
    const revoked = store.createInvitation(ownerId);
    store.revokeInvitation(ownerId, revoked.invitation.id);
    await expect(store.register('member', PASSWORD, revoked.code)).rejects.toMatchObject({
      code: 'INVALID_INVITATION',
    });
    const expired = store.createInvitation(ownerId);
    clock += 7 * MS_PER_DAY;
    await expect(store.register('member', PASSWORD, expired.code)).rejects.toMatchObject({
      code: 'INVALID_INVITATION',
    });
    await expect(store.register('member', PASSWORD, 'x'.repeat(43))).rejects.toMatchObject({
      code: 'INVALID_INVITATION',
    });
    const disabled = store.createInvitation(ownerId);
    store.db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(ownerId);
    await expect(store.register('member', PASSWORD, disabled.code)).rejects.toMatchObject({
      code: 'INVALID_INVITATION',
    });
    expect(store.listLedgers()).toHaveLength(1);
  });

  it.each(['reserved', 'initialized'] as const)(
    'recovers a failure at %s without consuming the code',
    async (phase) => {
      const store = open({
        provisionCheckpoint: (current) => {
          if (current === phase) throw new Error('Simulated provisioning interruption');
        },
      });
      const { code } = store.createInvitation(ownerId);
      await expect(store.register('member', PASSWORD, code)).rejects.toThrow(/interruption/);
      expect(store.listLedgers()).toHaveLength(1);
      expect(store.listInvitations(ownerId)[0]?.status).toBe('active');
      expect(store.db.prepare('SELECT * FROM ledger_provisions').all()).toEqual([]);
      store.close();
      expect((await open().register('member', PASSWORD, code)).role).toBe('member');
    },
  );

  it('allows login recovery when a response fails after durable activation', async () => {
    const store = open({
      provisionCheckpoint: (phase) => {
        if (phase === 'committed') throw new Error('Lost response');
      },
    });
    const { code } = store.createInvitation(ownerId);
    await expect(store.register('member', PASSWORD, code)).rejects.toThrow('Lost response');
    expect(store.listInvitations(ownerId)[0]?.status).toBe('used');
    expect((await store.authService.login('member', PASSWORD)).ok).toBe(true);
    expect(
      existsSync(store.listLedgers().find((ledger) => ledger.userId !== ownerId)!.dbFile),
    ).toBe(true);
  });

  it('password resets revoke only that account and disabled users lose existing sessions', async () => {
    const store = open();
    const member = await store.register('member', PASSWORD, store.createInvitation(ownerId).code);
    const ownerSession = store.authService.createSession(ownerId);
    const memberSession = store.authService.createSession(member.id);
    if (!ownerSession.ok || !memberSession.ok) throw new Error('Missing session');
    await store.authService.setPassword('owner', 'replacement-password');
    expect(store.authService.resolveSession(ownerSession.token)).toBeUndefined();
    expect(store.authService.resolveSession(memberSession.token)?.userId).toBe(member.id);
    store.db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(member.id);
    expect(store.authService.resolveSession(memberSession.token)).toBeUndefined();
  });
});

describe('native auth and invitation routes', () => {
  it('returns immutable identity, administrator capability and a fresh member session; enforces role and CSRF', async () => {
    const { store, app, ownerCookie } = await http();
    const owner = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      cookies: { [SESSION_COOKIE]: ownerCookie },
    });
    expect(owner.json()).toMatchObject({
      id: ownerId,
      username: 'owner',
      role: 'admin',
      capabilities: ['manageInvitations'],
      expiresAt: expect.any(Number),
    });
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/invitations',
      headers: CSRF,
      cookies: { [SESSION_COOKIE]: ownerCookie },
      payload: {},
    });
    expect(created.statusCode).toBe(201);
    const code = (created.json() as { code: string }).code;
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/auth/register',
          payload: { username: 'member', password: PASSWORD, invitationCode: code },
        })
      ).statusCode,
    ).toBe(403);
    const registration = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: CSRF,
      payload: { username: 'member', password: PASSWORD, invitationCode: code },
    });
    expect(registration.statusCode).toBe(201);
    expect(registration.json()).toMatchObject({
      id: expect.any(String),
      username: 'member',
      role: 'member',
      capabilities: [],
    });
    const memberCookie = registration.cookies.find(
      (cookie) => cookie.name === SESSION_COOKIE,
    )!.value;
    for (const method of ['GET', 'POST'] as const) {
      const denied = await app.inject({
        method,
        url: '/api/v1/admin/invitations',
        headers: CSRF,
        cookies: { [SESSION_COOKIE]: memberCookie },
        ...(method === 'POST' ? { payload: {} } : {}),
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    }
    expect(store.listLedgers()).toHaveLength(2);
  });

  it('rejects forged roles and oversized auth bodies without consuming valid invites', async () => {
    const { store, app } = await http();
    const { code } = store.createInvitation(ownerId);
    const forged = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: CSRF,
      payload: { username: 'member', password: PASSWORD, invitationCode: code, role: 'admin' },
    });
    expect(forged.statusCode).toBe(400);
    expect(forged.json()).toMatchObject({ error: { code: 'VALIDATION' } });
    const oversized = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: CSRF,
      payload: { username: 'member', password: 'a'.repeat(5000), invitationCode: code },
    });
    expect(oversized.statusCode).toBe(413);
    expect(store.listInvitations(ownerId)[0]?.status).toBe('active');
  });

  it('bounds registration attempts before provisioning', async () => {
    const { app, store } = await http();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/v1/auth/register',
            headers: CSRF,
            payload: { username: 'member', password: PASSWORD, invitationCode: 'invalid' },
          })
        ).statusCode,
      ).toBe(400);
    }
    const result = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      headers: CSRF,
      payload: {
        username: 'member',
        password: PASSWORD,
        invitationCode: store.createInvitation(ownerId).code,
      },
    });
    expect(result.statusCode).toBe(429);
    expect(result.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    expect(store.listLedgers()).toHaveLength(1);
  });
});

it('rate limits expire deterministically and reject excess concurrent hashing', async () => {
  let time = 1000;
  const limiter = new AuthRequestLimiter(() => time);
  for (let count = 0; count < 5; count += 1)
    await limiter.run('client', 'register', async () => true);
  await expect(limiter.run('client', 'register', async () => true)).rejects.toMatchObject({
    statusCode: 429,
  });
  time += 60 * 60_000;
  expect(await limiter.run('client', 'register', async () => true)).toBe(true);
  const releases: (() => void)[] = [];
  const active = Array.from({ length: 8 }, (_, index) =>
    limiter.run(
      `concurrent-${index}`,
      'login',
      () =>
        new Promise<void>((resolve) => {
          releases.push(resolve);
        }),
    ),
  );
  await expect(limiter.run('excess', 'login', async () => true)).rejects.toMatchObject({
    statusCode: 429,
  });
  releases.forEach((release) => release());
  await Promise.all(active);
});
