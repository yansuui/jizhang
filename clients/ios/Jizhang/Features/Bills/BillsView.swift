import SwiftUI

@MainActor final class LedgerBillsStore: ObservableObject {
    @Published private(set) var items: [LedgerTransaction] = []
    @Published private(set) var metadata = LedgerMetadata.empty
    @Published private(set) var total = 0
    @Published private(set) var loading = false
    @Published private(set) var loadingMore = false
    @Published private(set) var hasLoaded = false
    @Published private(set) var error: String?
    private var generation = 0
    private var owner: UUID?
    private var loadedQuery: LedgerBillQuery?
    private var revision: String?
    private let pageSize = 50

    func prepare(query: LedgerBillQuery) {
        guard loadedQuery != query else { return }
        generation += 1
        loadedQuery = query
        items = []
        total = 0
        hasLoaded = false
        error = nil
        loading = true
        loadingMore = false
    }

    func reload(api: APIClient, query: LedgerBillQuery) async {
        generation += 1
        let ticket = generation
        if loadedQuery != query || owner != api.identity { items = []; total = 0; hasLoaded = false }
        owner = api.identity
        loadedQuery = query
        loading = true
        loadingMore = false
        error = nil
        defer { if generation == ticket { loading = false } }
        do {
            let page: LedgerTransactionPage = try await api.request(query.path(limit: pageSize))
            try page.validate(expectedOffset: 0, expectedLimit: pageSize, requiresSearch: !query.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            let metadata = try await LedgerMetadata.load(api: api)
            guard generation == ticket, !Task.isCancelled else { return }
            self.metadata = metadata
            items = page.items
            total = page.total
            revision = page.searchRevision
            hasLoaded = true
        } catch {
            guard generation == ticket, !Task.isCancelled else { return }
            self.error = error.localizedDescription
        }
    }

    func next(api: APIClient) async {
        guard owner == api.identity, let query = loadedQuery, !loading, !loadingMore, items.count < total else { return }
        let ticket = generation
        let offset = items.count
        loadingMore = true
        error = nil
        defer { if generation == ticket { loadingMore = false } }
        do {
            let page: LedgerTransactionPage = try await api.request(query.path(offset: offset, limit: pageSize))
            try page.validate(expectedOffset: offset, expectedLimit: pageSize, requiresSearch: !query.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            guard generation == ticket, !Task.isCancelled else { return }
            guard page.total == total, page.searchRevision == revision,
                  !page.items.isEmpty,
                  Set(items.map(\.id)).isDisjoint(with: Set(page.items.map(\.id))) else {
                throw LedgerDataError.changedPage
            }
            items.append(contentsOf: page.items)
        } catch {
            guard generation == ticket, !Task.isCancelled else { return }
            self.error = error.localizedDescription
        }
    }
}

struct LedgerTransactionPage: Decodable {
    let items: [LedgerTransaction]
    let total: Int
    let limit: Int
    let offset: Int
    let searchVersion: Int?
    let searchRevision: String?

    func validate(expectedOffset: Int, expectedLimit: Int, requiresSearch: Bool = false) throws {
        if requiresSearch {
            guard searchVersion == 1, let searchRevision, !searchRevision.isEmpty else { throw LedgerDataError.unsupportedSearch }
        }
        guard offset == expectedOffset, limit == expectedLimit, total >= 0,
              offset >= 0, offset <= total, items.count <= limit, items.count <= total - offset,
              Set(items.map(\.id)).count == items.count else { throw LedgerDataError.invalidResponse }
    }
}

@MainActor struct BillsView: View {
    @ObservedObject var api: APIClient
    @State private var query: LedgerBillQuery
    @StateObject private var store = LedgerBillsStore()
    @State private var selectedBill: LedgerBillSelection?
    @State private var showingDates = false

    init(api: APIClient, initialQuery: LedgerBillQuery = LedgerBillQuery()) {
        self.api = api
        _query = State(initialValue: initialQuery)
    }

    private var grouped: [(String, [LedgerTransaction])] {
        let groups = Dictionary(grouping: store.items) { LedgerFormat.dayKey($0.date) }
        return groups.keys.sorted(by: >).map { ($0, groups[$0] ?? []) }
    }

    var body: some View {
        List {
            if store.loading && !store.hasLoaded {
                LedgerLoadingView(title: "正在读取账单…").listRowBackground(Color.clear)
            }
            if let error = store.error {
                LedgerErrorView(message: error, showingPrevious: !store.items.isEmpty) {
                    Task { await store.reload(api: api, query: query) }
                }.listRowBackground(Color.clear).listRowInsets(EdgeInsets())
            }
            if store.hasLoaded && store.items.isEmpty && !store.loading {
                LedgerEmptyView(title: "没有找到相关账单", message: "可以更换关键词或筛选条件。", symbol: "doc.text.magnifyingglass")
                    .listRowBackground(Color.clear)
            }
            ForEach(grouped, id: \.0) { day, transactions in
                Section(day) {
                    ForEach(transactions) { transaction in
                        Button { selectedBill = LedgerBillSelection(id: transaction.id) } label: {
                            LedgerTransactionRow(transaction: transaction, metadata: store.metadata)
                        }.buttonStyle(.plain)
                    }
                }
            }
            if store.hasLoaded && !store.items.isEmpty {
                Section {
                    if store.items.count < store.total {
                        Button {
                            Task { await store.next(api: api) }
                        } label: {
                            HStack {
                                Spacer()
                                if store.loadingMore { ProgressView() } else { Text("加载更多") }
                                Spacer()
                            }
                        }.disabled(store.loading || store.loadingMore)
                    }
                    Text("已显示 \(store.items.count) / \(store.total) 笔")
                        .font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity)
                }.listRowBackground(Color.clear)
            }
        }
        .navigationTitle("账单")
        .searchable(text: $query.text, prompt: "搜索备注、分类或标签")
        .safeAreaInset(edge: .top, spacing: 0) { filterControls }
        .sheet(item: $selectedBill) { selection in
            LedgerBillDetailSheet(api: api, transactionID: selection.id, metadata: store.metadata)
        }
        .sheet(isPresented: $showingDates) {
            LedgerBillDateFilter(query: $query)
        }
        .task(id: LedgerBillsReadKey(query: query, revision: api.ledgerRevision)) {
            store.prepare(query: query)
            if !query.text.isEmpty {
                do { try await Task.sleep(for: .milliseconds(300)) } catch { return }
            }
            await store.reload(api: api, query: query)
        }
        .refreshable { await store.reload(api: api, query: query) }
    }

    private var filterControls: some View {
        VStack(spacing: 10) {
            Picker("收支类型", selection: Binding(get: { query.type ?? -1 }, set: { query.type = $0 == -1 ? nil : $0 })) {
                Text("全部").tag(-1)
                Text("支出").tag(0)
                Text("收入").tag(1)
            }.pickerStyle(.segmented)
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 16) { accountFilter; dateFilter }
                VStack(alignment: .leading, spacing: 4) { accountFilter; dateFilter }
            }.frame(maxWidth: .infinity, alignment: .leading)
            if query.categoryId != nil || query.tag != nil {
                HStack {
                    VStack(alignment: .leading) {
                        if let id = query.categoryId { Text("分类：" + store.metadata.categoryName(id)) }
                        if let tag = query.tag { Text("标签：" + tag) }
                    }.font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Button("清除分类/标签") { query.categoryId = nil; query.tag = nil }.font(.caption)
                }
            }
        }.padding(.horizontal, 20).padding(.vertical, 10).background(.bar)
    }

    private var accountFilter: some View {
        Menu {
            Button("全部账户") { query.accountId = nil }
            ForEach(store.metadata.accounts) { account in
                Button(account.name) { query.accountId = account.id }
            }
        } label: {
            Label(query.accountId.map { store.metadata.accountName($0) } ?? "全部账户", systemImage: "creditcard")
                .font(.subheadline).lineLimit(1).frame(minHeight: 44)
        }.accessibilityLabel("切换账户")
    }

    private var dateFilter: some View {
        Menu {
            Button("全部日期") { query.from = nil; query.to = nil }
            Button("本月") { selectMonth(Date()) }
            Button("上月") {
                if let date = LedgerBillDates.calendar.date(byAdding: .month, value: -1, to: Date()) { selectMonth(date) }
            }
            Button("选择月份或日期范围…") { showingDates = true }
        } label: {
            Label(LedgerBillDates.title(query: query), systemImage: "calendar")
                .font(.subheadline).lineLimit(1).frame(minHeight: 44)
        }
    }

    private func selectMonth(_ date: Date) {
        let bounds = LedgerBillDates.month(containing: date)
        query.from = bounds.from
        query.to = bounds.to
    }
}

