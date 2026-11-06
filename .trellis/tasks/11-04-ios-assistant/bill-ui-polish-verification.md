# Bill UI polish verification — 2026-11-06

Scope and accepted behavior: [bill-ui-polish.md](./bill-ui-polish.md).
Original repository `yansuui/jizhang`, `main` only.

## Implementation

- `b80e8e4`: native full-screen presentation shared by Bills and Home; centred adaptive
  detail card, full-screen dimming/touch boundary, compact and accessibility layouts;
  type/account/date filters moved into the first ordinary List row; clearer daily figures.
- `dae03d1`: strengthen the real Bills pagination regression with a first-page request
  counter and settled loading-state check.
- No service contracts, financial calculations or server data were changed. Per-day figures
  still come only from the existing authoritative summary response.

## Checks

- `git diff --check` passed.
- Project generator: 46 application and 13 test Swift files.
- Both implementation workers independently checked each other's source. The hosted native
  regression uses a real BillsView/LedgerBillsStore, loads 55 paged records, presents above a
  real TabView, checks hit routing across tabs/navigation/background, then verifies retained
  first-page read count, all records, original scroll view and offset after dismissal.
- Accessibility-size modal and daily-statistic fixtures export actual simulator screenshots.
  These do not establish physical-device gesture or keyboard acceptance.
- Native compilation, tests, arm64 packaging and verified delivery are recorded below.
  Windows source checks are not native build evidence.

## Native test transport correction

Run `42143860787` compiled successfully and passed the other 131 tests, but the two
new hosted-modal cases attempted DNS resolution for `bill-modal.example` and timed out.
The shared `CoreMockURLProtocol` only intercepts `example.com`; the new fixture had
reused that helper with the wrong base host. Commit `3a8f401` aligns the fixture host
with the registered protocol. No app behavior or assertion was weakened. The complete
native run is repeated at the corrected commit to establish the actual modal checks.

Run `42145790096` then passed modal coverage, background/tab hit routing, accessibility
layout, the 55-record snapshot and first-page request-count assertions. Its sole failure
was an immediate pre-layout scroll sample of 240 versus the settled post-layout 344.
Commit `f381bfc` explicitly lays out the List and yields for pending List/navigation layout
before sampling the baseline. The strict one-point post-dismissal comparison is retained;
the final native run passed the stable-position check. The logs alone do not identify
which estimated row or navigation inset produced the initial 104-point adjustment.

## Final native result and delivery

- Successful run: https://github.com/yansuui/jizhang/actions/runs/42147423830.
- Code commit: `f381bfc0c0cde5ce2b7a16b83536acbad8e0d04b` on original `main`.
- Xcode 16.4: **133 XCTest cases passed, zero failures**; Release iPhone arm64 packaging passed.
- The actual hosted modal tests passed full-screen bounds, tab/navigation/background hit
  routing, accessibility scrolling bounds, 55 retained records, one first-page read,
  original scroll instance and the strict one-point stable offset comparison.
- Real exported normal modal, filters and daily-summary screenshots were inspected. An
  independent reviewer also checked the accessibility-size modal and maximum-cents statistics.
  TabBar is dimmed behind the card, never part of its content; actions and wrapped notes
  remain visible. The full `¥90,071,992,547,409.91` value is readable with vertical fallback.
- Ready IPA: `clients/ios/build/delivery/Jizhang-iOS-bill-ui-f381bfc.ipa`.
- Size: **2,685,307 bytes**; version **0.1.0**, build **12**, minimum iOS **17.0**.
- SHA-256: `8a341388f5f8667a8e7e974a82d22215a42c493a8d2def78abc5c0666868b300`.
- Successful-run source metadata, checksum manifest, copied file digest, ZIP CRC,
  iPhoneOS plist and arm64 Mach-O header were independently validated. No XCTest runtime
  is included in the Release package. Bundle ID remains `com.yansuu1.jizhang.ios`.
- Unsigned IPA is ready for local Sideloadly signing. No physical installation or physical
  gesture/keyboard acceptance was attempted; the user's earlier phone-connection deferral stands.
