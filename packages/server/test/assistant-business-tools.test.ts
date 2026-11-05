import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeDatabase, type Db } from '../src/db/index.js';
import { loadConfig } from '../src/config.js';
import { AssistantToolRegistry, type AssistantPreparedTool } from '../src/services/assistant-tool-registry.js';
import { AssistantConversationService } from '../src/services/assistant-conversation-service.js';
import { AssistantOrchestrator, buildAssistantContext } from '../src/services/assistant-orchestrator.js';
import { AiConfigService } from '../src/services/ai-config-service.js';
import { AiSpendingOrganizationService } from '../src/services/ai-spending-organization-service.js';
import { AiProviderService } from '../src/services/ai-provider-service.js';
import { normalizeAssistantJson, requireAssistantToolName, type AssistantJsonObject } from '../src/services/assistant-types.js';
import { seedHistoricalSalary } from './support/historical-salary-fixture.js';

const NOW = new Date(2026, 8, 22, 12).getTime();
const ACCOUNT = 'builtin-default-account';
const FOOD = 'builtin-expense-food';
const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', JIZHANG_USERNAME: 'test', JIZHANG_PASSWORD_HASH: 'unused', JIZHANG_AI_ENCRYPTION_KEY: 'ab'.repeat(32), DATA_DIR: './data' });
const registry = new AssistantToolRegistry();
let db: Db;
let context: ReturnType<typeof buildAssistantContext>['context'];
let conversations: AssistantConversationService;
let orchestrator: AssistantOrchestrator;
let providerCalls: number;
let response: unknown;
const fetchImpl: typeof fetch = async () => {
  providerCalls++;
  if (response === undefined) throw new Error('Unexpected external call during database-only preview/confirmation');
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(response) } }] }), { status: 200 });
};

beforeEach(() => {
  db = new Database(':memory:'); db.pragma('foreign_keys = ON'); initializeDatabase(db, null);
  providerCalls = 0; response = undefined;
  const options = { db, config, now: () => NOW, actorId: 'immutable-member-id', fetchImpl };
  context = buildAssistantContext(options).context;
  conversations = new AssistantConversationService(db, () => NOW);
  orchestrator = new AssistantOrchestrator({ ...options, conversations });
});
afterEach(() => db.close());

function persist(prepared: AssistantPreparedTool) {
  const conversation = conversations.create('业务验证');
  const message = conversations.appendMessage({ conversationId: conversation.id, role: 'user', kind: 'text', content: { version: 1, text: '请预览此操作' } });
  const action = conversations.createPendingAction({ conversationId: conversation.id, sourceMessageId: message.id, toolName: prepared.toolName,
    arguments: prepared.arguments, preview: prepared.preview, fingerprint: prepared.fingerprint });
  conversations.appendMessage({ conversationId: conversation.id, role: 'assistant', kind: 'tool-card', content: { version: 1, card: {
    version: 1, actionId: action.id, toolName: prepared.toolName, operation: prepared.operation, summary: prepared.summary,
    writes: true, affected: prepared.affected, values: prepared.values, warnings: prepared.warnings, fingerprint: prepared.fingerprint,
    status: 'pending', preview: prepared.preview,
  } } });
  return action;
}

async function prepare(name: string, args: AssistantJsonObject) {
  const before = db.serialize();
  const prepared = await registry.prepare(context, name, args);
  expect(db.serialize().equals(before), `${name} preview must not persist any database mutation`).toBe(true);
  return { prepared, action: persist(prepared) };
}
async function execute(name: string, args: AssistantJsonObject) {
  const { action } = await prepare(name, args);
  const first = await orchestrator.confirmAction(action.conversationId, action.id);
  const committed = db.serialize();
  const again = await orchestrator.confirmAction(action.conversationId, action.id);
  expect(again.action).toEqual(first.action);
  expect(db.serialize().equals(committed), 'duplicate confirmation must not duplicate writes').toBe(true);
  return first.action.result as AssistantJsonObject;
}
function expense(note = 'lunch') {
  return context.services.transactions.create({ type: 0, amountCents: 2500, categoryId: FOOD, accountId: ACCOUNT, date: NOW, note });
}

