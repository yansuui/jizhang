import SwiftUI
import Charts
import Combine

private struct LedgerStatisticsData {
    let window: LedgerStatsWindow
    let share: LedgerCategoryShare
}

@MainActor struct LedgerStatisticsView: View {
    let api: APIClient
    @State private var kind = "month"
    @StateObject private var category = LedgerResource<LedgerStatisticsData>()
    @StateObject private var trend = LedgerResource<LedgerTrend>()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Picker("统计区间", selection: $kind) {
                    Text("本月").tag("month")
                    Text("近 30 天").tag("last30")
                }.pickerStyle(.segmented)
                if let value = category.value {
                    summaryCard(value)
                    categoriesCard(value)
                } else if category.loading {
                    LedgerCard { LedgerLoadingView(title: "正在读取分类统计…") }
                }
                if let error = category.error {
                    LedgerErrorView(message: error, showingPrevious: category.value != nil) { Task { await loadCategories() } }
                }
                if let value = trend.value { trendCard(value) }
                else if trend.loading { LedgerCard { LedgerLoadingView(title: "正在读取收支趋势…") } }
                if let error = trend.error {
                    LedgerErrorView(message: error, showingPrevious: trend.value != nil) { Task { await loadTrend() } }
                }
                Text("收入包含工资与退款；普通支出按原始金额统计，退款单独记为收入。转账不计入收支。")
                    .font(.footnote).foregroundStyle(.secondary)
            }.padding(20)
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .navigationTitle("收支统计").navigationBarTitleDisplayMode(.inline)
        .task(id: kind) {
            category.clear()
            await loadCategories()
        }
        .task { await loadTrend() }
        .refreshable { await loadCategories(); await loadTrend() }
        .onReceive(api.$ledgerRevision.dropFirst()) { _ in
            Task { await loadCategories(); await loadTrend() }
        }
    }

    private func summaryCard(_ value: LedgerStatisticsData) -> some View {
        LedgerCard {
            LedgerSectionHeading(title: value.window.label, subtitle: "按账本服务的统计区间展示")
            HStack(spacing: 18) {
                LedgerMetric(title: "原始支出", value: LedgerFormat.money(value.share.expenseCents))
                LedgerMetric(title: "退款收入", value: LedgerFormat.money(value.share.refundIncomeCents), tint: AppTheme.accent)
            }
            Text("支出 \(value.share.expenseCount) 笔").font(.caption).foregroundStyle(.secondary)
        }
    }

    private func categoriesCard(_ value: LedgerStatisticsData) -> some View {
        LedgerCard {
            LedgerSectionHeading(title: "支出分类", subtitle: "占比按原始支出统计")
            if value.share.items.isEmpty {
                LedgerEmptyView(title: "这段时间还没有支出", message: "新增的支出会按分类展示在这里。", symbol: "chart.pie")
            }
            ForEach(value.share.items) { item in
                VStack(alignment: .leading, spacing: 9) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(item.categoryName).font(.subheadline.weight(.medium))
                        Spacer(minLength: 8)
                        Text(LedgerFormat.money(item.amountCents)).font(.subheadline).monospacedDigit()
                        Text(item.ratio.formatted(.percent.precision(.fractionLength(1))))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    ProgressView(value: item.ratio, total: 1).tint(AppTheme.accent)
                        .accessibilityLabel(item.categoryName + "占比")
                }.padding(.vertical, 5)
            }
        }
    }

    private func trendCard(_ value: LedgerTrend) -> some View {
        LedgerCard {
            LedgerSectionHeading(title: "近六个月收支", subtitle: value.range?.label)
            if value.items.isEmpty {
                LedgerEmptyView(title: "暂无趋势数据", symbol: "chart.bar")
            } else {
                Chart(value.items) { point in
                    BarMark(x: .value("月份", point.month), y: .value("金额", Double(point.incomeCents) / 100))
                        .foregroundStyle(by: .value("类型", "收入"))
                        .position(by: .value("类型", "收入"))
                    BarMark(x: .value("月份", point.month), y: .value("金额", Double(point.netExpenseCents) / 100))
                        .foregroundStyle(by: .value("类型", "支出"))
                        .position(by: .value("类型", "支出"))
                }
                .chartForegroundStyleScale(["收入": AppTheme.accent, "支出": Color.orange.opacity(0.8)])
                .chartYAxisLabel("元")
                .frame(height: 220)
                .accessibilityLabel("近六个月收支柱状图，准确金额列在下方")
                ForEach(value.items.reversed()) { point in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(point.month).font(.subheadline.weight(.semibold))
                        HStack(spacing: 16) {
                            LedgerMetric(title: "收入", value: LedgerFormat.money(point.incomeCents), tint: AppTheme.accent)
                            LedgerMetric(title: "支出", value: LedgerFormat.money(point.netExpenseCents))
                        }
                        if let salary = point.salaryIncomeCents, let refund = point.refundIncomeCents {
                            Text("其中工资 " + LedgerFormat.money(salary) + " · 退款 " + LedgerFormat.money(refund))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }.padding(.vertical, 8)
                }
            }
        }
    }

    private func loadCategories() async {
        let requestedKind = kind
        await category.load {
            let window: LedgerStatsWindow = try await api.request(LedgerURL.path("/stats/window", [("kind", requestedKind)]))
            guard window.kind == requestedKind, window.to > window.from, TimeZone(identifier: window.timeZone) != nil else {
                throw LedgerDataError.invalidResponse
            }
            let share: LedgerCategoryShare = try await api.request(LedgerURL.path("/stats/category-share", [("from", String(window.from)), ("to", String(window.to))]))
            guard share.from == window.from, share.to == window.to,
                  share.items.allSatisfy({ $0.ratio.isFinite && $0.ratio >= 0 && $0.ratio <= 1 && $0.amountCents >= 0 }) else {
                throw LedgerDataError.invalidResponse
            }
            return LedgerStatisticsData(window: window, share: share)
        }
    }
    private func loadTrend() async { await trend.load { try await api.request("/stats/monthly-trend?months=6") } }
}
