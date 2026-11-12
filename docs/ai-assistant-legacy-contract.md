# 记账项目现有 AI 助手契约盘点

> 用途：为人工将 AI 助手分阶段迁移到 Java / Spring AI Alibaba 提供源码索引和兼容检查清单。本文记录仓库中的实现，不代表生产环境、真机行为或迁移方案已经验证。迁移范围和是否完全兼容仍待决策。盘点日期：2026-11-07。

## 1. 系统边界

- 服务端为 Node.js + TypeScript、Fastify 和 SQLite；AI 提供商请求、解析和助手编排是项目自己实现的，而不是直接由某个 AI 编排框架提供。参考 [服务端依赖](../packages/server/package.json)、[AI 路由](../packages/server/src/routes/ai.ts)、[助手编排器](../packages/server/src/services/assistant-orchestrator.ts) 和 [提供商服务](../packages/server/src/services/ai-provider-service.ts)。
- 认证使用中央身份库，账本按用户隔离；每个用户有独立账本与 AI 配置。管理员权限不等于访问其他用户账本的权限，见 [多用户说明](MULTIUSER.md)。客户端可观察的是服务端 API，而不是某个模型框架。
- 金额使用整数分、时间戳使用毫秒；记账日期与服务端时区等通用规则见 [项目说明](../README.md)。Java 迁移不能把模型输出直接当作业务真相。
- 以下是代码层面的行为清单，不能单独证明线上版本、所有客户端入口或设备验收状态。对外请求/响应字段的最终真相是路由、服务类型与相关测试，不是本文的概述。
- 客户端源码依赖现有生成协议：Android 的 [AssistantRepository.kt](../clients/android/app/src/main/java/com/yansuu1/jizhang/repo/AssistantRepository.kt) 创建生成、获取快照并按 `afterSeq` 读取 SSE；iOS 的 [AssistantStore.swift](../clients/ios/Jizhang/Features/Assistant/AssistantStore.swift) 创建生成时声明 `workspace-v1` 并按序号接续事件。这里是源码证据，不表示已经在设备上验证。

## 2. 对外 HTTP 接口清单

这些路由位于经认证的服务端模块中；不同路由的完整请求、响应、边界和错误应以相应源码和测试为准。下面的 `:id` 为路径参数。

### 2.1 AI 配置及独立能力

前缀 `/api/v1/ai`，定义见 [ai.ts](../packages/server/src/routes/ai.ts)。

| 方法和路径（省略前缀） | 作用 |
| --- | --- |
| GET `/config`；PUT `/config` | 获取脱敏配置；保存配置 |
| POST `/models`；POST `/test` | 查询模型列表；显式测试提供商 |
| POST `/transaction-draft` | 根据输入生成只读记账草稿 |
| POST `/monthly-evaluation` | 月度评价 |
| POST `/organization-preview`；`/organization-apply`；`/organization-undo` | 整理预览、应用和撤销 |
| POST `/organization-runs`；POST `/organization-runs/:id/resume` | 创建、恢复日期范围分析任务 |
| GET `/organization-runs/:id`；GET `/organization-runs/:id/card` | 查询任务状态、结果卡片 |
| POST `/organization-runs/:id/apply`；POST `/organization-operations/:id/undo` | 应用所选结果；撤销操作 |

### 2.2 会话、生成和待确认操作

前缀 `/api/v1/assistant`，定义见 [assistant.ts](../packages/server/src/routes/assistant.ts)。

| 方法和路径（省略前缀） | 作用 |
| --- | --- |
| GET `/tools` | 工具目录 |
| GET、POST `/conversations` | 列出、新建会话 |
| DELETE `/conversations/:id` | 归档会话，同时处理活动生成/分析 |
| GET、POST `/conversations/:id/messages` | 读取消息；旧版同步消息入口 |
| POST、GET `/conversations/:conversationId/generations` | 创建生成任务；读取最近任务（`limit` 仅支持 1） |
| GET `/conversations/:conversationId/generations/:generationId` | 生成快照 |
| GET `/conversations/:conversationId/generations/:generationId/events` | SSE 事件与按 `afterSeq` 回放 |
| POST `/conversations/:conversationId/generations/:generationId/cancel` | 停止生成 |
| GET `/conversations/:conversationId/generations/:generationId/trace` | 生成的元数据诊断轨迹 |
| GET `/conversations/:conversationId/actions/:id/rows/:rowId/duplicates` | 导入候选重复记录 |
| POST `/actions/:id/analyse`、`/confirm`、`/cancel` | 导入分析、确认和取消待处理操作 |

创建生成的基本请求形状（可选能力字段、choice 请求和具体约束以源码为准）：

```json
{
  "version": 1,
  "clientRequestId": "client-generated-unique-id",
  "input": { "type": "text", "text": "这个月花了多少？" }
}
```

创建返回 `{ created, generation }`：新建为 HTTP 202，幂等重放为 200。输入还支持 `choice` 和 `choice-text`；字段限制见 [请求解析](../packages/server/src/services/assistant-generation-service.ts)。创建入口还可接收 `clientCapabilities: ["workspace-v1"]`，它由路由单独处理。不要将示例理解为覆盖全部输入类型。

