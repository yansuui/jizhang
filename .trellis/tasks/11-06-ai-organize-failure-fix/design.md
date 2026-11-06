# 技术设计：AI 整理记录失败修复

## 边界

服务端 `packages/server/src/services/` 内的生成循环与流解析；iOS `AssistantModels.swift` 的错误展示。
不触碰账本写入、确认事务、资金口径、鉴权与租户隔离。

## 核心判断

生产证据显示三类失败，根因分层：

1. **零 delta 的 INVALID_ENVELOPE（5 次）**——模型在 `response_format: json_object`
   下仍吐出纯文本或 ```json 围栏。tokenizer 在第一个字符就抛错，整轮报废。
2. **整理流程耗尽步数 / 工具报错杀轮**——模型被提示词要求在同轮内轮询 `spending.status`，
   且任何工具抛错都直接终止生成。
3. **客户端吞掉原因**——所有 STREAM_BOUNDS 显示为同一句提示。

## 方案

### D1 工具失败降级为「工具观察」

新增 bounded 错误观察类型，替代「抛出 → 整轮 failed」：

```ts
interface AssistantToolObservation {
  readonly toolName: AssistantToolName;
  readonly summary: string;         // 固定安全句式
  readonly data: { ok: false; code: string; message: string };
}
```

规则：
- 只透传 `AssistantError` / `AiError` 的 `code` 与 `message`（服务端自撰的固定句子）；
- 其他异常一律折叠为 `TOOL_FAILED` + 通用句子，绝不带 stack/SQL/凭据；
- 消息长度截断（≤ 300 字符）；
- 超时/取消/归档/步数耗尽仍然是致命条件，不进观察。

接入点：`assistant-generation-runner.ts` 的 `readTool`、`finishWriteTurn`，
以及 `parseArguments` 的包装（未知工具名/非法参数同属模型可纠正错误）。

### D2 步数上限与耗尽降级

- `MAX_GENERATION_STEPS` 3 → 6（协议常量，同步 `.trellis/spec/backend/assistant-streaming.md`）。
- 循环正常结束后：
  - `lastResult !== null` → 以该结果收尾为 `completed`，正文说明「已达单轮处理上限」；
  - `lastResult === null` → 仍然是 `failed`，但用明确文案。

### D3 整理流程去掉同轮轮询

`ai-provider-service.ts` 的 assistant 系统提示改为：

- 调用 `spending.preview`（或 `spending.resume`）后**立即结束本轮**，告知后台已开始；
- 进度由客户端轮询 `/ai/organization-runs/:id`，模型不需要在同轮调用 `spending.status`；
- 只有在**用户新提一轮**问进度时才调用 `spending.status`；
- `spending.card` 仅在 status 为 `ready` 且用户要查看建议时调用。

### D4 宽容信封解析（两层）

在 `AiProviderStream` 内引入「原始模式」：

1. tokenizer 正常时维持现状（增量渲染，最佳体验）。
2. tokenizer 首次抛错时**不终止流**：置 `tokenizerFailed`，停止喂 tokenizer，
   继续按 `MAX_STREAM_*` 上限累积原始 `delta.content`（此时已不可能有 delta 泄漏）。
3. 流结束后：
   - 剥 ```json 围栏 / 前后空白 → `JSON.parse` → 正常 `normalizeAssistantProviderTurn`；
   - 仍失败且原始文本非空 → 作为纯文本回复 `{message, toolCall:null, clarification:null}`；
   - 原始文本为空 → 维持 `INVALID_ENVELOPE`。

安全边界不变：原始报文永不外泄，仅正文可作为回复；长度受 `MAX_PROVIDER_MESSAGE_CHARS` 约束。

### D5 iOS 展示具体原因

`AssistantFault.displayMessage`：

- 已知 code 且文案确定 → 保持现有映射（不与服务端脱钩）；
- `ASSISTANT_STREAM_BOUNDS` 或未知 code → 优先用服务端 `message`（非空、截断 120 字符）；
- 服务端文案缺失 → 回退既有通用句。

不信任外部文本：仅截断展示，不做任何解析或执行。

## 兼容性

- 事件协议不变（version/seq/type/终态语义），Android/旧 iOS 客户端不受影响。
- `MAX_GENERATION_STEPS` 不是线上契约字段，客户端无感知。
- 工具观察只影响模型看到的 `previousResult`，不影响持久化消息结构。

## 回滚

全部为服务端行为变更，回滚即还原上述 4 个文件 + 常量。
不涉及数据库迁移。

## 风险

| 风险 | 缓解 |
|---|---|
| 放宽信封解析后把模型废话当正式回复 | 仅当原始文本非空且 JSON 不可解析；正文仍受长度上限；不产生卡片/确认 |
| 工具错误回灌导致重复调用 | 步数上限 6 兜底；每轮必须有终态 |
| 步数提高导致更慢 | 180s 生成时限不变，超时仍会中断 |
| 错误文案泄露内部信息 | 白名单 code + 固定句子 + 截断 |
