import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';
import type { AiConfigService } from '../src/services/ai-config-service.js';
import type { AiProviderService } from '../src/services/ai-provider-service.js';
import type { AiPromptContext } from '../src/services/ai-types.js';
import {
  AiSpendingCardNotReadyError,
  AiSpendingOverCapError,
  AiSpendingRunsInputError,
} from '../src/services/ai-types.js';
import { AiSpendingOrganizationService } from '../src/services/ai-spending-organization-service.js';

function day(year: number, month: number, date: number, hour = 12): number {
  return new Date(year, month - 1, date, hour, 0, 0, 0).getTime();
}

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, null);
  return db;
}

function seedCategory(db: Database.Database, id: string, name: string, type = 0): void {
  db.prepare(
    `INSERT INTO categories (id, name, type, parent_id, icon, color, sort_order, is_builtin, deleted, updated_at)
     VALUES (?, ?, ?, NULL, 'folder', 1, 20, 0, 0, 0)`,
  ).run(id, name, type);
}

function seedTransaction(db: Database.Database, id: string, categoryId: string, tags: string[], note: string, date: number): void {
  db.prepare(
    `INSERT INTO transactions (id, type, amount_cents, category_id, account_id, date, note, tags_json, is_refund, deleted, updated_at)
     VALUES (?, 0, 100, ?, 'builtin-default-account', ?, ?, ?, 0, 0, 0)`,
  ).run(id, categoryId, date, note, JSON.stringify(tags));
}

interface FakeProvider extends AiProviderService {
  readonly calls: readonly unknown[];
}

function fakeProvider(handler: (facts: unknown, callIndex: number) => unknown): FakeProvider {
  const calls: unknown[] = [];
  return {
    calls,
    async complete(_config: unknown, _secret: unknown, context: AiPromptContext): Promise<unknown> {
      calls.push(context.facts);
      return handler(context.facts, calls.length - 1);
    },
  } as unknown as FakeProvider;
}

function fakeConfig(): AiConfigService {
  return {
    getStoredOrThrow() {
      return {
        version: 1,
        enabled: true,
        mode: 'chat-completions',
        name: 'mock',
        url: 'http://mock',
        method: 'POST',
        model: 'mock',
        timeoutMs: 1000,
        headers: {},
        auth: { kind: 'none' },
        bodyTemplate: null,
        responsePath: 'choices[0].message.content',
        encryptedSecret: null,
        updatedAt: 0,
      };
    },
    getSecretOrThrow() {
      return null;
    },
  } as unknown as AiConfigService;
}

function emptyResponse(): Record<string, unknown> {
  return { reclassifications: [], tagSuggestions: [], noteSuggestions: [], newCategories: [], templateProposals: [] };
}

