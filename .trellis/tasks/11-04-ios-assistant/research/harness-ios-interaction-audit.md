# Conversational iOS assistant interaction audit

Research only, 2026-11-06, source baseline `e666591`. No product code, live provider,
deployment or device operation was performed for this audit. The user requests a
conversational assistant for the project's capabilities, real streaming, selectable cards
and explicit consent before modification. The current target is iOS; recent task evidence
explicitly excludes Android UI work (`11-06-ai-organize-failure-fix/verification.md:5`).

## Existing foundations to retain

| Surface | Actual source behavior | Evidence |
| --- | --- | --- |
| True streaming | `URLSession.AsyncBytes` consumes authenticated SSE, feeds a byte parser and applies a sequence/owner-aware reducer. End without terminal triggers same-generation snapshot reconciliation, not another inference. | `clients/ios/Jizhang/Features/Assistant/AssistantStore.swift:460`, `:497`; `AssistantSSEParser.swift:25`; `AssistantModels.swift:171` |
| Truthful provider mode | Actual incremental provider output is supported for Chat Completions, POST, `choices[0].message.content`; other configured modes remain explicitly buffered. | `packages/server/src/services/ai-provider-service.ts:320`; `AssistantStore.swift:40` |
| Clarification | Persisted single-select question, 2–6 options, server-owned question/option IDs and free-text alternative. The server validates owner, generation, stale/consumed question and membership before accepting a choice. | `AssistantModels.swift:52`; `AssistantStore.swift:208`; `packages/server/src/services/assistant-generation-runner.ts:940`; `assistant-generation-service.ts:661` |
| Financial consent | Write tools prepare an immutable action/card and terminate as `pending-confirmation`; only explicit confirm invokes the authenticated domain mutation. Current card/identity/status must be present in the thread. | `assistant-generation-runner.ts:988`; `AssistantStore.swift:307`; `AssistantActions.swift:183`; `assistant-orchestrator.ts:385` |
| Ambiguous confirmation | The action ID is idempotent, the body is frozen for uncertain retries, authoritative history resolves status and successful writes publish `ledgerRevision`. | `AssistantStore.swift:319`, `:446`; `assistant-orchestrator.ts:388` |
| Multi-step reads | Shared eight-decision/180-second bound, successful durable results, bounded facts, duplicate-read termination and typed correction already exist. | `assistant-stream-types.ts:21`; `assistant-generation-runner.ts:395`; `assistant-turn-policy.ts` |
| Background organization | Durable run handoff and read-only native progress observation, followed by a selectable suggestion review and separate confirmation. | `AssistantSpendingRunStore.swift`; `AssistantSpendingReview.swift:34`; `assistant-generation-runner.ts:538` |
| File import exception | Single original CSV/XLSX file, explicit row selection, category/200-unit note overrides, digest verification and frozen confirmation body. | `AssistantAttachments.swift:67`, `:85`; `AssistantActions.swift:158`; `assistant-orchestrator.ts:350` |
| Trace | Separate bounded, persisted generation trace, read through an ownership-checked endpoint. It describes tool/answer/error steps; it is not model reasoning. | `AssistantTraceView.swift`; `assistant-trace-service.ts:18`; `routes/assistant.ts:380` |

The 11-04 reliability verification records 142 native tests and backend 405 + 1315 tests
at its exact commits. The later 11-06 task records envelope recovery, 24 more server tests
and 9 Swift trace tests, plus successful native/backend runs; that record explicitly does
not independently extract the final XCTest count. Neither record establishes current
production deployment, physical interaction or live-provider correctness.

## Concrete interaction gaps

