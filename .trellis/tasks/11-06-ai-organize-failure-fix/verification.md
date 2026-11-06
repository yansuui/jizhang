# D4 + 执行轨迹实施记录（2026-11-06）

## 用户决策

- 2026-11-06：**只做 iOS 端，不做安卓端**。
- 顺序：先修格式失败（D4），再做执行轨迹。
- 轨迹需**持久化**；**只记步骤元信息**，不记模型推理原文。

## 前置说明

`4033d26` / `d3eddc3` / `ebc8086`（zhangh）已完成本 PRD 的 D1/D2/D3/D5：
步数 3→8、后台任务确定性交接、工具错误可纠正、iOS 安全文案映射。
因此本次只实施剩余部分：**D4 宽容信封** 与 **执行轨迹（仅 iOS）**。

## A. D4 宽容信封解析

新增 `packages/server/src/services/assistant-envelope-recovery.ts`，接入
`assistant-generation-runner.ts` 的 `JSON.parse(envelopeText)` 失败分支。

恢复顺序：
1. 原文直接解析（正常路径）；
2. 剥离一层 ```json / ``` 围栏；
3. 提取最外层**配对** `{...}`（正确处理字符串内花括号与转义引号）；
4. 完全无花括号的纯文本 → 作为普通回答。

安全边界：
- 恢复出的对象仍走 `normalizeAssistantProviderTurn` 全量校验；
- 纯文本兜底只给 `toolCall:null`，**不可能**产生卡片或确认；
- 含 `{`/`}` 的截断内容**绝不**当文本展示；
- `[1,2,3]`、`"x"`、`42` 等非对象 JSON 拒绝（测试发现的缺陷，已修）。

## B. 执行轨迹（仅 iOS）

### 服务端
- 迁移 023：`assistant_generation_trace`（独立表，不复用 `assistant_messages`，
  保证旧客户端渲染完全不变）。
- `assistant-trace-service.ts`：`begin` / `finish` / `list` / `closeOpenSteps`，
  每代最多 32 步、摘要 200 字符；**全部 best-effort**，诊断失败不得影响生成。
- `summarizeToolArguments`：数组/对象折叠为长度或键数，避免账单内容进入轨迹。
- runner 接入：工具步、答案步、错误步；`finalizeFailed` 补写失败步并关闭未完成步。
- 路由：`GET /assistant/conversations/:id/generations/:id/trace`，
  归属校验复用 `generations.get`。

### iOS
- `AssistantTraceView.swift`：`AssistantTraceEntry` + `AssistantTraceStore` + 折叠视图；
  默认为收起，**有错误时自动展开**；轨迹读取失败被静默吞掉，不影响对话。
- `AssistantView.swift`：气泡内按 `content.generationId` 渲染，按 `api.identity` + generation 建 key。

## 验证

- `pnpm -r run lint`：通过
- `pnpm -r run typecheck`：通过
- `pnpm -r run test`：**68 文件 / 1339 项全绿**（新增 24 项）
- `pnpm build`：通过
- 新增测试：`assistant-envelope-recovery.test.ts`（13）、
  `assistant-trace-service.test.ts`（11）、`AssistantTraceTests.swift`（9）
- Xcode 工程重新生成：48 应用文件 + 15 测试文件

## 未验证（必须如实记录）

- **未做生产部署**：部署需单独授权。
- **未在真实 provider 上验证围栏恢复**：仅有单元测试证据。
- 安卓端未改造（用户明确不做）；服务端保证新数据对旧客户端是附加且可忽略的。

## CI 结果（2026-11-06）

提交：`542a57d`（D4）、`50ab2f7`（执行轨迹），已推送 `origin/main`。

| 工作流 | Run | 结果 |
|---|---|---|
| Backend and Android verification | [42200666357](https://github.com/yansuui/jizhang/actions/runs/42200666357) | **success** |
| iOS build and IPA | [42200666393](https://github.com/yansuui/jizhang/actions/runs/42200666393) | **success** |

iOS job `build` 于 `10:10:56`–`10:28:24`（UTC）执行 `clients/ios/scripts/ci-build.sh`，
其中第 12–15 行运行 `xcodebuild ... test`，因此 native 编译与 XCTest（含新增
`AssistantTraceTests` 9 项）在真实 macOS + Xcode 16.4 环境通过，并产出
`Jizhang-ios-15`（5,042,293 字节）与 `ios-diagnostics-15` 两个产物。

注意：此前的同名 artifact 下载需要认证（`Requires authentication`），
故本条证据来自工作流定义 + job 成功状态，未逐一核对 XCTest 计数日志。

