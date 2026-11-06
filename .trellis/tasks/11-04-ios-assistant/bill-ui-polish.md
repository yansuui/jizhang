# Bill presentation and scrolling — 2026-11-06 continuation

The user reports background scrolling and the tab bar appearing with the centred bill
popup, and requests cleaner bill statistics with account/type filters scrolling with
the page. Continue the approved iOS task directly on original `main`.

## Change boundary

- The modal boundary currently lives inside Home/Bills navigation content. Move bill
  presentation into a native full-screen modal with a transparent presentation background
  and full-screen dimming layer. Keep the card centred, the underlying screen retained,
  and the modal's own content scrollable. Background list/navigation/tab interactions
  must be blocked until dismissal, including VoiceOver.
- Improve the existing detail card's density, grouping and compact/large-text sizing;
  retain linked bills, edit/refund/delete confirmation, and server-owned state.
- Move type/account/date filters from a top safe-area inset into the same scrollable
  content as the bill list. Refine per-day statistics spacing/hierarchy and narrow-width
  wrapping. Render only existing authoritative daily summary values and availability.
- Expected files: `BillsView.swift` (scroll composition and stats),
  `LedgerBillDetailCard.swift` (modal/card and shared presentation), `HomeView.swift`
  (shared presenter), relevant native tests and generated project membership, iOS docs/spec.
- No backend/API or money calculation changes. Do not reconstruct pages with `.id` or
  discard query, pagination, selection or scroll state to block interaction. Preserve
  in-flight mutation handling and current tag migration semantics.

## Verification

Native tests must exercise actual modal presentation above a TabView, background
hit routing, dismissal retaining the original scroll view/offset, and compact/large-text
renders. Inspect nested editor ownership and filter placement in the shared scrolling
content; screenshot/source inspection does not establish physical-device gestures.
Generate the project, run GitHub Xcode/XCTest and arm64 IPA packaging, inspect artifacts,
and prepare a checksum-verified IPA. Device gestures remain separate acceptance.
