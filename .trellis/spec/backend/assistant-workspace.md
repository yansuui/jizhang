# Conversational workspace contracts

Applies to the assistant workspace routes/services, migrations 024–025, capability adapters
and iOS workspace clients. Existing v1 generations, SSE and explicit action confirmation
remain authoritative; this is not arbitrary HTTP/SQL dispatch or a second unbounded agent.
Exact request/response fields are maintained in
[workspace v1](../../tasks/11-04-ios-assistant/research/harness-wire-contract.md).

## Capability and interaction boundary

- Ordinary clients negotiate `clientCapabilities:["workspace-v1"]` on generation creation.
  Old requests/history/cards remain readable and do not silently gain continuation work.
- `workspace.select` obtains actual account/category/tag/bill/salary/item/recurring/goal/
  fund-source/transfer/trash candidates, or a Shanghai ledger date range. IDs, filters,
  paging, expiry and allowed selections are server-owned and persisted by conversation.
- Selection answers atomically consume the interaction and bind one continuation generation.
  Changed/stale/foreign-owner answers fail; same request/payload replays the same result.
  Canonicalize JSON keys before hashing request identity, including nested arguments.
- Native destinations are enums with optional owned item/conversation/batch IDs. Never
  execute a provider-supplied URL. Protected forms/files stay outside model context and
  real auth capabilities remain server-authoritative.

## Approval, correction and continuation

- Financial and other business writes still prepare a durable action/card; selecting a
  resource, generating prose, or an earlier unrelated consent does not approve a mutation.
- Draft GET exposes a schema and full business arguments to the authenticated native UI.
  Repreview validates through the original adapter, cancels the old pending card and creates
  an immutable replacement. Preserve revisions/tokens; do not mutate an approved payload.
- After confirmed action status is authoritative, an explicit action-scoped continuation
  resumes only the original task. It is idempotent across reopening and uncertain responses.
  A subsequent write pauses again. A continuation failure cannot downgrade a successful
  mutation to unconfirmed or cause a new action/financial write.
- Selected facts and approved references persist separately from the last twenty messages.
  Keep eight decisions/180 seconds per generation, existing result/history/replay bounds,
  and deterministic handoff of background organization jobs.
- Organization paging and selected prepare are direct typed operations with no model call
  or composer-string bridge. Exact selection and domain fingerprint checks still apply.
- Reconcile workflow/interaction phase with Stop, cancellation, archive and interrupted
  recovery; stale metadata must not keep a task labelled running after work has ended.

## Daily review and native imports

- A notification tap explicitly launches one frozen date/zone request via the existing
  generation/SSE path. Load authoritative full-day ordinary/refund/salary facts, including
  the complete salary window, not a first page. Transfers remain outside income/expense.
- The daily read-only marker belongs to the durable workflow and is inherited through
  selections/clarifications. Enforce it before any write prepare, not just in a prompt.
  Potential issue evidence is bounded and labelled, never proof of a duplicate.
- Generic CSV import preview is dedicated native transport: at most 2 MiB, explicit
  columns/rows/count/omission, real SQLite-only import validation in rollback, 20-minute
  expiry, original digest and business-ledger fingerprint. Persist no raw CSV in chat.
  Confirmation checks the same bytes/CAS and commits once with its durable receipt.
- File/worker/network operations cannot be made safe merely by rolling back SQLite.
  Keep platform merged import, image processing and export in their dedicated protocols.

## Live activity and checks

Trace stores operation shape/status/timestamps, not raw argument strings/numbers, bill
notes, credentials, provider bodies or hidden reasoning. Discard unsafe historical argument
summaries on read and safely clean old stored values. Trace failures remain best-effort.

Use real isolated routes for read/select/revise/confirm/continue, JSON-order replay,
foreign/stale identities, read-only daily continuations and exact CSV preview/confirm.
Test lifecycle recovery, original-file ambiguity and domain money definitions. Native
mock/state tests and macOS build evidence are separate from signed-device/live-provider
acceptance. Update Android's affected stable contract inventory without implying new UI.

## Native outcome continuation

### Scope and trigger

