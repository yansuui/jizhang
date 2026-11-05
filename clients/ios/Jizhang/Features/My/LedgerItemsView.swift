import SwiftUI
import Combine

@MainActor struct LedgerItemsView: View {
    let api: APIClient
    @StateObject private var summary = LedgerResource<LedgerItemSummary>()
    @StateObject private var store = LedgerReadListStore<LedgerItem>()

    var body: some View {
        List {
            if let value = summary.value {
                Section {
                    HStack {
                        LedgerMetric(title: "累计购入金额", value: LedgerFormat.money(value.cumulativePurchaseCents))
                        LedgerMetric(title: "当前每日成本", value: LedgerFormat.money(value.currentDailyCostCents), tint: AppTheme.accent)
                    }.padding(.vertical, 10)
                    Text("共 \(value.totalItems) 件 · 在用 \(value.activeItems) · 闲置 \(value.idleItems) · 售出 \(value.soldItems) · 退役 \(value.retiredItems)")
                        .font(.caption).foregroundStyle(.secondary)
                    Text("购入金额是物品记录统计，不是账户资产。每日成本由服务端按已知价格和持有时间计算。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            } else if summary.loading { LedgerLoadingView(title: "正在读取物品概览…") }
            if let error = summary.error {
                LedgerErrorView(message: "物品概览：" + error, showingPrevious: summary.value != nil) { Task { await loadSummary() } }
            }
            Section("物品清单") {
                if store.loading && !store.hasLoaded { LedgerLoadingView() }
                if let error = store.error {
                    LedgerErrorView(message: error, showingPrevious: store.hasLoaded) { Task { await loadList() } }
                }
                if store.hasLoaded && store.items.isEmpty { LedgerEmptyView(title: "暂无物品", symbol: "shippingbox") }
                ForEach(store.items) { item in
                    NavigationLink { LedgerItemDetailView(api: api, itemID: item.id, metadata: store.metadata) } label: {
                        LedgerCatalogRow(title: item.name,
                                         subtitle: item.status.title + " · " + (item.category.isEmpty ? "未分类" : item.category),
                                         symbol: "shippingbox", detail: item.dailyCostCents.map { LedgerFormat.money($0) + "/天" } ?? "成本未知")
                    }
                }
                if store.hasMore {
                    Button { Task { await store.next(api: api, path: "/items") } } label: {
                        HStack {
                            Spacer()
                            if store.loadingMore { ProgressView() } else { Text("加载更多") }
                            Spacer()
                        }
                    }.disabled(store.loading || store.loadingMore)
                }
                if store.hasLoaded, let total = store.total {
                    Text("已显示 \(store.items.count) / \(total) 件").font(.caption).foregroundStyle(.secondary)
                }
            }
        }.navigationTitle("物品").navigationBarTitleDisplayMode(.inline)
            .task { await loadSummary() }.task { await loadList() }
            .refreshable { await loadSummary(); await loadList() }
            .onReceive(api.$ledgerRevision.dropFirst()) { _ in
                Task { await loadSummary(); await loadList() }
            }
    }
    private func loadSummary() async { await summary.load { try await api.request("/items/summary") } }
    private func loadList() async { await store.reload(api: api, path: "/items", paginated: true, needsMetadata: true) }
}

@MainActor private struct LedgerItemDetailView: View {
    let api: APIClient
    let itemID: String
    let metadata: LedgerMetadata
    @StateObject private var resource = LedgerResource<LedgerItem>()
    @State private var selectedBill: LedgerBillSelection?
    var body: some View {
        List {
            if let item = resource.value {
                Section {
                    HStack(spacing: 16) {
                        LedgerSymbol(name: "shippingbox.fill")
                        VStack(alignment: .leading, spacing: 6) {
                            Text(item.name).font(.title3.weight(.semibold))
                            Text(item.status.title).font(.subheadline).foregroundStyle(AppTheme.accent)
                        }
                    }.padding(.vertical, 12)
                    LedgerFieldRow(title: "分类", value: item.category.isEmpty ? "未分类" : item.category)
                    if !item.brand.isEmpty { LedgerFieldRow(title: "品牌", value: item.brand) }
                    if !item.model.isEmpty { LedgerFieldRow(title: "型号", value: item.model) }
                    if !item.note.isEmpty { LedgerFieldRow(title: "备注", value: item.note) }
                }
                Section("持有与成本") {
                    LedgerFieldRow(title: "购入日期", value: LedgerFormat.date(item.purchaseDate))
                    LedgerFieldRow(title: "购入金额", value: item.purchasePriceCents.map { LedgerFormat.money($0) } ?? "未记录")
                    LedgerFieldRow(title: "持有天数", value: "\(item.heldDays) 天")
                    LedgerFieldRow(title: "净成本", value: item.netCostCents.map { LedgerFormat.money($0) } ?? "未知")
                    LedgerFieldRow(title: "每日成本", value: item.dailyCostCents.map { LedgerFormat.money($0) } ?? "暂不可计算")
                    if let date = item.closedDate { LedgerFieldRow(title: "结束日期", value: LedgerFormat.date(date)) }
                    if let cents = item.salePriceCents { LedgerFieldRow(title: "售出金额", value: LedgerFormat.money(cents)) }
                }
                if item.purchaseTransactionId != nil || item.saleTransactionId != nil {
                    Section("关联账单") {
                        if let id = item.purchaseTransactionId {
                            Button("查看购入账单") { selectedBill = LedgerBillSelection(id: id) }
                        }
                        if let id = item.saleTransactionId {
                            Button("查看售出账单") { selectedBill = LedgerBillSelection(id: id) }
                        }
                    }
                }
                if item.photoUrl != nil {
                    Section { Label("已保存物品照片，照片预览将在后续版本提供。", systemImage: "photo").font(.footnote).foregroundStyle(.secondary) }
                }
            } else if resource.loading { LedgerLoadingView() }
            if let error = resource.error {
                LedgerErrorView(message: error, showingPrevious: resource.value != nil) { Task { await load() } }
            }
        }.navigationTitle("物品详情").navigationBarTitleDisplayMode(.inline)
            .task { await load() }.refreshable { await load() }
            .onReceive(api.$ledgerRevision.dropFirst()) { _ in Task { await load() } }
            .sheet(item: $selectedBill) { bill in
                LedgerBillDetailSheet(api: api, transactionID: bill.id, metadata: metadata)
            }
    }
    private func load() async { await resource.load { try await api.request("/items/" + LedgerURL.segment(itemID)) } }
}
