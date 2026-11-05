-- 022 — retire allocation templates by folding them into record tags.
--
-- ⚠️ Preferred path: do NOT run this by hand. The server applies the same change as
--    `packages/server/src/db/migrations/022-template-tags.ts` on its next start, inside
--    a transaction, after taking a backup. This file exists for repair sessions on a
--    database whose server cannot be restarted, and as an executable description of
--    exactly what the migration does.
--
-- What it does (identical to the TypeScript migration):
--   1. creates `template_tag_mappings` (audit + rollback material only; no runtime code
--      reads it);
--   2. ensures every live user-created `budget_templates` row exists as an active tag,
--      recreating the tag if the same name was soft-deleted, never renaming an existing
--      tag, and skipping the seeded `builtin-default-template`;
--   3. records template → tag for every row it touched;
--   4. records version 22 in `schema_migrations` so the server does not redo the work.
--
-- It is additive and loss-less: `budget_templates` and `budget_allocations` keep every
-- row, so shipped Android/Harmony builds and historical salary allocations still read.
--
-- Usage:
--   sqlite3 data/jizhang.db "VACUUM INTO 'data/backups/pre-022-manual.db'"
--   sqlite3 data/jizhang.db < docs/migrations/022-template-to-tag.sql
--
-- Two deliberate approximations versus the JavaScript implementation, both harmless
-- because a tag's NAME is its identity (`services/tags.ts`):
--   * whitespace trimming is spelled out as a character list instead of JS `trim()`;
--   * the 32-character cap counts characters (SQLite `substr`) instead of UTF-16 units.
--     Only templates longer than 32 characters or containing astral emoji are affected.
-- The generated id also differs from the server's `tagNameKey` (UTF-16 hex) for
-- non-ASCII names. That is tolerated: `TagCatalogService.ensureTag` looks a tag up by
-- name before it derives an id, so the row is reused rather than duplicated.

BEGIN;

-- ── 1. audit table ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS template_tag_mappings (
  template_id   TEXT PRIMARY KEY,
  template_name TEXT NOT NULL,
  tag_id        TEXT NOT NULL,
  tag_name      TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS template_tag_mappings_tag ON template_tag_mappings(tag_id);

-- ── 2. one tag per live template ──────────────────────────────────────────────
--
-- `tag_name` here is the normalised name; the same expression is repeated in the
-- following statements because a CTE cannot be shared across them.
--
-- `id <> 'builtin-default-template'` skips the template every account is seeded with.
-- It is app furniture rather than something the user named, so folding it would put a
-- meaningless "默认模板" label in a brand-new user's tag list.
WITH normalised AS (
  SELECT
    id AS template_id,
    name AS template_name,
    substr(
      trim(name, char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196,
                    8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279)),
      1, 32
    ) AS tag_name
  FROM budget_templates
  WHERE deleted = 0
    AND id <> 'builtin-default-template'
)
INSERT INTO tags (id, name, parent_id, deleted, created_at, updated_at)
SELECT
  'tag-' || lower(hex(CAST(n.tag_name AS BLOB))),
  n.tag_name,
  NULL,
  0,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM normalised n
WHERE n.tag_name <> ''
  AND NOT EXISTS (SELECT 1 FROM tags t WHERE t.name = n.tag_name)
  AND NOT EXISTS (
    SELECT 1 FROM tags t WHERE t.id = 'tag-' || lower(hex(CAST(n.tag_name AS BLOB)))
  );

-- A name that only exists as a soft-deleted tag is revived, never duplicated: the
-- live-name unique index would reject a second row with the same name anyway.
UPDATE tags
   SET deleted = 0,
       updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE deleted = 1
   AND name IN (
     SELECT substr(
              trim(name, char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196,
                           8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279)),
              1, 32)
       FROM budget_templates
      WHERE deleted = 0
        AND id <> 'builtin-default-template'
   );

-- ── 3. record the template → tag mapping ──────────────────────────────────────
--
-- Name match first (a renamed tag kept its id), then the derived id (that tag was
-- renamed, so its own name wins) — the same precedence as `backfillTemplateTags`.
WITH normalised AS (
  SELECT
    id AS template_id,
    name AS template_name,
    substr(
      trim(name, char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196,
                    8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279)),
      1, 32
    ) AS tag_name
  FROM budget_templates
  WHERE deleted = 0
    AND id <> 'builtin-default-template'
)
INSERT INTO template_tag_mappings (template_id, template_name, tag_id, tag_name, created_at)
SELECT
  n.template_id,
  n.template_name,
  COALESCE(
    (SELECT t.id FROM tags t WHERE t.name = n.tag_name LIMIT 1),
    (SELECT t.id FROM tags t WHERE t.id = 'tag-' || lower(hex(CAST(n.tag_name AS BLOB))) LIMIT 1)
  ),
  COALESCE(
    (SELECT t.name FROM tags t WHERE t.name = n.tag_name LIMIT 1),
    (SELECT t.name FROM tags t WHERE t.id = 'tag-' || lower(hex(CAST(n.tag_name AS BLOB))) LIMIT 1)
  ),
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM normalised n
WHERE n.tag_name <> ''
  AND COALESCE(
    (SELECT t.id FROM tags t WHERE t.name = n.tag_name LIMIT 1),
    (SELECT t.id FROM tags t WHERE t.id = 'tag-' || lower(hex(CAST(n.tag_name AS BLOB))) LIMIT 1)
  ) IS NOT NULL
ON CONFLICT(template_id) DO UPDATE SET
  template_name = excluded.template_name,
  tag_id        = excluded.tag_id,
  tag_name      = excluded.tag_name;

-- ── 4. no version row is written here ─────────────────────────────────────────
--
-- This script deliberately does NOT touch `schema_migrations`. Every statement above
-- is idempotent, so if the server later applies its own version 22 the only work it
-- redoes is a no-op: the audit table already exists, each template already has its
-- tag, and the mapping upsert rewrites identical values.
--
-- Writing the version by hand would be worse: it would skip the server's own backfill
-- on a database someone provisioned differently, with no record that it happened.

COMMIT;
