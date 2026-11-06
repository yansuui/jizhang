# Backend conversational workspace handoff — 2026-11-06

## Delivered source boundary

Original main, no worker commit/deploy/live provider. Root owns the cutout JPEG/PNG
proxy/client/tests separately; this worker did not edit those files. All other server
workspace source/test changes are frozen after the focused gate below. Native contracts
were coordinated directly with the iOS worker in `harness-wire-contract.md`.

New migration024 stores tenant-owned workflows, negotiated generation bindings, typed
interactions, original result-query descriptors, action continuation references, request
replay receipts and CSV-preview receipts. It safely clears obsolete trace argument text.
Existing pending actions/generation/SSE/card contracts remain the financial authority.

## Implemented behavior

- 88 pre-existing tools remain; four additions are `capabilities.list`, `workspace.select`,
  `workspace.open`, `daily.review`. Only workspace-v1 generations advertise/execute the
  first three; old-client attempts cannot create interactions/native cards. Existing
  ordinary daily read results remain decodable without the workspace feature.
- Searchable actual-resource selection supports account,category,tag,transaction,salary,
  date-range,item,recurring,recurring-occurrence,goal,fund-source,transfer,trash. Parent
  category/tag names distinguish equal child labels. Date/account/category/tag scope
  survives paging and membership validation; inherited date choices narrow later queries.
  The10,000 candidate cap applies to filtered bill/salary scopes, not a random first page.
- Workflow facts persist the original task, latest selections plus a bounded ordered
  selection history, so selecting transfer-from then transfer-to cannot erase the first
  account. Membership, fingerprint, expiry and consumption are server-owned. Stable
  requests/answers replay; changed answers conflict. A choice itself never books money.
- Draft GET supplies full frozen arguments plus editable schema. Revise uses original
  service validation, protects resource identity/operation/revision/hash fields, prepares
  a new immutable card, cancels its predecessor atomically and replays the replacement.
  Initial selected-resource/fund/source guards and complete-preview transport caps remain.
- Existing confirmation endpoint is unchanged. Explicit post-confirm continuation has
  one durable generation per original approved action; it rereads current facts and
  carries actual confirmed result into the original task. A later proposed mutation stops
  at a new approval. Missing secondary action indexes recover the original generation
  binding before falling back to a legacy task; normal create+negotiation binding is atomic.
- Direct result pages retain server-owned tool/filter arguments. Structural organization
  pages retain the original full-scope preview hash and skip extra model explanation;
  spending ready-card/page reads are direct. Only explicit eligible action IDs prepare
  an organization draft, linked back to its original task. No composer JSON bridge or
  model round trip is needed for paging, selection preparation or revision.
- Daily notification launch freezes date and Asia/Shanghai ledger zone, preloads complete
  ordinary daily totals plus the full salary window (not the first200 salaries), category/
  account breakdowns and bounded potential-duplicate evidence IDs. Omissions are labelled.
  Daily read-only scope persists at workflow level and is inherited by typed selections
  and ordinary clarification continuations; the runner rejects every write before prepare.
- Native CSV import previews call the actual transaction/transfer importer in rollback,
  retain original-file digest and ledger fingerprint, show bounded source rows/real counts,
  and execute only explicit confirmation. Exact retry replays once. Files never enter model
  context; stale ledgers/changed bytes require re-review.
- Trace now records only aggregate parameter/type counts, never keys, string prefixes,
  numeric amounts or arbitrary tool names. Old persisted argument text is redacted at the
  read boundary as well as migration cleanup. Boot interruption, archive and action-cancel
  reconcile workflow/interaction metadata without inference. Confirmed cards awaiting
  continuation report `awaiting-continuation`; native already offers the same-action button.

## Source files

New: migration024; routes/assistant-workspace.ts; assistant-business-fingerprint.ts;
assistant-csv-import-service.ts; assistant-daily-review.ts; assistant-organization-page.ts;
assistant-workspace-store.ts; assistant-workspace-tools.ts; assistant-workspace-service.ts;
test/assistant-workspace-routes.test.ts.

