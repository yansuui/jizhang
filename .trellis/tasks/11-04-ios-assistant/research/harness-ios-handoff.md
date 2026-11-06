# iOS conversational workspace implementation handoff

Owned scope: Assistant Swift files, `AssistantWorkspaceTests.swift`, and this handoff.
No App/My/APIClient/project generation, commit, deployment or live-provider operation.
The root owns project generation and real Xcode validation on GitHub.

## Implemented

- Advertise additive `workspace-v1` on ordinary generations; preserve v1 reducer/SSE,
  same-request submission retry, Stop and owner fences.
- `AssistantSelectionStore/Card`: authoritative opaque choice IDs, readable equal-name
  rows, search and real paging, multiple selection across pages, native date range,
  stale/expired state and immutable uncertain retry body. Response conversation is checked.
- `AssistantWorkspaceResultCard`: readable money/account/category rows, full inspectable
  details and direct server-owned offset paging. Trusted native destination cards route
  through root's enum/environment; invitation buttons honor the injected permission flag.
- Ordinary draft review now offers adjustment. GET retrieves full arguments plus editable
  schema; the form preserves opaque tokens/revisions, supports account/category pickers,
  enums, dates, money, booleans and complex argument editing, then calls deterministic
  revise. The returned old cancelled/new pending cards replace history; no ledger change.
- Structural/historical organization selects actual eligible action IDs and calls typed
  prepare directly. Ready spending cards and their pages use `/workspace/organization/card`.
  Selection survives page changes; no composer text or model round trip on these controls.
  Explicit resume invokes the existing run resume route with a stable uncertain identity.
- Successful confirmation continues its original task via an idempotent action-scoped
  request. Reconciled uncertain confirmation can continue only after authoritative history
  says confirmed. Later writes remain new pending cards. Manual continuation retries use
  `continue-<actionID>`, including reopening. Old servers without workspace discovery keep
  their original confirmation behavior.
- Persisted workflow original intent/status is read separately and shown compactly; it
  cannot displace messages when its optional read fails. One current-generation activity
  observer does bounded read-only trace refresh. Historical per-generation traces are
  deduplicated, still collapse, and never display legacy arbitrary argument summaries.
- Capability launcher reads the runtime catalog, starts the selected dialogue capability,
  and opens real native workspaces. Item/photo actions select a real item first. Merged
  import history opens its owned conversation/batch in root's native import workspace.
- `AssistantView(api:launch:onLaunchCheckpoint:)` adopts the reminder worker's immutable
  intent and checkpoint API. Shared in-flight launch task prevents duplicate tap races.
  Persist conversation/submitting before direct daily-review inference; freeze day/zone/
  request. Accepted/uncertain checkpoints persist, including explicit retry callbacks.
  Non-starting reopen only reads/reconciles and offers same-request retry. No extra
  Generate tap, background automatic inference or wrong-owner launch.

The old standalone `AssistantSpendingSelection.prompt`/preview view is retained for
existing source tests/visual fixtures. Actual conversation paths now use the typed
organization view and never invoke that composer bridge.

## Verification and integration

- Added **13** native mock/state tests: multi-page equal-name selection IDs; frozen
  ambiguous selection replay; foreign-owner response rejection; exact money/opaque facts;
  immutable revision; organization preparation without inference; persisted daily launch;
  confirmed operation continuation identity; native inclusive date selection; failed
  outbox barrier preventing inference; wrong-owner/reopen behavior; bounded GET-only trace;
  additive item/recurring/goal/fund-source/transfer/trash kinds retaining authoritative IDs.
- Date choices use the existing Shanghai ledger calendar and explicitly display that zone,
  independently of the device's clock/locale, matching the server's accepted day scope.
- Mocks target `https://example.com`, the host actually intercepted by CoreMockURLProtocol.
- Static duplicate label scan and `git diff --check` passed. No local Swift compiler or
  Xcode is available; these tests are source until root's macOS CI passes.
- Root must generate pbx membership for three new app Swift files and this new test file.
  New files: `AssistantWorkspaceModels.swift`, `AssistantWorkspaceViews.swift`,
  `AssistantDraftRevisionView.swift`.
- Root owns actual screenshots/compact and large-text review with the reminder worker,
  native IPA checksum/source validation and the final capability coverage gate.

Wire coordination uses `research/harness-wire-contract.md`, including the added direct
spending card read, draft `action.inputSchema`, capability/native-action catalogs and
the original confirm + explicit workspace continuation pair.