describe('assistant business confirmations', () => {
  it('previews then confirms expense, ordinary income and linked refund with gross totals intact', async () => {
    const categoryId = context.services.masterData.listCategories(1)[0]!.id;
    const initial = await execute('transaction.create', { type: 'expense', amountCents: 2500, categoryId: FOOD, accountId: ACCOUNT, date: NOW, note: 'expense', fundPurpose: 'essentials' });
    const originalId = (initial['transaction'] as AssistantJsonObject)['id'] as string;
    await execute('transaction.create', { type: 'income', amountCents: 5000, categoryId, accountId: ACCOUNT, date: NOW });
    const refund = await execute('transaction.create', { type: 'income', amountCents: 700, categoryId, accountId: ACCOUNT, date: NOW, isRefund: true, refundLinkedTxIds: [originalId] });
    expect(refund['transaction']).toMatchObject({ type: 1, amountCents: 700, isRefund: true, refundLinkedTxIds: [originalId] });
    const original = context.services.transactions.getByIdOrThrow(originalId);
    expect(original.amountCents).toBe(2500);
    expect(original.refundDetails).toHaveLength(1);
    expect(context.services.transactions.list().total).toBe(3);
    expect(context.services.stats.monthlyTrend(1)[0]).toMatchObject({ netExpenseCents: 2500, incomeCents: 5700 });
    expect(providerCalls).toBe(0);
  });

  it('configures funds and creates, updates and deletes canonical allocated income for a member with no ledger users', async () => {
    expect(db.prepare('SELECT * FROM users').all()).toEqual([]);
    const ratiosBps = { growth: 2500, reserve: 2500, essentials: 4000, joy: 1000 };
    await execute('funds.configure', { expectedRevision: 0, ratiosBps, timeZone: 'Asia/Shanghai' });
    const income = await execute('salary.create', { amountCents: 100_003, accountId: ACCOUNT, date: NOW, expectedFundConfigRevision: 1 });
    const salary = income['salary'] as AssistantJsonObject;
    expect(salary).toMatchObject({ amountCents: 100_003, fundGrant: { revision: 1, ratiosBps } });
    expect(db.prepare('SELECT * FROM budget_allocations').all()).toEqual([]);
    await execute('salary.update', { id: salary['id']!, expectedGrantRevision: 1, amountCents: 110_003 });
    await execute('salary.delete', { id: salary['id']!, expectedGrantRevision: 2 });
    expect(context.services.salaries.list()).toHaveLength(0);
    expect(providerCalls).toBe(0);
  });

  it('saves independent plans and tracks manual reserve without creating ledger transactions', async () => {
    await execute('plan.save', { monthlyIncomeCents: 800_000, essentialMonthlyCents: 300_000, reserveBalanceCents: 600_000, expectedRevision: 0 });
    await execute('goals.opening', { goal: 'reserve', openingCents: 10000, openingAt: NOW - 86400000, expectedRevision: 0 });
    const created = await execute('goals.create', { goal: 'reserve', kind: 'deposit', amountCents: 2000, date: NOW, note: 'saved', expectedRevision: 1 });
    const entry = created['entry'] as AssistantJsonObject;
    await execute('goals.update', { id: entry['id']!, amountCents: 3000, expectedRevision: 2 });
    await execute('goals.delete', { id: entry['id']!, expectedRevision: 3 });
    expect(context.services.transactions.list().total).toBe(0);
    expect(context.services.salaries.list()).toHaveLength(0);
    const goals = await registry.read(context, 'goals.read', { view: 'entries', goal: 'reserve', includeDeleted: true, limit: 1 });
    expect(goals.data['total']).toBe(1);
    expect(providerCalls).toBe(0);
  });

  it('creates and updates recurring rules, generates occurrences, then confirms exactly one bill', async () => {
    const created = await execute('recurring.create', { name: 'daily', type: 0, amountCents: 100, categoryId: FOOD, accountId: ACCOUNT, frequency: 'daily', anchorDate: NOW });
    const rule = created['rule'] as AssistantJsonObject;
    await execute('recurring.update', { id: rule['id']!, name: 'daily updated' });
    await execute('recurring.generate', {});
    expect(context.services.transactions.list().total).toBe(0);
    const occurrence = context.services.recurring.listPending()[0]!;
    await execute('recurring.confirm', { occurrenceId: occurrence.id });
    expect(context.services.transactions.list().total).toBe(1);
    await execute('recurring.toggle', { id: rule['id']!, enabled: false });
    await execute('recurring.delete', { id: rule['id']! });
  });

  it('manages item lifecycle without introducing a purchase or sale bill', async () => {
    const created = await execute('item.create', { name: 'camera', purchaseDate: NOW - 86400000, purchasePriceCents: 50000 });
    const id = (created['item'] as AssistantJsonObject)['id']!;
    await execute('item.update', { id, name: 'travel camera', status: 'idle' });
    await execute('item.sell', { id, closedDate: NOW - 86400000, salePriceCents: 30000 });
    expect((await registry.read(context, 'items.read', { id })).data['item']).toMatchObject({ status: 'sold' });
    await execute('item.delete', { id });
    expect(context.services.transactions.list().total).toBe(0);
  });

  it('queries all requested pages with original filters and server day/statistics windows', async () => {
    const other = context.services.masterData.createAccount({ name: 'second', type: 0 });
    for (let index = 0; index < 3; index++) expense(`coffee ${index}`);
    context.services.transactions.create({ type: 0, amountCents: 999, accountId: other.id, categoryId: FOOD, date: NOW });
    const query = { accountId: ACCOUNT, from: NOW - 1, to: NOW + 1, limit: 2, q: 'coffee' };
    const first = await registry.read(context, 'transactions.query', query);
    const second = await registry.read(context, 'transactions.query', { ...query, offset: 2 });
    expect(first.data['total']).toBe(3); expect((first.data['items'] as unknown[]).length).toBe(2);
    expect(second.data['total']).toBe(3); expect((second.data['items'] as unknown[]).length).toBe(1);
    const daily = await registry.read(context, 'transactions.daily', { from: NOW - 1, to: NOW + 1, accountId: ACCOUNT, timeZone: 'Asia/Shanghai' });
    expect(daily.data['items']).toHaveLength(1);
    const stats = await registry.read(context, 'stats.query', { view: 'categories', from: NOW - 1, to: NOW + 1, accountId: ACCOUNT });
    expect(stats.data).toHaveProperty('expenseCents', 7500);
  });

  it('preserves all pages past the assistant JSON array bound for accounts, salaries, rules and trash', async () => {
    for (let index = 0; index < 205; index++) {
      context.services.masterData.createAccount({ name: `account-${index}`, type: 0 });
      seedHistoricalSalary(db, { amountCents: 100, accountId: ACCOUNT, date: NOW, id: `salary-${index}` });
      context.services.recurring.createRule({ name: `rule-${index}`, type: 0, amountCents: 100, categoryId: FOOD, accountId: ACCOUNT, frequency: 'monthly', anchorDate: NOW });
      context.services.transactions.softDelete(expense(`deleted-${index}`).id);
    }
    for (const [name, args, expected] of [
      ['master-data.read', { kind: 'accounts' }, 206], ['accounts.balances', {}, 206], ['salaries.read', {}, 205], ['recurring.rules', {}, 205],
      ['trash.list', {}, 205],
    ] as const) {
      const collected: string[] = [];
      for (let offset = 0; offset < expected; offset += 100) {
        const result = await registry.read(context, name, { ...args, limit: 100, offset });
        expect(result.data['total']).toBe(expected);
        expect(result.data['hasMore']).toBe(offset + 100 < expected);
        collected.push(...(result.data['items'] as AssistantJsonObject[]).map((item) => (item['id'] ?? item['accountId']) as string));
      }
      expect(new Set(collected).size, name).toBe(expected);
    }
  });

  it('freezes canonical purpose edit CAS and refuses a recurring generation card after the calendar day advances', async () => {
    const original = expense();
    const edit = await prepare('transaction.update', { id: original.id, changes: { fundPurpose: 'growth' } });
    expect(edit.prepared.arguments['changes']).toMatchObject({ expectedFundPurposeRevision: 0, expectedTransactionToken: expect.stringMatching(/^[a-f0-9]{64}$/), operationId: expect.any(String) });
    await orchestrator.confirmAction(edit.action.conversationId, edit.action.id);
    expect(context.services.transactions.getByIdOrThrow(original.id).fundPurpose).toBe('growth');
    context.services.recurring.createRule({ name: 'daily', type: 0, amountCents: 100, categoryId: FOOD, accountId: ACCOUNT, frequency: 'daily', anchorDate: NOW });
    const generation = await prepare('recurring.generate', {});
    const tomorrow = new AssistantOrchestrator({ db, config, conversations, actorId: 'immutable-member-id', now: () => NOW + 86400000 });
    await expect(tomorrow.confirmAction(generation.action.conversationId, generation.action.id)).rejects.toThrow();
    expect(context.services.recurring.listOccurrences()).toEqual([]);
  });

  it('covers financial planning source, preview, confirm and refund split adapters through real contracts', async () => {
    await execute('planning.configure', { enabled: true, expectedRevision: 0, ratiosBps: { growth: 2500, reserve: 1500, essentials: 5000, joy: 1000 }, essentialMonthlyCents: 10000, targetMonths: 5, cycle: { kind: 'natural-month' }, timeZone: 'Asia/Shanghai' });
    const mapping = (await registry.read(context, 'planning.read', { view: 'mapping' })).data['mapping'] as AssistantJsonObject;
    await execute('planning.mapping', { expectedRevision: 0, expectedTopologyToken: mapping['topologyToken']!, rules: [{ categoryId: FOOD, purpose: 'essentials' }] });
    const salary = seedHistoricalSalary(db, { amountCents: 10000, accountId: ACCOUNT, date: NOW - 86400000 });
    const source = (await registry.read(context, 'planning.read', { view: 'source', id: salary.id })).data['source'] as AssistantJsonObject;
    const proposal = { periodId: null, expectedRevision: 0, expectedConfigRevision: 1, expectedMappingRevision: 1, selectedSources: [{ salaryId: salary.id, expectedSourceToken: source['sourceToken']! }], mappingPolicy: 'current', reason: 'salary-confirmation' };
    const preview = (await registry.read(context, 'planning.preview', { proposal })).data['preview'] as AssistantJsonObject;
    await execute('planning.confirm', { proposal, previewToken: preview['previewToken']! });
    const original = expense();
    const refund = context.services.transactions.create({ type: 1, amountCents: 700, categoryId: context.services.masterData.listCategories(1)[0]!.id, accountId: ACCOUNT, date: NOW, isRefund: true, refundLinkedTxIds: [original.id] });
    const review = (await registry.read(context, 'planning.read', { view: 'refund', id: refund.id })).data['refund'] as AssistantJsonObject;
    const originals = review['originals'] as AssistantJsonObject[];
    await execute('planning.refund-splits', { id: refund.id, expectedRevision: review['splitRevision'] ?? 0, expectedRefundToken: review['refundToken']!, originals: originals.map((entry) => ({ transactionId: entry['transactionId']!, expectedTransactionToken: entry['transactionToken']! })), splits: [{ originalTransactionId: original.id, amountCents: 700 }] });
  });

  it('reviews an unclaimed historical salary using the current source hash without creating another income', async () => {
    const salary = seedHistoricalSalary(db, { amountCents: 10003, accountId: ACCOUNT, date: NOW - 86400000 });
    const source = (await registry.read(context, 'planning.read', { view: 'source', id: salary.id })).data['source'] as AssistantJsonObject;
    const result = await execute('funds.review', { expectedRevision: 0, ratiosBps: { growth: 2500, reserve: 1500, essentials: 5000, joy: 1000 }, sources: [{ salaryId: salary.id, expectedSourceToken: source['sourceToken']! }] });
    expect(result['grant']).toMatchObject({ sourceAmountCents: 10003 });
    expect(context.services.salaries.count()).toBe(1);
    expect(context.services.transactions.list().total).toBe(0);
  });

  it('confirms tag, transfer and recycle-bin operations and reports actual bulk counts', async () => {
    // Template writes are gone from the assistant: allocation templates were retired in
    // favour of tags (migration 022), so the tool must not even be addressable.
    // Old persisted result messages remain decodable, but the model cannot call the tool.
    expect(requireAssistantToolName('template.create', 'toolName')).toBe('template.create');
    expect(registry.catalog().some((tool) => tool.name === 'template.create')).toBe(false);
    await expect(registry.prepare(context, 'template.create', { name: 'Assistant template', modules: [{ categoryId: FOOD, ratio: 1 }] })).rejects.toThrow();
    await expect(registry.prepare(context, 'template.delete', { id: 'builtin-default-template' })).rejects.toThrow();
    const tag = (await execute('tag.create', { name: 'Trip' }))['tag'] as AssistantJsonObject;
    await execute('tag.update', { id: tag['id']!, name: 'Travel' });
    await execute('tag.remove', { id: tag['id']! });
    const target = context.services.masterData.createAccount({ name: 'Destination', type: 0 });
    const transfer = (await execute('transfer.create', { fromAccountId: ACCOUNT, toAccountId: target.id, amountCents: 500, date: NOW }))['transfer'] as AssistantJsonObject;
    await execute('transfer.update', { id: transfer['id']!, amountCents: 700 });
    await execute('transfer.delete', { id: transfer['id']! });
    for (let index = 0; index < 3; index++) context.services.transactions.softDelete(expense().id);
    const restore = await prepare('trash.restore-all', {});
    expect(restore.prepared.affected.count).toBe(3);
    await orchestrator.confirmAction(restore.action.conversationId, restore.action.id);
    for (const row of context.services.transactions.list().items) context.services.transactions.softDelete(row.id);
    const purge = await prepare('trash.purge-all', {});
    expect(purge.prepared.affected.count).toBe(3);
    await orchestrator.confirmAction(purge.action.conversationId, purge.action.id);
    expect(context.services.transactions.countDeleted()).toBe(0);
  });

  it('rejects forged fingerprints, stale drafts, unknown fields and cross-conversation or other-ledger actions', async () => {
    const { action, prepared } = await prepare('item.create', { name: 'camera', purchaseDate: NOW - 86400000 });
    expect(() => registry.confirmInTransaction(context, 'item.create', { ...prepared.arguments, __fingerprint: 'forged' })).toThrow();
    expect(() => registry.parseArguments('item.create', { name: 'camera', purchaseDate: NOW, sql: 'delete' })).toThrow();
    await expect(orchestrator.confirmAction(conversations.create().id, action.id)).rejects.toThrow();
    const other = new Database(':memory:'); initializeDatabase(other, null);
    try {
      const foreign = new AssistantOrchestrator({ db: other, config, now: () => NOW, actorId: 'other-member', conversations: new AssistantConversationService(other, () => NOW) });
      await expect(foreign.confirmAction(action.conversationId, action.id)).rejects.toThrow();
    } finally { other.close(); }
    expense('another confirmed write after the preview');
    await expect(orchestrator.confirmAction(action.conversationId, action.id)).rejects.toThrow();
    expect(db.prepare('SELECT * FROM asset_items').all()).toEqual([]);
    expect(conversations.pending(action.id).status).toBe('pending');
  });

  it('rejects invalid business values at preview with no committed or external effects', async () => {
    const before = db.serialize();
    await expect(registry.prepare(context, 'funds.configure', { expectedRevision: 0, ratiosBps: { growth: 1, reserve: 2, essentials: 3, joy: 4 }, timeZone: 'Asia/Shanghai' })).rejects.toThrow();
    await expect(registry.prepare(context, 'salary.create', { amountCents: 1000, accountId: 'foreign-account', date: NOW, expectedFundConfigRevision: 0 })).rejects.toThrow();
    await expect(registry.prepare(context, 'item.create', { name: 'bad link', purchaseDate: NOW - 86400000, purchaseTransactionId: 'foreign-bill' })).rejects.toThrow();
    expect(db.serialize().equals(before)).toBe(true); expect(providerCalls).toBe(0);
    expect(() => normalizeAssistantJson({ accessToken: 'a'.repeat(64) })).toThrow();
    expect(normalizeAssistantJson({ expectedSourceToken: 'a'.repeat(64) })).toEqual({ expectedSourceToken: 'a'.repeat(64) });
  });
});

