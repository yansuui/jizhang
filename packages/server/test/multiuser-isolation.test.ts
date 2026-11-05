import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import { closeDatabase, initializeDatabase, openDatabase, type Db } from '../src/db/index.js';
import { openIdentityStore, type IdentityStore } from '../src/identity/store.js';
import { SESSION_COOKIE, type AuthedRequest } from '../src/plugins/auth.js';
import { AuthService } from '../src/services/auth-service.js';
import { TenantContext, TenantContextManager } from '../src/tenancy/context.js';

const PASSWORD = 'correct horse battery staple';
const NOW = new Date(2026, 9, 20, 12).getTime();
const CSRF = { 'x-requested-with': 'fetch' };
const WEBP = Buffer.from('UklGRigAAABXRUJQVlA4TBsAAAAvF8AFEAYyaRsv9a+zZ9k52l2R/k/Ao6I3URIA', 'base64');
const JOB = 'a'.repeat(32);
let dataDir: string;
let config: AppConfig;
let db: Db;
let identity: IdentityStore;
let app: FastifyInstance;
let owner: string;
let member: string;
let ownerId: string;
let memberId: string;
let fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>;

function request(cookie: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: Record<string, unknown>) {
  return app.inject({ method, url, headers: { ...CSRF, cookie }, ...(payload === undefined ? {} : { payload }) });
}

async function login(username: string): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: CSRF, payload: { username, password: PASSWORD } });
  expect(response.statusCode, response.body).toBe(200);
  const token = response.cookies.find((cookie) => cookie.name === SESSION_COOKIE)?.value;
  expect(token).toBeTruthy();
  return `${SESSION_COOKIE}=${token}`;
}

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'jizhang-tenant-test-'));
  config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', JIZHANG_USERNAME: 'owner', JIZHANG_PASSWORD_HASH: 'unused', DATA_DIR: dataDir,
    JIZHANG_AI_ENCRYPTION_KEY: 'ab'.repeat(32), JIZHANG_ITEM_CUTOUT_SERVICE_URL: 'http://jizhang-cutout:8090' });
  db = openDatabase(config);
  initializeDatabase(db, null);
  ownerId = await new AuthService(db, { sessionTtlDays: 30 }).setPassword('owner', PASSWORD);
  identity = openIdentityStore({ config, legacyDb: db });
  const invitation = identity.createInvitation(ownerId);
  memberId = (await identity.register('member', PASSWORD, invitation.code)).id;
  fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
    if (init?.method === 'POST') return Response.json({ jobId: JOB });
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    return Response.json({ jobId: JOB, state: 'ready', message: 'ready', candidates: [] });
  });
  app = buildApp({ config, db, identityStore: identity, fetchImpl, now: () => NOW, secureCookies: false });
  await app.ready();
  owner = await login('owner');
  member = await login('member');
});

afterEach(async () => {
  await app?.close();
  identity?.close();
  if (db !== undefined) closeDatabase(db);
  if (dataDir !== undefined) rmSync(dataDir, { recursive: true, force: true });
});

