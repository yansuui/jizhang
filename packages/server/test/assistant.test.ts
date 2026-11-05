import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { closeDatabase, initializeDatabase, type Db } from '../src/db/index.js';
import { SESSION_COOKIE } from '../src/plugins/auth.js';
import { AuthService } from '../src/services/auth-service.js';
import { AiConfigService } from '../src/services/ai-config-service.js';
import { normalizeAssistantContent } from '../src/services/assistant-types.js';
import { TransactionService } from '../src/services/transaction-service.js';
import { MasterDataService } from '../src/services/master-data-service.js';

const USERNAME = 'quiz';
const PASSWORD = 'correct horse battery staple';
const CSRF = { 'x-requested-with': 'fetch' };
const KEY = 'ab'.repeat(32);
const NOW = Date.UTC(2026, 8, 22, 12);
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const wechatBytes = readFileSync(join(FIXTURES, 'wechat-bill-sample.csv'));

let db: Db;
let app: FastifyInstance;
let cookie: string;
let providerEnvelope: unknown;
let scenario: 'transaction' | 'unknown' | 'custom' = 'transaction';
let customCall: { name: string; arguments: Record<string, unknown> } | undefined;
let testDataDir: string;
let billScenario: 'valid' | 'invalid' | 'failure' | 'partial-failure' = 'valid';
let billCalls = 0;
let assistantProviderFailure: 'unavailable' | 'invalid-response' | null = null;

function authHeaders() {
  return { ...CSRF, Cookie: `${SESSION_COOKIE}=${cookie}` };
}

async function inject(method: 'GET' | 'POST' | 'DELETE', url: string, payload?: Record<string, unknown>) {
  return app.inject({ method, url, headers: authHeaders(), ...(payload === undefined ? {} : { payload }) });
}

function providerResponse(): Response {
  const toolCall = scenario === 'transaction'
    ? { name: 'transaction.create', arguments: { type: 'expense', amountCents: 2500, categoryId: 'builtin-expense-food', accountId: 'builtin-default-account', date: '2026-09-20', note: 'lunch' } }
    : scenario === 'custom'
      ? customCall
      : { name: 'database.drop', arguments: {} };
  providerEnvelope = { message: '请检查这笔支出。', toolCall };
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(providerEnvelope) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
}

beforeEach(async () => {
  testDataDir = mkdtempSync(join(tmpdir(), 'assistant-test-'));
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  initializeDatabase(db, null);
  const config = loadConfig({
    NODE_ENV: 'test', LOG_LEVEL: 'silent', JIZHANG_USERNAME: USERNAME,
    JIZHANG_PASSWORD_HASH: 'unused', JIZHANG_AI_ENCRYPTION_KEY: KEY, DATA_DIR: testDataDir,
  });
  const auth = new AuthService(db, { sessionTtlDays: config.sessionTtlDays, now: () => NOW });
  await auth.setPassword(USERNAME, PASSWORD);
  new AiConfigService(db, { aiEncryptionKey: KEY, production: false, now: () => NOW }).save({
    enabled: true,
    mode: 'chat-completions',
    name: 'assistant test provider',
    url: 'https://provider.example.test/v1/chat/completions',
    method: 'POST', model: 'test-model', timeoutMs: 10_000, headers: {}, auth: { kind: 'bearer' },
    bodyTemplate: null, responsePath: 'choices[0].message.content', secret: 'test-only-provider-secret',
  });
  scenario = 'transaction';
  billScenario = 'valid'; billCalls = 0;
  assistantProviderFailure = null;
  customCall = undefined;
  providerEnvelope = undefined;
  app = buildApp({
    config, db, authService: auth, secureCookies: false, now: () => NOW,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { messages?: { content: string }[] };
      if (assistantProviderFailure === 'unavailable') return new Response('provider-private-response SECRET_PROVIDER_BODY', { status: 503 });
      if (assistantProviderFailure === 'invalid-response') return new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), { status: 200 });
      if (body.messages?.[0]?.content.includes('Analyse imported bill facts')) {
        billCalls++;
        if (billScenario === 'failure' || (billScenario === 'partial-failure' && billCalls === 2)) return new Response('unavailable', { status: 503 });
        const facts = JSON.parse(body.messages[1]!.content) as { rows: { id: string; type: number }[]; categories: { id: string; type: number }[] };
        const result = billScenario === 'invalid' ? { recommendations: [{ id: 'invented' }] } : { recommendations: facts.rows.map((r) => ({ id: r.id, include: true, reason: 'Reviewed source facts', categoryId: facts.categories.find((c) => c.type === r.type)?.id ?? null })) };
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }), { status: 200 });
      }
      return providerResponse();
    },
  });
  await app.ready();
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: CSRF, payload: { username: USERNAME, password: PASSWORD } });
  cookie = (login.cookies as { name: string; value: string }[]).find((item) => item.name === SESSION_COOKIE)?.value as string;
});

