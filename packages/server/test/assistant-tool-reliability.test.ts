import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { initializeDatabase, type Db } from '../src/db/index.js';
import { buildAssistantContext } from '../src/services/assistant-orchestrator.js';
import { AssistantToolRegistry } from '../src/services/assistant-tool-registry.js';
import { normalizeAssistantContent, normalizeAssistantJson, type AssistantJsonObject } from '../src/services/assistant-types.js';
import { FinancialPlanService } from '../src/services/financial-plan-service.js';
import { FinancialGoalsService } from '../src/services/financial-goals-service.js';
import { ASSISTANT_READ_RESULT_MAX_BYTES } from '../src/services/assistant-result-projection.js';

const now = new Date(2026, 10, 6, 12).getTime();
const accountId = 'builtin-default-account';
const categoryId = 'builtin-expense-food';
const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', JIZHANG_USERNAME: 'unit', JIZHANG_PASSWORD_HASH: 'unused', DATA_DIR: './data' });
const registry = new AssistantToolRegistry();
let db: Db;
let context: ReturnType<typeof buildAssistantContext>['context'];
let transactionId: string;

beforeEach(() => {
  db = new Database(':memory:'); db.pragma('foreign_keys = ON'); initializeDatabase(db, null);
  context = buildAssistantContext({ db, config, actorId: 'member-without-ledger-user', now: () => now,
    fetchImpl: async () => { throw new Error('Unexpected provider request during read-only business discovery'); } }).context;
  transactionId = context.services.transactions.create({ type: 0, amountCents: 12800, categoryId, accountId, date: now, note: '午餐' }).id;
  context.services.salaries.create({ contractVersion: 1, operationId: randomUUID(), expectedFundConfigRevision: 0,
    amountCents: 123456, date: now, accountId }, { actorId: 'member-without-ledger-user' });
  new FinancialPlanService(db, { now: () => now }).save({ monthlyIncomeCents: 800000,
    essentialMonthlyCents: 300000, reserveBalanceCents: 600000, expectedRevision: 0 });
});
afterEach(() => db.close());

const reads: readonly [string, AssistantJsonObject][] = [
  ['transactions.recent', {}], ['accounts.balances', {}], ['budget.overview', {}], ['stats.monthly', {}], ['recurring.pending', {}],
  ['transactions.query', { accountId, from: now - 86_400_000, to: now + 86_400_000, limit: 1 }],
  ['transaction.details', { id: 'known-expense' }],
  ['transactions.daily', { from: now - 1, to: now + 1, timeZone: 'Asia/Shanghai' }],
  ...(['categories', 'accounts', 'tags', 'tag-names'] as const).map((kind): [string, AssistantJsonObject] => ['master-data.read', { kind }]),
  ['master-data.read', { kind: 'category-usage', id: categoryId }],
  ['master-data.read', { kind: 'account-usage', id: accountId }],
  ...(['summary', 'config', 'capabilities', 'issues'] as const).map((view): [string, AssistantJsonObject] => ['funds.read', { view }]),
  ['salaries.read', {}], ['plan.read', {}],
  ['plan.preview', { monthlyIncomeCents: 800000, essentialMonthlyCents: 300000, reserveBalanceCents: 600000 }],
  ['goals.read', { view: 'summary' }], ['goals.read', { view: 'entries', goal: 'reserve' }],
  ['items.read', {}], ['settings.read', {}], ['transfers.query', {}], ['trash.list', {}],
  ...(['rules', 'occurrences', 'pending'] as const).map((view): [string, AssistantJsonObject] => ['recurring.rules', { view }]),
  ...(['window', 'categories', 'monthly', 'pool', 'range'] as const).map((view): [string, AssistantJsonObject] => ['stats.query', { view }]),
  ...(['capabilities', 'config', 'mapping', 'sources', 'periods', 'execution', 'refunds', 'monthly'] as const)
    .map((view): [string, AssistantJsonObject] => ['planning.read', { view }]),
  ['planning.read', { view: 'purpose', id: 'known-expense' }],
];