function enableProvider() {
  new AiConfigService(db, { aiEncryptionKey: config.aiEncryptionKey, production: false, now: () => NOW }).save({ enabled: true, mode: 'chat-completions', name: 'fixture', url: 'https://example.test/chat/completions', method: 'POST', model: 'fixture', timeoutMs: 10000, headers: {}, auth: { kind: 'none' }, bodyTemplate: null, responsePath: 'choices[0].message.content' });
}

/**
 * Starts a background analysis through the assistant tool and waits for it to finish.
 *
 * `spending.preview` returns immediately on purpose (awaiting the whole analysis inside one
 * assistant generation is what made the second turn time out), so a test that wants the card
 * must poll `spending.status` the way the model is instructed to.
 */
async function startSpending(startDate: string, endDate: string): Promise<AssistantJsonObject> {
  const preview = await registry.read(context, 'spending.preview', { startDate, endDate });
  const runId = (preview.data['run'] as AssistantJsonObject)['runId'] as string;
  for (let attempt = 0; attempt < 200; attempt++) {
    const status = await registry.read(context, 'spending.status', { runId });
    const run = status.data['run'] as AssistantJsonObject;
    if (run['status'] === 'ready') {
      const card = await registry.read(context, 'spending.card', { runId });
      return card.data;
    }
    if (run['status'] === 'failed' || run['status'] === 'cancelled') throw new Error(`analysis did not become ready: ${JSON.stringify(run)}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('analysis did not become ready in time');
}

describe('historical spending organization assistant tools', () => {
  it('analyzes without changing bills, applies only explicit choices, and conditionally undoes with an audit operation', async () => {
    enableProvider(); const original = expense('original note');
    response = { reclassifications: [], tagSuggestions: [{ transactionId: original.id, tags: ['工作餐'], reason: 'work lunch', confidence: 0.9 }], noteSuggestions: [{ transactionId: original.id, suggestedNote: 'clean note', reason: 'readable', confidence: 0.8 }], newCategories: [], templateProposals: [] };
    const beforeBills = db.prepare('SELECT * FROM transactions').all();
    const card = await startSpending('2026-09-01', '2026-09-22');
    expect(card).toMatchObject({ eligibleCount: 1, completedCount: 1, totalActions: 2, hasMore: false });
    expect(db.prepare('SELECT * FROM transactions').all()).toEqual(beforeBills);
    const actions = card['actions'] as AssistantJsonObject[];
    const note = actions.find((entry) => entry['kind'] === 'note')!;
    const tag = actions.find((entry) => entry['kind'] === 'tag')!;
    await expect(registry.prepare(context, 'spending.apply', { runId: card['runId']!, actionIds: [note['actionId']!] })).rejects.toThrow();
    await expect(registry.prepare(context, 'spending.apply', { runId: card['runId']!, actionIds: [] })).rejects.toThrow();
    const result = await execute('spending.apply', { runId: card['runId']!, actionIds: [tag['actionId']!] });
    expect(context.services.transactions.getByIdOrThrow(original.id)).toMatchObject({ note: 'original note', tags: ['工作餐'], amountCents: 2500 });
    await execute('spending.undo', { operationId: result['operationId']! });
    expect(context.services.transactions.getByIdOrThrow(original.id)).toMatchObject({ note: 'original note', tags: [] });
    expect(db.prepare('SELECT status FROM ai_organization_operations').all()).toEqual([{ status: 'undone' }]);
    expect(providerCalls).toBe(1);
  });

  it('returns before the provider-backed analysis finishes, so a second turn cannot hit the generation deadline', async () => {
    // The reported bug: the assistant asks for a date range, the user answers, and the second
    // reply fails. The cause was `spending.preview` awaiting the whole batched analysis inside
    // one generation, which is capped at MAX_GENERATION_DEADLINE_MS (180 s). The tool must now
    // hand back a run id while the provider work is still blocked.
    enableProvider();
    expense();
    response = { reclassifications: [], tagSuggestions: [], noteSuggestions: [], newCategories: [], templateProposals: [] };

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const gatedFetch: typeof fetch = async () => {
      providerCalls++;
      await gate;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(response) } }] }), { status: 200 });
    };
    const gatedContext = { ...context, provider: new AiProviderService(gatedFetch) };

    // Resolves while the provider call is still pending. If the tool awaited the analysis this
    // await would never settle and the test would time out.
    const preview = await registry.read(gatedContext, 'spending.preview', { startDate: '2026-09-01', endDate: '2026-09-22' });
    const run = preview.data['run'] as AssistantJsonObject;
    expect(run['status']).toBe('running');
    expect(preview.data['nextStep']).toBe('spending.status');

    // The same ask again (what a repeated or retried second turn does) must reuse the run
    // instead of failing on AI_ORGANIZATION_BUSY.
    const repeated = await registry.read(gatedContext, 'spending.preview', { startDate: '2026-09-01', endDate: '2026-09-22' });
    expect((repeated.data['run'] as AssistantJsonObject)['runId']).toBe(run['runId']);

    release();
    for (let attempt = 0; attempt < 200; attempt++) {
      const status = await registry.read(context, 'spending.status', { runId: run['runId'] });
      if ((status.data['run'] as AssistantJsonObject)['status'] === 'ready') break;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    const card = await registry.read(context, 'spending.card', { runId: run['runId'] });
    expect(card.data).toMatchObject({ status: 'ready', eligibleCount: 1 });
  });

  it('does not recover or interrupt active runs when another scoped assistant service is constructed', async () => {
    enableProvider(); expense();
    response = { reclassifications: [], tagSuggestions: [], noteSuggestions: [], newCategories: [], templateProposals: [] };
    const first = new AiSpendingOrganizationService(db, context.config, context.provider, { now: () => NOW });
    const pending = first.startAnalysis({ startDate: '2026-09-01', endDate: '2026-09-22' });
    const next = new AiSpendingOrganizationService(db, context.config, context.provider, { now: () => NOW });
    expect(next.hasActiveWork).toBe(true);
    expect((await pending).status).toBe('ready');
    expect(next.hasActiveWork).toBe(false);
  });

  it('can reopen spending service after a drained owner context retains the same database connection', async () => {
    const first = new AiSpendingOrganizationService(db, context.config, context.provider, { now: () => NOW });
    await AiSpendingOrganizationService.shutdownFor(db);
    await expect(first.startAnalysis({ startDate: '2026-09-01', endDate: '2026-09-22' })).rejects.toThrow();
    const reopened = new AiSpendingOrganizationService(db, context.config, context.provider, { now: () => NOW });
    expect((await reopened.startAnalysis({ startDate: '2026-09-01', endDate: '2026-09-22' })).status).toBe('ready');
  });

  it('pages complete spending evidence when a legitimate run spans more than 100 categories', async () => {
    enableProvider();
    for (let index = 0; index < 101; index++) {
      const category = context.services.masterData.createCategory({ name: `category-${index}`, type: 0 });
      context.services.transactions.create({ type: 0, amountCents: 100, categoryId: category.id, accountId: ACCOUNT, date: NOW });
    }
    response = { reclassifications: [], tagSuggestions: [], noteSuggestions: [], newCategories: [], templateProposals: [] };
    const card = await startSpending('2026-09-01', '2026-09-22');
    expect(card).toMatchObject({ evidenceCategoryCount: 101, eligibleCount: 101, completedCount: 101 });
    const page = await registry.read(context, 'spending.card', { runId: card['runId']!, limit: 1 });
    expect(page.data['evidenceCategoryCount']).toBe(101);
    const tail = await registry.read(context, 'spending.evidence', { runId: card['runId']!, offset: 100, limit: 100 });
    expect(tail.data).toMatchObject({ total: 101, hasMore: false });
    expect(tail.data['items']).toHaveLength(1);
  });

  it('can confirm the stored legacy organization arguments and undo without calling a provider again', async () => {
    context.services.masterData.createCategory({ name: 'Duplicate', type: 0 });
    context.services.masterData.createCategory({ name: 'Duplicate', type: 0 });
    const preview = await context.services.organization.preview({ explain: false });
    const ready = preview.actions.find((entry) => entry.status === 'ready')!;
    expect(ready).toBeDefined();
    const result = await execute('organization.apply', { actionIds: [ready.actionId] });
    await execute('organization.undo', { operationId: result['operationId']! });
    expect(providerCalls).toBe(0);
  });
});
