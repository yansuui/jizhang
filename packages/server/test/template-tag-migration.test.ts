/**
 * Migration 022 acceptance: allocation templates fold into record tags.
 *
 * The behaviour that matters is the *upgrade* path, not the fresh install: an
 * existing ledger already has templates, salary allocations and possibly tags whose
 * names collide with a template. None of that may be destroyed or duplicated.
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { initializeDatabase, seedDatabase } from '../src/db/index.js';
import { MIGRATIONS, runMigrations } from '../src/db/migrate.js';
import { backfillTemplateTags } from '../src/db/migrations/022-template-tags.js';
import { tagNameKey } from '../src/services/tags.js';

const FOOD = 'builtin-expense-food';

function database(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  return db;
}

/** A database as it existed before 022: migrations 1–21 only. */
function preTemplatesDatabase(): Database.Database {
  const db = database();
  for (const migration of MIGRATIONS.filter((entry) => entry.version <= 21)) db.exec(migration.sql);
  db.exec(
    'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)',
  );
  const record = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );
  for (const migration of MIGRATIONS.filter((entry) => entry.version <= 21)) {
    record.run(migration.version, migration.name, 1);
  }
  return db;
}

function addTemplate(db: Database.Database, id: string, name: string, deleted = 0): void {
  db.prepare(
    'INSERT INTO budget_templates (id, name, is_default, modules_json, deleted, updated_at) VALUES (?, ?, 0, ?, ?, 1)',
  ).run(id, name, JSON.stringify([{ categoryId: FOOD, ratio: 1 }]), deleted);
}

function addAllocation(db: Database.Database, id: string): void {
  db.prepare(
    "INSERT INTO salary_records (id, amount_cents, date, note, account_id, deleted, updated_at) VALUES (?, ?, ?, '', ?, 0, 1)",
  ).run(`salary-${id}`, 100_000, 1_700_000_000_000, 'builtin-default-account');
  db.prepare(
    'INSERT INTO budget_allocations (id, salary_record_id, date, allocations_json, deleted, updated_at) VALUES (?, ?, ?, ?, 0, 1)',
  ).run(
    id,
    `salary-${id}`,
    1_700_000_000_000,
    JSON.stringify([{ categoryId: FOOD, amountCents: 100_000 }]),
  );
}

function templateNames(db: Database.Database): string[] {
  return (
    db.prepare('SELECT name FROM budget_templates ORDER BY id').all() as { name: string }[]
  ).map((row) => row.name);
}

function tagNames(db: Database.Database): string[] {
  return (
    db.prepare('SELECT name FROM tags WHERE deleted = 0 ORDER BY name').all() as { name: string }[]
  ).map((row) => row.name);
}

