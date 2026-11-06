import SwiftUI

extension View {
    /// A native presentation owns the entire screen, including navigation and the tab bar.
    /// The source view remains mounted so its query, loaded pages and scroll position survive.
    @MainActor
    func ledgerBillDetail(api: APIClient, selection: Binding<LedgerBillSelection?>,
                          metadata: LedgerMetadata) -> some View {
        modifier(LedgerBillPresentation(api: api, selection: selection, metadata: metadata))
    }
}

@MainActor private struct LedgerBillPresentation: ViewModifier {
    let api: APIClient
    @Binding var selection: LedgerBillSelection?
    let metadata: LedgerMetadata

    func body(content: Content) -> some View {
        content.fullScreenCover(item: $selection) { bill in
            LedgerBillDetailOverlay(api: api, transactionID: bill.id, metadata: metadata,
                                    onDismiss: { selection = nil })
                .presentationBackground(.clear)
                .presentationBackgroundInteraction(.disabled)
                .interactiveDismissDisabled()
                .accessibilityAction(.escape) { selection = nil }
        }
    }
}
