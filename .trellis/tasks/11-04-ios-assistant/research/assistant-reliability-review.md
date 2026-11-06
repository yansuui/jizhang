# Independent assistant reliability review — 2026-11-06

Scope: read-only source investigation plus isolated in-memory runner fixtures. Baseline is
`e316f5c`; sibling agents own implementation. No product source, production database,
live provider or credentials were modified by this reviewer.

## Confirmed causes

### 1. Ordinary three-read workflows cannot finish

Baseline `assistant-stream-types.ts` sets `MAX_GENERATION_STEPS = 3` and the runner spends
one provider decision per single tool call. A request to read accounts, categories and
tags needs three reads and then an answer; the final decision is never reached.

Executed via `pnpm --filter @jizhang/server exec tsx --input-type=module -` with migrated
in-memory SQLite, real `AssistantConversationService`, `AssistantGenerationService` and
`AssistantGenerationRunner`, a configured synthetic buffered provider and immutable actor.
The provider script queued:

1. `master-data.read({kind:'accounts'})`
2. `master-data.read({kind:'categories'})`
3. `master-data.read({kind:'tag-names'})`
4. a normal final answer

Observed baseline output:

```json
{"providerCalls":3,"status":"failed","error":{"code":"ASSISTANT_STREAM_BOUNDS","message":"本次生成步骤过多，已中断。"},"resultCards":0}
```

All three domain reads had succeeded. History contained only their narration, not any
read result. This is a concrete non-organization failure, not a speculative provider fault.

### 2. Earlier successful read facts disappear after the next read

The baseline runner keeps only `lastResult` and persists a result card only in
`finishTextTurn`. `readTool` persists narration, so earlier facts are absent from both
`conversations.context()` and durable history after `lastResult` is overwritten.

A second real-runner fixture seeded one expense with unique note `review_unique_fact_71af`
and scripted `transactions.query({})`, `items.read({})`, then a normal final answer.
Observed output:

```json
{"providerCalls":3,"status":"completed","requestContainsFact":[false,true,false],"resultToolNames":["items.read"],"historyContainsFact":false}
```

The model receives the bill on its second decision but loses it on its third decision.
Increasing only the step count cannot fix multi-domain or multi-account summaries. Reads
must be preserved in bounded provider context and inspectable history.

### 3. Background job starts without an observable result card

The screenshot matches the same control-flow defect: `spending.preview` schedules a run;
the prompt asks the model to query status; repeated reads exhaust three decisions. The
run is durable but its `result.data.run` only existed in `lastResult`. The failed terminal
therefore leaves no job card for `AssistantSpendingRunStatus` to observe. Deterministic
start/status handoff must persist the result and complete the chat turn without another
model polling decision. Baseline `spending.status` already uses `{run: ...}` correctly;
no top-level/nested run shape mismatch was found.

### 4. Error causes collapse twice

`toStreamError` maps provider timeout, provider connection failure, configuration faults,
invalid provider output and unknown errors into the one `ASSISTANT_STREAM_BOUNDS` code,
using distinct fixed safe messages. iOS `AssistantFault.displayMessage` then ignores those
messages for that code and always renders the screenshot's generic unfinished-reply text.
This conceals whether the fault is budget, provider transport or format/schema. Any fix
must expose only fixed server-owned diagnostics, never raw provider bodies or secrets.

### 5. A transient native polling error permanently stops observation

The baseline Status View's `.task(id: runID)` exits its loop when `error != nil`. Manual
refresh can clear the error but does not change `runID`, so automatic observation does not
restart. A paused observer needs explicit restart or bounded transient-error recovery.

## Why earlier tests did not catch these

Registry/domain tests prove an individual adapter's arguments, calculations, preview and
confirmation; they do not exercise multiple provider decisions, intermediate fact retention,
job-card persistence, exhausted budgets or the native polling state machine. The fixes need
conversation-level scripted-provider regressions in both streamed and buffered delivery,
not only more single-tool domain tests. Budget growth must remain bounded and preserve
Stop/archive/deadline fencing, explicit financial confirmation and action/request identities.

## Review of in-progress fixes

- Runner worker was notified of both executed reproductions and is adding persistent read
  result cards, bounded read context, background handoff and duplicate-read handling.
- Root's new `AssistantSpendingRunStore` and six read-only transport tests were independently
  read. `example.com` matches `CoreMockURLProtocol.canInit`; retry and read bounds, observation
  tickets, old-ticket completion fencing and `ledgerRevision == 0` are coherent. No definite
  Swift syntax or session-ownership defect was found. Native compilation remains required.
- The new observer replaces the stopped-error fixed-ID loop with bounded retries and an
  explicit refresh ticket. `openCard` is an independent GET task, but its result is confined
  to the original run/API store; no demonstrated cross-conversation pollution warrants
  expanding this change.
- Android's streamed model decoder was searched for a closed three-step upper bound; no
  such consumer-side limit was found in the relevant streaming models/reducer source.

The reviewer has not claimed final integrated tests passed; final checks belong to root
after the implementation workers freeze their changes.

## Final backend integration review (2026-11-06)

