import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { MIGRATIONS, runMigrations } from '../src/db/migrate.js';
import { AiConfigService } from '../src/services/ai-config-service.js';
import { AiProviderService } from '../src/services/ai-provider-service.js';
import { AiSpendingOrganizationService } from '../src/services/ai-spending-organization-service.js';
import { AuthService } from '../src/services/auth-service.js';
import { SESSION_COOKIE } from '../src/plugins/auth.js';

const DATE = new Date(2026, 7, 5, 12).getTime();
const RANGE = { startDate: '2026-08-01', endDate: '2026-08-31' };
const empty = () => ({ reclassifications: [], tagSuggestions: [], noteSuggestions: [], newCategories: [], templateProposals: [] });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture(count = 16) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, null);
  const insert = db.prepare(`INSERT INTO transactions (id,type,amount_cents,category_id,account_id,date,note,tags_json,is_refund,deleted,updated_at)
    VALUES (?,0,100,'builtin-expense-food','builtin-default-account',?,'private source note','[]',0,0,0)`);
  for (let i = 0; i < count; i++) insert.run(`tx-${i}`, DATE);
  const batches = [deferred<unknown>(), deferred<unknown>()];
  const complete = vi.fn((_config, _secret, _context, options: { signal: AbortSignal }) => {
    const batch = batches[complete.mock.calls.length - 1];
    if (!batch) throw new Error('unexpected call');
    return Promise.race([batch.promise, new Promise<never>((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    })]);
  });
  const config = { getStoredOrThrow: () => ({ model: 'mock' }), getSecretOrThrow: () => null } as unknown as AiConfigService;
  const service = new AiSpendingOrganizationService(db, config, { complete } as unknown as AiProviderService, { now: () => DATE });
  return { db, service, complete, batches };
}

async function waitTerminal(service: AiSpendingOrganizationService, id: string) {
  await vi.waitFor(() => expect(service.getRun(id).status).not.toBe('running'));
  return service.getRun(id);
}

