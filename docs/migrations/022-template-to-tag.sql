-- 手工备选方案；优先让服务端自动执行迁移 022。请先使用 SQLite 备份并停止所有写入。
-- 使用 sqlite3 -bail ledger.db < 022-template-to-tag.sql；出错时整个事务回滚。
-- 为避免 SQLite 字符长度和 JS UTF-16 截断规则不一致，超过 32 字符或包含非 BMP
-- 字符的名称将拒绝执行；此时应使用服务端自动迁移，不要删改任何旧记录。
BEGIN IMMEDIATE;
CREATE TABLE IF NOT EXISTS template_tag_mappings (
  template_id TEXT PRIMARY KEY, template_name TEXT NOT NULL,
  tag_id TEXT NOT NULL, tag_name TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS template_tag_mappings_tag ON template_tag_mappings(tag_id);
CREATE TEMP TABLE template_tag_input (template_id TEXT PRIMARY KEY, template_name TEXT NOT NULL, tag_name TEXT NOT NULL);
INSERT INTO template_tag_input
SELECT id, name, trim(name, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))
FROM budget_templates t
WHERE deleted = 0 AND NOT (id = 'builtin-default-template' AND name = '默认模板')
  AND NOT EXISTS (SELECT 1 FROM template_tag_mappings m WHERE m.template_id = t.id);
CREATE TEMP TABLE template_tag_guard (valid INTEGER NOT NULL CHECK(valid = 1));
INSERT INTO template_tag_guard
WITH RECURSIVE chars(name, pos) AS (
  SELECT tag_name, 1 FROM template_tag_input WHERE tag_name <> ''
  UNION ALL SELECT name, pos + 1 FROM chars WHERE pos < length(name)
)
SELECT CASE WHEN EXISTS (SELECT 1 FROM template_tag_input WHERE length(tag_name) > 32)
  OR EXISTS (SELECT 1 FROM chars WHERE unicode(substr(name, pos, 1)) > 65535)
  THEN 0 ELSE 1 END;
-- Random IDs are valid opaque tag identities. Name lookup precedes ID derivation.
INSERT OR IGNORE INTO tags(id, name, parent_id, deleted, created_at, updated_at)
SELECT lower(hex(randomblob(16))), tag_name, NULL, 0,
       CAST(strftime('%s','now') AS INTEGER)*1000, CAST(strftime('%s','now') AS INTEGER)*1000
FROM template_tag_input WHERE tag_name <> '';
INSERT OR IGNORE INTO template_tag_mappings(template_id, template_name, tag_id, tag_name, created_at)
SELECT i.template_id, i.template_name, t.id, i.tag_name, CAST(strftime('%s','now') AS INTEGER)*1000
FROM template_tag_input i JOIN tags t ON t.name = i.tag_name AND t.deleted = 0
WHERE i.tag_name <> '';
DROP TABLE template_tag_guard;
DROP TABLE template_tag_input;
-- Do not mark schema_migrations: the server still runs its transactional migration.
COMMIT;
