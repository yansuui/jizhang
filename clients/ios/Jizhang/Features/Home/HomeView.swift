import SwiftUI

private struct LedgerRecentData {
    let items: [LedgerTransaction]
    let metadata: LedgerMetadata
}

@MainActor struct HomeView: View {
    @ObservedObject var api: APIClient
    @StateObject private var balances = LedgerResource<LedgerBalances>()
    @StateObject private var month = LedgerResource<LedgerTrend>()
    @StateObject private var recent = LedgerResource<LedgerRecentData>()
    @State private var balanceHidden = false
    @State private var selectedBill: LedgerBillSelection?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("把每一笔，记在心里。")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                balanceSection
                monthSection
                HStack(spacing: 14) {
                    NavigationLink { PlanView(api: api) } label: {
                        quickLink("四用途资金", subtitle: "让每一份收入有方向", symbol: "square.grid.2x2.fill")
                    }
                    NavigationLink { LedgerStatisticsView(api: api) } label: {
                        quickLink("收支统计", subtitle: "看清消费与收入", symbol: "chart.bar.fill")
                    }
                }.buttonStyle(.plain)
                recentSection
            }.padding(20)
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .navigationTitle("记账")
        .task(id: api.ledgerRevision) { await loadBalances() }
        .task(id: api.ledgerRevision) { await loadMonth() }
        .task(id: api.ledgerRevision) { await loadRecent() }
        .sheet(item: $selectedBill) { selection in
            LedgerBillDetailSheet(api: api, transactionID: selection.id, metadata: recent.value?.metadata ?? .empty)
        }
        .refreshable {
            await loadBalances()
            await loadMonth()
            await loadRecent()
        }
    }

    @ViewBuilder private var balanceSection: some View {
        if let value = balances.value {
            VStack(alignment: .leading, spacing: 24) {
                HStack {
                    Text("账户总余额").font(.subheadline).foregroundStyle(.white.opacity(0.85))
                    Spacer()
                    Button { balanceHidden.toggle() } label: {
                        Image(systemName: balanceHidden ? "eye.slash" : "eye")
                            .frame(width: 44, height: 32)
                    }.foregroundStyle(.white.opacity(0.9))
                        .accessibilityLabel(balanceHidden ? "显示余额" : "隐藏余额")
                }
                Text(balanceHidden ? "••••••" : LedgerFormat.money(value.totalBalanceCents))
                    .font(.system(.largeTitle, design: .rounded).weight(.semibold))
                    .monospacedDigit().foregroundStyle(.white)
                    .minimumScaleFactor(0.55).lineLimit(1)
                    .privacySensitive()
                HStack {
                    heroMetric("总资产", cents: value.totalAssetsCents)
                    heroMetric("总负债", cents: value.totalLiabilitiesCents)
                }
                if !value.items.isEmpty {
                    Divider().overlay(.white.opacity(0.2))
                    ForEach(value.items.prefix(3)) { account in
                        HStack {
                            Text(account.name).font(.subheadline).lineLimit(1)
                            Spacer()
                            Text(balanceHidden ? "••••" : LedgerFormat.money(account.balanceCents))
                                .font(.subheadline.weight(.medium)).monospacedDigit()
                        }.foregroundStyle(.white.opacity(0.9))
                    }
                }
                NavigationLink { LedgerAccountsView(api: api) } label: {
                    HStack {
                        Text("查看全部账户").font(.caption.weight(.semibold))
                        Spacer()
                        Image(systemName: "arrow.right").font(.caption.weight(.semibold))
                    }.foregroundStyle(.white)
                }
            }
            .padding(24)
            .background(LinearGradient(colors: [AppTheme.accent, Color(red: 0.06, green: 0.30, blue: 0.24)], startPoint: .topLeading, endPoint: .bottomTrailing), in: RoundedRectangle(cornerRadius: 28))
        } else if balances.loading {
            LedgerCard { LedgerLoadingView(title: "正在读取账户余额…") }
        }
        if let error = balances.error {
            LedgerErrorView(message: error, showingPrevious: balances.value != nil) { Task { await loadBalances() } }
        }
    }

    private func heroMetric(_ label: String, cents: Int64) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(.caption).foregroundStyle(.white.opacity(0.7))
            Text(balanceHidden ? "••••" : LedgerFormat.money(cents))
                .font(.subheadline.weight(.medium)).monospacedDigit().foregroundStyle(.white)
                .minimumScaleFactor(0.7).lineLimit(1)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private var monthSection: some View {
        if let point = month.value?.items.last {
            LedgerCard {
                LedgerSectionHeading(title: "本月收支", subtitle: point.month + " · 收入包含工资与退款")
                HStack(spacing: 20) {
                    LedgerMetric(title: "收入", value: LedgerFormat.money(point.incomeCents), tint: AppTheme.accent)
                    LedgerMetric(title: "支出", value: LedgerFormat.money(point.netExpenseCents))
                }
            }
        } else if month.loading {
            LedgerCard { LedgerLoadingView(title: "正在读取本月收支…") }
        } else if month.value != nil {
            LedgerCard { LedgerEmptyView(title: "暂无本月收支数据", symbol: "chart.bar") }
        }
        if let error = month.error {
            LedgerErrorView(message: error, showingPrevious: month.value != nil) { Task { await loadMonth() } }
        }
    }

    private func quickLink(_ title: String, subtitle: String, symbol: String) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            LedgerSymbol(name: symbol)
            Text(title).font(.subheadline.weight(.semibold))
            Text(subtitle).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }.frame(maxWidth: .infinity, alignment: .leading).padding(18)
            .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 22))
    }

    private var recentSection: some View {
        LedgerCard {
            HStack {
                LedgerSectionHeading(title: "最近账单")
                NavigationLink { BillsView(api: api) } label: { Text("全部").font(.subheadline) }
            }
            if let value = recent.value {
                if value.items.isEmpty {
                    LedgerEmptyView(title: "还没有账单", message: "已有账单会同步显示在这里。", symbol: "list.bullet.rectangle")
                } else {
                    ForEach(value.items) { transaction in
                        Button { selectedBill = LedgerBillSelection(id: transaction.id) } label: {
                            LedgerTransactionRow(transaction: transaction, metadata: value.metadata)
                        }.buttonStyle(.plain)
                        if transaction.id != value.items.last?.id { Divider() }
                    }
                }
            } else if recent.loading { LedgerLoadingView() }
            if let error = recent.error {
                LedgerErrorView(message: error, showingPrevious: recent.value != nil) { Task { await loadRecent() } }
            }
        }
    }

    private func loadBalances() async {
        await balances.load { try await api.request("/accounts/balances") }
    }
    private func loadMonth() async {
        await month.load { try await api.request("/stats/monthly-trend?months=1") }
    }
    private func loadRecent() async {
        await recent.load {
            let page: LedgerPage<LedgerTransaction> = try await api.request("/transactions?limit=8&offset=0")
            let metadata = try await LedgerMetadata.load(api: api)
            return LedgerRecentData(items: page.items, metadata: metadata)
        }
    }
}
