import SwiftUI

/// The system widget families this project supports. It is declared here instead of using
/// WidgetKit's `WidgetFamily` so the app's simulator preview tests can render the very same views
/// without linking the widget extension.
enum LedgerWidgetSize: Equatable {
    case small, medium, large
}

/// Brand background shared by both widgets. The widget target hands it to
/// `.containerBackground(for: .widget)`; preview tests wrap the views with it directly.
struct LedgerWidgetBackground: View {
    var body: some View {
        LinearGradient(colors: [Color(red: 0.06, green: 0.30, blue: 0.24),
                                Color(red: 0.03, green: 0.15, blue: 0.12)],
                       startPoint: .topLeading, endPoint: .bottomTrailing)
    }
}

enum LedgerWidgetPalette {
    static func color(_ purpose: LedgerPurpose) -> Color {
        switch purpose {
        case .growth: return Color(red: 0.55, green: 0.78, blue: 1.0)
        case .reserve: return Color(red: 0.40, green: 0.88, blue: 0.92)
        case .essentials: return Color(red: 0.44, green: 0.93, blue: 0.72)
        case .joy: return Color(red: 1.0, green: 0.79, blue: 0.45)
        }
    }
}

/// 记账概览: the account balance and this month's server totals.
struct LedgerBalanceWidgetView: View {
    let snapshot: LedgerWidgetSnapshot?
    let size: LedgerWidgetSize
    var sharedContainerAvailable = true

