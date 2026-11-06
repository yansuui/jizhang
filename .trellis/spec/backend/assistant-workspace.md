# Conversational workspace contracts

Applies to the assistant workspace routes/services, migration 024, capability adapters
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