afterEach(async () => {
  await app.close();
  closeDatabase(db);
  rmSync(testDataDir, { recursive: true, force: true });
});

async function prepareTool(name: string, args: Record<string, unknown>) {
  scenario = 'custom';
  customCall = { name, arguments: args };
  const conversation = (await inject('POST', '/api/v1/assistant/conversations', {})).json();
  const response = await inject('POST', `/api/v1/assistant/conversations/${conversation.id}/messages`, { text: `prepare ${name}` });
  const item = response.json().items.at(-1);
  expect(item.kind, response.body).toBe('tool-card');
  return { conversationId: conversation.id as string, actionId: item.content.card.actionId as string, card: item.content.card };
}

async function confirmTool(actionId: string) {
  return inject('POST', `/api/v1/assistant/actions/${actionId}/confirm`, {});
}

describe('assistant authenticated routes and confirmation contract', () => {
  it('marks failed provider turns as failed and returns only a safe mapped error without ledger writes', async () => {
    assistantProviderFailure = 'unavailable';
    const conversation = (await inject('POST', '/api/v1/assistant/conversations', {})).json();
    const response = await inject('POST', `/api/v1/assistant/conversations/${conversation.id}/messages`, { text: '帮我记一笔午饭' });
    expect(response.statusCode).toBe(200);
    const items = response.json().items as { kind: string; content: { progress?: { state: string }; error?: { code: string; message: string }; text?: string } }[];
    expect(items.find((item) => item.kind === 'progress')?.content.progress?.state).toBe('failed');
    const error = items.find((item) => item.kind === 'error')?.content.error;
    expect(error).toMatchObject({ code: 'AI_PROVIDER_ERROR', message: expect.stringContaining('检查服务地址') });
    expect(JSON.stringify(items)).not.toContain('provider-private-response');
    expect(JSON.stringify(items)).not.toContain('SECRET_PROVIDER_BODY');
    expect((db.prepare('SELECT COUNT(*) AS count FROM transactions').get() as { count: number }).count).toBe(0);
  });

  it('maps malformed provider output to a stable safe response and keeps successful draft preparation unchanged', async () => {
    assistantProviderFailure = 'invalid-response';
    const conversation = (await inject('POST', '/api/v1/assistant/conversations', {})).json();
    const failed = await inject('POST', `/api/v1/assistant/conversations/${conversation.id}/messages`, { text: '帮我记午饭' });
    expect(failed.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'progress', content: expect.objectContaining({ progress: { state: 'failed' } }) }),
      expect.objectContaining({ kind: 'error', content: expect.objectContaining({ error: { code: 'AI_RESPONSE_INVALID', message: expect.stringContaining('检查模型配置') } }) }),
    ]));
    expect((db.prepare('SELECT COUNT(*) AS count FROM transactions').get() as { count: number }).count).toBe(0);

    assistantProviderFailure = null;
    scenario = 'transaction';
    const success = await inject('POST', `/api/v1/assistant/conversations/${conversation.id}/messages`, { text: '午饭 25 元' });
    expect(success.json().items.at(-1).content.card).toMatchObject({ toolName: 'transaction.create', status: 'pending' });
    expect(success.json().items.filter((item: { kind: string }) => item.kind === 'progress').at(-1).content.progress.state).toBe('complete');
    expect((db.prepare('SELECT COUNT(*) AS count FROM transactions').get() as { count: number }).count).toBe(0);
  });

  it('keeps the legacy complete progress state readable', () => {
    expect(normalizeAssistantContent('progress', { version: 1, progress: { state: 'complete' } }).progress?.state).toBe('complete');
  });

  it('prepares a typed transaction card and creates exactly one transaction only after confirmation', async () => {
    const conversation = await inject('POST', '/api/v1/assistant/conversations', {});
    expect(conversation.statusCode).toBe(200);
    const id = conversation.json().id as string;
    const response = await inject('POST', `/api/v1/assistant/conversations/${id}/messages`, { text: '午饭花了 25 元', clientRequestId: 'request-1' });
    expect(response.statusCode).toBe(200);
    expect(response.json().items.at(-1).content.card).toMatchObject({ toolName: 'transaction.create', writes: true, status: 'pending' });
    expect((db.prepare('SELECT COUNT(*) AS count FROM transactions WHERE deleted = 0').get() as { count: number }).count).toBe(0);

    const savedConversations = await inject('GET', '/api/v1/assistant/conversations');
    expect(savedConversations.json().items).toEqual([expect.objectContaining({ id })]);
    const restoredMessages = await inject('GET', `/api/v1/assistant/conversations/${id}/messages`);
    expect(restoredMessages.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: expect.objectContaining({ text: '午饭花了 25 元' }) }),
      expect.objectContaining({ content: expect.objectContaining({ card: expect.objectContaining({ status: 'pending' }) }) }),
    ]));

    const actionId = response.json().items.at(-1).content.card.actionId as string;
    const [confirmed, simultaneous] = await Promise.all([
      inject('POST', `/api/v1/assistant/actions/${actionId}/confirm`, {}),
      inject('POST', `/api/v1/assistant/actions/${actionId}/confirm`, {}),
    ]);
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(simultaneous.statusCode).toBe(200);
    expect(confirmed.json().action.status).toBe('confirmed');
    expect((db.prepare('SELECT COUNT(*) AS count FROM transactions WHERE deleted = 0').get() as { count: number }).count).toBe(1);

    const repeated = await inject('POST', `/api/v1/assistant/actions/${actionId}/confirm`, {});
    expect(repeated.statusCode).toBe(200);
    expect((db.prepare('SELECT COUNT(*) AS count FROM transactions WHERE deleted = 0').get() as { count: number }).count).toBe(1);
  });

  it('rejects an unknown provider tool without writes and persists only a bounded safe error', async () => {
    scenario = 'unknown';
    const conversation = (await inject('POST', '/api/v1/assistant/conversations', {})).json();
    const response = await inject('POST', `/api/v1/assistant/conversations/${conversation.id}/messages`, { text: 'do something unsafe' });
    expect(response.statusCode).toBe(200);
    expect(response.json().items.at(-1).kind).toBe('error');
    expect((db.prepare('SELECT COUNT(*) AS count FROM transactions').get() as { count: number }).count).toBe(0);
    const persisted = db.prepare('SELECT content_json FROM assistant_messages').all() as { content_json: string }[];
    expect(JSON.stringify(persisted)).not.toContain('database.drop');
  });

  it('previews a byte attachment, rejects a digest mismatch, validates selected rows, then imports once', async () => {
    const conversation = (await inject('POST', '/api/v1/assistant/conversations', {})).json();
    const file = {
      fileName: 'wechat-bill-sample.csv',
      source: 'auto',
      fileBase64: wechatBytes.toString('base64'),
    };
    const previewResponse = await inject('POST', `/api/v1/assistant/conversations/${conversation.id}/messages`, { text: '导入账单', attachment: file });
    expect(previewResponse.statusCode, previewResponse.body).toBe(200);
    const cardMessage = previewResponse.json().items.find((item: { content: { card?: unknown } }) => item.content.card !== undefined);
    const card = cardMessage.content.card as { actionId: string; preview: { rows: { id: string; ignored: boolean; alreadyExists: boolean }[] } };
    const selectedIds = card.preview.rows.filter((row) => !row.ignored && !row.alreadyExists).slice(0, 1).map((row) => row.id);
    expect(selectedIds.length).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS count FROM transactions WHERE deleted = 0').get() as { count: number }).count).toBe(0);

    const mismatch = await inject('POST', `/api/v1/assistant/actions/${card.actionId}/confirm`, { fileBase64: Buffer.from('different').toString('base64'), selectedIds });
    expect(mismatch.statusCode).toBe(409);
    const expiredHistory = await inject('GET', `/api/v1/assistant/conversations/${conversation.id}/messages`);
    expect(expiredHistory.json().items.find((item: { content: { card?: { actionId: string } } }) => item.content.card?.actionId === card.actionId).content.card.status).toBe('expired');
    expect((db.prepare('SELECT COUNT(*) AS count FROM transactions WHERE deleted = 0').get() as { count: number }).count).toBe(0);

    const refreshed = await inject('POST', `/api/v1/assistant/conversations/${conversation.id}/messages`, { text: '重新预览导入', attachment: file });
    const refreshedCard = refreshed.json().items.filter((item: { content: { card?: unknown } }) => item.content.card !== undefined).at(-1).content.card as { actionId: string };
    const invalidSelection = await inject('POST', `/api/v1/assistant/actions/${refreshedCard.actionId}/confirm`, { fileBase64: file.fileBase64, selectedIds: ['fabricated-row-id'] });
    expect(invalidSelection.statusCode).toBe(409);
    expect((db.prepare('SELECT COUNT(*) AS count FROM transactions WHERE deleted = 0').get() as { count: number }).count).toBe(0);
    const refreshedAgain = await inject('POST', `/api/v1/assistant/conversations/${conversation.id}/messages`, { text: '确认正确行', attachment: file });
    const currentCard = refreshedAgain.json().items.filter((item: { content: { card?: unknown } }) => item.content.card !== undefined).at(-1).content.card as { actionId: string; preview: { rows: { id: string; ignored: boolean; alreadyExists: boolean }[] } };
    const currentSelectedIds = currentCard.preview.rows.filter((row) => !row.ignored && !row.alreadyExists).slice(0, 1).map((row) => row.id);
    const confirmed = await inject('POST', `/api/v1/assistant/actions/${currentCard.actionId}/confirm`, { fileBase64: file.fileBase64, selectedIds: currentSelectedIds, categoryOverrides: { [currentSelectedIds[0]!]: (db.prepare('SELECT id FROM categories WHERE type = ? AND deleted = 0 LIMIT 1').get((currentCard.preview.rows.find((r) => r.id === currentSelectedIds[0]) as unknown as { type: number }).type) as { id: string }).id } });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(confirmed.json().action.status).toBe('confirmed');
    expect((db.prepare('SELECT COUNT(*) AS count FROM transactions WHERE deleted = 0').get() as { count: number }).count).toBe(1);
    const rows = db.prepare('SELECT content_json FROM assistant_messages').all() as { content_json: string }[];
    expect(JSON.stringify(rows)).not.toContain(file.fileBase64);
  });

  it('previews transaction edits and soft delete/restore, then revalidates before each write', async () => {
    const service = new TransactionService(db, { now: () => NOW });
    const original = service.create({ type: 0, amountCents: 1800, categoryId: 'builtin-expense-food', accountId: 'builtin-default-account', date: Date.UTC(2026, 8, 19), note: 'before' });
    const edit = await prepareTool('transaction.update', { id: original.id, changes: { note: 'after', amountCents: 2100 } });
    expect(service.getByIdOrThrow(original.id)).toMatchObject({ note: 'before', amountCents: 1800 });
    const edited = await confirmTool(edit.actionId);
    expect(edited.statusCode).toBe(200);
    expect(service.getByIdOrThrow(original.id)).toMatchObject({ note: 'after', amountCents: 2100 });

    const deletion = await prepareTool('transaction.delete', { id: original.id });
    expect((db.prepare('SELECT deleted FROM transactions WHERE id = ?').get(original.id) as { deleted: number }).deleted).toBe(0);
    expect((await confirmTool(deletion.actionId)).statusCode).toBe(200);
    expect((db.prepare('SELECT deleted FROM transactions WHERE id = ?').get(original.id) as { deleted: number }).deleted).toBe(1);

    const restoration = await prepareTool('transaction.restore', { id: original.id });
    expect((await confirmTool(restoration.actionId)).statusCode).toBe(200);
    expect((db.prepare('SELECT deleted FROM transactions WHERE id = ?').get(original.id) as { deleted: number }).deleted).toBe(0);
  });

  it('previews an income conversion without inheriting an expense-only purpose override', async () => {
    const service = new TransactionService(db, { now: () => NOW });
    const original = service.create({
      type: 0,
      amountCents: 1800,
      categoryId: 'builtin-expense-food',
      accountId: 'builtin-default-account',
      date: Date.UTC(2026, 8, 19),
      financialPurpose: 'essentials',
    });
    const incomeCategory = db.prepare('SELECT id FROM categories WHERE type = 1 AND deleted = 0 LIMIT 1').get() as { id: string };
    const edit = await prepareTool('transaction.update', {
      id: original.id,
      changes: { type: 'income', categoryId: incomeCategory.id },
    });
    // Preview must be read-only; the implicit clear happens only after confirmation.
    expect(service.getByIdOrThrow(original.id)).toMatchObject({ type: 0, financialPurpose: 'essentials' });
    const confirmed = await confirmTool(edit.actionId);
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(service.getByIdOrThrow(original.id)).toMatchObject({ type: 1, financialPurpose: null });
  });

  it('confirms transfer writes but never recreates retired module budgets', async () => {
    const secondAccount = new MasterDataService(db, { now: () => NOW }).createAccount({ name: 'Transfer destination', type: 0 });
    const transfer = await prepareTool('transfer.create', { fromAccountId: 'builtin-default-account', toAccountId: secondAccount.id, amountCents: 4000, date: '2026-09-20', note: 'move' });
    expect((db.prepare('SELECT COUNT(*) AS count FROM transfers WHERE deleted = 0').get() as { count: number }).count).toBe(0);
    expect((await confirmTool(transfer.actionId)).statusCode).toBe(200);
    expect((db.prepare('SELECT COUNT(*) AS count FROM transfers WHERE deleted = 0').get() as { count: number }).count).toBe(1);

    // Legacy module-allocation salary payloads remain forbidden. Canonical fund
    // salary.create has a different validated version/revision contract.
    const templateId = (db.prepare('SELECT id FROM budget_templates WHERE is_default = 1').get() as { id: string }).id;
    for (const [name, args] of [
      ['salary.create', { amountCents: 100_000, accountId: 'builtin-default-account', date: '2026-09-20', templateId, note: 'salary' }],
      ['budget.template.apply', { templateId }],
    ] as const) {
      scenario = 'custom';
      customCall = { name, arguments: args };
      const conversation = (await inject('POST', '/api/v1/assistant/conversations', {})).json();
      const response = await inject('POST', `/api/v1/assistant/conversations/${conversation.id}/messages`, { text: `prepare ${name}` });
      expect(response.statusCode).toBe(200);
      expect(response.json().items.at(-1).kind).toBe('error');
      expect((db.prepare('SELECT COUNT(*) AS count FROM salary_records WHERE deleted = 0').get() as { count: number }).count).toBe(0);
      expect((db.prepare('SELECT COUNT(*) AS count FROM budget_allocations WHERE deleted = 0').get() as { count: number }).count).toBe(0);
    }
  });

  it('confirms safe category/account create-update-delete actions only after previews', async () => {
    const category = await prepareTool('category.create', { name: 'Assistant test category', type: 0 });
    expect((db.prepare("SELECT COUNT(*) AS count FROM categories WHERE name = 'Assistant test category' AND deleted = 0").get() as { count: number }).count).toBe(0);
    const categoryCreated = await confirmTool(category.actionId);
    const categoryId = categoryCreated.json().message.content.result.data.category.id as string;
    const categoryUpdate = await prepareTool('category.update', { id: categoryId, changes: { name: 'Assistant updated category' } });
    expect((await confirmTool(categoryUpdate.actionId)).statusCode).toBe(200);
    expect((db.prepare('SELECT name FROM categories WHERE id = ?').get(categoryId) as { name: string }).name).toBe('Assistant updated category');
    const categoryDelete = await prepareTool('category.delete', { id: categoryId });
    expect((await confirmTool(categoryDelete.actionId)).statusCode).toBe(200);
    expect((db.prepare('SELECT deleted FROM categories WHERE id = ?').get(categoryId) as { deleted: number }).deleted).toBe(1);

    const account = await prepareTool('account.create', { name: 'Assistant unused account', type: 0, initialBalanceCents: 500 });
    expect((db.prepare("SELECT COUNT(*) AS count FROM accounts WHERE name = 'Assistant unused account' AND deleted = 0").get() as { count: number }).count).toBe(0);
    const accountCreated = await confirmTool(account.actionId);
    const accountId = accountCreated.json().message.content.result.data.account.id as string;
    const accountUpdate = await prepareTool('account.update', { id: accountId, changes: { name: 'Assistant renamed account' } });
    expect((await confirmTool(accountUpdate.actionId)).statusCode).toBe(200);
    expect((db.prepare('SELECT name FROM accounts WHERE id = ?').get(accountId) as { name: string }).name).toBe('Assistant renamed account');
    const accountDelete = await prepareTool('account.delete', { id: accountId });
    expect((await confirmTool(accountDelete.actionId)).statusCode).toBe(200);
    expect((db.prepare('SELECT deleted FROM accounts WHERE id = ?').get(accountId) as { deleted: number }).deleted).toBe(1);
  });

  it('keeps backup creation preview inert and creates a named backup only on confirmation', async () => {
    const sourceDb = new Database(join(testDataDir, 'jizhang.db'));
    initializeDatabase(sourceDb, null);
    closeDatabase(sourceDb);
    const preview = await prepareTool('backup.create', {});
    expect((await inject('GET', '/api/v1/backups')).json().items).toHaveLength(0);
    const confirmed = await confirmTool(preview.actionId);
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().message.content.result.data.fileName).toMatch(/^jizhang-/);
    expect((await inject('GET', '/api/v1/backups')).json().items).toHaveLength(1);
  });
});