describe('private account route ownership', () => {
  it('keeps public health and signed-in/out unknown-route contracts', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/v1/unknown' })).statusCode).toBe(401);
    expect((await request(member, 'GET', '/api/v1/unknown')).statusCode).toBe(404);
  });

  it('isolates ledger lists, direct IDs, mutations, nested references, exports and repeated builtin IDs', async () => {
    const created = await request(owner, 'POST', '/api/v1/transactions', {
      type: 0, amountCents: 12345, categoryId: 'builtin-expense-food', accountId: 'builtin-default-account', date: NOW - 1000, note: 'owner-private-note',
    });
    expect(created.statusCode, created.body).toBe(201);
    const transactionId = (created.json() as { id: string }).id;
    expect((await request(member, 'GET', '/api/v1/transactions')).body).not.toContain('owner-private-note');
    for (const method of ['GET', 'PATCH', 'DELETE'] as const) {
      const result = await request(member, method, `/api/v1/transactions/${transactionId}`, method === 'PATCH' ? { note: 'attack' } : undefined);
      expect(result.statusCode, result.body).toBe(404);
    }
    expect((await request(member, 'GET', '/api/v1/export/transactions.csv')).body).not.toContain('owner-private-note');
    expect((await request(owner, 'GET', '/api/v1/export/transactions.csv')).body).toContain('owner-private-note');
    const category = await request(owner, 'POST', '/api/v1/categories', { name: 'owner-private-category', type: 0 });
    expect(category.statusCode, category.body).toBe(201);
    const categoryId = (category.json() as { id: string }).id;
    const foreignReference = await request(member, 'POST', '/api/v1/transactions', {
      type: 0, amountCents: 100, categoryId, accountId: 'builtin-default-account', date: NOW - 1000,
    });
    expect(foreignReference.statusCode).toBeGreaterThanOrEqual(400);
    expect((await request(member, 'GET', '/api/v1/categories')).body).not.toContain('owner-private-category');
    const rename = await request(member, 'PATCH', '/api/v1/accounts/builtin-default-account', { name: 'member-private-wallet' });
    expect(rename.statusCode, rename.body).toBe(200);
    expect((await request(owner, 'GET', '/api/v1/accounts')).body).not.toContain('member-private-wallet');
    expect((await request(member, 'GET', '/api/v1/accounts')).body).toContain('member-private-wallet');
  });

  it('keeps AI settings and conversation/import/generation resources private', async () => {
    const ai = await request(owner, 'PUT', '/api/v1/ai/config', {
      enabled: true, mode: 'chat-completions', name: 'private provider', url: 'https://provider.test/v1/chat/completions',
      method: 'POST', model: 'owner-private-model', timeoutMs: 5000, headers: {}, auth: { kind: 'bearer' },
      bodyTemplate: null, responsePath: 'choices[0].message.content', secret: 'owner-private-secret',
    });
    expect(ai.statusCode, ai.body).toBe(200);
    expect((await request(owner, 'GET', '/api/v1/ai/config')).body).toContain('owner-private-model');
    const memberConfig = await request(member, 'GET', '/api/v1/ai/config');
    expect(memberConfig.statusCode, memberConfig.body).toBe(200);
    expect(memberConfig.body).not.toContain('owner-private-model');
    expect(memberConfig.body).not.toContain('owner-private-secret');
    const conversation = await request(owner, 'POST', '/api/v1/assistant/conversations', { title: 'owner-private-conversation' });
    expect(conversation.statusCode, conversation.body).toBe(200);
    const id = (conversation.json() as { id: string }).id;
    expect((await request(member, 'GET', '/api/v1/assistant/conversations')).body).not.toContain(id);
    for (const suffix of ['/messages', '/generations?limit=1', '/import-batches/missing', '/generations/missing/events']) {
      const response = await request(member, 'GET', `/api/v1/assistant/conversations/${id}${suffix}`);
      expect(response.statusCode, `${suffix}: ${response.body}`).toBe(404);
    }
    const cancel = await request(member, 'POST', `/api/v1/assistant/conversations/${id}/generations/missing/cancel`);
    expect(cancel.statusCode, cancel.body).toBe(404);
    const batch = await request(owner, 'POST', `/api/v1/assistant/conversations/${id}/import-batches`, {
      clientRequestId: 'private-batch', analyse: false,
      files: [{ fileName: 'private-bill.csv', source: 'auto', fileBase64: readFileSync(new URL('./fixtures/wechat-bill-sample.csv', import.meta.url)).toString('base64') }],
    });
    expect(batch.statusCode, batch.body).toBe(201);
    const batchId = (batch.json() as { batch: { batchId: string } }).batch.batchId;
    expect((await request(owner, 'GET', `/api/v1/assistant/conversations/${id}/import-batches/${batchId}`)).statusCode).toBe(200);
    expect((await request(member, 'GET', `/api/v1/assistant/conversations/${id}/import-batches/${batchId}`)).statusCode).toBe(404);
  });

  it('isolates budget, statistics, transfers, trash, recurring, planning, goals and fund service graphs', async () => {
    const settings = await request(owner, 'PUT', '/api/v1/settings', { cycleStartDay: 3 });
    expect(settings.statusCode, settings.body).toBe(200);
    expect((await request(member, 'GET', '/api/v1/settings')).json()).toMatchObject({ cycleStartDay: null });

    const bill = await request(owner, 'POST', '/api/v1/transactions', {
      type: 0, amountCents: 12345, categoryId: 'builtin-expense-food', accountId: 'builtin-default-account', date: NOW - 1000, note: 'matrix-private-bill',
    });
    expect(bill.statusCode, bill.body).toBe(201);
    const billId = (bill.json() as { id: string }).id;
    const trend = '/api/v1/stats/monthly-trend?months=1&endMonth=2026-10';
    expect((await request(owner, 'GET', trend)).body).toContain('12345');
    expect((await request(member, 'GET', trend)).body).not.toContain('12345');
    expect((await request(owner, 'DELETE', `/api/v1/transactions/${billId}`)).statusCode).toBe(204);
    expect((await request(owner, 'GET', '/api/v1/trash')).body).toContain('matrix-private-bill');
    expect((await request(member, 'GET', '/api/v1/trash')).body).not.toContain('matrix-private-bill');
    expect((await request(member, 'POST', `/api/v1/trash/${billId}/restore`)).statusCode).toBe(404);

    const account = await request(owner, 'POST', '/api/v1/accounts', { name: 'matrix-private-account', type: 1, initialBalanceCents: 0 });
    expect(account.statusCode, account.body).toBe(201);
    const accountId = (account.json() as { id: string }).id;
    const transferBody = { fromAccountId: 'builtin-default-account', toAccountId: accountId, amountCents: 100, date: NOW - 1000, note: 'matrix-private-transfer' };
    const transfer = await request(owner, 'POST', '/api/v1/transfers', transferBody);
    expect(transfer.statusCode, transfer.body).toBe(201);
    expect((await request(member, 'GET', '/api/v1/transfers')).body).not.toContain('matrix-private-transfer');
    expect((await request(member, 'GET', `/api/v1/transfers/${(transfer.json() as { id: string }).id}`)).statusCode).toBe(404);
    expect((await request(member, 'POST', '/api/v1/transfers', transferBody)).statusCode).toBe(400);

    const rule = await request(owner, 'POST', '/api/v1/recurring/rules', {
      name: 'matrix-private-rule', type: 0, amountCents: 100, categoryId: 'builtin-expense-food', accountId: 'builtin-default-account', frequency: 'monthly', anchorDate: NOW - 86400000,
    });
    expect(rule.statusCode, rule.body).toBe(201);
    const ruleId = (rule.json() as { id: string }).id;
    expect((await request(member, 'GET', '/api/v1/recurring/rules')).body).not.toContain(ruleId);
    expect((await request(member, 'PATCH', `/api/v1/recurring/rules/${ruleId}`, { name: 'attack' })).statusCode).toBe(404);

    const planning = await request(owner, 'PUT', '/api/v1/financial-planning/config', {
      operationId: randomUUID(), expectedRevision: 0, enabled: true,
      ratiosBps: { growth: 2500, reserve: 1500, essentials: 5000, joy: 1000 },
      essentialMonthlyCents: 76543, targetMonths: 5, cycle: { kind: 'natural-month' }, timeZone: 'UTC',
    });
    expect(planning.statusCode, planning.body).toBe(200);
    expect((await request(owner, 'GET', '/api/v1/financial-planning/config')).body).toContain('76543');
    expect((await request(member, 'GET', '/api/v1/financial-planning/config')).body).not.toContain('76543');

    const opening = await request(owner, 'PUT', '/api/v1/financial-goals/opening', {
      goal: 'reserve', openingCents: 54321, openingAt: NOW - 86400000, expectedRevision: 0, operationId: randomUUID(),
    });
    expect(opening.statusCode, opening.body).toBe(200);
    expect((await request(owner, 'GET', '/api/v1/financial-goals')).body).toContain('54321');
    expect((await request(member, 'GET', '/api/v1/financial-goals')).body).not.toContain('54321');

    const operationId = randomUUID();
    const ownerRatios = { growth: 1000, reserve: 1000, essentials: 7000, joy: 1000 };
    const memberRatios = { growth: 3000, reserve: 2000, essentials: 4000, joy: 1000 };
    for (const [cookie, ratiosBps] of [[owner, ownerRatios], [member, memberRatios]] as const) {
      const saved = await request(cookie, 'PUT', '/api/v1/financial-funds/config', { operationId, expectedRevision: 0, ratiosBps, timeZone: 'UTC' });
      expect(saved.statusCode, saved.body).toBe(200);
    }
    expect((await request(owner, 'GET', '/api/v1/financial-funds/config')).json()).toMatchObject({ config: { revision: 1, ratiosBps: ownerRatios } });
    expect((await request(member, 'GET', '/api/v1/financial-funds/config')).json()).toMatchObject({ config: { revision: 1, ratiosBps: memberRatios } });
  });

  it('uses the immutable member actor for purpose-bearing edits and confirmed assistant writes after credentials leave the ledger', async () => {
    const created = await request(member, 'POST', '/api/v1/transactions', {
      type: 0, amountCents: 1000, categoryId: 'builtin-expense-food', accountId: 'builtin-default-account', date: NOW - 1000, fundPurpose: 'reserve',
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = (created.json() as { id: string }).id;
    const edited = await request(member, 'PATCH', `/api/v1/transactions/${id}`, { note: 'member-edit' });
    expect(edited.statusCode, edited.body).toBe(200);
    const configured = await request(member, 'PUT', '/api/v1/ai/config', {
      enabled: true, mode: 'chat-completions', name: 'member provider', url: 'https://provider.test/v1/chat/completions',
      method: 'POST', model: 'member-model', timeoutMs: 5000, headers: {}, auth: { kind: 'bearer' },
      bodyTemplate: null, responsePath: 'choices[0].message.content', secret: 'member-secret',
    });
    expect(configured.statusCode, configured.body).toBe(200);
    fetchImpl.mockImplementation(async () => Response.json({ choices: [{ message: { content: JSON.stringify({
      message: 'Please confirm', toolCall: { name: 'transaction.update', arguments: { id, changes: { note: 'assistant-member-write' } } },
    }) } }] }));
    const conversation = (await request(member, 'POST', '/api/v1/assistant/conversations', {})).json() as { id: string };
    const preview = await request(member, 'POST', `/api/v1/assistant/conversations/${conversation.id}/messages`, { text: 'change the note' });
    expect(preview.statusCode, preview.body).toBe(200);
    const last = (preview.json() as { items: { kind: string; content: { card: { actionId: string } } }[] }).items.at(-1)!;
    expect(last.kind, preview.body).toBe('tool-card');
    const confirmed = await request(member, 'POST', `/api/v1/assistant/actions/${last.content.card.actionId}/confirm`, {});
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect((await request(member, 'GET', `/api/v1/transactions/${id}`)).json()).toMatchObject({ note: 'assistant-member-write', fundPurpose: 'reserve' });
    fetchImpl.mockImplementation(async () => Response.json({ choices: [{ message: { content: JSON.stringify({
      message: 'Confirm allocated income', toolCall: { name: 'salary.create', arguments: {
        amountCents: 56789, accountId: 'builtin-default-account', date: NOW - 1000, expectedFundConfigRevision: 0,
      } },
    }) } }] }));
    const salaryPreview = await request(member, 'POST', `/api/v1/assistant/conversations/${conversation.id}/messages`, { text: 'allocate income' });
    const salaryCard = salaryPreview.json().items.at(-1).content.card as { actionId: string };
    expect(salaryCard, salaryPreview.body).toBeDefined();
    expect((await request(member, 'GET', '/api/v1/salaries')).json().items).toHaveLength(0);
    for (const action of ['confirm', 'cancel']) {
      expect((await request(owner, 'POST', `/api/v1/assistant/actions/${salaryCard.actionId}/${action}`, {})).statusCode).toBe(404);
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await request(member, 'POST', `/api/v1/assistant/actions/${salaryCard.actionId}/confirm`, {});
      expect(result.statusCode, result.body).toBe(200);
    }
    expect((await request(member, 'GET', '/api/v1/salaries')).json().items).toHaveLength(1);
    expect((await request(owner, 'GET', '/api/v1/salaries')).json().items).toHaveLength(0);
    const ledger = identity.getLedger(memberId)!;
    const check = openDatabase({ ...config, ...ledger });
    expect(check.prepare('SELECT actor_id FROM financial_fund_purpose_events WHERE transaction_id = ?').get(id)).toEqual({ actor_id: memberId });
    expect(check.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 0 });
    expect(check.prepare('SELECT actor_id FROM financial_fund_grant_revisions').get()).toEqual({ actor_id: memberId });
    closeDatabase(check);
  });

  it('isolates item details and photo bytes as well as worker status/cancel/results, surviving app restart', async () => {
    const created = await request(owner, 'POST', '/api/v1/items', { name: 'owner-private-camera', purchaseDate: NOW - 86400000 });
    expect(created.statusCode, created.body).toBe(201);
    const id = (created.json() as { id: string }).id;
    const photo = await app.inject({ method: 'PUT', url: `/api/v1/items/${id}/photo`, headers: { ...CSRF, cookie: owner, 'content-type': 'image/webp' }, payload: WEBP });
    expect(photo.statusCode, photo.body).toBe(204);
    expect((await request(owner, 'GET', `/api/v1/items/${id}/photo`)).rawPayload.equals(WEBP)).toBe(true);
    expect((await request(member, 'GET', `/api/v1/items/${id}/photo`)).statusCode).toBe(404);
    expect((await request(member, 'DELETE', `/api/v1/items/${id}/photo`)).statusCode).toBe(404);
    expect((await request(member, 'GET', `/api/v1/items/${id}`)).statusCode).toBe(404);
    expect((await request(member, 'GET', '/api/v1/items')).body).not.toContain('owner-private-camera');
    const job = await app.inject({ method: 'POST', url: '/api/v1/items/cutouts', headers: { ...CSRF, cookie: owner, 'content-type': 'image/webp' }, payload: WEBP });
    expect(job.statusCode, job.body).toBe(202);
    await app.close();
    app = buildApp({ config, db, identityStore: identity, fetchImpl, now: () => NOW, secureCookies: false });
    await app.ready();
    const calls = fetchImpl.mock.calls.length;
    for (const [method, suffix] of [['GET', ''], ['DELETE', ''], ['GET', '/candidates/0/preview'], ['GET', '/candidates/0/image']] as const) {
      expect((await request(member, method, `/api/v1/items/cutouts/${JOB}${suffix}`)).statusCode).toBe(404);
    }
    expect(fetchImpl.mock.calls.length).toBe(calls);
    expect((await request(owner, 'GET', `/api/v1/items/cutouts/${JOB}`)).statusCode).toBe(200);
  });

  it('keeps a delayed generation bound to its original user while another user reads and attempts cancellation', async () => {
    const saved = await request(owner, 'PUT', '/api/v1/ai/config', {
      enabled: true, mode: 'chat-completions', name: 'private provider', url: 'https://provider.test/v1/chat/completions',
      method: 'POST', model: 'private-model', timeoutMs: 5000, headers: {}, auth: { kind: 'bearer' },
      bodyTemplate: null, responsePath: 'choices[0].message.content', secret: 'private-secret',
    });
    expect(saved.statusCode, saved.body).toBe(200);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const envelope = JSON.stringify({ message: 'owner-only answer', toolCall: null, clarification: null });
    fetchImpl.mockImplementation(async () => {
      await gate;
      const text = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: envelope } }] })}\n\n` +
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;
      return new Response(text, { headers: { 'content-type': 'text/event-stream' } });
    });
    try {
      const conversation = (await request(owner, 'POST', '/api/v1/assistant/conversations', { title: 'delayed private turn' })).json() as { id: string };
      const created = await request(owner, 'POST', `/api/v1/assistant/conversations/${conversation.id}/generations`, {
        version: 1, clientRequestId: 'same-client-request', input: { type: 'text', text: 'hello' },
      });
      expect(created.statusCode, created.body).toBe(202);
      const generation = (created.json() as { generation: { id: string } }).generation;
      const route = `/api/v1/assistant/conversations/${conversation.id}/generations/${generation.id}`;
      expect((await request(member, 'GET', '/api/v1/assistant/conversations')).body).not.toContain(conversation.id);
      expect((await request(member, 'POST', `${route}/cancel`)).statusCode).toBe(404);
      expect((await request(member, 'GET', `${route}/events`)).statusCode).toBe(404);
      const pending = (await request(owner, 'GET', route)).json() as { generation: { status: string } };
      expect(['accepted', 'running']).toContain(pending.generation.status);
      release();
      let status = pending.generation.status;
      for (let attempt = 0; attempt < 100 && ['accepted', 'running'].includes(status); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        status = ((await request(owner, 'GET', route)).json() as { generation: { status: string } }).generation.status;
      }
      expect(status).toBe('completed');
      const events = await request(owner, 'GET', `${route}/events`);
      expect(events.statusCode).toBe(200);
      expect(events.body).toContain('owner-only answer');
      expect((await request(member, 'GET', '/api/v1/assistant/conversations')).body).not.toContain('owner-only answer');
    } finally { release(); }
  });

  it('creates personal backups with no other ledger or central credentials', async () => {
    const backup = await request(member, 'POST', '/api/v1/backups');
    expect(backup.statusCode, backup.body).toBe(201);
    const listed = await request(member, 'GET', '/api/v1/backups');
    expect(listed.statusCode).toBe(200);
    const ownerList = await request(owner, 'GET', '/api/v1/backups');
    expect(ownerList.body).not.toContain((backup.json() as { fileName: string }).fileName);
    const ledger = identity.getLedger(memberId)!;
    const check = openDatabase({ ...config, ...ledger });
    expect(check.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 0 });
    expect(check.prepare("SELECT name FROM sqlite_master WHERE name = 'invitations'").get()).toBeUndefined();
    closeDatabase(check);
  });

  it('bounds contexts, evicts idle graphs safely, and rejects a missing mapped ledger instead of creating one', async () => {
    await app.close();
    app = buildApp({ config, db, identityStore: identity, maxTenantContexts: 1, secureCookies: false });
    await app.ready();
    expect((await request(owner, 'GET', '/api/v1/unknown-does-not-pin-context')).statusCode).toBe(404);
    for (const cookie of [owner, member, owner, member]) {
      const response = await request(cookie, 'GET', '/api/v1/assistant/conversations');
      expect(response.statusCode, response.body).toBe(200);
    }
    await app.close();
    const ledger = identity.getLedger(memberId)!;
    rmSync(ledger.dbFile);
    app = buildApp({ config, db, identityStore: identity, secureCookies: false });
    await app.ready();
    expect((await request(member, 'GET', '/api/v1/accounts')).statusCode).toBe(500);
    expect((await request(owner, 'GET', '/api/v1/accounts')).statusCode).toBe(200);
  });

  it('keeps a disconnected provider handler pinned and refuses late service construction during shutdown', async () => {
    const manager = new TenantContextManager(identity, config, db, 1);
    const ownerRequest = { auth: { userId: ownerId, expiresAtMs: Date.now() + 10000 } } as AuthedRequest;
    const memberRequest = { auth: { userId: memberId, expiresAtMs: Date.now() + 10000 } } as AuthedRequest;
    const responseClosed = await manager.lease(ownerRequest);
    responseClosed(); // Connection lost; provider handler has not returned.
    await expect(manager.lease(memberRequest)).rejects.toMatchObject({ statusCode: 503, code: 'TENANT_BUSY' });
    manager.handlerFinished(ownerRequest);
    const memberClosed = await manager.lease(memberRequest);
    const context = manager.forRequest(memberRequest);
    await manager.drain();
    const lateFactory = vi.fn(() => 'must not run');
    expect(() => context.service(Symbol('late'), lateFactory)).toThrow();
    expect(lateFactory).not.toHaveBeenCalled();
    memberClosed();
    manager.handlerFinished(memberRequest);
    await manager.close();

    // Background work also pins an otherwise idle context until its task settles.
    const graph = new TenantContext(ownerId, db, config.dbFile, dataDir, false);
    let working = true;
    graph.whileBusy(() => working);
    expect(graph.idle).toBe(false);
    working = false;
    expect(graph.idle).toBe(true);
    await graph.close();
  });
});
