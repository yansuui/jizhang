import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type AppConfig } from '../src/config.js';
import { closeDatabase, initializeDatabase, openDatabase, type Db } from '../src/db/index.js';
import { openIdentityStore, type IdentityStore } from '../src/identity/store.js';
import { AiConfigService } from '../src/services/ai-config-service.js';
import { AI_PROVIDER_SETTING_KEY } from '../src/services/ai-types.js';
import { AssistantConversationService } from '../src/services/assistant-conversation-service.js';
import { AuthService } from '../src/services/auth-service.js';
import { ItemService } from '../src/services/item-service.js';
import { TransactionService } from '../src/services/transaction-service.js';

const NOW = Date.UTC(2026, 9, 20, 12);
const PURCHASE_DATE = Date.UTC(2026, 8, 20);
const PASSWORD = 'migration-fixture-password';
const ENCRYPTION_KEY = 'ab'.repeat(32);
const PROVIDER_SECRET = 'owner-only-synthetic-provider-secret';
const PHOTO = Buffer.from(
  'UklGRigAAABXRUJQVlA4TBsAAAAvF8AFEAYyaRsv9a+zZ9k52l2R/k/Ao6I3URIA',
  'base64',
);

let directory: string | undefined;
let ownerDb: Db | undefined;
let identity: IdentityStore | undefined;

