# 生产失败证据（2026-11-06 变更前快照）

## 快照来源

`~/.ssh/jizhang-backups/multiuser-20261106/final-snapshot.db`（2,134,016 字节，2026-11-06 10:45 生成）。
本地只读查询（`mode=ro&immutable=1`），未访问生产服务器、未修改任何文件。

## 供应商配置

```json
{"mode":"chat-completions","method":"POST","url":"https://api.yansuu1.com/v1/chat/completions",
 "model":"gpt-6-luna","timeoutMs":20000,"responsePath":"choices[0].message.content",
 "auth":{"kind":"bearer"},"headers":{},"bodyTemplate":null}
```

即：Chat Completions + `response_format: {type: "json_object"}` + 20s 超时 + 自建网关。

## assistant_generations 汇总

| status | error_code | error_message | 次数 |
|---|---|---|---|
| completed | — | — | 29 |
| failed | ASSISTANT_STREAM_BOUNDS | AI 返回内容无法识别，本次生成未产生结果。 | 5 |
| failed | ASSISTANT_STREAM_BOUNDS | AI 回复超出长度上限，本次生成未产生结果。 | 2 |
| failed | ASSISTANT_STREAM_BOUNDS | AI 响应超时，本次生成已中断。 | 1 |
| cancelled | ASSISTANT_GENERATION_CANCELLED | 生成已被用户停止。 | 1 |

**关键**：5 次「无法识别」全部是 `{state:1, terminal:1}` 级别事件，
零条 `text-delta` —— 说明上游在第一个可解码字符前就不满足 JSON 信封，
tokenizer 在 `push` 阶段即抛 `INVALID_ENVELOPE`。

## 三次整理记录失败的用户输入

| 时间 | 用户输入 |
|---|---|
| 2026-11-05 14:07:43 | `最近30天` |
| 2026-11-05 14:08:12 | `先查看不限定日期的整理预览` |
| 2026-11-05 14:21:47 | `最近30天（2026-10-07 至 2026-11-05）` |

同一对话中模型自己承认：

> 刚才只收到"最近30天"，但我没有继续调用整理预览，所以流程停在了日期确认后；没有修改任何账单。

说明模型在拿到 clarification 答复后没有继续走整理流程 —— 与「步数耗尽 / 工具报错杀轮」一致。

## ai_analysis_runs

| 状态 | error_code | 次数 |
|---|---|---|
| ready | — | 2 |
| failed | AI_PROVIDER_TIMEOUT | 4 |
| failed | AI_PROVIDER_ERROR | 2 |
| failed | AI_RESPONSE_INVALID | 1 |

成功两次分别尝试 3 次、耗时 377.7s/226.0s 与 96.6s；
说明该上游在批量分析场景下不稳定，但这是既有行为，不是本任务第一优先级。

## 代码侧对应点

- `assistant-generation-runner.ts:749` — `registry.read` 抛错直接冒泡到 `run()` → `finalizeFailed`。
- `assistant-generation-runner.ts:372` — 步数循环上限 3，耗尽即 `finalizeFailed`。
- `ai-provider-service.ts:604` — delta 字段白名单只允许 `content`/`role`。
- `ai-provider-service.ts:649` — 未收到 `[DONE]` 即 `INVALID_ENVELOPE`。
- `assistant-stream-tokenizer.ts:131` — 第一个非 JSON 字符即失败（零 delta 的根因）。
- `AssistantModels.swift:32` — iOS 把全部 STREAM_BOUNDS 折叠成同一句提示。