describe('reviewed bill import', () => {
  const file = { fileName: 'wechat.csv', source: 'auto', fileBase64: wechatBytes.toString('base64') };
  async function preview() {
    const conversation = (await inject('POST', '/api/v1/assistant/conversations', {})).json();
    const response = await inject('POST', `/api/v1/assistant/conversations/${conversation.id}/messages`, { text: '导入', attachment: file });
    return response.json().items.at(-1).content.card;
  }
  it('uses bounded real provider requests without writes; reviewed note clearing and refund identity survive category edits and duplicate confirmation', async () => {
    const card = await preview();
    expect(card.preview.analysis.status).toBe('complete');
    expect(billCalls).toBe(2);
    expect((db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n).toBe(0);
    const refund = card.preview.rows.find((r: { isRefund: boolean }) => r.isRefund);
    const category = card.preview.categories.find((c: { type: number }) => c.type === 1);
    const payload = { fileBase64: file.fileBase64, selectedIds: [refund.id], categoryOverrides: { [refund.id]: category.id }, noteOverrides: { [refund.id]: '' } };
    const callsBefore = billCalls;
    const response = await inject('POST', `/api/v1/assistant/actions/${card.actionId}/confirm`, payload);
    expect(response.statusCode, response.body).toBe(200);
    expect(billCalls).toBe(callsBefore);
    expect(db.prepare('SELECT note, is_refund, amount_cents FROM transactions WHERE id = ?').get(refund.id)).toEqual({ note: '', is_refund: 1, amount_cents: refund.amountCents });
    expect((await inject('POST', `/api/v1/assistant/actions/${card.actionId}/confirm`, payload)).statusCode).toBe(200);
    expect((db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n).toBe(1);
  });
  it('shows analysis failure honestly and retries explicitly with matching original file', async () => {
    billScenario = 'failure';
    const card = await preview();
    expect(card.preview.analysis).toMatchObject({ status: 'failed', analysed: 0, recommendations: [] });
    const mismatch = await inject('POST', `/api/v1/assistant/actions/${card.actionId}/analyse`, { fileBase64: Buffer.from('wrong').toString('base64') });
    expect(mismatch.statusCode).toBe(409);
    billScenario = 'valid';
    const retry = await inject('POST', `/api/v1/assistant/actions/${card.actionId}/analyse`, { fileBase64: file.fileBase64 });
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json().items.at(-1).content.card.preview.analysis.status).toBe('complete');
    expect((db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n).toBe(0);
  });
  it('rejects malformed AI output and invalid categories without any partial write', async () => {
    billScenario = 'invalid';
    const card = await preview();
    expect(card.preview.analysis.status).toBe('failed');
    const candidates = card.preview.rows.filter((r: { ignored: boolean; alreadyExists: boolean }) => !r.ignored && !r.alreadyExists).slice(0, 2);
    const payload = { fileBase64: file.fileBase64, selectedIds: candidates.map((r: { id: string }) => r.id), categoryOverrides: { [candidates[0].id]: 'missing', [candidates[1].id]: 'missing' } };
    expect((await inject('POST', `/api/v1/assistant/actions/${card.actionId}/confirm`, payload)).statusCode).toBe(400);
    expect((db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n).toBe(0);
  });
  it('discards earlier recommendations when a later batch fails', async () => {
    billScenario = 'partial-failure';
    const card = await preview();
    expect(billCalls).toBe(2);
    expect(card.preview.analysis).toMatchObject({ status: 'failed', analysed: 0, recommendations: [] });
    expect((db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n).toBe(0);
  });
  it('rejects a preview after a selected source identity is inserted into the ledger', async () => {
    const card = await preview();
    const row = card.preview.rows.find((r: { ignored: boolean; type: number }) => !r.ignored && r.type === 0);
    db.prepare(`INSERT INTO transactions (id, type, amount_cents, category_id, account_id, date, note, tags_json, is_refund, deleted, updated_at)
      VALUES (?, 0, ?, 'builtin-expense-food', 'builtin-default-account', ?, '', '[]', 0, 0, ?)`).run(row.id, row.amountCents, NOW, NOW);
    const rejected = await inject('POST', `/api/v1/assistant/actions/${card.actionId}/confirm`, { fileBase64: file.fileBase64, selectedIds: [row.id], categoryOverrides: { [row.id]: 'builtin-expense-food' } });
    expect(rejected.statusCode).toBe(409);
    expect((db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n).toBe(1);
  });
  it('revalidates current categories and ledger and rolls back database errors atomically', async () => {
    const stale = await preview();
    const row = stale.preview.rows.find((r: { ignored: boolean; alreadyExists: boolean; type: number }) => !r.ignored && !r.alreadyExists && r.type === 0);
    db.prepare("UPDATE categories SET deleted = 1 WHERE id = 'builtin-expense-food'").run();
    const rejected = await inject('POST', `/api/v1/assistant/actions/${stale.actionId}/confirm`, { fileBase64: file.fileBase64, selectedIds: [row.id], categoryOverrides: { [row.id]: 'builtin-expense-food' } });
    expect(rejected.statusCode).toBe(409);
    expect((db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n).toBe(0);
    db.prepare("UPDATE categories SET deleted = 0 WHERE id = 'builtin-expense-food'").run();
    const atomic = await preview();
    const rows = atomic.preview.rows.filter((r: { ignored: boolean; alreadyExists: boolean; type: number }) => !r.ignored && !r.alreadyExists && r.type === 0).slice(0, 2);
    db.exec(`CREATE TRIGGER review_failure BEFORE INSERT ON transactions WHEN NEW.id = '${rows[1].id}' BEGIN SELECT RAISE(ABORT, 'fixture insert failure'); END`);
    const failure = await inject('POST', `/api/v1/assistant/actions/${atomic.actionId}/confirm`, { fileBase64: file.fileBase64, selectedIds: rows.map((r: { id: string }) => r.id), categoryOverrides: Object.fromEntries(rows.map((r: { id: string }) => [r.id, 'builtin-expense-food'])) });
    expect(failure.statusCode).toBe(500);
    expect((db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT status FROM assistant_pending_actions WHERE id = ?').get(atomic.actionId) as { status: string }).status).toBe('pending');
  });

});

describe('current action-row scoped duplicate comparison', () => {
  async function prepareComparison() {
    const conversation = (await inject('POST', '/api/v1/assistant/conversations', {})).json();
    const response = await inject('POST', `/api/v1/assistant/conversations/${conversation.id}/messages`, {
      text: '导入', attachment: { fileName: 'wechat.csv', source: 'auto', fileBase64: wechatBytes.toString('base64') },
    });
    const card = response.json().items.at(-1).content.card;
    const row = card.preview.rows.find((r: { ignored: boolean; amountCents: number }) => !r.ignored && r.amountCents > 0);
    return { conversation, card, row, url: `/api/v1/assistant/conversations/${conversation.id}/actions/${card.actionId}/rows/${row.id}/duplicates` };
  }
  it('requires authentication, correct conversation/action and a displayed row; rejects closed and legacy actions', async () => {
    const { conversation, card, row, url } = await prepareComparison();
    const unauthenticated = await app.inject({ method: 'GET', url });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json().error.code).toBe('UNAUTHORIZED');
    const other = (await inject('POST', '/api/v1/assistant/conversations', {})).json();
    const wrongOwner = await inject('GET', url.replace(conversation.id, other.id));
    expect(wrongOwner.statusCode).toBe(409);
    expect(wrongOwner.json().error.code).toBe('ASSISTANT_ACTION_STALE');
    const missing = await inject('GET', url.replace(`/rows/${row.id}/`, '/rows/missing/'));
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error.message).toContain('当前预览');
    const stored = db.prepare('SELECT preview_json FROM assistant_pending_actions WHERE id = ?').get(card.actionId) as { preview_json: string };
    const legacy = JSON.parse(stored.preview_json);
    const hidden = { ...legacy.rows.find((r: { id: string }) => r.id === row.id), id: 'hidden-row' };
    const bounded = { ...legacy, rows: [...Array.from({ length: 200 }, (_, index) => ({ ...hidden, id: `visible-${index}` })), hidden] };
    db.prepare('UPDATE assistant_pending_actions SET preview_json = ? WHERE id = ?').run(JSON.stringify(bounded), card.actionId);
    const outsideDisplay = await inject('GET', url.replace(`/rows/${row.id}/`, '/rows/hidden-row/'));
    expect(outsideDisplay.statusCode).toBe(400);
    expect(outsideDisplay.json().error).toMatchObject({ code: 'ASSISTANT_INVALID', message: expect.stringContaining('当前预览') });
    delete legacy.rows.find((r: { id: string }) => r.id === row.id).comparisonAccountId;
    db.prepare('UPDATE assistant_pending_actions SET preview_json = ? WHERE id = ?').run(JSON.stringify(legacy), card.actionId);
    const old = await inject('GET', url);
    expect(old.statusCode).toBe(400);
    expect(old.json().error.message).toContain('重新上传');
    await inject('POST', `/api/v1/assistant/actions/${card.actionId}/cancel`, {});
    const closed = await inject('GET', url);
    expect(closed.statusCode).toBe(409);
    expect(closed.json().error.code).toBe('ASSISTANT_ACTION_STALE');
  });
  it('validates bounded query values and returns live reads without invoking AI or changing any database row', async () => {
    const { url } = await prepareComparison();
    for (const query of ['limit=0', 'limit=51', 'limit=1.5', 'limit=-1', 'cursor=', `cursor=${'x'.repeat(101)}`, 'limit=2&limit=3']) {
      const invalid = await inject('GET', `${url}?${query}`);
      expect(invalid.statusCode, query).toBe(400);
      expect(invalid.json().error).toMatchObject({ code: 'VALIDATION', message: expect.stringContaining('分页') });
    }
    const before = db.serialize();
    const calls = billCalls;
    const response = await inject('GET', url);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ total: 0, items: [], nextCursor: null, readAt: NOW });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(billCalls).toBe(calls);
    expect(db.serialize().equals(before)).toBe(true);
  });
  it('rejects the original comparison after explicit analysis replacement and an archived workspace', async () => {
    const { conversation, card, url } = await prepareComparison();
    const retry = await inject('POST', `/api/v1/assistant/actions/${card.actionId}/analyse`, { fileBase64: wechatBytes.toString('base64') });
    expect(retry.statusCode).toBe(200);
    const stale = await inject('GET', url);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('ASSISTANT_ACTION_STALE');
    await inject('DELETE', `/api/v1/assistant/conversations/${conversation.id}`);
    const archived = await inject('GET', url);
    expect(archived.statusCode).toBe(404);
    expect(archived.json().error.code).toBe('ASSISTANT_NOT_FOUND');
  });
});