describe('assistant read-tool wire reliability', () => {
  it.each(reads)('normalizes %s %j without provider calls or business writes', async (name, args) => {
    const before = db.serialize();
    const result = await registry.read(context, name, args['id'] === 'known-expense' ? { ...args, id: transactionId } : args);
    expect(result.toolName).toBe(name);
    expect(result.summary.length).toBeGreaterThan(0);
    expect(() => normalizeAssistantJson(result)).not.toThrow();
    expect(() => normalizeAssistantContent('result', { version: 1, result: { version: 1, ...result } })).not.toThrow();
    expect(db.serialize().equals(before)).toBe(true);
  });

  it('permits only a valid financial summary digest while continuing to reject credential tokens', async () => {
    const summary = await registry.read(context, 'funds.read', { view: 'summary' });
    expect(summary.data['snapshotToken']).toMatch(/^[a-f0-9]{64}$/);
    expect(normalizeAssistantJson({ snapshotToken: 'ab'.repeat(32) })).toEqual({ snapshotToken: 'ab'.repeat(32) });
    for (const snapshotToken of [null, '', 'not-a-digest', 'ab'.repeat(31), 123]) {
      expect(() => normalizeAssistantJson({ snapshotToken })).toThrow('受保护字段');
    }
    for (const key of ['token', 'sessionToken', 'accessToken', 'apiToken', 'secret', 'cookie']) {
      expect(() => normalizeAssistantJson({ [key]: 'ab'.repeat(32) })).toThrow('受保护字段');
    }
  });

  it('honors a specifically requested month instead of silently substituting the last thirty days', async () => {
    const result = await registry.read(context, 'stats.query', { view: 'window', month: '2026-11', timeZone: 'Asia/Shanghai' });
    expect(result.data['kind']).toBe('month');
    expect(result.data['from']).toBe(new Date('2026-10-31T16:00:00.000Z').getTime());
    expect(result.data['to']).toBe(new Date('2026-11-30T16:00:00.000Z').getTime());
    const explicit = await registry.read(context, 'stats.query', { view: 'window', kind: 'last30', month: '2026-11', timeZone: 'Asia/Shanghai' });
    expect(explicit.data['kind']).toBe('last30');
  });
});

function assertReadEventFits(result: Awaited<ReturnType<AssistantToolRegistry['read']>>) {
  expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(ASSISTANT_READ_RESULT_MAX_BYTES);
  const content = normalizeAssistantContent('result', { version: 1, text: result.summary, result: { version: 1, ...result } });
  const event = { version: 1, generationId: randomUUID(), seq: 1, type: 'message',
    message: { id: randomUUID(), conversationId: randomUUID(), role: 'assistant', kind: 'result', content, createdAt: now } };
  expect(Buffer.byteLength('data: ' + JSON.stringify(event) + '\n\n', 'utf8')).toBeLessThan(64 * 1024);
}