afterEach(() => {
  identity?.close();
  identity = undefined;
  if (ownerDb !== undefined) closeDatabase(ownerDb);
  ownerDb = undefined;
  if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

/** Compare business rows, not file bytes: auth cutover intentionally changes users/sessions. */
function businessSnapshot(db: Db): Record<string, string[]> {
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table'
       AND name NOT LIKE 'sqlite_%'
       AND name NOT IN ('users', 'sessions', 'schema_migrations') ORDER BY name`,
    )
    .all() as { name: string }[];
  return Object.fromEntries(
    tables.map(({ name }) => {
      const quoted = name.replaceAll('"', '""');
      const rows = db.prepare(`SELECT * FROM "${quoted}"`).all();
      return [name, rows.map((row) => JSON.stringify(row)).sort()];
    }),
  );
}

function provider(db: Db, config: AppConfig): AiConfigService {
  return new AiConfigService(db, {
    aiEncryptionKey: config.aiEncryptionKey,
    production: false,
    now: () => NOW,
  });
}

describe('populated legacy ledger cutover', () => {
  it('preserves financial rows, encrypted provider, chat history and photos through registration and two real restarts', async () => {
    directory = mkdtempSync(path.join(tmpdir(), 'jizhang-migration-preservation-'));
    const config = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATA_DIR: directory,
      JIZHANG_USERNAME: 'owner',
      JIZHANG_PASSWORD_HASH: 'unused',
      JIZHANG_AI_ENCRYPTION_KEY: ENCRYPTION_KEY,
    });
    ownerDb = openDatabase(config);
    initializeDatabase(ownerDb, null);
    const ownerId = await new AuthService(ownerDb, { sessionTtlDays: 30 }).setPassword(
      'owner',
      PASSWORD,
    );
    const originalPassword = ownerDb
      .prepare('SELECT password_hash FROM users WHERE id = ?')
      .get(ownerId) as { password_hash: string };
    ownerDb
      .prepare('UPDATE categories SET name = ? WHERE id = ?')
      .run('Owner renamed food category', 'builtin-expense-food');

    const transactions = new TransactionService(ownerDb, { now: () => NOW, actorId: ownerId });
    const purchase = transactions.create({
      type: 0,
      amountCents: 879_900,
      categoryId: 'builtin-expense-shopping',
      accountId: 'builtin-default-account',
      date: PURCHASE_DATE,
      note: 'Owner camera purchase',
      tags: ['private-camera'],
    });
    const refund = transactions.create({
      type: 1,
      amountCents: 35_000,
      categoryId: 'builtin-income-other',
      accountId: 'builtin-default-account',
      date: PURCHASE_DATE + 86_400_000,
      note: 'Owner partial refund',
      isRefund: true,
      refundLinkedTxIds: [purchase.id],
    });
    const originalLedgerView = transactions.list();

    const ai = provider(ownerDb, config);
    ai.save({
      enabled: true,
      mode: 'chat-completions',
      name: 'Private owner connection',
      url: 'https://provider.example.test/v1/chat/completions',
      method: 'POST',
      model: 'owner-model',
      timeoutMs: 10_000,
      headers: { 'X-Owner-Route': 'private' },
      auth: { kind: 'bearer' },
      secret: PROVIDER_SECRET,
    });
    const originalConfig = ai.summary();
    expect(ai.getSecretOrThrow(ai.getStoredOrThrow())).toBe(PROVIDER_SECRET);
    const storedConfig = ownerDb
      .prepare('SELECT value_json FROM settings WHERE key = ?')
      .get(AI_PROVIDER_SETTING_KEY) as { value_json: string };
    expect(storedConfig.value_json).not.toContain(PROVIDER_SECRET);
    // The snapshot below also proves ciphertext is preserved without re-encryption.
    expect(JSON.stringify(businessSnapshot(ownerDb))).not.toContain(PROVIDER_SECRET);

    const conversations = new AssistantConversationService(ownerDb, () => NOW);
    const conversation = conversations.create('Owner camera history');
    conversations.appendMessage({
      conversationId: conversation.id,
      role: 'user',
      kind: 'text',
      content: { version: 1, text: 'Review my private camera spending.' },
      clientRequestId: 'legacy-message-request',
    });
    conversations.appendMessage({
      conversationId: conversation.id,
      role: 'assistant',
      kind: 'text',
      content: { version: 1, text: 'Saved owner-only conversation history.' },
    });
    const originalMessages = conversations.messages(conversation.id);

    const items = new ItemService(ownerDb, { now: () => NOW, actorId: ownerId });
    const item = items.create({
      name: 'Owner camera',
      category: 'Photography',
      purchasePriceCents: 879_900,
      purchaseDate: PURCHASE_DATE,
      purchaseTransactionId: purchase.id,
    });
    items.putPhoto(item.id, 'image/webp', PHOTO);
    const originalItem = items.getByIdOrThrow(item.id);
    const before = businessSnapshot(ownerDb);
    expect(before.transactions).toHaveLength(2);
    expect(before.assistant_messages).toHaveLength(2);
    expect(before.asset_item_photos).toHaveLength(1);

    identity = openIdentityStore({ config, legacyDb: ownerDb, now: () => NOW });
    const member = await identity.register(
      'member',
      PASSWORD,
      identity.createInvitation(ownerId).code,
    );
    const memberBinding = identity.getLedger(member.id);
    if (memberBinding === undefined) throw new Error('Registered account lacks its ledger binding');
    expect(memberBinding.dbFile).not.toBe(config.dbFile);
    expect(identity.getLedger(ownerId)?.dbFile).toBe(config.dbFile);

    for (let restart = 0; restart <= 2; restart += 1) {
      if (restart > 0) {
        identity.close();
        closeDatabase(ownerDb);
        ownerDb = openDatabase(config);
        initializeDatabase(ownerDb, null);
        identity = openIdentityStore({ config, legacyDb: ownerDb, now: () => NOW + restart });
      }
      expect(identity.authService.findUserById(ownerId)).toMatchObject({
        id: ownerId,
        role: 'admin',
        password_hash: originalPassword.password_hash,
      });
      expect(identity.authService.findUserById(member.id)?.role).toBe('member');
      expect(ownerDb.prepare('SELECT * FROM users').all()).toEqual([]);
      expect(ownerDb.prepare('SELECT * FROM sessions').all()).toEqual([]);
      expect(businessSnapshot(ownerDb), `owner business data after restart ${restart}`).toEqual(
        before,
      );
      expect(new TransactionService(ownerDb, { now: () => NOW, actorId: ownerId }).list()).toEqual(
        originalLedgerView,
      );
      const reopenedAi = provider(ownerDb, config);
      expect(reopenedAi.summary()).toEqual(originalConfig);
      expect(reopenedAi.getSecretOrThrow(reopenedAi.getStoredOrThrow())).toBe(PROVIDER_SECRET);
      expect(
        ownerDb
          .prepare('SELECT value_json FROM settings WHERE key = ?')
          .get(AI_PROVIDER_SETTING_KEY),
      ).toEqual(storedConfig);
      expect(
        new AssistantConversationService(ownerDb, () => NOW).messages(conversation.id),
      ).toEqual(originalMessages);
      const reopenedItems = new ItemService(ownerDb, { now: () => NOW, actorId: ownerId });
      expect(reopenedItems.getByIdOrThrow(item.id)).toEqual(originalItem);
      expect(reopenedItems.getPhoto(item.id)?.bytes.equals(PHOTO)).toBe(true);

      const freshMember = openDatabase({ ...config, ...memberBinding });
      try {
        expect(provider(freshMember, config).summary()).toMatchObject({
          configured: false,
          hasSecret: false,
        });
        expect(() => provider(freshMember, config).getStoredOrThrow()).toThrow();
        const memberTransactions = new TransactionService(freshMember, {
          now: () => NOW,
          actorId: member.id,
        });
        expect(memberTransactions.list().items).toEqual([]);
        expect(memberTransactions.getById(purchase.id)).toBeUndefined();
        expect(memberTransactions.getById(refund.id)).toBeUndefined();
        expect(new AssistantConversationService(freshMember).list()).toEqual([]);
        expect(new ItemService(freshMember).getPhoto(item.id)).toBeUndefined();
        expect(freshMember.prepare('SELECT * FROM users').all()).toEqual([]);
        const seededCategory = freshMember
          .prepare('SELECT name FROM categories WHERE id = ?')
          .get('builtin-expense-food');
        expect(seededCategory).toEqual({ name: expect.any(String) });
        expect(seededCategory).not.toEqual({ name: 'Owner renamed food category' });
        expect(
          freshMember
            .prepare('SELECT id FROM accounts WHERE id = ?')
            .get('builtin-default-account'),
        ).toEqual({ id: 'builtin-default-account' });
      } finally {
        closeDatabase(freshMember);
      }
    }

    const snapshot = identity.db
      .prepare("SELECT value FROM identity_metadata WHERE key = 'legacy_snapshot'")
      .get() as { value: string };
    const originalBackup = openDatabase({
      ...config,
      dbFile: path.join(directory, snapshot.value),
    });
    try {
      expect(originalBackup.pragma('quick_check', { simple: true })).toBe('ok');
      expect(businessSnapshot(originalBackup)).toEqual(before);
      expect(
        provider(originalBackup, config).getSecretOrThrow(
          provider(originalBackup, config).getStoredOrThrow(),
        ),
      ).toBe(PROVIDER_SECRET);
    } finally {
      closeDatabase(originalBackup);
    }
  }, 30_000);
});
