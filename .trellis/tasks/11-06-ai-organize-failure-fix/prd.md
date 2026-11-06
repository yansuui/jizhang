# 修复 AI 整理记录频繁失败与错误提示

## 背景

用户反馈：AI 助手的「整理记录」（历史账单整理）对话频繁出现「本次回复未能完成」。
这句提示在 iOS 上是 `AssistantModels.swift` 对 `ASSISTANT_STREAM_BOUNDS` 的固定映射，
服务端实际原因被一并吞掉。

## 生产证据（2026-11-06 变更前快照）

来源：`~/.ssh/jizhang-backups/multiuser-20261106/final-snapshot.db`（10:45 生成，只读查询）。

供应商配置：`chat-completions`、`response_format: json_object`、`timeoutMs: 20000`、
模型 `gpt-6-luna`、网关 `api.yansuu1.com`。

`assistant_generations` 失败分布：

| 服务端真实原因 | 次数 |
|---|---|
| AI 返回内容无法识别（INVALID_ENVELOPE） | 5 |
| AI 回复超出长度上限 | 2 |
| AI 响应超时 | 1 |

关键细节：11-05 那轮整理对话连续 3 次失败，事件记录均只有 `{state:2, terminal:1}`，
**零条 text-delta** —— 上游在产出第一个可解码字符前就不满足 JSON 信封。
用户当时问「为什么未完成」，模型自己也承认「没有继续调用整理预览」。

`ai_analysis_runs` 9 次中 7 次失败：4 次 `AI_PROVIDER_TIMEOUT`、2 次 `AI_PROVIDER_ERROR`、
1 次 `AI_RESPONSE_INVALID`；成功的两次分别是 attempt=3（226s）和 96.6s。

## 需求

### R1 工具错误不得杀死整轮生成

工具执行失败（参数不合法、`AI_ORGANIZATION_NOT_READY`、越界日期、超出上限等）必须以
结构化工具结果回灌给模型，让模型解释或换参重试，而不是让整轮生成 `failed`。

### R2 整理流程不再让模型在同一轮内轮询

`spending.preview` / `spending.resume` 返回后，提示词应让模型直接结束本轮并告知任务已在后台运行。
进度由客户端经 `/ai/organization-runs/:id` 独立轮询，不占用生成步数。

### R3 步数上限与「步数耗尽」的降级行为

`MAX_GENERATION_STEPS = 3` 对 `preview → status → card` 这类多跳流程过紧。
同时「步数耗尽」不应直接失败：已有可用工具结果时应降级为该结果 + 说明，而非丢弃整轮。

### R4 容忍不合规的信封形态

上游在 `response_format: json_object` 下仍返回纯文本或 ```json 围栏时，
应剥掉围栏后重试解析，而不是零输出直接 `INVALID_ENVELOPE`。

### R5 客户端展示服务端具体原因

iOS 对 `ASSISTANT_STREAM_BOUNDS` 应优先展示服务端下发的安全文案（该文案本身已是固定安全句子），
仅在没有文案时回退到通用提示。Android 已按原因分开措辞，保持现状。

### R6 回归测试

为 R1–R4 增加服务端回归测试；iOS 侧增加错误映射单测。

## 非目标

- 不改变账本写入、确认语义与资金口径。
- 不放松任何安全边界（provider 报文、凭据、prompt 永不外泄）。
- 不做生产部署（部署需单独授权）。
- 不调整 `MAX_GENERATION_DEADLINE_MS`（180s）既定契约。

## 验收标准

- [ ] 工具抛错时该轮仍产出可见回复，且模型能看到错误内容
- [ ] 整理预览轮不再耗尽步数；不需要模型轮询进度
- [ ] 纯文本/围栏信封能正常解析为最终回复
- [ ] iOS 在失败时展示服务端具体原因
- [ ] 服务端 lint / typecheck / test / build 全绿；iOS 单测通过或明确记录未跑
- [ ] 相关 README / spec 同步更新
