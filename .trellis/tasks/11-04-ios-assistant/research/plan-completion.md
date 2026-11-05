# Four-purpose iOS completion

The current gap is the absence of editable income allocation, prospective ratio settings,
and history/review entry points in Plan. Work is confined to Features/Plan and plan XCTest
fixtures. Existing server financial rules and Android behaviour were inspected; Android's
older salary/template UI is not evidence for the current canonical fund contract.

Contracts: POST /salaries with contractVersion 1 and expectedFundConfigRevision creates
income and its server-calculated frozen allocation; PUT /financial-funds/config uses
expectedRevision plus operationId and only changes future defaults. GET /salaries/:id
returns the frozen fundGrant. Migration issues supply current tokens for unclaimed salary
review. Existing legacy aggregates must retain original membership and frozen ratios;
only those grants can be reconfirmed through /financial-funds/grants/review.

All mutation requests are frozen with one operation UUID before sending. Unknown results
are recovered through actor-scoped financial operation lookup and exact-payload replay;
the UI does not release the draft for a different write until the original is resolved.
API session ownership protects against late results. The parent supplies session-owned
ledgerRevision notification, documentation, project generation and native CI validation.

No financial calculations, server contracts, Android source, branches, or commits are
changed by this worker. Windows source review is separate from native Mac/device checks.

## Implemented

- Plan exposes Add income allocation, Edit future ratios, and Income allocation history.
- Income editor uses exact decimal cents, account/date/note, visible frozen ratio preview,
  server-config CAS, and canonical salary v1; no category-template or client-side allocation.
- Ratio editor accepts 0–100% with two decimals and an exact 10000-bps sum; refresh after
  conflict preserves the typed draft and requires the user to confirm against current ratios.
- History reads the original grant targets/ratios/status, labels legacy aggregate totals,
  distinguishes resolved migration issues, pages issue records, and reviews unclaimed income.
- Legacy-group reconfirmation reads the period's source IDs and current source tokens;
  the server still validates the grant's exact frozen membership and ratios. Missing/deleted
  or changed memberships fail visibly and cannot silently substitute another salary.
- Tab-owned editor/review stores retain unresolved exact requests across sheet reopening.
  Recovery validates operation UUID, method, resource, status and response, then broadcasts
  the shared ledger revision only on confirmed success. No cross-session retry is allowed.
  Pending requests are in session memory; cold-process recovery is not newly persisted here.

## Verification

- Added 12 meaningful `PlanEditingTests` covering exact decimal/ratio validation, v1 payloads,
  existing grant ratio snapshots, CAS conflict and draft preservation, same-operation replay,
  committed-response lookup, mismatched recovery records, and session invalidation.
- `git diff --check` passed for touched Plan source/test paths on Windows.
- Native Swift compilation/XCTest and phone layout require the parent's GitHub macOS gate;
  no native or physical-device success is claimed by this worker.

## Follow-up: retained My and statistics screens

The parent assigned an additional refresh integration after assistant business writes.
`LedgerReadList`, account balances, item summary/list/detail, salary detail, and statistics
now subscribe to the same API client's `ledgerRevision.dropFirst()` and invoke existing
load functions. The initial subscription does not add duplicate initial reads. Salary
detail also refreshes account/category labels, retaining a visible error if that fails.

Already-open account/template/recurring/pending/transfer/trash details previously captured
immutable row snapshots. `LedgerLiveDetail` now preserves the selected ID and reloads its
current record and metadata on a mutation notification; removed/processed records show a
clear empty state. First presentation uses the already-read row and adds no network request.
The new detail wrapper reuses LedgerResource generation/cancellation protections and the
existing API session owner. Item linked-bill sheet changes owned by the parent were preserved.

Statistics live under Features/My rather than a separate Stats directory. There is no
existing native goal list/detail to subscribe. Login, invitation and provider configuration
were not changed. `git diff --check` passes for the five touched My source files; native
compilation remains part of the parent's macOS build gate.

Source audit confirmed templates and recurring rule/pending lists return all matching
rows; account balances return all accounts; transfers use their GET-by-ID endpoint.
Trash is capped and includes a total. If an ID is absent from a partial/capped response,
LedgerLiveDetail retains the prior detail and shows a refresh error instead of asserting
deletion. Only a complete list or an explicit GET-by-ID 404 permits the absent state.
