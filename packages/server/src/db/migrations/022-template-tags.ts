import { randomUUID } from 'node:crypto';
import { BUILTIN_DEFAULT_TEMPLATE_ID, SEED_TEMPLATE } from '@jizhang/shared';
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
 * The unchanged seeded default is skipped to avoid a meaningless label on new
 * accounts; a user-renamed default is retained. A tag previously deleted or renamed
 * by the user is never revived or overwritten merely because a backfill runs again.
 *
 * The backfill may run on startup and in manual-repair workflows. Existing mappings
 * are immutable: they prevent deleted/renamed tags being re-created on restart. A new
 * mapping reuses an active tag of the same name, otherwise creates a distinct identity.
 */
export const MIGRATION_022_TEMPLATE_TAGS = `
CREATE TABLE IF NOT EXISTS template_tag_mappings (
  template_id   TEXT PRIMARY KEY,
  template_name TEXT NOT NULL,
  tag_id        TEXT NOT NULL,
  tag_name      TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS template_tag_mappings_tag ON template_tag_mappings(tag_id);
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
  const findByName = db.prepare('SELECT id FROM tags WHERE name = ? AND deleted = 0');
  const findById = db.prepare('SELECT id FROM tags WHERE id = ?');
  const findMapping = db.prepare('SELECT 1 FROM template_tag_mappings WHERE template_id = ?');
  const insert = db.prepare(
    'INSERT INTO tags (id, name, parent_id, deleted, created_at, updated_at) VALUES (?, ?, NULL, 0, ?, ?)',
  );
  const recordMapping = db.prepare(
    `INSERT INTO template_tag_mappings (template_id, template_name, tag_id, tag_name, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(template_id) DO NOTHING`,
  );

  let created = 0;
  const run = db.transaction((): number => {
    for (const template of templates) {
      // A renamed preset is user data; only the untouched default name is skipped.
      if (template.id === BUILTIN_DEFAULT_TEMPLATE_ID && template.name === SEED_TEMPLATE.name) continue;
      // Backfill is called at startup too. Once mapped, never recreate a tag the user
      // subsequently renamed or deleted, and never silently change the audit mapping.
      if (findMapping.get(template.id) !== undefined) continue;
      const name = normaliseTags([template.name])[0];
      if (name === undefined) continue;

      const byName = findByName.get(name) as { id: string } | undefined;
      let tagId = byName?.id;
      if (tagId === undefined) {
        const derivedId = `tag-${tagNameKey(name)}`;
        // A renamed or soft-deleted row can own the derived ID. It is not the same
        // active tag; allocate a fresh identity without changing the historical row.
        tagId = findById.get(derivedId) === undefined ? derivedId : randomUUID();
        insert.run(tagId, name, now, now);
        created += 1;
      }
      recordMapping.run(template.id, template.name, tagId, name, now);
    }
    return created;
  });

  return run();
}
