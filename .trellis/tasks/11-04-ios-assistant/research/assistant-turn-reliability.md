# Assistant turn reliability implementation — 2026-11-06

Scope: generation runner, legacy buffered orchestrator, provider instructions and their
integration tests. Work remains on the original repository/main. No live-provider calls,
production writes, commits or pushes were performed by this worker.

## Proven causes

1. The former three-decision budget counted the final answer as a decision. Three valid
   ordinary reads followed by an answer failed before the fourth provider call.
2. Successful read results were only held in `lastResult` until the final answer. The next
   read replaced the earlier facts; a later provider error lost all result cards. The
   independent reviewer reproduced transaction → items → answer with unique transaction
   marker visibility `[false,true,false]` in actual provider requests.
3. `spending.preview` scheduled real background work, but the prompt requested model
   progress polling. The runner exhausted its decisions without saving `data.run`, so
   the native client could not mount its existing task card. This explains the screenshot.
4. Snapshot validation also hardcoded step indexes 0–2. Merely increasing the loop bound
   produced a snapshot HTTP 500 at the fourth streamed decision.
5. Typed business validation ended the whole generation, leaving no opportunity to fix
   arguments. Separately, normal organization states such as >500 eligible bills, a
   pending card or an active task were mapped to the same generic generation failure.
6. Large legal reads could exceed replay limits: two pages of 100 bills with 4,000 Chinese
   characters per note failed while persisting the second read. The fix must also respect
   native SSE line/frame limits, not just the server's 2 MiB aggregate replay bound.

## Runtime contract

- Shared `MAX_GENERATION_STEPS` is **8 provider decisions including the final answer**.
  The streamed partial/snapshot validators use the same bound. Total generation deadline
  stays **180 seconds**; no replay/subscriber/provider-envelope limit was raised.
- Legacy turns also share that 180-second total deadline. Outer and nested provider calls
  receive only the remaining timeout. File analysis batches use the same turn budget;
  failure still leaves the explicit, reviewable file preview and failed analysis status.
- Every validated ordinary read is saved immediately as an independent result message.
  Final prose does not duplicate the last card. Later failures leave earlier facts in
  conversation history. Read facts appear in both `facts.messages` and `input.priorMessages`
  so existing custom templates consuming only input can still see earlier reads.
- Recent context uses the existing 20-message source window, bounded to 128 KiB by removing
  oldest whole context entries with an explicit omission/re-read notice. Current-turn read
  facts stop further inference after exceeding 64 KiB and end with a truthful partial-range
  explanation. Persisted history is not deleted.
- A canonical tool name + arguments identity stops identical read loops without running the
  tool or model again. Different offsets/ranges remain distinct. At the decision budget,
  already-read results are preserved and the turn normally completes with a limit message.
- Only trusted business error codes with HTTP 400/404/409 receive up to **two** additional
  correction opportunities, using a fixed safe schema hint. Unknown tools and retired
  salary-allocation inputs remain hard failures. Auth, cancellation, timeout, active-session,
  infrastructure and unknown errors do not become correction opportunities.
- Specific expected organization states receive fixed actionable completed text without
  another inference call. The exact code and status must both match. No original error
  text, provider body, internal endpoint or credential is copied into these replies.

## Native handoff and payload budgets

Background handoff retains the existing wire contract:

```text
message.kind = result
message.content.result = { version:1, toolName, summary, data:{run:{runId,status,...}} }
generation.status = completed
generation.outcome = answer
```

`spending.preview`, `spending.status`, `spending.resume`, and a not-ready `spending.card`
with a valid actual `data.run` complete deterministically. Ready suggestion cards still
return the existing actions/page structure. The native task card reads progress directly;
the generation does not poll through another provider call. Background start/resume uses
the tenant-owned context, so disposal of the short chat-tool scope does not abort the job.

The adapter worker's central read projection ensures tool-result JSON <=40 KiB before
the runner saves a card. Long text summaries carry explicit truncation metadata. Numeric
offset pages can shrink with truthful `limit/nextOffset/hasMore`; cursor pages are not
silently sliced. An unsafe oversized result instead carries `requiresNarrowerQuery` and
`financialFactsOmitted`, and ends with an explicit incomplete-query message. The runner's
40/64/128 KiB policies do not change monetary values, hashes or selected financial effects.

Before saving a streamed financial confirmation, the runner measures the entire message
JSON plus event allowance against 48 KiB. A larger preview normally completes with a request
for fewer selected records, before creating any pending action. It does not crop the write
scope. Legacy attachment POST/messages retains its original full-preview path; there is no
generic registry.prepare size rejection.

A read tool can persist its narration before a domain error occurs. Completed safe outcome
text then receives a new message ID rather than reusing the already committed provisional
ID; otherwise the existing replay/idempotency fence would skip that outcome silently.

## Safe normal organization feedback

These are completed assistant text, **not new stream error codes or reason fields**:

| Exact code / status | Fixed behavior |
| --- | --- |
| `AI_ORGANIZATION_OVER_CAP` / 400 | 一次最多整理 500 笔账单；缩小日期；本次未启动新任务。 |
| `AI_ORGANIZATION_RUNS_INVALID` / 400 | 补充正确起止日期或要继续的任务。 |
| `AI_ORGANIZATION_INVALID` / 400 | 核对选择或范围，重新预览。 |
| `AI_ORGANIZATION_RUN_NOT_FOUND` / 404 | 从已有任务卡继续，或给出日期重新分析。 |
| `AI_ORGANIZATION_NOT_READY` / 409 | 查看原任务进度，完成后再读取建议。 |
| `AI_ORGANIZATION_CONFLICT` / 409 | 账本/建议已变化，重新预览再确认。 |
| `AI_ORGANIZATION_BUSY` / 409 | 查看已有任务；明确本次新范围尚未启动。 |
| `AI_ORGANIZATION_OPERATION_NOT_FOUND` / 404 | 重新读取整理记录并核对操作编号。 |

The existing stream failure DTO stays `{code,message}`. Provider timeout/network/config/
invalid-envelope and deadline/cancellation use existing safe fixed messages. Swift can
allowlist those messages and retain its generic fallback; this work adds no raw-message
display permission and no automatic provider retry.

## Verification evidence

Final focused command with Node 22.23.4 and workspace pnpm:

```text
pnpm --filter @jizhang/server exec vitest run test/assistant-stream-routes.test.ts test/assistant-turn-policy.test.ts test/assistant.test.ts
3 files / 77 tests passed (53 route + 4 policy + 20 legacy)
pnpm --filter @jizhang/server typecheck
passed
```

ESLint passed for all owned changed source/test files. Actual Fastify route regressions
cover streamed and buffered background handoff, four distinct reads followed by an answer,
multi-read plan preview and explicit confirmation, bad-argument recovery with zero financial
writes, canonical duplicate reads, eight distinct reads with budget completion, persistence
after provider failure, legacy 180-second deadline, long-read SSE/replay bounds, oversized
write preview with zero pending action, 501-bill feedback, not-ready card actual-run handoff
with exactly one provider call, and a different-range busy request that starts no new task.
Existing cancellation, archive, nested-provider prepare, idempotency and attachment-confirm
regressions remained passing in the same focused run.

The independent reviewer reran the original large-page reproduction: completed, three
provider calls, two approximately 27 KiB cards, 56,098-byte replay. It also independently
verified seven distinct reads followed by the eighth decision's answer, with the first
marker retained in all seven subsequent provider user-input bodies and persisted history.

These are isolated synthetic-provider and source checks. Root owns the full repository
gate, Swift/native CI, commit/push, IPA artifact and any later deployment/device checks.
