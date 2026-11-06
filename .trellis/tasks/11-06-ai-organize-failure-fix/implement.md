# 实施计划：AI 整理记录失败修复

## 前置

- 已读 `.trellis/spec/backend/assistant-streaming.md`、`assistant-business.md`、`frontend/ios-client.md`。
- 证据：`research/production-evidence.md`。

## 已由 zhangh 的提交完成的部分（勿重复实施）

`4033d26` / `d3eddc3` / `ebc8086` 已实现：
步数上限 3→8、后台任务确定性交接、工具错误可纠正/给出可操作回复、
iOS 服务端安全文案映射、结果投影与传输边界。

**因此下列原 D1/D2/D3/D5 条目已完成，本任务只保留剩余部分。**

## 剩余范围（2026-11-06 用户确认）

用户明确：**只做 iOS 端，不做安卓端**；顺序为 **先 D4，后执行轨迹**。

### A. D4 宽容信封解析（先做）

目标：模型偶发不守 `response_format: json_object` 时不再整轮报废。

文件：`packages/server/src/services/ai-provider-service.ts`、
`packages/server/src/services/assistant-generation-runner.ts`

- [ ] 新增独立的围栏剥离工具函数（可单测）：支持 ```json / ``` 两种围栏、
      前后空白与说明文字，返回剥离后的候选 JSON 文本。
- [ ] `runStreamedStep` 的 `JSON.parse(envelopeText)` 失败时先尝试剥离再解析。
- [ ] 纯文本兜底：剥离后仍无法解析且正文非空时，作为 `{message, toolCall:null,
      clarification:null}` 回复，**不产生卡片/确认**。
- [ ] 空内容仍维持 `INVALID_ENVELOPE`。
- [ ] 安全边界不变：原始报文永不外泄，长度受既有上限约束。

验证：`pnpm --filter @jizhang/server test` 全绿；新增针对性回归。

### B. 执行轨迹（后做，仅 iOS）

- [ ] 新增 `trace` 消息类型（不复用 `progress`，避免破坏既有三态语义）。
- [ ] 服务端每步写入：序号、类型（thinking/tool/result/error）、工具名、
      参数摘要、耗时、状态；与 `persistTurn` 同事务。
- [ ] 只记录可公开元信息；**不记录**模型原始推理、provider 报文、prompt、SQL。
- [ ] iOS 折叠 UI：默认收起，失败时自动展开。
- [ ] **Android 不改造**（用户明确不做）；服务端需保证旧客户端忽略新类型不报错。
- [ ] 需新增数据库迁移。

## 验证命令

```bash
pnpm -r run lint
pnpm -r run typecheck
pnpm -r run test
pnpm build
```

iOS 无法在 Windows 编译，只能静态检查 + 记录未跑原生测试。

## 回滚点

A、B 独立可回滚；A 完成并全绿后再开始 B。