describe('organization durable progress lifecycle', () => {
  it('returns run identity before Provider finishes and exposes truthful complete-batch checkpoints', async () => {
    const f = fixture();
    try {
      const before = f.db.prepare('SELECT * FROM transactions').all();
      const run = await f.service.startAnalysis({ ...RANGE, background: true, clientRequestId: 'early' });
      expect(run.status).toBe('running');
      expect(run.progress?.phase).toBe('preparing');
      expect(run.progress?.totalBatches).toBe(2);
      expect(f.complete).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(f.complete).toHaveBeenCalledTimes(1));
      expect(f.service.getRun(run.runId).progress).toMatchObject({ phase: 'analysing', currentBatch: 1, completedBatches: 0 });
      const facts = f.complete.mock.calls[0]?.[2] as { facts: { transactions: { transactionId: string }[] } };
      const tx = facts.facts.transactions[0]?.transactionId;
      f.batches[0]?.resolve({ ...empty(), tagSuggestions: [{ transactionId: tx, tags: ['午餐'], reason: 'fixture', confidence: 0.8 }] });
      await vi.waitFor(() => expect(f.complete).toHaveBeenCalledTimes(2));
      const progress = f.service.getRun(run.runId);
      expect(progress.completedCount).toBe(10);
      expect(progress.progress).toMatchObject({ phase: 'analysing', currentBatch: 2, completedBatches: 1, suggestionCount: 1 });
      expect(() => f.service.getCard(run.runId)).toThrow();
      const calls = f.complete.mock.calls.length;
      f.service.getRun(run.runId); f.service.getRun(run.runId);
      expect(f.complete).toHaveBeenCalledTimes(calls);
      f.batches[1]?.resolve(empty());
      const ready = await waitTerminal(f.service, run.runId);
      expect(ready.status).toBe('ready');
      expect(ready.completedCount).toBe(16);
      expect(ready.progress).toMatchObject({ phase: 'ready', completedBatches: 2 });
      expect(ready.progress?.events.map((e) => e.phase)).toContain('validating');
      expect(ready.progress?.events.map((e) => e.phase)).toContain('publishing');
      expect(JSON.stringify(ready.progress)).not.toContain('private source note');
      expect(f.db.prepare('SELECT * FROM transactions').all()).toEqual(before);
    } finally { await f.service.close(); f.db.close(); }
  });

  it('reports the safe failing batch and field, clears every partial card and note', async () => {
    const f = fixture();
    try {
      const run = await f.service.startAnalysis({ ...RANGE, background: true, clientRequestId: 'bad-field' });
      await vi.waitFor(() => expect(f.complete).toHaveBeenCalledTimes(1));
      f.batches[0]?.resolve(empty());
      await vi.waitFor(() => expect(f.complete).toHaveBeenCalledTimes(2));
      f.batches[1]?.resolve({ reclassifications: [], newCategories: [], suggestions: [], leaked: 'provider-secret-body' });
      const failed = await waitTerminal(f.service, run.runId);
      expect(failed.errorCode).toBe('AI_RESPONSE_INVALID');
      expect(failed.completedCount).toBe(10);
      expect(failed.progress).toMatchObject({ phase: 'failed', suggestionCount: 0, errorDetail: { stage: 'validating', field: 'tagSuggestions', batch: 2 } });
      expect(JSON.stringify(failed)).not.toContain('provider-secret-body');
      expect(() => f.service.getCard(run.runId)).toThrow();
      expect(f.db.prepare('SELECT suggestions_json, template_proposals_json FROM ai_analysis_runs WHERE id = ?').get(run.runId))
        .toEqual({ suggestions_json: '[]', template_proposals_json: '[]' });
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM ai_note_suggestions').get()).toEqual({ n: 0 });
    } finally { await f.service.close(); f.db.close(); }
  });

  it('replays identical start requests and rejects mismatches and concurrent new runs', async () => {
    const f = fixture(1);
    try {
      const input = { ...RANGE, background: true, clientRequestId: 'stable' };
      const run = await f.service.startAnalysis(input);
      expect((await f.service.startAnalysis(input)).runId).toBe(run.runId);
      await expect(f.service.startAnalysis({ ...input, endDate: '2026-08-30' })).rejects.toMatchObject({ code: 'AI_ORGANIZATION_RUNS_INVALID' });
      await expect(f.service.startAnalysis({ ...input, clientRequestId: 'other' })).rejects.toMatchObject({ code: 'AI_ORGANIZATION_BUSY' });
      await vi.waitFor(() => expect(f.complete).toHaveBeenCalledTimes(1));
      f.batches[0]?.resolve(empty());
      await waitTerminal(f.service, run.runId);
      expect((await f.service.startAnalysis(input)).runId).toBe(run.runId);
      expect(f.complete).toHaveBeenCalledTimes(1);
    } finally { await f.service.close(); f.db.close(); }
  });

  it('aborts and drains work on close without late ready or automatic restart', async () => {
    const f = fixture(1);
    try {
      const run = await f.service.startAnalysis({ ...RANGE, background: true, clientRequestId: 'closing' });
      await vi.waitFor(() => expect(f.complete).toHaveBeenCalledTimes(1));
      await f.service.close();
      expect(f.service.getRun(run.runId)).toMatchObject({ status: 'failed', errorCode: 'AI_ORGANIZATION_INTERRUPTED' });
      f.batches[0]?.resolve(empty());
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(() => f.service.getCard(run.runId)).toThrow();
      await expect(f.service.startAnalysis(RANGE)).rejects.toMatchObject({ code: 'AI_ORGANIZATION_INTERRUPTED' });
    } finally { await f.service.close(); f.db.close(); }
  });

  it('fails old running rows on process startup without calling Provider', async () => {
    const f = fixture(0);
    try {
      f.db.prepare(`INSERT INTO ai_analysis_runs (id,status,start_date,end_date,eligible_count,completed_count,created_at,updated_at)
        VALUES ('orphan','running','2026-08-01','2026-08-31',5,0,1,1)`).run();
      const restored = new AiSpendingOrganizationService(f.db, {} as AiConfigService, { complete: f.complete } as unknown as AiProviderService);
      expect(restored.getRun('orphan')).toMatchObject({ status: 'failed', errorCode: 'AI_ORGANIZATION_INTERRUPTED' });
      expect(f.complete).not.toHaveBeenCalled();
      await restored.close();
    } finally { await f.service.close(); f.db.close(); }
  });

  it('requires valid request identity for background calls, and empty ranges need no Provider', async () => {
    const f = fixture(0);
    try {
      await expect(f.service.startAnalysis({ ...RANGE, background: true })).rejects.toMatchObject({ code: 'AI_ORGANIZATION_RUNS_INVALID' });
      await expect(f.service.startAnalysis({ ...RANGE, background: 'true' })).rejects.toMatchObject({ code: 'AI_ORGANIZATION_RUNS_INVALID' });
      const run = await f.service.startAnalysis({ ...RANGE, background: true, clientRequestId: 'empty' });
      expect(run).toMatchObject({ status: 'ready', eligibleCount: 0, completedCount: 0, progress: { phase: 'ready', totalBatches: 0 } });
      expect(f.complete).not.toHaveBeenCalled();
    } finally { await f.service.close(); f.db.close(); }
  });

  it('upgrades schema16 additively and keeps historical cards readable', () => {
    const db = new Database(':memory:');
    try {
      runMigrations(db, null, MIGRATIONS.filter((m) => m.version <= 16));
      db.prepare(`INSERT INTO ai_analysis_runs (id,status,start_date,end_date,eligible_count,created_at,updated_at)
        VALUES ('history','ready','2026-08-01','2026-08-31',0,1,1)`).run();
      // Every migration above the cutoff applies, and nothing below it is repeated.
      // Derived from MIGRATIONS so adding a later migration does not require editing
      // this assertion — the property under test is the cutoff, not a fixed list.
      expect(runMigrations(db, null).applied).toEqual(
        MIGRATIONS.filter((m) => m.version > 16).map((m) => m.version),
      );
      expect(runMigrations(db, null).applied).toEqual([]);
      const service = new AiSpendingOrganizationService(db, {} as AiConfigService, {} as AiProviderService);
      expect(service.getRun('history').progress).toBeNull();
      expect(service.getCard('history').actions).toEqual([]);
    } finally { db.close(); }
  });
});

