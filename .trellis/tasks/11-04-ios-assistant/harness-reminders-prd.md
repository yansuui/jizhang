# Conversational project workspace and daily reminders

## Goal and review status

Turn the iOS assistant into a conversational workspace for every current user-facing
project capability: understand a request, read real facts, offer selectable cards,
prepare changes, wait for the user's consent, execute once, and continue reporting.
Add daily recording/review notifications. This is a user-directed continuation of
the existing iOS task, on original repository `main`, with no new code branch/fork.

The user approved the final expanded scope with "实施" after reviewing the plan.
Implementation is authorized. The existing task stays active for its earlier deferred
device checks; no additional permission gate is needed for the reviewed implementation.

## Confirmed background and decisions

- Source baseline: `e666591`. Current generation/SSE, durable history, typed tools,
  action confirmation, background organization and metadata trace are reusable foundations.
- The executable catalog contains 88 tools. Registration is not end-to-end usability.
  Most ordinary ledger reads/writes exist; result selection, editable previews, task
  continuation and several dedicated native workspaces are missing.
- iOS is the target. Shared API compatibility and the Android contract inventory still
  apply; Android UI redesign is not part of this continuation.
- The user explicitly requires consent before modifications. Selection, explanation,
  inference completion and a prior unrelated approval are not permission to write.
- User confirmed **20:00 recording reminder**, **21:00 review reminder**, editable times.
  Review is generated **only after tapping the notification**, not automatically daily.
  A review notification tap itself authorizes one read-only review generation; do not
  demand an unrelated second generate click or retry inference automatically.
- Existing signing/delivery uses GitHub unsigned device IPA and local Sideloadly.
  Reminders therefore use local notification scheduling, without assuming APNs signing
  entitlements, a paid developer account or a remote provider service.

The maintained source audits are [capability coverage](research/harness-capability-audit.md),
[iOS interaction](research/harness-ios-interaction-audit.md) and
[notification design](research/daily-reminder-design.md). They contain exact code anchors.

## Requirements

| ID | Observable requirement |
| --- | --- |
| H1 | Every active capability in the coverage audit has a working conversational tool or trusted native action, with truthful availability and permission state. A generic JSON block or an unavailable placeholder does not count as coverage. |
| H2 | Bills/income/expenses/refunds, accounts, hierarchical categories/tags, transfers/trash, recurring/pending bills, four-purpose allocations, plans/goals, statistics, items, both organization workflows and backup creation are operable from dialogue. Preserve existing financial definitions and revisions. |
| H3 | Account/category/tag/date/range/bill/source/suggestion choices use authoritative identities and readable paged cards. Search, equal names and more than six options work; a row index or model-invented ID is never authority. |
| H4 | Every modification has a readable effect preview and explicit confirmation. Users can revise the proposed fields/scope and receive a new preview; the superseded card cannot execute. Destructive/all-record actions name their scope and permanence. |
| H5 | A requested multi-step task persists progress and selected facts, pauses for selections/approvals, executes the approved operation once, then rereads/reports and continues the original task. Each subsequent modification needs its own visible approval. |
| H6 | Real streaming, Stop, reconnect/reopen and active execution status remain coherent. Supported provider modes stream actual prose; buffered modes are labelled. Validated cards appear atomically. Trace contains operation metadata, not internal reasoning, raw bill text or credentials. |
| H7 | Protected account/password/AI settings/invitation actions, file import and export, item photos/cutout and system permissions use explicit native workspaces reachable through trusted cards. Secrets and file bytes stay out of generic model arguments/history. Existing provider/invitation views are reused; missing forms/workspaces are implemented. |
| H8 | Two independently configurable daily local notifications use the confirmed times, with visible permission/scheduling state. Recording opens the native entry sheet; review opens the assistant for the notification's visible review date. Disabled/denied reminders do not claim delivery. |
| H9 | Notification taps respect server/account ownership and login restoration; duplicate taps/reopen/uncertain network responses resume one stable daily review request. The daily report uses authoritative day totals, category/account breakdown and clearly labelled potential issues, with no bookkeeping mutation. |

H7 includes generic transaction/transfer CSV import review, multi-file platform import
and conflict review, authenticated CSV sharing, password change, item photo changes and
cutout candidate review. These are genuine current capability gaps, not extra generic tools.

## Acceptance criteria

- **A1 (H1/H2/H7):** Check off every active row of the source audit with a callable tool
  or working native workspace, actual read/write path and automated evidence. Old template
  tools are not advertised; role-restricted actions remain server-authorized.
- **A2 (H3/H4):** Record an expense, select an account/category from multiple pages,
  change 28 to 35 before confirmation, then confirm once: exactly one 3500-cent bill and
  the old preview is non-executable. Cancellation makes no financial change.
- **A3 (H2/H3/H5):** Find a prior expense, select the correct equal-name/multi-page record,
  prepare and confirm a linked refund, then stream the verified result. Refund remains
  income and original expense remains gross; ambiguous retry does not duplicate it.
- **A4 (H2/H4/H5):** Edit a plan/ratio/category/tag/item/recurring record through dialogue,
  preview exact before/after, reject stale revisions, and continue a requested read after
  confirmation. An unrelated next modification cannot inherit that confirmation.
- **A5 (H3/H5):** Historical organization survives transient progress failure, selects exact
  eligible actions across pages and prepares them without a long text prompt/model round trip.
  Only the selected effect is confirmed; note-only suggestions remain reference.
- **A6 (H6):** Delayed stream/selection/card/confirmation after A -> B -> A or session/server
  change cannot publish to the wrong owner. Stop and reconciliation preserve existing
  no-late-write/no-auto-inference rules. Live status and history survive reopening.
- **A7 (H7):** Import original-file identity, explicit rows/conflicts and confirmation are
  preserved; export yields a real authenticated file/share sheet; photo/cutout candidates
  are real and applied only by consent. Password/key/invitation plaintext never enters chat.
- **A8 (H8):** Permission granted/denied, schedule time edit, independent disable, logout
  and account replacement produce the correct two-or-fewer pending requests and visible
  state. A foreground notification and notification tap use the intended entry point.
- **A9 (H9):** Repeated review taps create at most one model generation for that delivery
  and owner; uncertain submission retains its request identity. Date/day boundaries and
  empty days are correct, totals come from server services, and the ledger is unchanged.
- **A10 (all):** Repository lint/typecheck/tests/build and native macOS tests/arm64 IPA
  packaging pass; inspect actual compact/large-text/card/reminder screenshots and verify
  artifact provenance/hash. Record real-device notification/provider acceptance separately.

## Boundaries

- This grants project capabilities through typed services, not arbitrary HTTP, SQL,
  shell commands or model-controlled native URLs.
- Current four-purpose behavior remains authoritative. Removed templates and superseded
  legacy product surfaces are not revived; compatibility decoders/routes are not new UI.
- Live backup restoration remains the existing stopped-server operator process. There
  is no online restore API; the assistant may explain this boundary but cannot pretend
  that a chat action restores a running database.
- APNs infrastructure, unattended daily model runs and an Apple signing-account migration
  are unnecessary for the user's confirmed reminder flow and outside this scope.
- Production deployment, signed physical installation, OS permission grants and live-provider
  validation are distinct from source/CI evidence; do not relabel one as another.

There are no remaining product-preference questions. Final planning approval is recorded
above; implementation and verification proceed on original main.
