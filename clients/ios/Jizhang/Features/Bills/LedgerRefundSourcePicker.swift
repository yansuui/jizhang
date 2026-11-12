import SwiftUI

/// Server-authoritative page of original expenses for one refund. Only expenses can be linked:
/// the server rejects a link to an income, to another refund, or to a deleted row.
@MainActor final class LedgerRefundSourceStore: ObservableObject {
    @Published private(set) var items: [LedgerTransaction] = []
    @Published private(set) var total = 0
    @Published private(set) var loading = false
    @Published private(set) var loadingMore = false
    @Published private(set) var hasLoaded = false
    @Published private(set) var error: String?
    private let pageSize = 30
    private var generation = 0
    private var text = ""

    var hasMore: Bool { items.count < total }
    private var isSearching: Bool { !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    /// Expenses only: a refund is income-typed, so it can never appear as its own original bill.
    private var query: LedgerBillQuery {
        var query = LedgerBillQuery()
        query.type = LedgerBillKind.expense.rawValue
        query.text = text
        return query
    }

    func reload(api: APIClient, text: String) async {
        generation += 1
        let ticket = generation
        self.text = text
        let query = self.query
        let searching = self.isSearching
        loading = true
        loadingMore = false
        error = nil
        defer { if generation == ticket { loading = false } }
        do {
            let page: LedgerTransactionPage = try await api.request(query.path(offset: 0, limit: pageSize))
            try page.validate(expectedOffset: 0, expectedLimit: pageSize, requiresSearch: searching)
            guard generation == ticket, !Task.isCancelled else { return }
            items = page.items
            total = page.total
            hasLoaded = true
        } catch {
            guard generation == ticket, !Task.isCancelled else { return }
            self.error = error.localizedDescription
        }
    }

    func next(api: APIClient) async {
        guard hasMore, !loading, !loadingMore else { return }
        let ticket = generation
        let offset = items.count
        let query = self.query
        let searching = isSearching
        loadingMore = true
        error = nil
        defer { if generation == ticket { loadingMore = false } }
        do {
            let page: LedgerTransactionPage = try await api.request(query.path(offset: offset, limit: pageSize))
            try page.validate(expectedOffset: offset, expectedLimit: pageSize, requiresSearch: searching)
            guard generation == ticket, !Task.isCancelled else { return }
            guard page.total == total, !page.items.isEmpty,
                  Set(items.map(\.id)).isDisjoint(with: Set(page.items.map(\.id))) else { throw LedgerDataError.changedPage }
            items.append(contentsOf: page.items)
        } catch {
            guard generation == ticket, !Task.isCancelled else { return }
            self.error = error.localizedDescription
        }
    }
}

@MainActor struct LedgerRefundSourcePicker: View {
    let api: APIClient
    let metadata: LedgerMetadata
    @Binding var selectedIds: [String]
    @Environment(\.dismiss) private var dismiss
    @StateObject private var store = LedgerRefundSourceStore()
    @State private var text = ""

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack {
                        Text("已选择 \(selectedIds.count) 笔原支出").font(.subheadline)
                        Spacer(minLength: 8)
                        if !selectedIds.isEmpty {
                            Button("清空") { selectedIds = [] }.font(.footnote)
                        }
                    }
                }
                if store.loading && !store.hasLoaded { LedgerLoadingView(title: "正在读取支出…") }
                if let error = store.error {
                    LedgerErrorView(message: error, showingPrevious: !store.items.isEmpty) {
                        Task { await store.reload(api: api, text: text) }
                    }
                }
                if store.hasLoaded && store.items.isEmpty && store.error == nil {
                    LedgerEmptyView(title: "没有可关联的支出",
                                    message: "只有支出可以作为退款原单；退款本身不能再被关联。",
                                    symbol: "arrow.up.right")
                }
                ForEach(store.items) { transaction in
                    Button { toggle(transaction.id) } label: {
                        HStack(spacing: 12) {
                            LedgerTransactionRow(transaction: transaction, metadata: metadata)
                            Image(systemName: selectedIds.contains(transaction.id) ? "checkmark.circle.fill" : "circle")
                                .font(.title3)
                                .foregroundStyle(selectedIds.contains(transaction.id) ? AppTheme.accent : Color.secondary)
                                .accessibilityHidden(true)
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityValue(selectedIds.contains(transaction.id) ? "已关联" : "未关联")
                }
                if store.hasMore {
                    Button { Task { await store.next(api: api) } } label: {
                        HStack {
                            Spacer()
                            if store.loadingMore { ProgressView() } else { Text("加载更多") }
                            Spacer()
                        }
                    }.disabled(store.loading || store.loadingMore)
                }
            }
            .navigationTitle("选择原支出")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $text, prompt: "搜索备注、分类或标签")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } }
            }
            // First appearance loads immediately; typing debounces like the bill search.
            .task(id: text) {
                if !text.isEmpty {
                    do { try await Task.sleep(for: .milliseconds(300)) } catch { return }
                }
                await store.reload(api: api, text: text)
            }
        }
    }

    private func toggle(_ id: String) {
        if let index = selectedIds.firstIndex(of: id) { selectedIds.remove(at: index) }
        else { selectedIds.append(id) }
    }
}
