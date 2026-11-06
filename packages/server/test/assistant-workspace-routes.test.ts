import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { initializeDatabase, closeDatabase, type Db } from '../src/db/index.js';
import { AuthService } from '../src/services/auth-service.js';
import { AiConfigService } from '../src/services/ai-config-service.js';
import { TransactionService } from '../src/services/transaction-service.js';
import type { AssistantGenerationSnapshot } from '../src/services/assistant-stream-types.js';
import type { AssistantMessageDto } from '../src/services/assistant-types.js';
import { AssistantWorkspaceStore } from '../src/services/assistant-workspace-store.js';
import { AssistantTraceStore, summarizeToolArguments } from '../src/services/assistant-trace-service.js';
import { ItemService } from '../src/services/item-service.js';
import { RecurringService } from '../src/services/recurring-service.js';
import { FinancialGoalsService } from '../src/services/financial-goals-service.js';
import { assistantBusinessFingerprint } from '../src/services/assistant-business-fingerprint.js';
import { AssistantConversationService } from '../src/services/assistant-conversation-service.js';
import { AssistantGenerationService } from '../src/services/assistant-generation-service.js';

const NOW = Date.UTC(2026, 10, 6, 14);
const PREFIX = '/api/v1/assistant';
const KEY = 'ab'.repeat(32);
let db: Db; let app: FastifyInstance; let directory: string; let cookie: string;
let turns: Record<string, unknown>[]; let prompts: string[];
async function request(method: 'GET' | 'POST' | 'DELETE', url: string, payload?: Record<string, unknown>) {
  return app.inject({ method, url: `${PREFIX}${url}`, headers: { cookie, 'x-requested-with': 'fetch' }, ...(payload === undefined ? {} : { payload }) });
}
async function conversation(): Promise<string> { return (await request('POST', '/conversations', {})).json<{ id: string }>().id; }
async function terminal(cid: string, id: string): Promise<AssistantGenerationSnapshot> {
  for (let index = 0; index < 400; index++) {
    const response = await request('GET', `/conversations/${cid}/generations/${id}`);
    expect(response.statusCode).toBe(200);
    const value = response.json<{ generation: AssistantGenerationSnapshot }>().generation;
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(value.status)) return value;
    await new Promise((done) => setTimeout(done, 2));
  }
  throw new Error('generation did not reach terminal');
}
async function generate(cid: string, text: string, key = 'initial', enabled = true) {
  const response = await request('POST', `/conversations/${cid}/generations`, { version: 1, clientRequestId: key, input: { type: 'text', text }, ...(enabled ? { clientCapabilities: ['workspace-v1'] } : {}) });
  expect(response.statusCode, response.body).toBe(202);
  return terminal(cid, response.json<{ generation: AssistantGenerationSnapshot }>().generation.id);
}
function messages(snapshot: AssistantGenerationSnapshot): AssistantMessageDto[] { return snapshot.messages as AssistantMessageDto[]; }
function selection(snapshot: AssistantGenerationSnapshot): Record<string, unknown> {
  expect(snapshot.status, JSON.stringify(snapshot.error)).toBe('completed');
  const result = messages(snapshot).find((m) => m.content.result?.data['workspace']);
  return result!.content.result!.data['workspace'] as Record<string, unknown>;
}
async function answer(cid: string, iid: string, ids: string[], key: string) {
  const response = await request('POST', `/conversations/${cid}/workspace/interactions/${iid}/answer`, { clientRequestId: key, selectedIds: ids });
  expect(response.statusCode, response.body).toBe(202);
  return terminal(cid, response.json<{ generation: AssistantGenerationSnapshot }>().generation.id);
}
function count(table = 'transactions'): number { return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n; }

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'workspace-routes-'));
  db = new Database(':memory:'); db.pragma('foreign_keys=ON'); initializeDatabase(db, null);
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', JIZHANG_USERNAME: 'quiz', JIZHANG_PASSWORD_HASH: 'unused', JIZHANG_AI_ENCRYPTION_KEY: KEY, DATA_DIR: directory });
  const auth = new AuthService(db, { sessionTtlDays: 30, now: () => NOW });
  await auth.setPassword('quiz', 'correct horse battery staple');
  new AiConfigService(db, { aiEncryptionKey: KEY, production: false, now: () => NOW }).save({ enabled: true, mode: 'chat-completions', name: 'scripted', url: 'https://provider.example.test/v1/chat/completions', method: 'POST', model: 'test', timeoutMs: 5000, headers: {}, auth: { kind: 'bearer' }, bodyTemplate: null, responsePath: 'choices[0].message.content', secret: 'isolated-test-secret' });
  turns = []; prompts = [];
  app = buildApp({ db, config, authService: auth, secureCookies: false, now: () => NOW, generationStepDelayMs: 0,
    fetchImpl: async (_url, init) => {
      prompts.push(String(init?.body));
      const next = turns.shift(); if (!next) throw new Error('No scripted response remaining');
      const content = JSON.stringify({ message: '正在核对。', toolCall: null, ...next });
      if (JSON.parse(String(init?.body)).stream === true) {
        const frame = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        return new Response(frame({ content }) + frame({}, 'stop') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { headers: { 'content-type': 'application/json' } });
    },
  });
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { 'x-requested-with': 'fetch' }, payload: { username: 'quiz', password: 'correct horse battery staple' } });
  cookie = String(login.headers['set-cookie']).split(';')[0]!;
});
afterEach(async () => { await app.close(); closeDatabase(db); rmSync(directory, { recursive: true, force: true }); });