### 2.3 助手工作区和导入

工作区仍使用 `/api/v1/assistant` 前缀，详见 [assistant-workspace.ts](../packages/server/src/routes/assistant-workspace.ts)：能力目录、CSV 导入预览及确认、会话工作流读取、交互回答、草稿读取/修订/继续、结果分页、整理卡片及准备、每日回顾和 native completion 等接口。

多文件合并导入在 `/api/v1/assistant/conversations/:conversationId/import-batches` 下，包括创建与读取批次、行/重复项/分类读取、review、analyse、文件移除/替换、confirm 和 cancel。复核需要版本、分析版本和视图版本等字段，确认需要 review token、预期版本及原文件；完整契约见 [import-batches.ts](../packages/server/src/routes/import-batches.ts)。这与旧版 `actions/:id` 导入路径不能当作同一接口。

## 3. 模型配置和提供商调用

- 模式为 `chat-completions`、`responses`、`custom`；配置包括 URL、HTTP 方法、模型、超时、请求头、认证方式、请求体模板和响应字段路径。认证类型为 `none`、`bearer` 或自定义 `header`，见 [ai-types.ts](../packages/server/src/services/ai-types.ts)。
- 自定义模板支持 `input`、`categories`、`accounts`、`model`、`today`、`responseSchema`、`facts`；模板解析不执行任意表达式，见 [AI 配置校验](../packages/server/src/services/ai-config-service.ts) 和 [提供商模板处理](../packages/server/src/services/ai-provider-service.ts)。生产 URL 要求 HTTPS。默认超时 20 秒，允许范围 3–60 秒。
- 原生上游增量流当前仅针对 `chat-completions` + `POST` + 响应路径 `choices[0].message.content`；其他配置走缓冲路径。这和对客户端提供的生成 SSE 不是同一层协议，见 [supportsAssistantStream](../packages/server/src/services/ai-provider-service.ts)。
- 持久化密钥采用 AES-256-GCM，32 字节部署密钥以 64 位十六进制配置，密文保存版本、IV、tag、ciphertext；配置查询只返回是否存在密钥等摘要，见 [ai-crypto.ts](../packages/server/src/services/ai-crypto.ts) 和 [多用户恢复说明](MULTIUSER.md)。不得在文档、日志、测试或迁移脚本中泄露真实密钥。Spring AI Alibaba 自带适配器是否覆盖所有旧模式尚未验证，不能直接假设等价。

## 4. 持久化和消息

- 基础状态包含 `assistant_conversations`、`assistant_messages`、`assistant_pending_actions`，见 [迁移 009](../packages/server/src/db/migrations/009-assistant.ts)。消息角色为 `user` / `assistant` / `tool`，类型为 `text` / `progress` / `tool-card` / `result` / `error` / `attachment`，DTO 和卡片见 [assistant-types.ts](../packages/server/src/services/assistant-types.ts)。
- 生成快照和持久事件分别存储在 `assistant_generations`、`assistant_generation_events`；同会话的 `client_request_id` 有唯一约束，并用部分唯一索引限制同会话最多一个 `accepted` / `running` 生成，见 [迁移 011](../packages/server/src/db/migrations/011-assistant-generations.ts)。
- 还包括导入批次、诊断轨迹和工作区相关表，见 [迁移 012](../packages/server/src/db/migrations/012-import-batches.ts)、[迁移 023](../packages/server/src/db/migrations/023-assistant-trace.ts)、[迁移 024](../packages/server/src/db/migrations/024-assistant-workspace.ts)。完整数据迁移方案需继续核对后续迁移、附件与恢复机制；不能只迁消息表。
- 用户隔离依赖当前用户账本上下文，而不是仅靠会话 ID。迁移期间建议保持单一数据写入权威，不能让两个进程任意并发直写同一 SQLite 文件；这是迁移建议，不是声称当前已提供 Java 内部接口。

## 5. 生成状态与事件流

权威 DTO、状态、错误及上限见 [assistant-stream-types.ts](../packages/server/src/services/assistant-stream-types.ts)，路由与所有权校验见 [assistant.ts](../packages/server/src/routes/assistant.ts)。

