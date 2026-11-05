import { BUILTIN_DEFAULT_TEMPLATE_ID } from '@jizhang/shared';
import type { Db } from '../index.js';
import { normaliseTags, tagNameKey } from '../../services/tags.js';

/**
 * Migration 022 — retire budget templates by folding them into record tags.
 *
 * Why this exists
 * ---------------
 * "分配模板" (a named set of category ratios a salary was split by) stopped being
 * developed when salaries started producing a frozen four-purpose grant keyed by
 * operation id (`salary-service.ts`). The template surface is therefore dead
 * weight in the UI, but its ROWS are not: a user may have named templates that
 * carry real meaning, and old Android/Harmony builds still read `/templates`.
 *
 * So this migration is deliberately **additive and loss-less**:
 *   * `budget_templates` / `budget_allocations` are untouched — an older client
 *     keeps working and historical salary allocations keep rendering;
 *   * every live *user* template NAME becomes a real tag in `tags`, so the meaning
 *     of a template survives as a label a bill can carry;
 *   * `template_tag_mappings` records which tag a template became. It is audit
 *     and rollback material only — no runtime code reads it.
 *
 * The seeded template is deliberately NOT folded. Every account starts with it, so
 * turning it into a tag would hand a brand-new user a meaningless "默认模板" label
 * before they have recorded anything. It is app furniture, not something they named.
 *
 * Idempotency
 * -----------
 * The migration runs once per database by version, but `seed.ts` calls the same
 * backfill on every boot (a fresh install has no templates yet when migrations
 * run), so the function below must be safe to call repeatedly. It never renames
 * or re-creates an existing tag: a name match reuses (and un-deletes) the row, an
 * id match reuses the row it found, and only a complete miss inserts.
 */
export const MIGRATION_022_TEMPLATE_TAGS = `
CREATE TABLE template_tag_mappings (
  template_id   TEXT PRIMARY KEY,
  template_name TEXT NOT NULL,
  tag_id        TEXT NOT NULL,
  tag_name      TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX template_tag_mappings_tag ON template_tag_mappings(tag_id);
`;

interface TemplateRow {
  readonly id: string;
  readonly name: string;
}

/**
 * Ensures every live template exists as an active tag and records the mapping.
 *
 * A template whose name normalises to nothing (blank, or whitespace only) has no
 * usable tag identity and is skipped; `tags_active_name` is a unique index on the
 * normalised name, so inserting a blank one would collide on every attempt.
 */
export function backfillTemplateTags(db: Db, now = Date.now()): number {
  // `seedDatabase` re-runs this on every boot, including before a test database has
  // every migration applied. Reporting "nothing to do" beats throwing on a schema
  // the caller did not ask for.
  const hasTable = db
    .prepare(
      "SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'template_tag_mappings'",
    )
    .get() as { x: number } | undefined;
  if (hasTable === undefined) return 0;

  const templates = db
    .prepare('SELECT id, name FROM budget_templates WHERE deleted = 0 ORDER BY id')
    .all() as TemplateRow[];
  const findByName = db.prepare('SELECT id FROM tags WHERE name = ?');
  const findById = db.prepare('SELECT id, name FROM tags WHERE id = ?');
  // Only a soft-deleted row is written. Touching `updated_at` on an already-live tag
  // would make every boot a data change, which breaks the ledger snapshot guarantees
  // (and would show up as spurious "modified" rows to a client diffing them).
  const revive = db.prepare(
    'UPDATE tags SET deleted = 0, updated_at = ? WHERE id = ? AND deleted = 1',
  );
  const insert = db.prepare(
    'INSERT INTO tags (id, name, parent_id, deleted, created_at, updated_at) VALUES (?, ?, NULL, 0, ?, ?)',
  );
  const recordMapping = db.prepare(
    `INSERT INTO template_tag_mappings (template_id, template_name, tag_id, tag_name, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(template_id) DO UPDATE SET
       template_name = excluded.template_name,
       tag_id = excluded.tag_id,
       tag_name = excluded.tag_name`,
  );

  let created = 0;
  const run = db.transaction((): number => {
    for (const template of templates) {
      // The seeded template is app furniture that every account has; folding it
      // would put a meaningless "默认模板" label in a brand-new user's tag list.
      if (template.id === BUILTIN_DEFAULT_TEMPLATE_ID) continue;
      const name = normaliseTags([template.name])[0];
      if (name === undefined) continue;

      const byName = findByName.get(name) as { id: string } | undefined;
      let tagId: string;
      let tagName = name;
      if (byName !== undefined) {
        tagId = byName.id;
        revive.run(now, tagId);
      } else {
        // The derived id may already belong to a tag the user renamed. Reusing it
        // keeps `tags.id` stable for bills that reference the name, and skipping
        // the rename avoids overwriting the user's choice.
        const derivedId = `tag-${tagNameKey(name)}`;
        const byId = findById.get(derivedId) as { id: string; name: string } | undefined;
        if (byId !== undefined) {
          tagId = byId.id;
          tagName = byId.name;
          revive.run(now, tagId);
        } else {
          tagId = derivedId;
          insert.run(tagId, name, now, now);
          created += 1;
        }
      }
      recordMapping.run(template.id, template.name, tagId, tagName, now);
    }
    return created;
  });

  return run();
}