A successful native import/photo/export must return verified facts to the original
`workspace.open` task before the requested follow-up can continue. Native UI success
text or a model-generated claim is not a server receipt. Source implementation is
`services/assistant-native-completion.ts`, `AssistantWorkspaceService.nativeCompletion`
and the authenticated `routes/assistant-workspace.ts` registration.

### Signatures and storage

`POST /api/v1/assistant/conversations/:cid/workspace/native-completions`
accepts `{clientRequestId,sourceMessageId,reference}` and returns
`{created,generation,workflow}`:202 for creation,200 for committed replay.
Migration025 adds nullable integer `assistant_csv_previews.confirmed_at`; first CSV
confirmation writes result and timestamp in the same transaction. Never rewrite024 or
invent historical timestamps. Legacy results remain import-confirm replayable.

### Request and result contracts

`reference` is a closed union; no extra fields, raw CSV, prose or credentials:

- `{kind:"csv-import",previewId}`
- `{kind:"platform-import",batchId}`
- `{kind:"item-photo",itemId,operation:"saved"|"viewed",sha256}`
- `{kind:"item-photo",itemId,operation:"removed"}`
- `{kind:"export",exportKind:"transactions"|"salaries"|"recurring"|"transfers"}`

IDs are nonblank strings of at most120 units. SHA256 is exactly64 lowercase hexadecimal
characters over current raw image bytes; removal omits it. The source must be an owned
assistant `workspace.open` result with a completed bound generation and matching native
destination/item. CSV receipts need a nonnull confirmed_at >=source.createdAt; confirmed
batch receipts additionally belong to that conversation and use updated_at >=source time.
Photos prove current matching bytes or absence, not who changed them. Exports regenerate
the allowlisted CSV and prove server readability, not device storage or OS Share success.

The visible result has `toolName:"workspace.open"` and `data.nativeCompletion` containing
`sourceMessageId`, the typed reference, verified result/counts or current-state metadata,
`checkedAt` and truthful attribution. `lastNativeOutcome` in the original workflow holds
the same bounded facts. Canonical request identity and source/reference receipt identity
deduplicate continuation; alias request IDs also freeze to the recorded reference.
Result/facts/request records and generation binding commit atomically. Replay returns the
recorded generation before rechecking subsequently changed state. Daily scope inherits;
every later write still prepares a new approval. Protected credential/logout/server-switch
destinations have no completion kind and cannot continue across invalidated auth scope.

### Validation and error matrix

| Condition | Response |
| --- | --- |
| Unknown kind/field, invalid digest/ID/operation |400 ASSISTANT_WORKSPACE_INVALID |
| Unknown/foreign source, receipt, batch or live item |404; no source/tenant disclosure |
| Source destination/item or reused request content differs |409 ASSISTANT_WORKSPACE_CONFLICT |
| Archived conversation, uncompleted source, missing/older receipt, changed photo |409 ASSISTANT_WORKSPACE_STALE |
| Another active conversation operation |409; entire attempted continuation rolls back |
| Missing session/CSRF | Existing401/403 authentication envelope |

### Good, base and bad cases

Good: explicitly confirm CSV, submit its preview ID with the original import card ID,
then read the ledger and summarize within that original task. Base: reopening resubmits
the identical frozen request and recovers the same generation. Bad: old receipts, wrong
card/item/conversation, unconfirmed imports or a bare “saved” string cannot prove success.

### Required tests

`assistant-workspace-routes.test.ts` exercises real CSV and merged-batch confirm ->
continuation, actual ledger readback, canonical replay/alias conflicts, all four exports,
photo view/save/remove hash checks, stale/null receipt timestamps, foreign sources,
subsequent approval and inherited daily read-only enforcement. A forced receipt INSERT
failure must leave no outcome message/facts/generation. `db.test.ts` upgrades024 to025,
preserves old result JSON with null time and verifies idempotent migration. These are
isolated source/automated evidence, separate from final macOS/native/device/live gates.

### Wrong versus correct

Wrong: append client text “import succeeded” as a new prompt, or claim Share success from
HTTP200. Correct: submit the typed receipt/source pair, reread authoritative server facts,
resume the original workflow once, and state exactly what those facts establish.