| ID | Gap and implication | Exact evidence |
| --- | --- | --- |
| H-I01 | Account/category/date/transaction selections have no typed picker contract. A clarification carries label-only options; the server converts a selected option back to `option.label`. Lists with more than six resources, equal names, hierarchy, search and calendar selection are not a complete native interaction. | `AssistantModels.swift:53`, `:64`; `assistant-generation-runner.ts:944`; `assistant-generation-service.ts:681` |
| H-I02 | Most read results are recursively expanded JSON, without record-row actions, meaningful resource names, deterministic next-page controls, or account/category chips. This provides inspection but not a conversational workspace for every function. | `AssistantView.swift:419`; `AssistantActions.swift:79`, `:95` |
| H-I03 | Ordinary write review is read-only. Non-import confirmation sends `{}` and offers a generic preview and confirm button. There is no edit-and-repreview path for amount, note, date, category or target resource. | `AssistantActions.swift:140`, `:143`, `:168`, `:191` |
| H-I04 | Sending a correction in chat while a draft is pending is allowed, but there is no explicit supersession identity between old/new previews. Creating another pending action does not close earlier actions; current `canAct` accepts any matching pending card in history. A future "change this draft" UI must close/replace the old draft deliberately. | `AssistantStore.swift:32`, `:307`; `assistant-conversation-service.ts:389` (insert only); `:281` (expiration belongs to archive) |
| H-I05 | Historical suggestion selection is serialized into a free-text prompt, put back in the composer, and requires the user to send again through inference. The prompt must fit 2000 units, so the UI's 100-selection ceiling is not always reachable. Read-only next page also builds a free-text prompt instead of calling the existing deterministic read. | `AssistantSpendingReview.swift:20`, `:29`, `:137`, `:146`; `AssistantStore.swift:360` |
| H-I06 | The execution trace is a one-shot GET on view appearance, rendered once per message carrying a generation ID. It has no refresh tied to generation sequence/terminal status, no trace event subscription and no conversation-level live activity owner. It cannot yet serve as a continuously updating harness activity strip. | `AssistantTraceView.swift:85`, `:95`, `:162`; `AssistantView.swift:245`, `:435` |
| H-I07 | Error expansion is initialized from the message's error state only. `hasFailure` exists but is not used to expand after a loaded trace reveals a failure. Reuse as a live timeline must explicitly respond to trace status changes. | `AssistantTraceView.swift:83`, `:112`, `:115` |
| H-I08 | Multi-file import is rendered as an inspectable record, not the merged-import workspace available elsewhere in the project. The attachment button is a single-file importer. Full-capability claims must list this as a real UI gap until a safe native multi-file flow is implemented. | `AssistantView.swift:224`, `:330`, `:426`; `AssistantActions.swift:205` |
| H-I09 | A write confirmation refreshes conversation/history and ledger views, but does not continue a larger user-requested sequence automatically. The server creates one write card then stops. "Do X, then report Y" requires an explicit persisted task/continuation policy; it must not silently authorize later writes. | `assistant-generation-runner.ts:517`, `:1047`; `AssistantStore.swift:337`; `assistant-orchestrator.ts:406` |

### Trace data minimization discrepancy

Current comments/specs promise step metadata rather than ledger content, but
`assistant-trace-service.ts:66`–`:77` serializes arbitrary string prefixes (up to 40 units)
and raw numeric/boolean scalars. `assistant-generation-runner.ts:509`–`:510` calls this
before tool argument parsing. A `transaction.create` argument with `note: "private text"`
therefore produces a persisted `note=private text` summary; `amountCents` is also copied.
This is direct source evidence, not a production incident or cross-account disclosure.
Before promoting trace to a more visible activity/notification surface, use a field-level
metadata allowlist or type/length summaries and remove the claim that current text has no
bill content. Do not include hidden model reasoning in the replacement.

## Minimal incremental architecture

1. Keep `AssistantStore`, the generation/event store, SSE parser/reducer, existing action
   registry and authenticated domain services. A second agent runtime or model-controlled
   HTTP dispatcher is unnecessary. All operations keep typed allowlisted adapters.
