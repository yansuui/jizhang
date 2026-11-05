# iOS bills completion — 2026-11-05

The current user request supersedes the shipped read-only scope. This worker changes
Bills, Home's recent bills, the bill query DTO, and bill-specific XCTest fixtures only.
No backend arithmetic, Android implementation, branches, commits or pushes are changed.

## Implemented interfaces and behavior

- `LedgerTransactionEditor(api:transaction:refundOf:onSaved:)` defaults both optional
  transaction arguments to nil; the root entry can call `LedgerTransactionEditor(api:onSaved:)`.
  It owns its NavigationStack. It creates expenses/income, edits existing bills and
  creates linked refunds. Fields: exact decimal amount, type, active category/account,
  Beijing date/time, note, comma-separated tags, optional canonical four-purpose value.
  Existing inactive metadata can remain unchanged when editing a historical bill.
- `LedgerBillDetailSheet(api:transactionID:metadata:)` owns a NavigationStack and
  medium/large presentation detents. Home and Bills select a sheet item without
  navigating away or replacing source list state. Linked refund/original views stay
  inside the same sheet with an explicit back action. Editing/refund uses a child sheet.
- Bills always displays account and date controls above the scrolling list. Supports
  all dates, current/previous month, selected year/month and inclusive calendar-day
  ranges. Query `from` is inclusive and `to` exclusive, in Asia/Shanghai to match the
  displayed bill calendar; updates preserve text/type/category/tag and reset paging.
- Home, Bills and open detail reload on the API session's `ledgerRevision`. Query
  generations, API identities and task cancellation reject obsolete list responses.

## Verified source contracts

`transactions.ts` / `transaction-service.ts` / `transaction-types.ts`:

- POST `/transactions` supports the existing operation replay contract when an explicit
  `fundPurpose` is present, including null. Every editor write includes this field and
  a fresh UUID, frozen together before sending.
- PATCH additionally carries `expectedFundPurposeRevision` and
  `expectedTransactionToken` from GET `/financial-planning/bill-purposes/:id`.
  The existing server token protects financial source fields; it is not a full version
  of concurrent note/tag edits. No stronger backend guarantee is claimed here.
- Refund POST uses income type 1, `isRefund=true`, `refundLinkedTxIds=[originalId]` and
  `fundPurpose=null`; original expense is never rewritten. Existing backend detail
  provides both `refundDetails` and reverse `refundLinkedTxIds`.
- Ordinary refunds remain income and ordinary expense remains gross. The editor does
  not synthesize financial totals or silently confirm separate refund allocation splits.

The write store gates duplicate taps synchronously. Definite 4xx rejection releases
the draft; ambiguous network/5xx/invalid-response failures lock the frozen write.
The user can query `/financial-planning/operations/:operationId` or explicitly retry
the exact original payload/UUID. Success alone calls `notifyLedgerChanged()`.
Pending writes survive editor dismissal within the same API identity, sharing one
create slot for global entry/refund entry, and separate edit slots per bill. A new
authenticated API identity never adopts an older session's pending write. Retention
is in memory for the session; process termination recovery is not implemented.

## Verification status

Read `trellis-before-dev`, iOS/client ownership specs, financial execution contracts,
frontend quality guide and relevant Android inventory/source evidence before edits.
Reviewed with the `trellis-check` checklist; `git diff --check` passes.

`LedgerBillEditingTests` adds 14 tests: exact cents/invalid input, leap-month and
inclusive range boundaries/filter preservation, linked refund wire payload, duplicate
tap blocking, guarded refund PATCH, ambiguous write reopening/session isolation,
exact-payload explicit replay, definite validation failure draft retention, stale
account-query rejection and paging query preservation, plus 3 compact/large-text
simulator screenshots (refund editor, actual medium detail sheet, persistent filters).
Fixtures use an isolated held URLProtocol and do not contact a live server/provider.

Windows has no Swift/Xcode SDK. Native compile, XCTest execution and screenshot
inspection are pending the parent's macOS GitHub CI integration; physical device
interaction remains separate. Parent owns Xcode project regeneration and delivery.

## Independent review follow-up

The Plan worker reviewed Bills and identified five boundary issues, all addressed:
operation UUIDs are created lowercased to match the server's normalized lookup;
inactive original refund accounts require explicit user selection rather than a
silent first-account substitution; CAS conflict refresh preserves edited fields,
rebases untouched fields onto the latest source and exposes that latest source for
comparison; a custom range ending at month-end still reopens as a range unless both
month boundaries match; an editor store refuses adoption by a new API identity and
recovery responses check the original identity/generation. Added/extended transport
tests cover these cases, including a real 409 → refresh → guarded save sequence.
