# iOS functional completion — user-directed continuation, 2026-11-05

This continues the existing in-progress iOS task. The latest six-item user request
supersedes the first delivery's read-only/preview-only restriction. The user also
confirmed: complete the existing four-purpose allocation workflow, not custom
new plan categories. Work directly on existing `main` in original `yansuui/jizhang`;
do not create branches or use a fork. Previous delivered source/data remain intact.

## Required outcomes

1. Tapping a bill opens a compact, expandable native sheet with the current list,
   selection and scroll position retained; do the same for Home recent bills.
2. An expense's sheet offers recording a refund. Create an income refund linked
   to the original expense through existing server contracts; show both directions
   of the relationship and refresh affected values. Preserve existing gross/net rules.
3. Restore a visible accounting action. The same editor creates expense/income
   with amount, account, category, date, note and existing optional purpose/tags.
   Existing bill edits use the existing server concurrency contracts where present.
4. Bills exposes persistent all/single account switching and date/month/range
   filtering, retaining other filters and resetting pagination. Scope stale reads
   by complete query/account/session. Never recompute server accounting totals.
5. Existing four-purpose plan exposes new income allocation, ratio editing and
   review of past/unallocated income. Keep four fixed purposes, 10000-bps ratios,
   server-issued revisions and idempotent operation IDs. Editing current ratios
   does not retroactively recalculate previously confirmed allocations.
6. Assistant is a complete client of existing business capabilities: readable
   results, executable preview/confirm/cancel cards, chat expense/income/refund,
   historical-bill organization with preview/apply/undo, and project business
   modules exposed through validated server tools. Audit every existing route
   family against the tool catalogue and close real gaps. The model never writes
   directly: retain explicit user confirmation, stale-action checks, ownership and
   idempotency. Credential/signing/offline maintenance remain dedicated trusted UI
   or operator flows, not unrestricted model HTTP/SQL access.

## Change boundary and parallel ownership

- Bills worker: `Features/Bills/**`, `Features/Home/HomeView.swift`, additions to
  Home/LedgerModels.swift necessary for real query/refund DTOs, bill-specific tests.
  Expose `LedgerTransactionEditor(api:onSaved:)` for the app's restored entry point.
- Plan worker: `Features/Plan/**`, new plan-specific tests. Reuse existing server
  fund/salary endpoints and expose clear editor/review UI. Do not change financial math.
- Backend assistant worker: server assistant tool/types/orchestrator/runner adapters,
  narrow domain service additions if needed, server tests and business capability map.
  Coordinate the existing preview/action wire format with root; keep additive API.
- Root: assistant Swift views/store/models, APIClient shared mutation notification,
  App shell accounting button, native docs/specs/Xcode membership and CI integration.

Root supplies `APIClient.notifyLedgerChanged()` and its published `ledgerRevision`.
Workers call it only after a confirmed successful mutation; Home/Bills/Plan reload
on that session-owned publisher. Cancel/preview/failure must not announce success.
Keep server errors visible and user drafts on failure. If a network response is
ambiguous, retain the operation/draft identity and reconcile; no blind second write.

## Verification and acceptance

- Real API-shape Swift fixtures cover creation, linked refunds, filter preservation,
  sheet presentation state, stale reads and current-plan revision/idempotency handling.
- Assistant fixtures cover chat income/expense, preview-only before confirmation,
  duplicate confirm, stale action, cross-conversation/account callbacks and historical
  organization execution/undo. Backend tests use two tenants and mock providers.
- Compile and run actual XCTest/iPhone Release build on GitHub; inspect compact-phone
  previews of bill sheet/editor, account/date controls, plan editor and action cards.
- Run backend/shared lint, typecheck, affected/full tests and build for tool changes;
  update Android's maintained API inventory if server contracts/capabilities change.
- Push `main`, deliver checksum-verified unsigned arm64 IPA. No live ledger/provider,
  production migration, Apple credential upload or physical-device acceptance implied.