2. Add a small typed interaction contract for resource selection, date/range input and
   bounded record selection. The server owns interaction identity, scope, resource IDs and
   validation; the model requests the kind/filter rather than inventing IDs. Persist the
   interaction and answer identity through the same generation history. Existing v1
   single-choice/text remains the compatibility fallback; clients must explicitly advertise
   support before receiving a new input/interaction variant.
3. Render resource result cards with readable authoritative values, real pagination and
   trusted action descriptors (`view`, `select`, `prepare-edit`, etc.). Reuse existing detail
   and editor views where practical. A model-written route, deep link or arbitrary tool name
   is never an executable client action.
4. Add an explicit draft-edit/repreview operation. Keep original immutable action identity;
   preparing the replacement closes/supersedes the prior draft and creates a new preview
   with current revisions/tokens. The human confirms only the replacement's exact visible
   scope. Preserve the existing narrow import override contract separately.
5. Use structured selected action IDs directly for historical organization and typed page
   reads. Deterministic read/review preparation does not need a model round trip or a long
   JSON prompt in the composer. Actual mutation still requires final review/confirmation.
6. Introduce one generation-owned activity model, with safe operation titles and explicit
   running/waiting-for-selection/waiting-for-confirmation/completed/failed states. Refresh
   metadata during generation or add bounded additive activity events without weakening
   the existing SSE sequence, replay and 64 KiB line/48 KiB card budgets. Validated cards
   appear atomically; never stream unvalidated financial fields as actionable UI.
7. For a requested multi-step job, persist requested steps and their status. Every new
   modification remains a separate visible consent boundary. Confirmation may trigger a
   user-requested read-only continuation, but an unsolicited model retry or a later write
   must not inherit consent from an unrelated earlier card.
8. Native-only capabilities (system permission, protected credentials, file/photo pickers,
   export sharing) should be trusted client-action cards that open an explicit dedicated
   flow and report a minimal result back to the owning conversation. Keep secrets/files
   outside generic model context. The backend capability audit determines exact coverage.

These are design recommendations, not approved product scope or implemented contracts.
Parent planning must settle notification behavior separately and keep real deployment /
provider / physical-device acceptance distinct from automated tests.

## Observable acceptance scenarios

- Record lunch, select from more than six accounts and hierarchical categories, choose a
  date, preview, change 28 to 35, confirm once: one exact 3500-cent bill; the old preview
  cannot execute. Equal account names must still select the correct authoritative ID.
- Query a bounded month/account, select a matching expense from multiple pages, preview
  a linked refund, cancel: zero financial changes. Confirm later with the same action after
  an ambiguous response: at most one linked income, original gross expense unchanged.
- Change a plan/ratio, examine before/after, modify the draft, then confirm. If ledger or
  revision changes before confirmation, present stale-preview recovery with no hidden write.
- Historical organization streams its narration, hands off the run, survives a failed GET,
  selects exact suggestions across pages, prepares their preview without a long composer
  prompt, and confirms only those IDs. A note-only suggestion remains reference-only.
- A delayed read/selection/confirmation after A -> B -> A or account/server replacement
  cannot update the wrong thread/session. A stale interaction is visibly rejected.
- Stop during tool preparation: no late write card; leaving the view only unsubscribes.
  Reconnect uses the same generation and sequence, with no automatic inference POST.
- Live activity transitions from a running tool to ready selection/confirmation and remains
  useful after reopening. Persisted/displayed metadata contains no note text, provider body,
  credentials or hidden chain of thought. Trace failure never blocks conversation output.
- Actual multi-file import either offers a native review/confirm workspace with original
  file identity, or is explicitly marked unavailable; generic JSON cannot count as parity.

Use real Fastify routes with synthetic providers and isolated ledgers for composed flows;
mock-transport Swift ownership/state tests, strict SSE/reducer tests and macOS native
compilation/screenshots for the client. Interactive keyboard, real-provider latency,
notification handling and signed hardware behavior need separate acceptance evidence.
