# Scrollable bill filters and daily statistics — 2026-11-06

## Change

`BillsView` now places type/account/date controls in the first List section as an
ordinary row. The top safe-area inset is removed; there is no section-header pinning
or separate scroll container. Search, query state, pagination, loading/error states,
refresh and the existing authoritative summary store are retained.

The filter row has a grouped rounded background with distinct 44-point account/date
controls and current values for accessibility. `bill-filters` identifies the container
for the root agent's actual hosted-scroll regression check.

Daily statistics use a date/count heading followed by two aligned amount columns,
with icon/label colour and a neutral amount. Accessibility text uses a vertical stack;
wide intrinsic values also fall back from the horizontal layout, preserving exact
formatted cents. A missing summary remains `—` rather than zero, and unavailable
summary queries still retain their explanation. `bill-day-summary` identifies the
container. No totals are derived from loaded transaction rows.

The Bills root also adopts the modal worker's shared
`.ledgerBillDetail(api:selection:metadata:)` presenter. The obsolete content-level
overlay and dismissal callback are removed.

## Verification

- `git diff --check -- clients/ios/Jizhang/Features/Bills/BillsView.swift`: passed.
- Existing bill filter/header screenshot tests exercise the new composition.
- Added `LedgerBillStatisticsPreviewTests` for the largest accepted amount with
  accessibility text, including loading/unavailable states. These are render fixtures;
  actual Xcode results and artifact review are owned by the root CI pass.
- Root owns hosted scrolling/modal interaction tests, project generation, native
  compilation/XCTest and IPA delivery. No Windows source check is labelled device proof.
