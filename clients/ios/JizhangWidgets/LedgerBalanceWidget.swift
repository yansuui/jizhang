import SwiftUI
import WidgetKit

/// 记账概览: total account balance and this month's server-reported income/expense.
struct LedgerBalanceWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "JizhangBalanceWidget", provider: LedgerWidgetProvider()) { entry in
            LedgerBalanceWidgetEntryView(entry: entry)
        }
        .configurationDisplayName("记账概览")
        .description("账户总余额、本月收入与支出。")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

private struct LedgerBalanceWidgetEntryView: View {
    @Environment(\.widgetFamily) private var family
    let entry: LedgerWidgetEntry

    var body: some View {
        LedgerBalanceWidgetView(snapshot: entry.snapshot, size: LedgerWidgetSize(family),
                                sharedContainerAvailable: entry.sharedContainerAvailable)
            .widgetURL(LedgerWidgetLink.balance)
            .containerBackground(for: .widget) { LedgerWidgetBackground() }
    }
}