    var body: some View {
        Group {
            if let snapshot, snapshot.hasBalance {
                content(snapshot)
            } else {
                LedgerWidgetEmptyView(size: size, symbol: "banknote",
                                      sharedContainerAvailable: sharedContainerAvailable)
            }
        }
        .foregroundStyle(.white)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    @ViewBuilder
    private func content(_ snapshot: LedgerWidgetSnapshot) -> some View {
        if size == .small {
            VStack(alignment: .leading, spacing: 4) {
                LedgerWidgetHeader(title: "记账", symbol: "chart.pie.fill")
                Spacer(minLength: 2)
                balanceAmount(snapshot, fontSize: 23)
                Spacer(minLength: 2)
                if let expense = snapshot.monthExpenseCents {
                    LedgerWidgetInlineMetric(title: "本月支出", cents: expense, compact: true)
                }
                if let income = snapshot.monthIncomeCents {
                    LedgerWidgetInlineMetric(title: "本月收入", cents: income, compact: true)
                }
                LedgerWidgetUpdatedText(updatedAt: snapshot.updatedAt, compact: true)
            }
        } else {
            VStack(alignment: .leading, spacing: 6) {
                LedgerWidgetHeader(title: "记账", symbol: "chart.pie.fill", trailing: snapshot.month)
                balanceAmount(snapshot, fontSize: 28)
                Spacer(minLength: 2)
                HStack(alignment: .bottom, spacing: 16) {
                    if let income = snapshot.monthIncomeCents {
                        LedgerWidgetMetric(title: "本月收入", cents: income)
                    }
                    if let expense = snapshot.monthExpenseCents {
                        LedgerWidgetMetric(title: "本月支出", cents: expense)
                    }
                    Spacer(minLength: 0)
                    VStack(alignment: .trailing, spacing: 3) {
                        if let assets = snapshot.totalAssetsCents {
                            LedgerWidgetTinyMetric(title: "总资产", cents: assets)
                        }
                        if let liabilities = snapshot.totalLiabilitiesCents {
                            LedgerWidgetTinyMetric(title: "总负债", cents: liabilities)
                        }
                        LedgerWidgetUpdatedText(updatedAt: snapshot.updatedAt, compact: true)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func balanceAmount(_ snapshot: LedgerWidgetSnapshot, fontSize: CGFloat) -> some View {
        if let total = snapshot.totalBalanceCents {
            VStack(alignment: .leading, spacing: 2) {
                Text("账户总余额").font(.caption2).foregroundStyle(.white.opacity(0.72))
                Text(LedgerFormat.money(total))
                    .font(.system(size: fontSize, weight: .semibold, design: .rounded))
                    .monospacedDigit().lineLimit(1).minimumScaleFactor(0.5)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("账户总余额 " + LedgerFormat.money(total))
        }
    }
}

/// 四用途: the four continuous purpose balances, with the fund evidence on the large family.
struct LedgerPurposeWidgetView: View {
    let snapshot: LedgerWidgetSnapshot?
    let size: LedgerWidgetSize
    var sharedContainerAvailable = true

    var body: some View {
        Group {
            if let snapshot, snapshot.hasPurposes {
                content(snapshot)
            } else {
                LedgerWidgetEmptyView(size: size, symbol: "square.grid.2x2.fill",
                                      sharedContainerAvailable: sharedContainerAvailable)
            }
        }
        .foregroundStyle(.white)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    @ViewBuilder
    private func content(_ snapshot: LedgerWidgetSnapshot) -> some View {
        switch size {
        case .small:
            VStack(alignment: .leading, spacing: 3) {
                LedgerWidgetHeader(title: "四用途", symbol: "square.grid.2x2.fill")
                ForEach(LedgerPurpose.allCases) { purpose in
                    LedgerWidgetPurposeRow(purpose: purpose, value: snapshot.purpose(purpose))
                }
                Spacer(minLength: 2)
                LedgerWidgetUpdatedText(updatedAt: snapshot.updatedAt, compact: true)
            }
        case .medium:
            VStack(alignment: .leading, spacing: 8) {
                LedgerWidgetHeader(title: "四用途", symbol: "square.grid.2x2.fill", trailing: snapshot.month)
                LedgerWidgetPurposeGrid(snapshot: snapshot, compact: true)
                Spacer(minLength: 0)
                if let pending = snapshot.coveragePendingCount, pending > 0 {
                    LedgerWidgetCoverageNote(pending: pending)
                }
            }
        case .large:
            VStack(alignment: .leading, spacing: 10) {
                LedgerWidgetHeader(title: "四用途资金", symbol: "square.grid.2x2.fill", trailing: snapshot.month)
                LedgerWidgetPurposeGrid(snapshot: snapshot, compact: false)
                Spacer(minLength: 0)
                if let pending = snapshot.coveragePendingCount, pending > 0 {
                    LedgerWidgetCoverageNote(pending: pending)
                } else if snapshot.coverageComplete == true {
                    Label("四用途已核对", systemImage: "checkmark.seal.fill")
                        .font(.system(size: 9)).foregroundStyle(.white.opacity(0.6))
                }
                LedgerWidgetUpdatedText(updatedAt: snapshot.updatedAt)
            }
        }
    }
}

/// The shared empty state: the same surface explains whether data merely has not synced yet or the
/// installed signature cannot share an App Group container at all.
struct LedgerWidgetEmptyView: View {
    let size: LedgerWidgetSize
    let symbol: String
    var sharedContainerAvailable = true

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            LedgerWidgetHeader(title: "记账", symbol: "chart.pie.fill")
            Spacer(minLength: 2)
            Image(systemName: symbol).font(.title3).foregroundStyle(.white.opacity(0.9))
                .accessibilityHidden(true)
            Text("尚未同步").font(.subheadline.weight(.semibold))
            Text(message).font(.caption2).foregroundStyle(.white.opacity(0.72))
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 2)
        }
        .foregroundStyle(.white)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .accessibilityElement(children: .combine)
    }

    private var message: String {
        guard sharedContainerAvailable else {
            return size == .small
                ? "当前安装没有 App Group 权限，小组件读不到汇总数据。"
                : "当前安装的签名没有 App Group 共享权限，因此小组件读不到 App 写入的汇总数据。"
        }
        return size == .small
            ? "打开 App 刷新一次即可显示金额。"
            : "打开记账 App 刷新一次，这里会显示账户余额、本月收支与四用途余额。"
    }
}

private struct LedgerWidgetHeader: View {
    let title: String
    let symbol: String
    var trailing: String? = nil

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: symbol).font(.caption2.weight(.semibold))
            Text(title).font(.caption.weight(.semibold))
            Spacer(minLength: 4)
            if let trailing {
                Text(trailing).font(.system(size: 9)).foregroundStyle(.white.opacity(0.55))
            }
        }
        .foregroundStyle(.white.opacity(0.82))
    }
}

private struct LedgerWidgetUpdatedText: View {
    let updatedAt: Int64
    var compact = false

    var body: some View {
        (Text("更新于 ") + Text(date, style: .relative))
            .font(.system(size: compact ? 9 : 10))
            .foregroundStyle(.white.opacity(0.55))
            .lineLimit(1)
    }

    private var date: Date {
        Date(timeIntervalSince1970: Double(updatedAt) / 1_000)
    }
}

private struct LedgerWidgetMetric: View {
    let title: String
    let cents: Int64

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.caption2).foregroundStyle(.white.opacity(0.72))
            Text(LedgerFormat.money(cents))
                .font(.subheadline.weight(.semibold)).monospacedDigit()
                .lineLimit(1).minimumScaleFactor(0.6)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(title + " " + LedgerFormat.money(cents))
    }
}