Changed: migrate.ts; routes/assistant.ts; ai-provider-service.ts; assistant-business-tools.ts;
assistant-generation-runner.ts; assistant-orchestrator.ts; assistant-tool-registry.ts;
assistant-trace-service.ts; assistant-turn-policy.ts; assistant-types.ts;
test/assistant-trace-service.test.ts. The fingerprint helper extraction preserves existing
business hash behavior and all existing domain services/shared arithmetic.

## Focused verification and evidence limits

Node22.23.4/pnpm10.12.2:

```
pnpm --filter @jizhang/server typecheck
pnpm --filter @jizhang/server lint
pnpm --filter @jizhang/server exec vitest run test/assistant-workspace-routes.test.ts test/assistant-trace-service.test.ts test/assistant-stream-routes.test.ts test/assistant-business-tools.test.ts test/assistant-tool-reliability.test.ts test/db.test.ts
```

All six files **188/188** passed:30 new composed workspace cases,53 existing actual
generation/SSE lifecycle cases,50 realistic read reliability cases,19 domain confirmation
cases,11 trace cases and25 DB cases. Typecheck and server-wide ESLint passed. A final
feature-negotiation replay-status assertion is included in the workspace suite; root owns
the final full-repository gate at the final source SHA.

Actual route regressions exercise paged account/category selection ->28-to35 replacement ->
old-card rejection -> double confirmation -> replayed continuation; date-selected real
linked refunds; two same-kind transfer choices; selector scopes in a10,002-bill ledger;
all seven additional source kinds; eight mutation families revised/confirmed then paused
for a new write; structural paging/selected prepare/confirm/continuation; daily205-salary
totals and refund/gross semantics; read-only selection/clarification continuations; empty
days; canonical reordered replay; CSV review/exact-once confirmation; old trace disclosure;
and archive/cancel/restart metadata. Existing tests separately retain tenant/actor/domain,
stream cancellation/deadline, replay-size, original-file and conditional-undo protections.

This is synthetic-provider/private-fixture evidence. It does not establish live-model
tool selection quality, production deployment or physical iOS notification interaction.
Root owns full gates, inventory/spec/journal updates, source push and the verified IPA.
# H5 native result continuation follow-up

An audit found that native workspaces were reachable and successful in their own UI but
did not return verified outcomes to the original conversational task. The additive
`POST /conversations/:cid/workspace/native-completions` endpoint now accepts only the
frozen source message ID and typed receipt reference documented in the wire contract.
It verifies the owned `workspace.open` destination/item/completed source generation,
checks authoritative CSV/batch receipts or current photo/export state, persists a bounded
visible result plus `lastNativeOutcome`, and continues the original workflow once.
Canonical request/receipt replay, original daily read-only authority and subsequent
separate write approval remain enforced. No client prose/file bytes/secrets serve as proof.

Additive migration025 records first CSV confirmation time atomically. Old receipts remain
ordinary-confirm replayable; a null/older confirmation time cannot claim a new completion.
Merged receipts use confirmed batch updated_at and conversation ownership. Photo viewed/
saved hashes and removed absence prove current state only. Export checks prove current
server generation only, never device storage or OS Share completion. Credential/logout/
server-switch operations cannot resume an invalidated authentication scope.

Modified product files are `db/migrate.ts`, `routes/assistant-workspace.ts`,
`services/assistant-csv-import-service.ts`, `services/assistant-workspace-service.ts`;
new product files are `db/migrations/025-native-completion-receipts.ts` and
`services/assistant-native-completion.ts`. Existing applied migration024 is unchanged.
Tests changed in `assistant-workspace-routes.test.ts` and `db.test.ts`.

Focused latest evidence: **39 workspace routes +26 DB cases =65 passing**, including nine
new native-continuation cases and the real024-to025 upgrade. These include actual CSV
confirm -> ledger query/summary, real merged review/confirm, all four exports, photo view/
saved/removed/current-hash mismatch, stale/null receipts, ownership/destination rejection,
canonical replay, new consent/daily read-only and forced receipt-write rollback. Full
server typecheck and lint pass for this follow-up. Root subsequently verified the full
local build/lint/typecheck gate and405 shared +1380 server tests (69 suites); exact logs
are `clients/ios/build/harness-quality/final-{build,lint,typecheck,test}.log`.
Root owns final native collector/App/client integration, CI and IPA provenance. No live provider,
deployment, physical phone or notification acceptance is implied by these local checks.
