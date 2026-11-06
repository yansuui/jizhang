# Centred bill modal boundary and detail layout — 2026-11-06

## Root cause

Home and Bills placed a `ZStack` overlay inside their NavigationStack content.
That local overlay did not own the surrounding navigation/tab container; ignoring
safe areas enlarged drawing but did not establish a modal presentation boundary.
The base list and tab controls could remain interactive outside that subtree.

## Implementation

- New `LedgerBillPresentation.swift` exposes
  `.ledgerBillDetail(api:selection:metadata:)` with the existing optional bill-selection binding.
- It uses a native `fullScreenCover` with a clear presentation background and explicitly
  disabled background interaction. The full-screen overlay owns the dimming layer and centred
  card. The base screen retains its state; no list `.id`, `.disabled` or `.scrollDisabled`
  is used to rebuild or indirectly lock it. Modal accessibility escape clears selection.
- Home is integrated with the shared presenter; Bills integration belongs to the statistics worker.
- The card is wider on narrow phones while bounded to 390 points, normally at most 620 points
  high and constrained by the available safe-area height. Accessibility sizes may use a taller
  card. The backdrop covers all screen edges, including the tab bar's area.
- The visual hierarchy now uses a compact category/icon row, a prominent amount and grouped
  attribute panel, without repeating category/note in both hero and attributes. Long notes,
  tags and linked bills remain available within the card's scroll view.
- Actions stay visible in portrait, become a vertical stack for accessibility sizes, and move
  into the scrollable content in compact-height/landscape so they do not consume the whole card.
  Large-text attribute rows stack label/value instead of squeezing a fixed-width column.
- The card observes its API client directly, ensuring a successful nested edit/refund triggers
  its `ledgerRevision` reload even while its full-screen presenter isolates it from the base.
- Identifiers `bill-detail-modal`, `bill-detail-card`, `bill-detail-backdrop`,
  `bill-detail-close` and `bill-detail-edit` support root-owned hosted interaction checks.

## API verification and evidence boundary

[Apple's presentation-background documentation](https://developer.apple.com/documentation/swiftui/view/presentationbackground(_:))
states that presentation backgrounds fill the presentation and can show views behind translucent
styles on supported platforms. [Apple's presentation modifiers](https://developer.apple.com/documentation/swiftui/view-presentation)
define fullScreenCover as a modal covering as much screen as possible. Transparency and actual
TabView hit-testing must still be verified by the native integration tests and exported screenshots.

Source whitespace checks passed. No local Swift/Xcode toolchain exists on Windows; root owns
project regeneration, native compile/XCTest, actual screenshots and IPA evidence. No CI or physical
gesture acceptance is claimed by this source-only handoff. No financial write contract changed.