private struct LedgerWidgetInlineMetric: View {
    let title: String
    let cents: Int64
    var compact = false

    var body: some View {
        HStack(spacing: 6) {
            Text(title).font(.caption2).foregroundStyle(.white.opacity(0.72))
            Spacer(minLength: 4)
            Text(LedgerFormat.money(cents))
                .font((compact ? Font.caption2 : Font.caption).weight(.semibold))
                .monospacedDigit().lineLimit(1).minimumScaleFactor(0.6)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(title + " " + LedgerFormat.money(cents))
    }
}

private struct LedgerWidgetTinyMetric: View {
    let title: String
    let cents: Int64

    var body: some View {
        Text(title + " " + LedgerFormat.money(cents))
            .font(.system(size: 9)).monospacedDigit()
            .foregroundStyle(.white.opacity(0.62))
            .lineLimit(1).minimumScaleFactor(0.6)
    }
}

private struct LedgerWidgetPurposeRow: View {
    let purpose: LedgerPurpose
    let value: LedgerWidgetSnapshot.Purpose?

    var body: some View {
        HStack(spacing: 5) {
            LedgerWidgetPurposeDot(purpose: purpose)
            Text(purpose.title).font(.caption2).foregroundStyle(.white.opacity(0.85)).lineLimit(1)
            Spacer(minLength: 4)
            Text(value.map { LedgerFormat.money($0.balanceCents) } ?? "—")
                .font(.caption2.weight(.semibold)).monospacedDigit()
                .lineLimit(1).minimumScaleFactor(0.6)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(purpose.title + " " + (value.map { LedgerFormat.money($0.balanceCents) } ?? "暂无"))
    }
}

private struct LedgerWidgetPurposeGrid: View {
    let snapshot: LedgerWidgetSnapshot
    let compact: Bool

    private let columns = [GridItem(.flexible(), spacing: 8, alignment: .leading),
                           GridItem(.flexible(), spacing: 8, alignment: .leading)]

    var body: some View {
        LazyVGrid(columns: columns, alignment: .leading, spacing: compact ? 8 : 10) {
            ForEach(LedgerPurpose.allCases) { purpose in
                LedgerWidgetPurposeCell(purpose: purpose, value: snapshot.purpose(purpose), compact: compact)
            }
        }
    }
}

private struct LedgerWidgetPurposeCell: View {
    let purpose: LedgerPurpose
    let value: LedgerWidgetSnapshot.Purpose?
    let compact: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 2 : 4) {
            HStack(spacing: 5) {
                LedgerWidgetPurposeDot(purpose: purpose)
                Text(purpose.title).font(.caption2).foregroundStyle(.white.opacity(0.82)).lineLimit(1)
            }
            Text(value.map { LedgerFormat.money($0.balanceCents) } ?? "—")
                .font(.system(size: compact ? 15 : 19, weight: .semibold, design: .rounded))
                .monospacedDigit().lineLimit(1).minimumScaleFactor(0.55)
            if !compact, let value {
                Text("已分配 " + LedgerFormat.money(value.fundedCents))
                    .font(.system(size: 9)).foregroundStyle(.white.opacity(0.6))
                    .lineLimit(1).minimumScaleFactor(0.7)
                Text("支出 " + LedgerFormat.money(value.spentCents))
                    .font(.system(size: 9)).foregroundStyle(.white.opacity(0.6))
                    .lineLimit(1).minimumScaleFactor(0.7)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityText)
    }

    private var accessibilityText: String {
        guard let value else { return purpose.title + "，暂无金额" }
        return purpose.title + "，余额 " + LedgerFormat.money(value.balanceCents)
    }
}

private struct LedgerWidgetPurposeDot: View {
    let purpose: LedgerPurpose

    var body: some View {
        Circle().fill(LedgerWidgetPalette.color(purpose))
            .frame(width: 6, height: 6)
            .accessibilityHidden(true)
    }
}

private struct LedgerWidgetCoverageNote: View {
    let pending: Int

    var body: some View {
        Label("部分资金待核对 · \(pending) 项", systemImage: "exclamationmark.circle.fill")
            .font(.system(size: 9)).foregroundStyle(.orange)
            .lineLimit(1).minimumScaleFactor(0.7)
    }
}