- 状态：`accepted`、`running`、`completed`、`failed`、`cancelled`、`interrupted`。终态为后四者；只有 `completed` 带 outcome，且完成不等于已经写入账本。
- outcome：`answer`、`awaiting-choice`、`pending-confirmation`。
- SSE 事件类型：`state`、`text-delta`、`message`、`terminal`。事件有 `version`、`generationId`、`seq`；增量文本还有 `messageId`、`step`、`offset`、`text`。`offset` 按 UTF-16 代码单元计算，例如 emoji `🍵` 的长度为 2，见 [iOS 协议测试](../clients/ios/JizhangTests/AssistantProtocolTests.swift)。读取 `events?afterSeq=...` 支持从序号之后回放。回放不可用时需要按客户端契约处理，而不是伪造完整流。
- SSE 客户端断开只关闭当前订阅，不自动取消模型生成；用户显式调用 cancel 才停止。持久事件先回放、再接实时事件并按 seq 去重，见 [SSE 路由实现](../packages/server/src/routes/assistant.ts)。
- 重试、幂等与并发是契约的一部分：同会话相同请求标识和相同内容重放已有生成；相同标识配不同内容返回冲突，不能产生重复用户消息。同一会话的新版生成、旧版同步 turn 和部分导入分析之间受活动锁约束。取消和归档先处理持久状态与后续上游中断，避免晚到结果重新落库。
- 示例上限：每次生成最多 8 个模型决策步骤、180 秒总期限、4,000 字符每轮显示、12,000 字符总显示；事件回放最多 2,048 条或 2 MiB；SSE 心跳为 15 秒。具体边界语义和其他限制应看源码，不应凭这些数字自行更改协议。
- 固定流错误码包括 `ASSISTANT_GENERATION_INVALID`、`ASSISTANT_REQUEST_CONFLICT`、`ASSISTANT_GENERATION_ACTIVE`、`ASSISTANT_CHOICE_STALE`、`ASSISTANT_REPLAY_UNAVAILABLE`、`ASSISTANT_STREAM_BOUNDS`、`ASSISTANT_GENERATION_NOT_FOUND`；其 HTTP 状态和安全错误处理见同一类型文件。

## 6. 工具与写入安全

- 工具名称是白名单，输入仍要服务端解析验证；工具定义包括 `read` 和 `write`，写工具分 prepare/confirm，见 [工具注册表](../packages/server/src/services/assistant-tool-registry.ts) 与 [工具名称](../packages/server/src/services/assistant-types.ts)。具体能力覆盖交易、账户、预算、统计、导入、整理、周期、资产、规划及工作区等，不应把本段描述当作完整工具清单。
- 待确认卡片包含 actionId、操作、影响范围、值、警告、预览、fingerprint 与状态；待处理状态为 `pending`、`confirmed`、`cancelled`、`expired`。确认时需再次校验当前状态；过期动作不能直接执行。确认路径对并发确认与已确认重试有处理，见 [assistant.ts](../packages/server/src/routes/assistant.ts)。
- 带附件导入的特定流程核对原文件 SHA-256 和大小；合并导入另有 review token 和版本检查。不要将模型的工具请求视为用户确认，也不要让模型直接绕过既有权限和账本事务。
- 工具白名单还保留部分历史模板工具名供旧消息解码，但这些名字并不作为可执行工具注册；迁移旧历史时应区别历史兼容和执行权限。

## 7. 测试与迁移检查

优先阅读和复用旧测试的输入、输出及异常场景，逐功能建立 Java 对照测试；下面是起点，不代表已运行通过：

- [助手契约测试](../packages/server/test/assistant-contracts.test.ts)：消息、工具名、校验等。
- [流式路由测试](../packages/server/test/assistant-stream-routes.test.ts)：模型模拟、事件及并发等。
- [流与生成持久化测试](../packages/server/test/assistant-stream.test.ts)、[生成持久化测试](../packages/server/test/assistant-generation-persistence.test.ts)。
- [助手业务工具测试](../packages/server/test/assistant-business-tools.test.ts)、[助手工具可靠性测试](../packages/server/test/assistant-tool-reliability.test.ts)、[工作区路由测试](../packages/server/test/assistant-workspace-routes.test.ts)。
- AI 配置、导入、租户与恢复等还需要按对应测试继续梳理；历史生产数据和客户端兼容情况需独立验收。

每项迁移至少检查：认证与跨用户隔离、输入校验、旧数据可读性、重复请求、并发锁、取消/恢复、超时与安全错误、确认前零写入、确认重试与过期冲突、回滚。对会接触财务数据的链路，先用隔离测试数据库验证。

## 8. 已发现的现有兼容风险

- **Android 生成步骤范围不一致：**服务端允许最多 8 步，循环使用 `step` 0–7；Android 当前的 partial snapshot 和 `text-delta` 解析只允许 0–2。见 [服务端限制](../packages/server/src/services/assistant-stream-types.ts)、[服务端循环](../packages/server/src/services/assistant-generation-runner.ts) 和 [Android 解析](../clients/android/app/src/main/java/com/yansuu1/jizhang/repo/AssistantStreamingModels.kt)。这意味着携带 step ≥ 3 的相关数据会被 Android 解析器拒绝；实际用户界面影响尚未进行设备验证。迁移前应决定如何兼容并增加 step ≥ 3 的端到端测试，而不是盲目复制此不一致。

## 9. 尚待产品和技术决策

1. 客户端接口、历史会话、所有模型模式及功能是否要求最终完全兼容；哪些允许调整。
2. Java 与 Fastify 的可信服务间身份传递、工具调用接口和权限边界如何设计。
3. 迁移过程中状态的唯一写入方、正在运行的任务如何切换，以及如何回滚。
4. 历史加密配置与密钥由谁持有/解密；密钥轮换和互操作测试如何安排。
5. 模型及 Spring AI Alibaba 版本、供应商支持矩阵，以及每项旧能力的迁移先后。均需单独验证，不应从本清单直接推断。

本文是盘点，不授权直接迁移生产数据、修改部署或删除旧功能。
