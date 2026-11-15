import SwiftUI
import WidgetKit

struct LedgerWidgetEntry: TimelineEntry {
    let date: Date
    let snapshot: LedgerWidgetSnapshot?
    let sharedContainerAvailable: Bool
}

/// Reads the snapshot the app writes into the App Group container.
///
/// The provider performs no network request: a widget owns no session, and a stale-but-real amount
/// is the honest state. The app reloads the timeline after every successful read.
struct LedgerWidgetProvider: TimelineProvider {
    func placeholder(in context: Context) -> LedgerWidgetEntry {
        LedgerWidgetEntry(date: Date(), snapshot: LedgerWidgetSnapshot.previewSample, sharedContainerAvailable: true)
    }

    func getSnapshot(in context: Context, completion: @escaping (LedgerWidgetEntry) -> Void) {
        completion(current(isPreview: context.isPreview))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<LedgerWidgetEntry>) -> Void) {
        // The periodic policy only keeps the relative "更新于" text and a month rollover honest if
        // the app stays closed; ledger changes arrive through the app's explicit reload.
        completion(Timeline(entries: [current(isPreview: false)],
                            policy: .after(Date().addingTimeInterval(30 * 60))))
    }

    private func current(isPreview: Bool) -> LedgerWidgetEntry {
        let store = LedgerWidgetSnapshotStore.shared
        return LedgerWidgetEntry(date: Date(),
                                 snapshot: isPreview ? LedgerWidgetSnapshot.previewSample : store.load(),
                                 sharedContainerAvailable: store.isAvailable)
    }
}

extension LedgerWidgetSize {
    init(_ family: WidgetFamily) {
        switch family {
        case .systemMedium: self = .medium
        case .systemLarge, .systemExtraLarge: self = .large
        default: self = .small
        }
    }
}