private struct LedgerBillsReadKey: Hashable { let query: LedgerBillQuery; let revision: Int }
struct LedgerBillSelection: Identifiable { let id: String }

@MainActor struct LedgerBillDetailSheet: View {
    let api: APIClient
    let transactionID: String
    let metadata: LedgerMetadata
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            LedgerBillDetailView(api: api, transactionID: transactionID, metadata: metadata)
                .toolbar { ToolbarItem(placement: .topBarTrailing) { Button("关闭") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}

@MainActor struct LedgerBillDetailView: View {
    @ObservedObject var api: APIClient
    let transactionID: String
    let metadata: LedgerMetadata
    @StateObject private var resource = LedgerResource<LedgerTransaction>()
    @State private var trail: [String] = []
    @State private var editSelection: LedgerBillEditSelection?
    private var currentID: String { trail.last ?? transactionID }

    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                if let value = resource.value {
                    HStack(spacing: 16) {
                        Button { editSelection = LedgerBillEditSelection(transaction: value, refund: false) } label: {
                            Label("编辑", systemImage: "square.and.pencil").frame(maxWidth: .infinity, minHeight: 44)
                        }.buttonStyle(.bordered)
                        if value.type == .expense && !value.isRefund {
                            Button { editSelection = LedgerBillEditSelection(transaction: value, refund: true) } label: {
                                Label("记录退款", systemImage: "arrow.uturn.backward").frame(maxWidth: .infinity, minHeight: 44)
                            }.buttonStyle(.borderedProminent)
                        }
                    }
                    LedgerBillDetailContent(transaction: value, metadata: metadata)
                    if let details = value.refundDetails, !details.isEmpty {
                        LedgerCard {
                            LedgerSectionHeading(title: "关联退款")
                            ForEach(details) { detail in
                                Button { openLinked(detail.id) } label: {
                                    HStack {
                                        Text(LedgerFormat.date(detail.date)).font(.subheadline)
                                        Spacer()
                                        Text("+" + LedgerFormat.money(detail.amountCents)).monospacedDigit().foregroundStyle(AppTheme.accent)
                                        Image(systemName: "chevron.right").font(.caption)
                                    }
                                }
                            }
                        }
                    }
                    if let originalIDs = value.refundLinkedTxIds, !originalIDs.isEmpty {
                        LedgerCard {
                            LedgerSectionHeading(title: "原始支出")
                            ForEach(Array(originalIDs.enumerated()), id: \.element) { index, id in
                                Button("查看原始账单 \(index + 1)") { openLinked(id) }.frame(minHeight: 44)
                            }
                        }
                    }
                } else if resource.loading { LedgerLoadingView() }
                if let error = resource.error {
                    LedgerErrorView(message: error, showingPrevious: resource.value != nil) { Task { await load() } }
                }
            }.padding(20)
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .navigationTitle("账单详情").navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if !trail.isEmpty {
                ToolbarItem(placement: .topBarLeading) {
                    Button { resource.clear(); trail.removeLast() } label: { Label("返回", systemImage: "chevron.left") }
                }
            }
        }
        .sheet(item: $editSelection) { selection in
            LedgerTransactionEditor(api: api, transaction: selection.refund ? nil : selection.transaction,
                                    refundOf: selection.refund ? selection.transaction : nil) {
                editSelection = nil
            }
        }
        .task(id: "\(currentID):\(api.ledgerRevision)") { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        let id = currentID
        await resource.load { try await api.request("/transactions/" + LedgerURL.segment(id)) }
    }