describe('022 template → tag migration', () => {
  it('folds every live template into a tag while keeping template and allocation rows intact', () => {
    const db = preTemplatesDatabase();
    try {
      addTemplate(db, 'template-a', '日常分配');
      addTemplate(db, 'template-b', '旅行预算');
      addTemplate(db, 'template-deleted', '已删除的模板', 1);
      addAllocation(db, 'allocation-a');
      const templatesBefore = templateNames(db);
      const allocationsBefore = db.prepare('SELECT * FROM budget_allocations ORDER BY id').all();

      const result = runMigrations(db, null);

      expect(result.applied).toContain(22);
      expect(templateNames(db)).toEqual(templatesBefore);
      expect(db.prepare('SELECT * FROM budget_allocations ORDER BY id').all()).toEqual(
        allocationsBefore,
      );
      expect(tagNames(db)).toEqual(['旅行预算', '日常分配']);

      const mappings = db
        .prepare(
          'SELECT template_id, tag_id, tag_name FROM template_tag_mappings ORDER BY template_id',
        )
        .all() as { template_id: string; tag_id: string; tag_name: string }[];
      expect(mappings.map((row) => row.template_id)).toEqual(['template-a', 'template-b']);
      expect(mappings[0]?.tag_id).toBe(`tag-${tagNameKey('日常分配')}`);
      expect(mappings[0]?.tag_name).toBe('日常分配');
    } finally {
      db.close();
    }
  });

  it('is idempotent: repeated backfills add no tag and never rename one', () => {
    const db = preTemplatesDatabase();
    try {
      addTemplate(db, 'template-a', '日常分配');
      runMigrations(db, null);
      const after = tagNames(db);

      // The runner is a no-op the second time, and seed.ts calls the backfill on
      // every boot, so both paths must be safe.
      runMigrations(db, null);
      expect(backfillTemplateTags(db)).toBe(0);
      expect(tagNames(db)).toEqual(after);
      expect(db.prepare('SELECT COUNT(*) AS c FROM template_tag_mappings').get()).toMatchObject({
        c: 1,
      });
    } finally {
      db.close();
    }
  });

  it('reuses an existing tag by name instead of creating a second identity', () => {
    const db = preTemplatesDatabase();
    try {
      addTemplate(db, 'template-a', '日常分配');
      db.prepare(
        'INSERT INTO tags (id, name, parent_id, deleted, created_at, updated_at) VALUES (?, ?, NULL, 0, 1, 1)',
      ).run('user-created-tag', '日常分配');

      runMigrations(db, null);

      const tags = db.prepare('SELECT id, name FROM tags').all() as { id: string; name: string }[];
      expect(tags).toEqual([{ id: 'user-created-tag', name: '日常分配' }]);
      expect(
        (
          db
            .prepare('SELECT tag_id FROM template_tag_mappings WHERE template_id = ?')
            .get('template-a') as {
            tag_id: string;
          }
        ).tag_id,
      ).toBe('user-created-tag');
    } finally {
      db.close();
    }
  });

  it('revives a soft-deleted tag with the template name rather than duplicating it', () => {
    const db = preTemplatesDatabase();
    try {
      addTemplate(db, 'template-a', '日常分配');
      db.prepare(
        'INSERT INTO tags (id, name, parent_id, deleted, created_at, updated_at) VALUES (?, ?, NULL, 1, 1, 1)',
      ).run('tag-deleted', '日常分配');

      runMigrations(db, null);

      const rows = db.prepare('SELECT id, deleted FROM tags').all() as {
        id: string;
        deleted: number;
      }[];
      expect(rows).toEqual([{ id: 'tag-deleted', deleted: 0 }]);
    } finally {
      db.close();
    }
  });

  it('keeps the renamed tag when the derived id already belongs to another name', () => {
    const db = preTemplatesDatabase();
    try {
      addTemplate(db, 'template-a', '日常分配');
      // The user renamed a tag, so the id that would be derived from this template
      // name is already taken by different content. Reusing it must not overwrite
      // the user's name, and inserting a second row with the derived id would throw.
      db.prepare(
        'INSERT INTO tags (id, name, parent_id, deleted, created_at, updated_at) VALUES (?, ?, NULL, 0, 1, 1)',
      ).run(`tag-${tagNameKey('日常分配')}`, '用户改过的名字');

      runMigrations(db, null);

      const tags = db.prepare('SELECT id, name FROM tags ORDER BY id').all() as {
        id: string;
        name: string;
      }[];
      expect(tags).toEqual([{ id: `tag-${tagNameKey('日常分配')}`, name: '用户改过的名字' }]);
      const mapping = db
        .prepare('SELECT tag_id, tag_name FROM template_tag_mappings WHERE template_id = ?')
        .get('template-a') as { tag_id: string; tag_name: string };
      expect(mapping.tag_name).toBe('用户改过的名字');
    } finally {
      db.close();
    }
  });

  it('skips a template whose name normalises to nothing', () => {
    const db = preTemplatesDatabase();
    try {
      addTemplate(db, 'template-blank', '   ');
      addTemplate(db, 'template-real', '日常分配');

      runMigrations(db, null);

      // A blank tag name would collide with the `tags_active_name` unique index on
      // every retry, so it must never be attempted.
      expect(tagNames(db)).toEqual(['日常分配']);
      expect(
        (db.prepare('SELECT COUNT(*) AS c FROM template_tag_mappings').get() as { c: number }).c,
      ).toBe(1);
    } finally {
      db.close();
    }
  });

  it('does not fold the seeded template into a user-visible tag', () => {
    // Every account starts with the preset template. Turning it into a tag would give
    // a brand-new user a meaningless "默认模板" label before they recorded anything,
    // so the backfill deliberately skips it.
    const db = database();
    try {
      initializeDatabase(db, null);

      expect(db.prepare('SELECT COUNT(*) AS c FROM tags').get()).toMatchObject({ c: 0 });
      expect(
        (db.prepare('SELECT COUNT(*) AS c FROM template_tag_mappings').get() as { c: number }).c,
      ).toBe(0);
      // The template row itself is untouched.
      expect(
        (
          db
            .prepare('SELECT name FROM budget_templates WHERE id = ?')
            .get('builtin-default-template') as {
            name: string;
          }
        ).name,
      ).toBe('默认模板');
    } finally {
      db.close();
    }
  });

  it('keeps seeding idempotent for the tag catalog', () => {
    const db = database();
    try {
      initializeDatabase(db, null);
      addTemplate(db, 'template-user', '旅行预算');
      backfillTemplateTags(db);
      const first = db.prepare('SELECT COUNT(*) AS c FROM tags').get() as { c: number };
      seedDatabase(db);
      seedDatabase(db);
      expect(db.prepare('SELECT COUNT(*) AS c FROM tags').get()).toMatchObject({ c: first.c });
    } finally {
      db.close();
    }
  });
});
