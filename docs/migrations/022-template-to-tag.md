# 022 — 取消「分配模板」，模板与标签融合

## 背景

「分配模板」原本是「一组分类 + 比例」，记录工资时按它拆分金额。后来工资改为按
**四用途资金**（长期增长 / 应急储备 / 日常必要 / 随心生活）在当前配置比例下生成冻结的
授权记录（见 `packages/server/src/services/salary-service.ts`），模板不再参与任何新计算。
产品方向也已明确：模板这个概念并回「标签」，一条账单可以直接带标签，不再需要先定义模板。

直接删表会带来两个不可接受的结果：

1. 已装在手机上的 Android / Harmony 客户端仍在调用 `/api/v1/templates`，删掉会让这些用户
   在会话中途报错；
2. 历史 `budget_allocations`（旧工资的按分类分配快照）会失去可读性，等于销毁用户账本历史。

所以 022 采取 **只增不减**：模板行原样保留，**模板名变成真实标签**，另建一张审计表记录
「哪个模板变成了哪个标签」。

## 改动内容

| 对象                    | 变化                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------ |
| `budget_templates`      | 不变（不删行、不改 `modules_json`）                                                  |
| `budget_allocations`    | 不变                                                                                 |
| `tags`                  | 每个未删除的**用户自建**模板，确保存在同名活跃标签（已存在则复用；曾被软删除则复活） |
| `template_tag_mappings` | **新增**。`template_id → tag_id/tag_name` 映射，仅用于审计与回滚                     |
| `schema_migrations`     | 记录版本 22（由 TypeScript 迁移写入；手写 SQL 脚本不写，原因见下）                   |

### 为什么跳过预置的「默认模板」

`builtin-default-template` 是每个账号播种时就有的模板，不是用户命名的内容。如果把它也
变成标签，一个刚注册、还没记过账的用户就会看到一条毫无意义的「默认模板」标签。因此回填
显式跳过它（`id <> 'builtin-default-template'`）；用户自己建的模板才会被折叠。

标签 id 的派生规则与服务端运行时一致（`TagCatalogService.ensureTag` / `tagIdForName`）：
`tag-<UTF-16 码元十六进制>`。但由于「名字才是标签的身份」，回填**先按名字查找**，
命中就直接复用（用户改过名的标签保留原 id），只有完全找不到时才按派生 id 插入。

## 幂等性

- 迁移本身按 `schema_migrations` 版本只执行一次；
- `backfillTemplateTags` 还会被 `seed.ts` 在**每次启动**调用。迁移先于播种执行，所以新库
  在迁移那一刻还没有任何模板行；每次启动重跑既覆盖新库后续创建的模板，也让"迁移已跑过但
  模板是之后才建的"这种中间状态自动收敛；
- 重复执行不会新增行、不会改名：名字命中即复用、id 命中即复用、`template_tag_mappings`
  以 `template_id` 为主键 `ON CONFLICT DO UPDATE`；
- 已经活跃的标签不会被改写 `updated_at`（只有复活软删除标签时才写），否则每次重启都会
  伪造一次数据变更，破坏账本快照比对。

## 执行方式

### 正常升级（推荐）

不需要人工操作。服务端下次启动会自动：

1. 备份数据库到 `${DATA_DIR}/backups/jizhang-<timestamp>.db`；
2. 在事务里执行 022；
3. 记录 `schema_migrations.version = 22`。

### 手工执行（服务端无法重启时的修复场景）

```bash
# 1) 先备份
sqlite3 data/jizhang.db "VACUUM INTO 'data/backups/pre-022-manual.db'"

# 2) 执行等价 SQL
sqlite3 data/jizhang.db < docs/migrations/022-template-to-tag.sql
```

`docs/migrations/022-template-to-tag.sql` 与 TypeScript 迁移行为一致。它**不写**
`schema_migrations`，因为脚本本身幂等：服务端之后照常执行版本 22 时，只需重做一遍
「表已存在 / 标签已存在 / 映射值相同」的空操作，不会产生重复数据；反过来手写版本号会
在配置不同的库上跳过服务端真正的回填，且没有痕迹。

> 该脚本有两处刻意的近似：空白裁剪用手写字符表代替 JS `trim()`；32 字符截断按字符而非
> UTF-16 码元计算。只有当模板名超过 32 字符或含星平面 emoji 时才有差异，且因为标签以名字
> 为身份，后续 `ensureTag` 仍会复用同一行而不是产生重复。

> 脚本对「SQLite 没有 `schema_migrations` 表」不做任何依赖，因此可以在一个只建了业务表
> 的库上直接跑；这也是它没有版本写入语句的原因之一。

## 校验

```sql
-- 应该为 0：未删除的用户模板都应该有映射（预置模板除外）
SELECT COUNT(*) FROM budget_templates t
 WHERE t.deleted = 0
   AND t.id <> 'builtin-default-template'
   AND NOT EXISTS (SELECT 1 FROM template_tag_mappings m WHERE m.template_id = t.id);

-- 每个映射指向的标签都应存在且活跃
SELECT m.template_id, m.tag_name, tg.deleted
  FROM template_tag_mappings m LEFT JOIN tags tg ON tg.id = m.tag_id
 WHERE tg.id IS NULL OR tg.deleted <> 0;

-- 模板行数不应变化（与升级前对比）
SELECT COUNT(*) FROM budget_templates;

-- 历史分配不应变化
SELECT COUNT(*) FROM budget_allocations;
```

## 回滚

022 只新增了 `template_tag_mappings` 和若干标签行，`budget_templates` / `budget_allocations`
一个字节都没改，所以**回滚代码即可**，数据无需回滚。

若确实要撤销这次数据变更（例如误把模板名建成了不想要的标签）：

```sql
BEGIN;
-- 只删除 022 自己建的标签，且只删那些没有被任何账单引用的
DELETE FROM tags
 WHERE id IN (SELECT tag_id FROM template_tag_mappings)
   AND NOT EXISTS (
     SELECT 1 FROM transactions
      WHERE deleted = 0 AND tags_json LIKE '%' || (SELECT name FROM tags WHERE id = tags.id) || '%'
   );
DROP TABLE IF EXISTS template_tag_mappings;
DELETE FROM schema_migrations WHERE version = 22;
COMMIT;
```

注意：`transactions.tags_json` 的 `LIKE` 判断只是保守估计，真正恢复请用迁移前的备份
文件（`VACUUM INTO` 生成的那份）。

## 已知限制

- `budget_templates` 不会被物理删除。彻底移除需要一次表重建（SQLite 的 12 步流程），
  与「旧客户端仍可读」的目标冲突，因此留到所有已发布客户端都不再引用 `/templates` 之后。
- 预置的 `builtin-default-template` 不参与折叠，因此它永远没有映射行；这是有意的，不是
  数据缺口。
- 模板名字如果规范化后为空（全空白），会被跳过——`tags_active_name` 是活跃名唯一索引，
  插入空名会立刻冲突。
- 一次模板改名不会同步到已生成的标签；两者从此独立。这是「模板 → 标签」一次性迁移的
  预期语义，不是 bug。
- `/api/v1/templates*` 已标记 `Deprecation: true` 响应头与 `Link: </api/v1/tags>;
rel="successor-version"`，并保持原有状态码与响应体，唯一新增是列表响应里的
  `deprecated: true` 字段。
- 重复启动不会改写任何标签行：活跃标签的 `updated_at` 保持不动（只有复活软删除标签时
  才写），否则每次重启都会伪造一次数据变更。