describe('assistant read projections fit native event lines without losing financial scope', () => {
  it('discloses a legal single note shortened by the protected JSON limit and directs to the native full detail', async () => {
    const tail = '【原始备注末尾标记】';
    const note = '账'.repeat(4500) + tail;
    const created = context.services.transactions.create({ type: 0, amountCents: 100, categoryId, accountId, date: now, note });
    expect(context.services.transactions.getByIdOrThrow(created.id).note).toBe(note);
    const result = await registry.read(context, 'transaction.details', { id: created.id });
    assertReadEventFits(result);
    const transaction = result.data['transaction'] as AssistantJsonObject;
    expect(transaction).toMatchObject({ id: created.id, amountCents: 100, noteTruncated: true,
      noteOriginalUnits: note.length, noteDisplayedUnits: 4000 });
    expect(transaction['note']).toBe(note.slice(0, 4000));
    expect(transaction['note']).not.toContain(tail);
    expect(result.data['fullNoteOmitted']).toBe(true);
    expect(result.data['notice']).toContain('有省略');
    expect(result.summary).toContain('有省略');
    expect(result.summary).toContain('账单页打开该记录');
    expect(context.services.transactions.getByIdOrThrow(created.id).note).toBe(note);
  });

  it('continues through 200 long-note/tag-heavy bills using the actual reduced page size, with exact IDs and amounts', async () => {
    const note = '账'.repeat(4000);
    const tags = Array.from({ length: 20 }, (_, index) => '标签' + index + '字'.repeat(25));
    db.transaction(() => {
      for (let index = 1; index < 200; index++) context.services.transactions.create({ type: 0, amountCents: 100 + index,
        categoryId, accountId, date: now, note, tags });
    })();
    const expected = new Map(context.services.transactions.list({ limit: 200 }).items.map((item) => [item.id, item]));
    const seen = new Set<string>();
    let offset = 0;
    while (offset < 200) {
      const result = await registry.read(context, 'transactions.query', { limit: 100, offset });
      assertReadEventFits(result);
      const values = result.data['items'] as AssistantJsonObject[];
      expect(result.data['total']).toBe(200);
      expect(values.length).toBeGreaterThan(0);
      expect(values.length).toBeLessThan(100);
      if (result.data['pageReducedForDisplay'] === true) expect(result.data['limit']).toBe(values.length);
      else expect(result.data['limit']).toBe(100);
      expect(result.data['nextOffset']).toBe(offset + values.length);
      expect(result.data['hasMore']).toBe(offset + values.length < 200);
      expect(result.summary).toContain('摘要');
      for (const value of values) {
        const source = expected.get(value['id'] as string)!;
        expect(source).toBeDefined(); expect(seen.has(source.id)).toBe(false); seen.add(source.id);
        expect(value['amountCents']).toBe(source.amountCents);
        expect(value['fundPurposeRevision']).toBe(source.fundPurposeRevision);
        expect(value['tags']).toEqual(source.tags);
        if (source.note.length > 200) expect(value).toMatchObject({ noteTruncated: true, noteOriginalUnits: 4000 });
      }
      offset = result.data['nextOffset'] as number;
    }
    expect(seen.size).toBe(200);
    const full = await registry.read(context, 'transaction.details', { id: Array.from(expected.values()).find((item) => item.note === note)!.id });
    assertReadEventFits(full);
    expect((full.data['transaction'] as AssistantJsonObject)['note']).toBe(note);
  });

  it('pages large nested refund details while preserving the source refund total and complete individual note', async () => {
    const incomeCategory = context.services.masterData.listCategories(1)[0]!.id;
    const note = '退'.repeat(4000);
    db.transaction(() => {
      for (let index = 0; index < 80; index++) context.services.transactions.create({ type: 1, amountCents: 100,
        categoryId: incomeCategory, accountId, date: now, note, isRefund: true, refundLinkedTxIds: [transactionId] });
    })();
    const expected = context.services.transactions.getByIdOrThrow(transactionId);
    const seen = new Set<string>();
    let offset = 0;
    while (offset < 80) {
      const result = await registry.read(context, 'transaction.details', { id: transactionId, limit: 100, offset });
      assertReadEventFits(result);
      const transaction = result.data['transaction'] as AssistantJsonObject;
      expect(transaction['refundSummary']).toEqual(expected.refundSummary);
      const values = transaction['refundDetails'] as AssistantJsonObject[];
      const page = result.data['refundDetailsPage'] as AssistantJsonObject;
      expect(page['total']).toBe(80);
      expect(page['nextOffset']).toBe(offset + values.length);
      for (const value of values) {
        expect(seen.has(value['id'] as string)).toBe(false); seen.add(value['id'] as string);
        expect(value).toMatchObject({ amountCents: 100, noteTruncated: true });
      }
      offset = page['nextOffset'] as number;
    }
    expect(seen.size).toBe(80);
    const full = await registry.read(context, 'transaction.details', { id: [...seen][0]! });
    expect((full.data['transaction'] as AssistantJsonObject)['note']).toBe(note);
  });

  it('does not invent offset continuation or advance an opaque cursor when a cursor page is too large', async () => {
    const goals = new FinancialGoalsService(db, { now: () => now, actorId: 'member-without-ledger-user' });
    goals.putOpening({ goal: 'reserve', expectedRevision: 0, operationId: randomUUID(), openingCents: 0, openingAt: now - 1 });
    for (let index = 0; index < 120; index++) goals.createEntry({ goal: 'reserve', expectedRevision: index + 1,
      operationId: randomUUID(), kind: 'deposit', amountCents: 1, date: now, note: '存'.repeat(200) });
    const oversized = await registry.read(context, 'goals.read', { view: 'entries', goal: 'reserve', limit: 100 });
    assertReadEventFits(oversized);
    expect(oversized.data).toMatchObject({ requiresNarrowerQuery: true, financialFactsOmitted: true, total: 120 });
    expect(oversized.data['items']).toBeUndefined(); expect(oversized.data['nextOffset']).toBeUndefined(); expect(oversized.data['nextCursor']).toBeUndefined();
    const original = goals.listEntries({ goal: 'reserve', limit: 10 });
    const result = await registry.read(context, 'goals.read', { view: 'entries', goal: 'reserve', limit: 10 });
    assertReadEventFits(result);
    expect(result.data['nextCursor']).toBe(original.nextCursor);
    expect((result.data['items'] as unknown[])).toHaveLength(10);
  });
});