it('authenticates asynchronous start/status and returns 202 before the real HTTP Provider resolves', async () => {
  const f = fixture(1);
  await f.service.close();
  const upstream = deferred<Response>();
  const calls = vi.fn(() => upstream.promise);
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', JIZHANG_USERNAME: 'test', JIZHANG_PASSWORD_HASH: 'unused', DATA_DIR: './data' });
  const auth = new AuthService(f.db, { sessionTtlDays: 30 });
  await auth.setPassword('test', 'correct horse battery staple');
  const app = buildApp({ config, db: f.db, authService: auth, secureCookies: false, fetchImpl: calls as unknown as typeof fetch });
  try {
    await app.ready();
    expect((await app.inject({ method: 'POST', url: '/api/v1/ai/organization-runs', headers: { 'x-requested-with': 'fetch' }, payload: RANGE })).statusCode).toBe(401);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { 'x-requested-with': 'fetch' }, payload: { username: 'test', password: 'correct horse battery staple' } });
    const cookie = login.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
    const headers = { Cookie: `${SESSION_COOKIE}=${cookie}`, 'x-requested-with': 'fetch' };
    expect((await app.inject({ method: 'POST', url: '/api/v1/ai/organization-runs', headers: { Cookie: headers.Cookie }, payload: RANGE })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/v1/ai/organization-runs/missing/resume', headers: { 'x-requested-with': 'fetch' }, payload: { clientRequestId: 'guard' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/v1/ai/organization-runs/missing/resume', headers: { Cookie: headers.Cookie }, payload: { clientRequestId: 'guard' } })).statusCode).toBe(403);
    new AiConfigService(f.db, { production: false, aiEncryptionKey: undefined }).save({ enabled: true, mode: 'chat-completions', name: 'mock', url: 'https://provider.invalid/mock', method: 'POST', model: 'mock', timeoutMs: 3000, headers: {}, auth: { kind: 'none' }, bodyTemplate: null, responsePath: 'choices[0].message.content' });
    const result = await app.inject({ method: 'POST', url: '/api/v1/ai/organization-runs', headers, payload: { ...RANGE, background: true, clientRequestId: 'route-run' } });
    expect(result.statusCode).toBe(202);
    const run = result.json<{ runId: string; status: string }>();
    expect(run.status).toBe('running');
    await vi.waitFor(() => expect(calls).toHaveBeenCalledTimes(1));
    const status = await app.inject({ method: 'GET', url: `/api/v1/ai/organization-runs/${run.runId}`, headers });
    expect(status.json().progress.phase).toBe('analysing');
    expect((await app.inject({ method: 'GET', url: `/api/v1/ai/organization-runs/${run.runId}/card`, headers })).statusCode).toBe(409);
    upstream.resolve(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(empty()) } }] }), { headers: { 'content-type': 'application/json' } }));
    await vi.waitFor(async () => {
      const snapshot = await app.inject({ method: 'GET', url: `/api/v1/ai/organization-runs/${run.runId}`, headers });
      expect(snapshot.json().status).toBe('ready');
    });
    expect((await app.inject({ method: 'GET', url: `/api/v1/ai/organization-runs/${run.runId}/card`, headers })).statusCode).toBe(200);
    expect(calls).toHaveBeenCalledTimes(1);
    // Legacy synchronous HTTP requests must be aborted before Fastify drains them.
    const stalled = deferred<Response>();
    calls.mockImplementation(() => stalled.promise);
    const synchronous = app.inject({ method: 'POST', url: '/api/v1/ai/organization-runs', headers, payload: RANGE });
    const pendingResponse = synchronous.then((response) => response);
    await vi.waitFor(() => expect(calls).toHaveBeenCalledTimes(2));
    await app.close();
    expect((await pendingResponse).json()).toMatchObject({ status: 'failed', errorCode: 'AI_ORGANIZATION_INTERRUPTED' });
  } finally { await app.close(); f.db.close(); }
});