Read-only review covered the final runner, legacy orchestrator, provider prompts, shared
turn policy, registry and result projection. Review-driven changes were made by their
owners; this reviewer only changed this research note and the relevant Android catalogue.

### Bounded result persistence required an additional cross-layer fix

Persisting every successful result exposed a real replay-size failure. A migrated
in-memory database held 200 valid expenses, each with a 4,000-character Chinese note.
Two `transactions.query` calls requested 100 rows each. Before the final projection,
the second successful read failed the generation with the 2 MiB replay bound; only the
first result was durable:

```json
{"calls":2,"status":"failed","error":{"code":"ASSISTANT_STREAM_BOUNDS","message":"本次生成回放数据超出上限，已停止。"},"resultCards":1,"eventBytes":{"n":1241038}}
```

The registry owner added an explicit read-result projection, preserving integer amounts,
identifiers, tags and concurrency hashes. Long display text is marked as summarized;
offset pages may shrink only with truthful continuation metadata. Results that cannot fit
must explicitly request a narrower query and cannot masquerade as empty or complete facts.
The runner stops normally before a further model decision when accumulated read facts
exceed 64 KiB. Replay and native single-line limits remain enforced.

The same real-runner fixture after this change completed, with two small result cards:

```json
{"calls":3,"status":"completed","error":null,"resultCards":2,"cardSizes":[27106,27109],"cardFields":[{"shown":25,"total":200,"hasMore":true,"nextOffset":25,"pageReducedForDisplay":true},{"shown":25,"total":200,"hasMore":true,"nextOffset":125,"pageReducedForDisplay":true}],"eventBytes":{"bytes":56098}}
```

The scripted second request deliberately retained its original offset 100; the result
does not claim that the two pages cover every record. A real caller must use the returned
`nextOffset` to continue each page.

### Cursor pages must not inherit offset shrinking

The initial shared projection would also shrink any `items` plus `total` collection,
leaving a goals cursor pointing beyond omitted records. The reviewer reported this
contract defect directly to the owner. The final guard shrinks only an explicit offset
page (or the documented recent-transactions alias); a cursor page too large to fit asks
for a smaller query without fabricating `nextOffset` or retaining a misleading cursor.

A real `FinancialGoalsService` fixture created 120 valid progress entries with 200-character
Chinese notes. Its 100-entry page was 81,125 bytes; the final projection returned
`requiresNarrowerQuery: true`, `financialFactsOmitted: true` and the true total 120. A
10-entry query retained all ten items and its exact original `nextCursor`.

### Eight-decision fact retention independently verified

The final runner was exercised with seven distinct successful reads, followed by a normal
eighth provider answer. The first read contained the unique bill marker from reproduction
2. The reviewer inspected the actual provider **user input**, independently of the system
facts, so custom templates using input also receive the earlier result:

```json
{"calls":8,"status":"completed","error":null,"inputsContainFact":[false,true,true,true,true,true,true,true],"resultCards":7,"historyContainsFact":true}
```

This verifies the final decision budget, intermediate persistence and cumulative facts
together. Recent history is bounded to 20 source messages and 128 KiB, with an explicit
omission notice when earlier content is removed; current read facts stop growing before
another decision can evict the current chain silently.

### Safety and lifecycle review

- Unknown/retired tools and retired salary allocation fields are checked before the
  correction catch. Only known business validation failures get at most two additional
  corrections; authorization, cancellation, timeout, busy/session and non-400/404/409
  errors remain outside that policy.
- Successful reads are fenced after asynchronous execution. Streamed writes prepare
  under an abort/deadline scope and recheck liveness, archive state and deadline before
  atomically persisting the pending action, confirmation card and terminal state. The
  change does not bypass explicit financial confirmation or introduce model-side ledger
  mutation.
- Oversized streamed financial previews request a smaller selection before creating a
  pending action; the visible financial effects are not silently clipped.
- Legacy buffered orchestration now shares the eight-decision budget and a total
  180-second deadline, including sequential provider calls, rather than granting eight
  independent full-duration requests.
- Historical organization start/resume uses the tenant-owned provider context. Closing
  the temporary chat-tool scope after a normal handoff does not cancel the scheduled
  background job. Progress status is a GET/read concern rather than a new model loop;
  resume remains an explicit user action.

No further high-confidence blocking defect was found in this final reviewed scope.
These are source review and isolated synthetic-provider results, not live-provider,
production, full-suite or device acceptance evidence. Final integrated gates belong to
root. `clients/android/README.md` was updated only for the affected assistant contract,
execution bounds, result projection and known native gaps; no Android source or global
inventory totals/audit dates were changed.

## Final long-note disclosure follow-up

A later frozen-diff review used a legal 4518-unit note with a unique tail marker and
found the general JSON normalizer's 4000-unit limit acted before the detail projection.
The missing text was not disclosed despite the tool promising a complete note. The tool
owner retained the global guard, removed that unqualified promise, and added original/
displayed lengths, truncation/full-note-omitted fields and a native-detail direction.
A realistic persisted-result/SSE regression proves the domain note remains unchanged.
The focused 82-test follow-up, typecheck and lint passed; root records final CI separately.
