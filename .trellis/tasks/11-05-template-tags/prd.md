# 分配模板退役、账单弹窗卡片与每日合计

> 续作复核：以下早期实现记录中的「模板写入继续可用」「旧运行覆盖全部后续修改」均已被修正。当前模板 HTTP 写入返回 410；标签迁移不会在重启时复活用户删除的标签；iOS 已补充标签选择和整理进度。此前 CI 不包含这些续作修复，须重新验证。

## 用户请求（原文要点）

1. 取消分配模板的功能，将模板和标签融合，作为记录的标签使用，需要兼容旧数据，或者修改旧数据分类，留下可执行 sql 和 readme 文档。
2. 记账记录的卡片需要是弹窗形式，同时将功能按钮放到底部（补充说明：**通过弹窗图片一样显示，安卓端有例子，仿照那个来**）。
3. AI 助理的历史记录整理"高度不可用"（澄清：让 AI 整理历史数据，AI 问时间范围后，**第二局就开始不能返回、出错**）。
4. 账单页面的每日账单统计不见了，需要加回来。注意目前主要开发 iOS 端。

## 决策（已与用户确认）

| 问题 | 结论 |
|---|---|
| 模板数据怎么处理 | **保留旧数据 + 迁移映射**：模板名折叠成标签，旧表行一律保留，另建审计映射表 |
| 改动覆盖哪些端 | **iOS + 服务端/文档**；Android/Harmony 不动源码，只在 Android README 记录契约变化 |
| 账单卡片形态 | 居中浮动弹窗卡片（仿 Android `TransactionDetailScreen.kt`），不是系统 sheet、不是导航页 |
| 每日合计范围 | 账单页**默认本月**，可切换；非整月或超过 32 天时隐藏合计并提示 |

## 交付

### 服务端

- `packages/server/src/db/migrations/022-template-tags.ts` —— 新增 `template_tag_mappings`，把每个**用户自建**模板名折叠为同名活跃标签（预置 `builtin-default-template` 刻意跳过）。幂等：名字命中复用、软删复活、id 命中复用且不覆盖用户改名；`budget_templates`/`budget_allocations` 一个字节都不改。
- `packages/server/src/db/migrate.ts` —— 追加 version 22。
- `packages/server/src/db/seed.ts` —— 播种后重跑回填（迁移先于播种，新库那时还没有模板行）。
- `packages/server/src/routes/budget.ts` —— `/templates*` 全部标注 deprecated：新增 `Deprecation: true`、`Link: </api/v1/tags>; rel="successor-version"` 响应头与列表 `deprecated: true` 字段；状态码/其余字段不变，避免打断已安装的 Android/Harmony。
- `packages/server/src/services/template-service.ts` —— 文件头写明已弃用与保留原因。
- `packages/server/src/services/ai-spending-organization-service.ts` —— 卡片不再产出/返回/应用 `templateProposals`；schema 保留该成员仅为兼容旧 prompt 形状；apply 只接受普通建议，undo 仍能逆转历史旧操作。
- `packages/server/src/services/assistant-business-tools.ts` —— **修复用户报告的 AI 第二次回复失败**：`spending.preview`/`spending.resume` 改为后台启动并立即返回 `run`（原先 await 整段分批分析，撞上单次生成 180 s 硬上限）；同时删掉 `templates.read`/`template.*` 工具。
- `packages/server/src/services/assistant-types.ts` —— 从 `ASSISTANT_TOOL_NAMES` 删除 5 个模板工具名（保留名字但不注册会让 `catalog()` 抛错）。

### iOS（主开发端）

- 删除模板入口与模型：`MyView.swift`、`LedgerCatalogViews.swift`、`LedgerCatalogModels.swift`。
- 标签承接：`LedgerTagsView` 显示每标签关联笔数、页脚说明标签即记录分类。
- 新增 `LedgerBillDetailCard.swift`：居中浮层卡片，顶部标题+✕、Hero（分类图块/分类名/备注/大金额）、紧凑属性列表、**底部胶囊按钮行（编辑/记录退款/删除）**；删除二次确认后调用 `DELETE /transactions/:id` 并广播 `ledgerRevision`。
- 新增 `LedgerBillDailySummary.swift`：严格解码 `/transactions/daily-summary`，校验 `searchVersion`/`searchRevision` 与列表页一致、每日笔数与已加载行一致，任何不一致都清空合计而不是编造数字。
- `BillsView.swift` / `LedgerBillDates.swift` / `HomeView.swift`：默认本月、每日合计分区头、首页最近账单共用同一张卡片。
- `Jizhang.xcodeproj/project.pbxproj`：由 `python3 scripts/generate_project.py` 重新生成，纳入 2 个新文件。

### 文档

- `docs/migrations/022-template-to-tag.sql` —— 可直接执行的等价 SQLite 脚本（已用真实 SQLite 验证可执行、可重复执行、跳过预置/空名/已删除模板）。
- `docs/migrations/022-template-to-tag.md` —— 背景、映射规则、执行方式、校验 SQL、回滚步骤、已知限制。
- `clients/ios/README.md`、`.trellis/spec/frontend/ios-client.md`、`clients/android/README.md`（契约变更记录，稳定 ID 保留、标记退役而不回收）、`packages/server/src/db/migrations/README.md`（新增"下线功能用迁移而非删除"规则）。

## 验收标准

- [x] 旧库升级后：用户自建模板名成为活跃标签，模板/分配行数不变，映射表可追溯。
- [x] 重复执行迁移与每次启动的播种回填都不新增标签、不改写已活跃标签的 `updated_at`。
- [x] `builtin-default-template` 不产生标签（新用户不会看到无意义的「默认模板」标签）。
- [x] `/templates*` 保持原有状态码/响应体，仅新增弃用标记。
- [x] 助理不再提供任何模板工具；`catalog()` 不因缺注册而抛错。
- [x] 历史整理第二次回复不再因为等待整段分析而失败（回归测试用被阻塞的 provider 证明工具先返回）。
- [x] 账单详情为居中弹窗浮层，底部有编辑/记录退款/删除，关闭后保留列表状态。
- [x] 每日合计只用服务端权威数据，范围不满足时隐藏并提示，绝不客户端累加。
- [x] 服务端全量测试/typecheck/lint 通过。
- [x] iOS 在 GitHub Actions macOS 上编译 + XCTest 通过：run 42013499694，129 tests / 0 failures，arm64 IPA 已产出并校验。
- [ ] 真机安装与交互验收（未做）。

## 验证状态

| 项 | 结果 |
|---|---|
| 服务端 `vitest run` | **64 files / 1244 tests 全通过** |
| 服务端 `tsc -p tsconfig.test.json --noEmit` | 通过 |
| 服务端 `eslint src test --max-warnings 0` | 0 问题 |
| `docs/migrations/022-template-to-tag.sql` | 真实 SQLite 执行 + 重复执行验证通过 |
| iOS Swift 编译 / XCTest | **通过**：run 42013499694，129 tests / 0 failures（含新增 2 个预览） |
| 真机 / 生产部署 | 未做 |

## 后续

- ~~GitHub Actions iOS 构建必须跑通~~ 已完成：run 42013499694 通过（129 tests / 0 failures）。当前剩余风险是真机安装与真实 Provider 行为。
- Android/Harmony 的模板入口仍可用但已弃用；待这些客户端不再引用 `/templates` 后，再考虑表重建式移除。
- 历史整理现在需要客户端配合「轮询进度」交互；iOS 侧目前由模型在对话里完成轮询，若体验不佳可后续做专门的整理工作区页面。