    private func openLinked(_ id: String) { resource.clear(); trail.append(id) }
}

private struct LedgerBillEditSelection: Identifiable {
    let transaction: LedgerTransaction
    let refund: Bool
    var id: String { transaction.id + (refund ? ":refund" : ":edit") }
}

struct LedgerBillDetailContent: View {
    let transaction: LedgerTransaction
    let metadata: LedgerMetadata
    var body: some View {
        VStack(spacing: 20) {
            LedgerCard {
                VStack(spacing: 12) {
                    LedgerSymbol(name: transaction.isRefund ? "arrow.uturn.backward" : (transaction.type == .income ? "arrow.down.left" : "arrow.up.right"))
                    Text(transaction.kindTitle).font(.subheadline).foregroundStyle(.secondary)
                    Text(transaction.sign + LedgerFormat.money(transaction.amountCents))
                        .font(.system(.largeTitle, design: .rounded).weight(.semibold)).monospacedDigit()
                        .foregroundStyle(transaction.type == .income ? AppTheme.accent : Color.primary)
                        .minimumScaleFactor(0.6).lineLimit(1)
                }.frame(maxWidth: .infinity).padding(.vertical, 14)
            }
            LedgerCard {
                LedgerFieldRow(title: "分类", value: metadata.categoryName(transaction.categoryId))
                Divider()
                LedgerFieldRow(title: "账户", value: metadata.accountName(transaction.accountId))
                Divider()
                LedgerFieldRow(title: "日期", value: LedgerFormat.date(transaction.date, time: true))
                Divider()
                LedgerFieldRow(title: "资金用途", value: transaction.fundPurpose?.title ?? "尚未归类")
                if !transaction.note.isEmpty {
                    Divider()
                    LedgerFieldRow(title: "备注", value: transaction.note)
                }
                if !transaction.tags.isEmpty {
                    Divider()
                    LedgerFieldRow(title: "标签", value: transaction.tags.joined(separator: " · "))
                }
                if let refund = transaction.refundSummary, refund.refundCount > 0 {
                    Divider()
                    LedgerFieldRow(title: "关联退款合计", value: LedgerFormat.money(refund.totalRefundCents))
                    Text("普通收支中，退款单独计入收入，原支出金额保持不变。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
        }
    }
}
