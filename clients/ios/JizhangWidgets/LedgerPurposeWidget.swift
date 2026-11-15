import SwiftUI
import WidgetKit

/// 四用途: the four continuous purpose balances, with the fund evidence on the large family.
struct LedgerPurposeWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "JizhangPurposeWidget", provider: LedgerWidgetProvider()) { entry in
            LedgerPurposeWidgetEntryView(entry: entry)
        }
        .configurationDisplayName("四用途")
        .description("长期增长、应急储备、日常必要与随心生活余额。")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

private struct LedgerPurposeWidgetEntryView: View {
    @Environment(\.widgetFamily) private var family
    let entry: LedgerWidgetEntry

    var body: some View {
        LedgerPurposeWidgetView(snapshot: entry.snapshot, size: LedgerWidgetSize(family),
                                sharedContainerAvailable: entry.sharedContainerAvailable)
            .widgetURL(LedgerWidgetLink.purposes)
            .containerBackground(for: .widget) { LedgerWidgetBackground() }
    }
}