describe('negotiated durable conversational workspace', () => {
  it('selects from multiple pages, revises28to35, confirms exactly once and resumes the original task with verified facts', async () => {
    for (let index = 0; index < 75; index++) db.prepare('INSERT INTO accounts(id,name,type,initial_balance_cents,deleted,updated_at) VALUES(?,?,0,0,0,?)').run(`page-account-${index}`, `账户${String(index).padStart(2, '0')}`, NOW);
    const cid = await conversation();
    turns.push({ toolCall: { name: 'workspace.select', arguments: { kind: 'account', question: '选择午餐账户' } } });
    const first = await generate(cid, '记午餐28元，先选账户和分类，确认后继续说明这笔记录。');
    expect(first.status).toBe('completed'); const accountCard = selection(first); const iid = String(accountCard['id']);
    expect(accountCard['page']).toMatchObject({ total: 76, hasMore: true });
    const page = await request('GET', `/conversations/${cid}/workspace/interactions/${iid}?offset=60&limit=20`);
    expect(page.statusCode).toBe(200);
    const selectedAccount = page.json<{ interaction: { items: { id: string }[] } }>().interaction.items.at(-1)!.id;
    const calls = prompts.length;
    expect((await request('GET', `/conversations/${cid}/workspace/interactions/${iid}?q=账户74`)).json().interaction.items).toHaveLength(1);
    expect(prompts).toHaveLength(calls);
    turns.push({ toolCall: { name: 'workspace.select', arguments: { kind: 'category', question: '选择支出分类', type: 0 } } });
    const categoryTurn = await answer(cid, iid, [selectedAccount], 'account-choice');
    expect(prompts.at(-1)).toContain(selectedAccount); expect(prompts.at(-1)).toContain('记午餐28元');
    const categoryCard = selection(categoryTurn);
    turns.push({ toolCall: { name: 'transaction.create', arguments: { type: 'expense', amountCents: 2800, accountId: selectedAccount, categoryId: 'builtin-expense-food', date: NOW, note: '午餐' } } });
    const preview = await answer(cid, String(categoryCard['id']), ['builtin-expense-food'], 'category-choice');
    expect(preview.outcome).toBe('pending-confirmation'); expect(count()).toBe(0);
    const oldId = messages(preview).find((m) => m.content.card)!.content.card!.actionId;
    const original = (await request('GET', `/conversations/${cid}/workspace/actions/${oldId}`)).json().action;
    expect(original.inputSchema.properties.amountCents).toBeDefined();
    const revision = await request('POST', `/conversations/${cid}/workspace/actions/${oldId}/revise`, { clientRequestId: 'change-35', arguments: { ...original.arguments, amountCents: 3500 } });
    expect(revision.statusCode, revision.body).toBe(200); expect(count()).toBe(0);
    const newId = revision.json().action.id as string;
    expect(newId).not.toBe(oldId);
    expect((await request('POST', `/actions/${oldId}/confirm`, {})).statusCode).toBe(409);
    const duplicateRevision = await request('POST', `/conversations/${cid}/workspace/actions/${oldId}/revise`, { clientRequestId: 'change-35', arguments: { ...original.arguments, amountCents: 3500 } });
    expect(duplicateRevision.json().action.id).toBe(newId);
    const reordered = Object.fromEntries(Object.entries({ ...original.arguments, amountCents: 3500 }).reverse());
    expect((await request('POST', `/conversations/${cid}/workspace/actions/${oldId}/revise`, { arguments: reordered, clientRequestId: 'change-35' })).json().action.id).toBe(newId);
    expect((await request('POST', `/actions/${newId}/confirm`, {})).statusCode).toBe(200);
    expect((await request('POST', `/actions/${newId}/confirm`, {})).statusCode).toBe(200);
    expect(count()).toBe(1); expect((db.prepare('SELECT amount_cents FROM transactions').get() as { amount_cents: number }).amount_cents).toBe(3500);
    turns.push({ message: '已核对，35元午餐支出只记录了一次。' });
    // Simulate a crash after pending/card commit but before the secondary action index.
    db.prepare('DELETE FROM assistant_workspace_actions WHERE action_id=?').run(newId);
    const continued = await request('POST', `/conversations/${cid}/workspace/actions/${newId}/continue`, { clientRequestId: 'continue-confirmed' });
    expect(continued.statusCode, continued.body).toBe(202);
    const completed = await terminal(cid, continued.json().generation.id);
    expect(completed.status).toBe('completed');
    expect(prompts.at(-1)).toContain('lastConfirmedAction'); expect(prompts.at(-1)).toContain('3500'); expect(prompts.at(-1)).toContain('原任务');
    const afterCalls = prompts.length;
    const again = await request('POST', `/conversations/${cid}/workspace/actions/${newId}/continue`, { clientRequestId: 'continue-after-uncertainty' });
    expect(again.statusCode).toBe(200); expect(again.json().generation.id).toBe(completed.id); expect(prompts).toHaveLength(afterCalls); expect(count()).toBe(1);
    expect((await request('GET', `/conversations/${cid}/workspace`)).json().workflow.phase).toBe('completed');
  });

  it('rejects forged membership, changed answers, foreign conversations, stale scopes and cancelled source generations', async () => {
    const cid = await conversation(); const foreign = await conversation();
    turns.push({ toolCall: { name: 'workspace.select', arguments: { kind: 'account', question: '选择账户' } } });
    const initial = await generate(cid, '选择记账账户'); const iid = String(selection(initial)['id']);
    expect((await request('GET', `/conversations/${foreign}/workspace/interactions/${iid}`)).statusCode).toBe(404);
    expect((await request('POST', `/conversations/${cid}/workspace/interactions/${iid}/answer`, { clientRequestId: 'forged', selectedIds: ['foreign-account'] })).statusCode).toBe(409);
    turns.push({ message: '已读取选择，账本未修改。' });
    const result = await answer(cid, iid, ['builtin-default-account'], 'real-choice');
    const same = await request('POST', `/conversations/${cid}/workspace/interactions/${iid}/answer`, { clientRequestId: 'real-choice', selectedIds: ['builtin-default-account'] });
    expect(same.statusCode).toBe(200); expect(same.json().generation.id).toBe(result.id);
    expect((await request('POST', `/conversations/${cid}/workspace/interactions/${iid}/answer`, { clientRequestId: 'new-choice', selectedIds: ['changed'] })).statusCode).toBe(409);
    turns.push({ toolCall: { name: 'workspace.select', arguments: { kind: 'account', question: '重新选择' } } });
    const stale = await generate(cid, '再选账户', 'stale-scope'); const staleId = String(selection(stale)['id']);
    db.prepare('UPDATE accounts SET updated_at=updated_at+1 WHERE id=?').run('builtin-default-account');
    expect((await request('POST', `/conversations/${cid}/workspace/interactions/${staleId}/answer`, { clientRequestId: 'stale', selectedIds: ['builtin-default-account'] })).statusCode).toBe(409);
    expect(count()).toBe(0);
  });

  it('pages original result filters and prepares only explicit structural choices without inference', async () => {
    const c = new TransactionService(db, { now: () => NOW });
    for (let index = 0; index < 5; index++) c.create({ type: 0, amountCents: 100 + index, accountId: 'builtin-default-account', categoryId: 'builtin-expense-food', date: NOW, note: 'scope-marker' });
    c.create({ type: 0, amountCents: 999, accountId: 'builtin-default-account', categoryId: 'builtin-expense-food', date: NOW, note: 'excluded-record' });
    const cid = await conversation();
    turns.push({ toolCall: { name: 'transactions.query', arguments: { type: 0, q: 'scope-marker', limit: 2, offset: 0 } } }, { message: '已读取第一页。' });
    const initial = await generate(cid, '查scope-marker支出'); const resultMessage = messages(initial).find((m) => m.content.result?.toolName === 'transactions.query')!;
    const before = prompts.length;
    const next = await request('POST', `/conversations/${cid}/workspace/results/${resultMessage.id}/page`, { offset: 2, limit: 2 });
    expect(next.statusCode, next.body).toBe(200); expect(next.json().result.data).toMatchObject({ total: 5, offset: 2 });
    expect(prompts).toHaveLength(before);
    const foreign = await conversation(); expect((await request('POST', `/conversations/${foreign}/workspace/results/${resultMessage.id}/page`, { offset: 2, limit: 2 })).statusCode).toBe(404);
  });

  it('keeps old requests working and never advertises workspace-only tools to old generations', async () => {
    const cid = await conversation(); turns.push({ message: '普通旧版回答' });
    expect((await generate(cid, '你好', 'old-client', false)).status).toBe('completed');
    expect((await request('POST', `/conversations/${cid}/generations`, { version: 1, clientRequestId: 'old-client', clientCapabilities: ['workspace-v1'], input: { type: 'text', text: '你好' } })).statusCode).toBe(409);
    const system = JSON.parse(prompts[0]!).messages[0].content as string;
    expect(system).not.toContain('"name":"workspace.select"');
    expect(system).not.toContain('"name":"capabilities.list"');
    const capabilities = (await request('GET', '/workspace/capabilities')).json();
    expect(capabilities.items).toContainEqual(expect.objectContaining({ name: 'transaction.update', access: 'write' }));
    expect(capabilities.nativeActions).toContainEqual(expect.objectContaining({ destination: 'invitations', requiresCapability: 'manageInvitations' }));
    expect(capabilities.items.some((v: { name: string }) => v.name === 'template.create')).toBe(false);
    expect((await request('POST', `/conversations/${cid}/generations`, { version: 1, clientRequestId: 'bad-feature', clientCapabilities: ['arbitrary'], input: { type: 'text', text: 'x' } })).statusCode).toBe(400);
    turns.push({ toolCall: { name: 'workspace.select', arguments: { kind: 'account', question: '不应创建的旧客户端卡片' } } });
    expect((await generate(cid, '旧客户端请求', 'unnegotiated-provider', false)).status).toBe('failed');
    expect(count('assistant_interactions')).toBe(0); expect(count('assistant_workflows')).toBe(0);
  });

  it('preloads exact daily facts including more than200 salaries, replays taps, and blocks a provider write at the runner boundary', async () => {
    const from = Date.UTC(2026, 10, 5, 16);
    for (let index = 0; index < 205; index++) db.prepare('INSERT INTO salary_records(id,amount_cents,date,account_id,note,deleted,updated_at) VALUES(?,?,?,? ,\'\',0,?)').run(`salary-${index}`, 100, from + 1000, 'builtin-default-account', NOW);
    const service = new TransactionService(db, { now: () => NOW });
    const original = service.create({ type: 0, amountCents: 1000, accountId: 'builtin-default-account', categoryId: 'builtin-expense-food', date: from + 2000 });
    service.create({ type: 1, amountCents: 300, accountId: 'builtin-default-account', categoryId: 'builtin-income-other', date: from + 3000, isRefund: true, refundLinkedTxIds: [original.id] });
    service.create({ type: 0, amountCents: 9999, accountId: 'builtin-default-account', categoryId: 'builtin-expense-food', date: from - 1 });
    const before = count(); const cid = await conversation();
    turns.push({ toolCall: { name: 'transaction.delete', arguments: { id: original.id } } });
    const input = { clientRequestId: 'notification-delivery-once', date: '2026-11-06', timeZone: 'Asia/Shanghai' };
    const response = await request('POST', `/conversations/${cid}/workspace/daily-review`, input);
    expect(response.statusCode, response.body).toBe(202);
    const result = await terminal(cid, response.json().generation.id);
    expect(result.status).toBe('completed'); expect(result.outcome).toBe('answer');
    const facts = messages(result).find((m) => m.content.result?.toolName === 'daily.review')!.content.result!.data;
    expect(facts['totals']).toMatchObject({ salaryCents: 20500, salaryCount: 205, ordinaryIncomeCents: 300, incomeCents: 20800, expenseCents: 1000, refundIncomeCents: 300 });
    expect(count()).toBe(before); expect(count('assistant_pending_actions')).toBe(0); expect(prompts).toHaveLength(1);
    const replay = await request('POST', `/conversations/${cid}/workspace/daily-review`, input);
    expect(replay.statusCode).toBe(200); expect(replay.json().generation.id).toBe(result.id); expect(prompts).toHaveLength(1);
    const reordered = await request('POST', `/conversations/${cid}/workspace/daily-review`, { timeZone: input.timeZone, date: input.date, clientRequestId: input.clientRequestId });
    expect(reordered.statusCode).toBe(200); expect(reordered.json().generation.id).toBe(result.id); expect(prompts).toHaveLength(1);
    expect((await request('POST', `/conversations/${cid}/workspace/daily-review`, { ...input, date: '2026-11-07' })).statusCode).toBe(409);
  });

  it('reviews an empty day without fabricated amounts or background generation', async () => {
    const cid = await conversation(); expect(prompts).toHaveLength(0); turns.push({ message: '这一天没有收支记录。' });
    const response = await request('POST', `/conversations/${cid}/workspace/daily-review`, { clientRequestId: 'empty-day', date: '2026-11-07', timeZone: 'Asia/Shanghai' });
    const result = await terminal(cid, response.json().generation.id);
    expect(messages(result).find((m) => m.content.result)?.content.result?.data['totals']).toMatchObject({ incomeCents: 0, expenseCents: 0, transactionCount: 0 });
  });

  it('inherits daily read-only authority after typed selection and legacy clarification continuation', async () => {
    const cid = await conversation();
    turns.push({ toolCall: { name: 'workspace.select', arguments: { kind: 'account', question: '查看哪个账户' } } });
    const launched = await request('POST', `/conversations/${cid}/workspace/daily-review`, { clientRequestId: 'daily-with-selection', date: '2026-11-06', timeZone: 'Asia/Shanghai' });
    const first = await terminal(cid, launched.json().generation.id); const iid = String(selection(first)['id']);
    turns.push({ toolCall: { name: 'account.delete', arguments: { id: 'builtin-default-account' } } });
    const resumed = await answer(cid, iid, ['builtin-default-account'], 'daily-account');
    expect(resumed.status).toBe('completed'); expect(count('assistant_pending_actions')).toBe(0);
    expect(db.prepare('SELECT deleted FROM accounts WHERE id=?').get('builtin-default-account')).toEqual({ deleted: 0 });
    expect((new AssistantWorkspaceStore(db, () => NOW).facts(resumed.id)!['dailyReview'])).toMatchObject({ date: '2026-11-06' });
    expect(JSON.parse(prompts.at(-1)!).messages[0].content).not.toContain('"name":"account.delete"');
    turns.push({ message: '请选择复盘方式', clarification: { question: '怎样展示？', options: ['简短', '详细'] } });
    const clarifiedLaunch = await request('POST', `/conversations/${cid}/workspace/daily-review`, { clientRequestId: 'daily-with-question', date: '2026-11-06', timeZone: 'Asia/Shanghai' });
    const clarification = await terminal(cid, clarifiedLaunch.json().generation.id);
    const question = messages(clarification).find((m) => m.content.clarification)!.content.clarification!;
    turns.push({ toolCall: { name: 'tag.create', arguments: { name: 'must-not-create' } } });
    const reply = await request('POST', `/conversations/${cid}/generations`, { version: 1, clientRequestId: 'daily-question-answer', clientCapabilities: ['workspace-v1'], input: { type: 'choice', sourceGenerationId: clarification.id, questionId: question.id, optionId: question.options[0]!.id } });
    const done = await terminal(cid, reply.json().generation.id);
    expect(done.status).toBe('completed'); expect(count('assistant_pending_actions')).toBe(0); expect(count('tags')).toBe(0);
  });

  it.each(['item', 'recurring', 'recurring-occurrence', 'goal', 'fund-source', 'transfer', 'trash'] as const)('uses actual paged %s choices rather than model labels', async (kind) => {
    let target: string;
    if (kind === 'item') target = new ItemService(db, { now: () => NOW }).create({ name: '真实物品', purchaseDate: NOW }).id;
    else if (kind === 'recurring' || kind === 'recurring-occurrence') {
      const service = new RecurringService(db, { now: () => NOW });
      const rule = service.createRule({ name: '真实周期规则', type: 0, amountCents: 100, categoryId: 'builtin-expense-food', accountId: 'builtin-default-account', frequency: 'monthly', anchorDate: NOW - 86400000 });
      service.generateDue(); target = kind === 'recurring' ? rule.id : service.listPending()[0]!.id;
    } else if (kind === 'goal') {
      const service = new FinancialGoalsService(db, { now: () => NOW });
      service.putOpening({ operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', expectedRevision: 0, goal: 'reserve', openingCents: 0, openingAt: NOW - 1 });
      const created = service.createEntry({ operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', expectedRevision: 1, goal: 'reserve', kind: 'deposit', amountCents: 100, date: NOW, note: '真实目标' });
      target = created.body.entry!.id;
    } else if (kind === 'fund-source') {
      db.prepare('INSERT INTO salary_records(id,amount_cents,date,account_id,note,deleted,updated_at) VALUES(\'real-source\',100,?,\'builtin-default-account\',\'真实来源\',0,?)').run(NOW, NOW); target = 'real-source';
    } else if (kind === 'transfer') {
      db.prepare('INSERT INTO accounts(id,name,type,updated_at) VALUES(\'to-account\',\'转入账户\',0,?)').run(NOW);
      const response = await app.inject({ method: 'POST', url: '/api/v1/transfers', headers: { cookie, 'x-requested-with': 'fetch' }, payload: { fromAccountId: 'builtin-default-account', toAccountId: 'to-account', amountCents: 100, date: NOW } });
      target = response.json().id;
    } else {
      const service = new TransactionService(db, { now: () => NOW }); const tx = service.create({ type: 0, amountCents: 100, categoryId: 'builtin-expense-food', accountId: 'builtin-default-account', date: NOW }); service.softDelete(tx.id); target = tx.id;
    }
    const cid = await conversation(); const before = assistantBusinessFingerprint(db, 'test', {}, NOW);
    turns.push({ toolCall: { name: 'workspace.select', arguments: { kind, question: '请选择实际记录' } } });
    const first = await generate(cid, `选择${kind}`); const card = selection(first);
    expect(card['items']).toEqual(expect.arrayContaining([expect.objectContaining({ id: target })]));
    if (kind === 'fund-source') expect((card['items'] as { facts: { expectedSourceToken: string } }[])[0]?.facts.expectedSourceToken).toMatch(/^[a-f0-9]{64}$/);
    turns.push({ message: '已核对选择，不执行修改。' }); await answer(cid, String(card['id']), [target], `choose-${kind}`);
    expect(assistantBusinessFingerprint(db, 'test', {}, NOW)).toBe(before);
  });

  it('keeps exact date and account/category filters while selecting from a ledger larger than10000', async () => {
    const insert = db.prepare("INSERT INTO transactions(id,type,amount_cents,category_id,account_id,date,note,tags_json,is_refund,deleted,updated_at) VALUES(?,0,100,'builtin-expense-food','builtin-default-account',?,'scope','[]',0,0,?)");
    db.transaction(() => { for (let index = 0; index < 10002; index++) insert.run(`scope-${index}`, index < 10000 ? NOW - 86400000 : NOW, NOW); })();
    const cid = await conversation(); turns.push({ toolCall: { name: 'workspace.select', arguments: { kind: 'transaction', question: '选择今天账单', from: NOW, to: NOW + 1, accountId: 'builtin-default-account', categoryId: 'builtin-expense-food', multiple: true } } });
    const first = await generate(cid, '只选今天这个账户的餐饮支出'); const card = selection(first);
    expect(card['page']).toMatchObject({ total: 2 });
    const ids = (card['items'] as { id: string }[]).map((v) => v.id);
    expect(ids.sort()).toEqual(['scope-10000', 'scope-10001']);
    turns.push({ message: '已选择两笔，未修改账本。' }); const next = await answer(cid, String(card['id']), ids, 'exact-filter');
    expect(next.status).toBe('completed');
    const captured = new AssistantWorkspaceStore(db, () => NOW).facts(next.id)!;
    expect(captured['selection_transaction']).toMatchObject({ selectedIds: ids });
  });

  it('carries an inclusive date-range choice into the next bill selector and makes a confirmed linked refund', async () => {
    const service = new TransactionService(db, { now: () => NOW });
    const expenses = Array.from({ length: 9 }, (_, index) => service.create({ type: 0, amountCents: 1000 + index, accountId: 'builtin-default-account', categoryId: 'builtin-expense-food', date: NOW - index * 1000, note: '同名午餐' }));
    service.create({ type: 0, amountCents: 8000, accountId: 'builtin-default-account', categoryId: 'builtin-expense-food', date: NOW - 86400000, note: '同名午餐' });
    const cid = await conversation(); turns.push({ toolCall: { name: 'workspace.select', arguments: { kind: 'date-range', question: '选择原支出日期' } } });
    const initial = await generate(cid, '选一笔旧支出记退款，确认后给我结果'); const dateCard = selection(initial);
    turns.push({ toolCall: { name: 'workspace.select', arguments: { kind: 'transaction', question: '选择同名支出中的正确一笔', type: 0 } } });
    const selectedDate = await request('POST', `/conversations/${cid}/workspace/interactions/${String(dateCard['id'])}/answer`, { clientRequestId: 'refund-date', dateRange: { from: '2026-11-06', to: '2026-11-06', timeZone: 'Asia/Shanghai' } });
    expect(selectedDate.statusCode, selectedDate.body).toBe(202); const billTurn = await terminal(cid, selectedDate.json().generation.id); const billCard = selection(billTurn);
    expect(billCard['page']).toMatchObject({ total: 9 });
    const original = expenses[8]!;
    turns.push({ toolCall: { name: 'transaction.create', arguments: { type: 'income', amountCents: 300, accountId: original.accountId, categoryId: 'builtin-income-other', date: NOW, note: '退款', isRefund: true, refundLinkedTxIds: [original.id] } } });
    const preview = await answer(cid, String(billCard['id']), [original.id], 'refund-original'); expect(prompts.at(-1)).toContain(original.id);
    const actionId = messages(preview).find((m) => m.content.card)!.content.card!.actionId; expect(count()).toBe(10);
    const confirmed = await request('POST', `/actions/${actionId}/confirm`, {}); expect(confirmed.statusCode, confirmed.body).toBe(200);
    expect(count()).toBe(11); const linked = service.getByIdOrThrow(original.id); expect(linked.amountCents).toBe(original.amountCents); expect(linked.refundDetails).toHaveLength(1);
    const refund = service.getByIdOrThrow(linked.refundDetails![0]!.id); expect(refund).toMatchObject({ type: 1, isRefund: true, amountCents: 300, refundLinkedTxIds: [original.id] });
    turns.push({ message: '退款收入已关联原支出；原支出金额保持不变。' }); const continued = await request('POST', `/conversations/${cid}/workspace/actions/${actionId}/continue`, { clientRequestId: 'refund-report' });
    expect((await terminal(cid, continued.json().generation.id)).status).toBe('completed'); expect(count()).toBe(11);
  });

  it('reconciles archive, cancelled approvals and interrupted startup without rerunning inference', async () => {
    const cid = await conversation(); turns.push({ toolCall: { name: 'workspace.select', arguments: { kind: 'account', question: '等待选择' } } });
    const first = await generate(cid, '选择一个账户'); const iid = String(selection(first)['id']);
    expect((await request('DELETE', `/conversations/${cid}`)).statusCode).toBe(200);
    expect((await request('GET', `/conversations/${cid}/workspace`)).statusCode).toBe(404);
    expect(new AssistantWorkspaceStore(db, () => NOW).workflow(cid)?.['phase']).toBe('cancelled');
    expect(db.prepare('SELECT status FROM assistant_interactions WHERE id=?').get(iid)).toEqual({ status: 'cancelled' });
    const second = await conversation(); turns.push({ toolCall: { name: 'plan.save', arguments: { monthlyIncomeCents: 800000, essentialMonthlyCents: 300000, reserveBalanceCents: 600000, expectedRevision: 0 } } });
    const pending = await generate(second, '修改计划'); const action = messages(pending).find((m) => m.content.card)!.content.card!.actionId;
    await request('POST', `/actions/${action}/cancel`, {});
    expect((await request('GET', `/conversations/${second}/workspace`)).json().workflow.phase).toBe('cancelled');
    const third = await conversation(); const conversations = new AssistantConversationService(db, () => NOW); const generations = new AssistantGenerationService(db, conversations, () => NOW); const store = new AssistantWorkspaceStore(db, () => NOW);
    const unfinished = generations.create(third, { version: 1, clientRequestId: 'before-crash', input: { type: 'text', text: '中断前的任务' } }, { delivery: 'buffered', today: '2026-11-06' });
    store.bind(third, unfinished.generation.id, '中断前的任务'); const beforeCalls = prompts.length;
    expect(generations.recoverUnfinished()).toBe(1); store.reconcile();
    expect(store.workflow(third)?.['phase']).toBe('cancelled'); expect(prompts).toHaveLength(beforeCalls);
  });

  it('retains two selections of the same resource kind for a transfer instead of overwriting the first account', async () => {
    db.prepare('INSERT INTO accounts(id,name,type,updated_at) VALUES(\'destination-account\',\'第二个账户\',0,?)').run(NOW);
    const cid = await conversation(); turns.push({ toolCall: { name: 'workspace.select', arguments: { kind: 'account', question: '选择转出账户' } } });
    const first = await generate(cid, '从一个账户转100元到另一个账户，先逐个让我选择');
    turns.push({ toolCall: { name: 'workspace.select', arguments: { kind: 'account', question: '选择转入账户' } } });
    const second = await answer(cid, String(selection(first)['id']), ['builtin-default-account'], 'transfer-from');
    turns.push({ toolCall: { name: 'transfer.create', arguments: { fromAccountId: 'builtin-default-account', toAccountId: 'destination-account', amountCents: 10000, date: NOW } } });
    const third = await answer(cid, String(selection(second)['id']), ['destination-account'], 'transfer-to');
    const facts = new AssistantWorkspaceStore(db, () => NOW).facts(third.id)!;
    expect(facts['selections']).toEqual([expect.objectContaining({ question: '选择转出账户', selectedIds: ['builtin-default-account'] }), expect.objectContaining({ question: '选择转入账户', selectedIds: ['destination-account'] })]);
    expect(third.outcome).toBe('pending-confirmation'); expect(count('transfers')).toBe(0);
  });

  it('pages structural suggestions and prepares only selected actions without another model request', async () => {
    for (let index = 0; index < 40; index++) for (const suffix of ['a', 'b']) db.prepare("INSERT INTO categories(id,name,type,parent_id,icon,color,sort_order,is_builtin,deleted,updated_at) VALUES(?,?,0,NULL,'folder',1,20,0,0,?)").run(`merge-${index}-${suffix}`, `同名组${index}`, NOW);
    const cid = await conversation(); turns.push({ toolCall: { name: 'organization.preview', arguments: { offset: 0, limit: 10 } } }, { message: '请选择需要整理的分类。' });
    const initial = await generate(cid, '整理重名分类'); const message = messages(initial).find((m) => m.content.result?.toolName === 'organization.preview')!;
    expect(message.content.result!.data['hasMore']).toBe(true);
    const calls = prompts.length; const page = await request('POST', `/conversations/${cid}/workspace/results/${message.id}/page`, { offset: 10, limit: 10 });
    expect(page.statusCode, page.body).toBe(200); expect(page.json().result.data.previewHash).toBe(message.content.result!.data['previewHash']);
    const selected = page.json().result.data.actions.filter((v: { status: string }) => v.status === 'ready').slice(0, 2).map((v: { actionId: string }) => v.actionId);
    expect(selected).toHaveLength(2);
    const prepared = await request('POST', `/conversations/${cid}/workspace/organization/prepare`, { clientRequestId: 'selected-merges', kind: 'structural', previewMessageId: message.id, actionIds: selected });
    expect(prepared.statusCode, prepared.body).toBe(200); expect(prompts).toHaveLength(calls);
    expect(prepared.json().messages.at(-1).content.card.affected.count).toBe(2);
    expect((db.prepare('SELECT COUNT(*) AS n FROM categories WHERE deleted=1').get() as { n: number }).n).toBe(0);
    const actionId = prepared.json().action.id as string;
    expect((await request('POST', `/actions/${actionId}/confirm`, {})).statusCode).toBe(200);
    expect((db.prepare('SELECT COUNT(*) AS n FROM categories WHERE deleted=1').get() as { n: number }).n).toBe(2);
    turns.push({ message: '已应用所选两项并核对结果。' }); const resumed = await request('POST', `/conversations/${cid}/workspace/actions/${actionId}/continue`, { clientRequestId: 'structural-report' });
    expect((await terminal(cid, resumed.json().generation.id)).status).toBe('completed');
    expect(new AssistantWorkspaceStore(db, () => NOW).facts(resumed.json().generation.id)?.['originalRequest']).toBe('整理重名分类');
  });

  it('keeps credential URLs and unknown native destinations outside the tool boundary', async () => {
    const cid = await conversation(); turns.push({ toolCall: { name: 'workspace.open', arguments: { destination: 'provider-settings' } } });
    const result = await generate(cid, '打开模型设置');
    expect(result.status, JSON.stringify(result.error)).toBe('completed'); expect(messages(result).find((m) => m.content.result)?.content.result?.data['nativeAction']).toEqual({ destination: 'provider-settings' });
    const store = new AssistantWorkspaceStore(db, () => NOW); expect(store.enabled(result.id)).toBe(true);
  });

  it.each([
    { name: 'plan.save', args: { monthlyIncomeCents: 800000, essentialMonthlyCents: 300000, reserveBalanceCents: 600000, expectedRevision: 0 }, edit: { monthlyIncomeCents: 900000 } },
    { name: 'funds.configure', args: { expectedRevision: 0, ratiosBps: { growth: 2500, reserve: 2500, essentials: 4000, joy: 1000 }, timeZone: 'Asia/Shanghai' }, edit: { ratiosBps: { growth: 3000, reserve: 2500, essentials: 3500, joy: 1000 } } },
    { name: 'category.create', args: { name: '待审核分类', type: 0 }, edit: { name: '已审核分类' } },
    { name: 'tag.create', args: { name: '待审核标签' }, edit: { name: '已审核标签' } },
    { name: 'account.create', args: { name: '待审核账户', type: 0 }, edit: { name: '已审核账户' } },
    { name: 'item.create', args: { name: '待审核物品', purchaseDate: NOW }, edit: { name: '已审核物品' } },
    { name: 'recurring.create', args: { name: '待审核周期规则', type: 0, amountCents: 100, categoryId: 'builtin-expense-food', accountId: 'builtin-default-account', frequency: 'monthly', anchorDate: NOW }, edit: { amountCents: 200 } },
    { name: 'goals.opening', args: { goal: 'reserve', openingCents: 10000, openingAt: NOW - 1, expectedRevision: 0 }, edit: { openingCents: 12000 } },
  ])('revises $name through real generation/domain approval and pauses again for a later write', async ({ name, args, edit }) => {
    const cid = await conversation(); const before = assistantBusinessFingerprint(db, 'test', {}, NOW);
    turns.push({ toolCall: { name, arguments: args } });
    const first = await generate(cid, `先${name}，确认后再帮我记一笔支出`);
    expect(first.outcome, JSON.stringify(first.error)).toBe('pending-confirmation'); expect(assistantBusinessFingerprint(db, 'test', {}, NOW)).toBe(before);
    const firstId = messages(first).find((m) => m.content.card)!.content.card!.actionId;
    const draft = (await request('GET', `/conversations/${cid}/workspace/actions/${firstId}`)).json().action;
    if ('expectedRevision' in draft.arguments) {
      const omitted = { ...draft.arguments }; delete omitted.expectedRevision;
      expect((await request('POST', `/conversations/${cid}/workspace/actions/${firstId}/revise`, { clientRequestId: 'invalid-omission', arguments: omitted })).statusCode).toBe(400);
    }
    const revised = await request('POST', `/conversations/${cid}/workspace/actions/${firstId}/revise`, { clientRequestId: 'domain-revise', arguments: { ...draft.arguments, ...edit } });
    expect(revised.statusCode, revised.body).toBe(200); expect(assistantBusinessFingerprint(db, 'test', {}, NOW)).toBe(before);
    const id = revised.json().action.id as string;
    expect((await request('POST', `/actions/${id}/confirm`, {})).statusCode).toBe(200);
    const afterApproved = assistantBusinessFingerprint(db, 'test', {}, NOW); expect(afterApproved).not.toBe(before);
    turns.push({ toolCall: { name: 'transaction.create', arguments: { type: 'expense', amountCents: 300, accountId: 'builtin-default-account', categoryId: 'builtin-expense-food', date: NOW } } });
    const continuation = await request('POST', `/conversations/${cid}/workspace/actions/${id}/continue`, { clientRequestId: 'continue-domain' });
    expect(continuation.statusCode, continuation.body).toBe(202); const second = await terminal(cid, continuation.json().generation.id);
    expect(second.outcome, JSON.stringify(second.error)).toBe('pending-confirmation');
    expect(assistantBusinessFingerprint(db, 'test', {}, NOW)).toBe(afterApproved); expect(count()).toBe(0);
    const secondId = messages(second).find((m) => m.content.card)!.content.card!.actionId; expect(secondId).not.toBe(id);
    expect((await request('POST', `/actions/${secondId}/cancel`, {})).statusCode).toBe(200); expect(count()).toBe(0);
  });
});

describe('trusted reviewed CSV import and trace privacy', () => {
  it('previews without writes and confirms the same original CSV once, rejecting changed bytes and stale ledgers', async () => {
    const csv = 'id,date,type,amount,category,account,note,tags,isRefund\nreviewed-row,2026-11-06,expense,35.00,餐饮,现金,午餐,,0\n';
    // Obtain the actual existing export column format/names rather than guessing fixtures.
    const service = new TransactionService(db, { now: () => NOW });
    service.create({ type: 0, amountCents: 3500, categoryId: 'builtin-expense-food', accountId: 'builtin-default-account', date: NOW, note: 'csv source' });
    const exported = await app.inject({ method: 'GET', url: '/api/v1/export/transactions.csv', headers: { cookie } });
    const source = exported.body.replace(/(?<=\n)[^,]+,/, 'reviewed-new-id,');
    const initialCount = count(); const preview = await request('POST', '/data-import/preview', { kind: 'transactions', csv: source, clientRequestId: 'csv-preview' });
    expect(preview.statusCode, preview.body).toBe(200); expect(count()).toBe(initialCount);
    const id = preview.json().preview.id as string;
    expect(preview.json().preview.totalRows).toBe(1); expect(preview.json().preview.result.inserted).toBe(1);
    expect((await request('POST', `/data-import/${id}/confirm`, { csv })).statusCode).toBe(409);
    const confirmed = await request('POST', `/data-import/${id}/confirm`, { csv: source });
    expect(confirmed.statusCode, confirmed.body).toBe(200); expect(count()).toBe(initialCount + 1);
    expect((await request('POST', `/data-import/${id}/confirm`, { csv: source })).json()).toEqual(confirmed.json());
    expect(count()).toBe(initialCount + 1); expect(prompts).toHaveLength(0);
    expect((db.prepare('SELECT preview_json FROM assistant_csv_previews WHERE id=?').get(id) as { preview_json: string }).preview_json).not.toContain(source);
  });

  it('scrubs old trace strings/numbers and never stores new argument values or attacker-controlled keys', () => {
    const trace = new AssistantTraceStore(db, () => NOW);
    db.prepare('INSERT INTO assistant_generation_trace(id,generation_id,conversation_id,step,kind,tool_name,argument_summary,status,started_at,created_at) VALUES(\'old\',\'g\',\'c\',0,\'tool\',\'transactions.query\',\'note=SECRET salary=998877\',\'ok\',?,?)').run(NOW, NOW);
    const raw = { SECRET_KEY: 'SECRET_NOTE', amountCents: 998877, source: { secret: 'hidden' } };
    const id = trace.begin({ generationId: 'g', conversationId: 'c', step: 1, kind: 'tool', toolName: 'transaction.create', argumentSummary: summarizeToolArguments(raw) });
    trace.finish(id, 'ok');
    const listed = JSON.stringify(trace.list('g'));
    expect(listed).not.toContain('SECRET'); expect(listed).not.toContain('998877'); expect(trace.list('g')[0]?.argumentSummary).toBeNull();
    const stored = db.prepare('SELECT argument_summary FROM assistant_generation_trace WHERE id=?').get(id) as { argument_summary: string };
    expect(stored.argument_summary).not.toContain('SECRET');
  });
});