describe('AI spending organization analysis', () => {
  it('analyses an inclusive range and keeps note suggestions separate from original notes', async () => {
    const db = makeDb();
    try {
      seedCategory(db, 'food', '餐饮');
      seedCategory(db, 'transport', '交通');
      seedTransaction(db, 'a', 'food', ['饭'], 'lunch 35元', day(2026, 8, 5));
      seedTransaction(db, 'b', 'transport', [], 'bus', day(2026, 8, 31));
      seedTransaction(db, 'c', 'transport', [], 'sept', day(2026, 9, 1));

      const provider = fakeProvider(() => ({
        reclassifications: [{ transactionId: 'b', targetCategoryId: 'food', reason: 'R', confidence: 0.9 }],
        tagSuggestions: [{ transactionId: 'a', tags: ['工作餐'], reason: 'T', confidence: 0.8 }],
        noteSuggestions: [{ transactionId: 'a', suggestedNote: 'work lunch', reason: 'N', confidence: 0.7 }],
        newCategories: [],
        templateProposals: [],
      }));
      const service = new AiSpendingOrganizationService(db, fakeConfig(), provider, { now: () => 0 });

      const run = await service.startAnalysis({ startDate: '2026-08-01', endDate: '2026-08-31' });
      expect(run.status).toBe('ready');
      expect(run.eligibleCount).toBe(2);
      expect(run.completedCount).toBe(2);

      const card = service.getCard(run.runId);
      expect(card.actions.map((action) => action.kind).sort()).toEqual(['category', 'note', 'tag']);
      expect(card.actions.find((action) => action.kind === 'category')).toMatchObject({
        transactionId: 'b',
        transactionDateLabel: '2026-08-31',
        transactionAmountCents: 100,
        transactionType: 0,
        beforeCategoryName: '交通',
        afterCategoryName: '餐饮',
      });
      expect(card.noteSuggestions).toEqual([
        {
          actionId: card.noteSuggestions[0]?.actionId,
          transactionId: 'a',
          transactionDateLabel: '2026-08-05',
          transactionAmountCents: 100,
          transactionType: 0,
          suggestedNote: 'work lunch',
        },
      ]);

      expect(db.prepare("SELECT note FROM transactions WHERE id = 'a'").get()).toEqual({ note: 'lunch 35元' });
      expect(db.prepare('SELECT transaction_id, suggested_note FROM ai_note_suggestions').all()).toEqual([
        { transaction_id: 'a', suggested_note: 'work lunch' },
      ]);
    } finally {
      db.close();
    }
  });

  it('rejects an over-cap range before any provider call', async () => {
    const db = makeDb();
    try {
      seedCategory(db, 'food', '餐饮');
      for (let index = 0; index < 501; index += 1) seedTransaction(db, `t${index}`, 'food', [], 'n', day(2026, 8, 1));
      let calls = 0;
      const provider = fakeProvider(() => {
        calls += 1;
        return emptyResponse();
      });
      const service = new AiSpendingOrganizationService(db, fakeConfig(), provider, { now: () => 0 });

      await expect(service.startAnalysis({ startDate: '2026-08-01', endDate: '2026-08-01' })).rejects.toBeInstanceOf(
        AiSpendingOverCapError,
      );
      expect(calls).toBe(0);
    } finally {
      db.close();
    }
  });

  it('fails the whole run when a batch provider call fails and publishes no card', async () => {
    const db = makeDb();
    try {
      seedCategory(db, 'food', '餐饮');
      for (let index = 0; index < 26; index += 1) seedTransaction(db, `t${index}`, 'food', [], 'n', day(2026, 8, 1));
      let calls = 0;
      const provider = fakeProvider(() => {
        calls += 1;
        if (calls === 2) throw new Error('boom');
        return emptyResponse();
      });
      const service = new AiSpendingOrganizationService(db, fakeConfig(), provider, { now: () => 0 });

      const run = await service.startAnalysis({ startDate: '2026-08-01', endDate: '2026-08-01' });
      expect(run.status).toBe('failed');
      expect(run.errorCode).toBe('AI_ORGANIZATION_FAILED');
      expect(() => service.getCard(run.runId)).toThrow(AiSpendingCardNotReadyError);
      expect(db.prepare('SELECT suggestions_json FROM ai_analysis_runs WHERE id = ?').get(run.runId)).toEqual({
        suggestions_json: '[]',
      });
    } finally {
      db.close();
    }
  });

  it('returns a ready empty run for an empty interval without calling the provider', async () => {
    const db = makeDb();
    try {
      let calls = 0;
      const provider = fakeProvider(() => {
        calls += 1;
        return emptyResponse();
      });
      const service = new AiSpendingOrganizationService(db, fakeConfig(), provider, { now: () => 0 });

      const run = await service.startAnalysis({ startDate: '2026-08-01', endDate: '2026-08-31' });
      expect(run.status).toBe('ready');
      expect(run.eligibleCount).toBe(0);
      expect(calls).toBe(0);
      expect(service.getCard(run.runId).actions).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('publishes interval evidence and drops template proposals now that templates are retired', async () => {
    const db = makeDb();
    try {
      seedCategory(db, 'food', '餐饮');
      seedCategory(db, 'transport', '交通');
      seedTransaction(db, 'a', 'food', [], 'lunch', day(2026, 8, 5));
      const provider = fakeProvider(() => ({
        reclassifications: [],
        tagSuggestions: [],
        noteSuggestions: [],
        newCategories: [],
        templateProposals: [
          {
            kind: 'new',
            templateId: null,
            templateName: 'AI 模板',
            modules: [
              { categoryId: 'food', ratio: 0.6 },
              { categoryId: 'transport', ratio: 0.4 },
            ],
            reason: 'R',
            confidence: 0.9,
          },
        ],
      }));
      const service = new AiSpendingOrganizationService(db, fakeConfig(), provider, { now: () => 1000 });

      const run = await service.startAnalysis({ startDate: '2026-08-01', endDate: '2026-08-31' });
      const card = service.getCard(run.runId);
      expect(card.evidenceByCategory).toEqual({ food: 100 });
      // Allocation templates are retired (migration 022 folds template names into tags), so
      // a provider that still emits proposals must not turn them into reviewable actions.
      expect(card.templateProposals).toEqual([]);
      expect(card.version).toBe(1000);
      expect(card.expiresAt).toBe(1000 + 24 * 60 * 60 * 1000);
    } finally {
      db.close();
    }
  });

  it('ignores template proposals entirely, even well-formed ones', async () => {
    const db = makeDb();
    try {
      seedCategory(db, 'food', '餐饮');
      seedTransaction(db, 'a', 'food', [], 'lunch', day(2026, 8, 5));
      const provider = fakeProvider(() => ({
        reclassifications: [],
        tagSuggestions: [],
        noteSuggestions: [],
        newCategories: [],
        templateProposals: [
          {
            kind: 'new',
            templateId: null,
            templateName: '坏模板',
            modules: [{ categoryId: 'food', ratio: 0.7 }],
            reason: 'R',
            confidence: 0.9,
          },
        ],
      }));
      const service = new AiSpendingOrganizationService(db, fakeConfig(), provider, { now: () => 0 });

      const run = await service.startAnalysis({ startDate: '2026-08-01', endDate: '2026-08-31' });
      expect(service.getCard(run.runId).templateProposals).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('rejects malformed or inverted dates', async () => {
    const db = makeDb();
    try {
      const provider = fakeProvider(() => emptyResponse());
      const service = new AiSpendingOrganizationService(db, fakeConfig(), provider, { now: () => 0 });

      await expect(service.startAnalysis({ startDate: '2026-02-30', endDate: '2026-03-01' })).rejects.toBeInstanceOf(
        AiSpendingRunsInputError,
      );
      await expect(service.startAnalysis({ startDate: '2026-03-02', endDate: '2026-03-01' })).rejects.toBeInstanceOf(
        AiSpendingRunsInputError,
      );
      await expect(service.startAnalysis({ startDate: 'not-a-date', endDate: '2026-03-01' })).rejects.toBeInstanceOf(
        AiSpendingRunsInputError,
      );
    } finally {
      db.close();
    }
  });

  it('applies category and tag actions atomically, leaves notes untouched, and replays idempotently', async () => {
    const db = makeDb();
    try {
      seedCategory(db, 'food', '餐饮');
      seedCategory(db, 'transport', '交通');
      seedTransaction(db, 'a', 'food', ['饭'], 'lunch', day(2026, 8, 5));
      seedTransaction(db, 'b', 'transport', [], 'bus', day(2026, 8, 6));
      const provider = fakeProvider(() => ({
        reclassifications: [{ transactionId: 'b', targetCategoryId: 'food', reason: 'R', confidence: 0.9 }],
        tagSuggestions: [{ transactionId: 'a', tags: ['工作餐'], reason: 'T', confidence: 0.8 }],
        noteSuggestions: [{ transactionId: 'a', suggestedNote: 'work lunch', reason: 'N', confidence: 0.7 }],
        newCategories: [],
        templateProposals: [],
      }));
      const service = new AiSpendingOrganizationService(db, fakeConfig(), provider, { now: () => 1000 });

      const run = await service.startAnalysis({ startDate: '2026-08-01', endDate: '2026-08-31' });
      const card = service.getCard(run.runId);
      const ids = card.actions.map((action) => action.actionId);
      const result = service.apply(run.runId, ids);

      expect(result.status).toBe('applied');
      expect(db.prepare("SELECT category_id FROM transactions WHERE id = 'b'").get()).toEqual({ category_id: 'food' });
      expect(db.prepare("SELECT tags_json FROM transactions WHERE id = 'a'").get()).toEqual({ tags_json: '["工作餐"]' });
      expect(db.prepare("SELECT note FROM transactions WHERE id = 'a'").get()).toEqual({ note: 'lunch' });

      const replay = service.apply(run.runId, ids);
      expect(replay.operationId).toBe(result.operationId);
      expect(replay.status).toBe('applied');
    } finally {
      db.close();
    }
  });

  it('conditionally undoes an applied operation and conflicts after an external edit', async () => {
    const db = makeDb();
    try {
      seedCategory(db, 'food', '餐饮');
      seedCategory(db, 'transport', '交通');
      seedTransaction(db, 'a', 'food', ['饭'], 'lunch', day(2026, 8, 5));
      const provider = fakeProvider(() => ({
        reclassifications: [],
        tagSuggestions: [{ transactionId: 'a', tags: ['工作餐'], reason: 'T', confidence: 0.8 }],
        noteSuggestions: [],
        newCategories: [],
        templateProposals: [],
      }));
      const service = new AiSpendingOrganizationService(db, fakeConfig(), provider, { now: () => 1000 });

      const run = await service.startAnalysis({ startDate: '2026-08-01', endDate: '2026-08-31' });
      const card = service.getCard(run.runId);
      const applied = service.apply(run.runId, card.actions.map((action) => action.actionId));
      expect(db.prepare("SELECT tags_json FROM transactions WHERE id = 'a'").get()).toEqual({ tags_json: '["工作餐"]' });

      const undone = service.undo(applied.operationId);
      expect(undone.status).toBe('undone');
      expect(db.prepare("SELECT tags_json FROM transactions WHERE id = 'a'").get()).toEqual({ tags_json: '["饭"]' });

      // Replay is a no-op after undo.
      expect(service.undo(applied.operationId).status).toBe('undone');

      // Re-apply, then edit underneath, then undo must conflict and leave the edit alone.
      const second = service.apply(run.runId, card.actions.map((action) => action.actionId));
      db.prepare("UPDATE transactions SET tags_json = '[\"外部修改\"]' WHERE id = 'a'").run();
      expect(() => service.undo(second.operationId)).toThrow(/无法撤销/);
      expect(db.prepare("SELECT tags_json FROM transactions WHERE id = 'a'").get()).toEqual({ tags_json: '["外部修改"]' });
    } finally {
      db.close();
    }
  });
});
