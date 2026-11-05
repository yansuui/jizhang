# 实现与验证计划

## 顺序与状态

1. [x] 确认 4 项需求的范围与数据策略（模板保留旧数据 + 迁移映射；iOS 为主开发端；弹窗仿 Android）。
2. [x] 服务端：新增迁移 022 与回填函数，把用户自建模板名折叠为标签。
3. [x] 服务端：播种后重跑回填，覆盖"迁移先于播种"的新库窗口。
4. [x] 服务端：`/templates*` 标注弃用（响应头 + 列表字段），不改状态码与响应体。
5. [x] 服务端：历史整理卡片停止产出/返回/应用模板建议；undo 仍可逆转历史旧操作。
6. [x] 服务端：修复 AI 第二次回复失败 —— `spending.preview`/`spending.resume` 改为后台启动并立即返回 `run`。
7. [x] 服务端：从助理工具白名单移除 5 个模板工具名。
8. [x] iOS：删除模板入口、视图与模型；标签页承担记录分类语义。
9. [x] iOS：新增居中浮层账单卡片（对齐 Android 布局），底部胶囊按钮（编辑/记录退款/删除）。
10. [x] iOS：首页最近账单复用同一张卡片。
11. [x] iOS：账单页默认本月 + 服务端权威每日合计（严格校验、不可用即隐藏）。
12. [x] iOS：历史整理建议卡不再把模板建议列为可选。
13. [x] 重跑 `clients/ios/scripts/generate_project.py` 纳入 2 个新源文件。
14. [x] 新增 2 个模拟器预览测试（居中弹窗卡片、每日合计分区头）。
15. [x] 文档：可执行 SQL + README、iOS README、ios-client spec、Android README 契约记录、迁移 README 规则。

## 门禁结果

| 命令 | 结果 |
|---|---|
| `pnpm lint` | 通过（shared + server，0 warning） |
| `pnpm typecheck` | 通过 |
| `pnpm build` | 通过 |
| `pnpm test` | shared 405 + server 1244，全通过 |
| `python3 scripts/generate_project.py` | 45 app + 11 test Swift 文件，工程已更新 |
| iOS Swift 编译 / XCTest | **通过** —— [run 42013499694](https://github.com/yansuui/jizhang/actions/runs/42013499694)，129 tests / 0 failures，arm64 打包成功 |
| iOS IPA | `Jizhang-unsigned.ipa` 2,627,321 字节，SHA-256 `36feac9e012d5fb9a8019f4e56c9b6249ea65b28f618911c3bdf2ee6806958a0`，commit `b114d1f` |

## 过程中发现并修掉的真实缺陷

- **AI 历史整理第二次回复必然失败**：`spending.preview` 在工具里 await 整段分批 provider 调用（最坏 50 批），而单次生成硬上限 `MAX_GENERATION_DEADLINE_MS = 180_000`，`openToolScope` 到点 abort，于是"问完日期范围的第二次生成"稳定失败。改为后台启动 + 轮询。
- **预置模板污染新用户标签**：最初把所有模板都折叠，导致刚注册用户就有一条「默认模板」标签；改为跳过 `builtin-default-template`。
- **每次启动伪造数据变更**：回填最初无条件写 `updated_at`，使账本快照在重启后出现差异（被 `multiuser-migration-preservation` 测试抓到）；改为只复活软删除行。
- **iOS 条件手势编译错误**：`@ViewBuilder var dismissDrag: some Gesture` 不是合法 SwiftUI（没有 `@GestureBuilder`），改为无条件手势 + 闭包内判断。
- **iOS 首页仍走系统 sheet**：与"账单卡片要弹窗"不一致，改为与账单页共用居中浮层。
- **两个迁移版本号断言写死**：`fund-budget-migration` 与 `ai-organization-progress` 里 `toEqual([21])` / `[17,18,19,20,21]`，改为从 `MIGRATIONS` 派生，避免以后每加一个迁移就要改测试。

## CI 实测结果（2026-11-05）

- `Backend and Android verification` run 42013499686：**success**。
- `iOS build and IPA` run 42013499694：**success**，12m48s。`Executed 129 tests, with 0 failures`；
  新增的两个预览 `testCentredBillDetailOverlayPreview`、`testDaySummaryHeaderPreview` 均导出截图并已人工查看：
  居中卡片布局与 Android 一致；每日合计在有数据时正常显示 `支出 ¥128.00 收入 ¥3,000.00 4 笔`，
  缺数据时显示占位符 `—`，不可汇总时只显示日期（三种降级都符合设计）。
- IPA 校验：`sha256sum -c` 通过，`build-metadata.json` 的 commit 与 `b114d1f` 一致。

## 待办（需要真机）

- 真机 Sideloadly 安装与交互验收：弹窗卡片动画、下滑关闭、删除确认、每日合计滚动表现、大字体。
- 真实 Provider 下验证历史整理的后台分析 + 轮询体验。
- Android/Harmony 的模板入口在服务端完全移除后才考虑下线；目前保留且已弃用。

## 提交与推送状态

- `b114d1f` feat: retire allocation templates into tags, fix history analysis and bills UX —— **已推送** origin/main，CI 全绿。
- `9428d97` docs: record verified iOS delivery for template-to-tag change —— 本地已提交，**尚未推送**：推送到 github.com:443 连续三次失败（Connection reset / Could not connect），属网络问题而非代码问题。网络恢复后执行 `git push origin main` 即可（仅含文档更新）。
