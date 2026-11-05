import SwiftUI

@MainActor final class LedgerBillsStore: ObservableObject {
    @Published private(set) var items: [LedgerTransaction] = []
    @Published private(set) var metadata = LedgerMetadata.empty
    @Published private(set) var total = 0
    @Published private(set) var loading = false
    @Published private(set) var loadingMore = false
    @Published private(set) var hasLoaded = false
    @Published private(set) var error: String?
    /// 服务端权威的按天合计；为空表示"不可用"，绝不退化成客户端累加。
    @Published private(set) var summaries: [String: LedgerDaySummary] = [:]
    @Published private(set) var summaryError: String?
    /// 当前查询是否具备请求每日合计的条件（整月且不超过 32 天）。
    @Published private(set) var summaryRequested = false
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
        summaries = [:]
        summaryError = nil
        summaryRequested = LedgerBillDates.summaryScope(query) != nil
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
        summaries = [:]
        summaryError = nil
        let scope = LedgerBillDates.summaryScope(query)
        summaryRequested = scope != nil
        defer { if generation == ticket { loading = false } }
        do {
            let searching = !query.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            let page: LedgerTransactionPage = try await api.request(query.path(limit: pageSize))
            try page.validate(expectedOffset: 0, expectedLimit: pageSize, requiresSearch: searching)
            let metadata = try await LedgerMetadata.load(api: api)
            guard generation == ticket, !Task.isCancelled else { return }
            self.metadata = metadata
            items = page.items
            total = page.total
            revision = page.searchRevision
            hasLoaded = true
            guard let scope else { return }
            await loadSummaries(api: api, query: query, scope: scope, searching: searching,
                                expectedRevision: page.searchRevision, ticket: ticket)
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
            recheckSummaryCounts()
        } catch {
            guard generation == ticket, !Task.isCancelled else { return }
            self.error = error.localizedDescription
        }
    }

    /// 每日合计只来自服务端；任何解码/校验失败都清空展示并给出原因。
    private func loadSummaries(api: APIClient, query: LedgerBillQuery,
                               scope: (from: Int64, to: Int64), searching: Bool,
                               expectedRevision: String?, ticket: Int) async {
        do {
            let page: LedgerDaySummaryPage = try await api.request(LedgerDaySummaryRequest.path(for: query, scope: scope))
            let decoded = try page.validate(searching: searching, expectedSearchRevision: expectedRevision, scope: scope)
            try LedgerDaySummaryPage.validateCounts(rows: items, total: total, summaries: decoded)
            guard generation == ticket, !Task.isCancelled else { return }
            summaries = decoded
            summaryError = nil
        } catch is CancellationError {
            return
        } catch {
            guard generation == ticket, !Task.isCancelled else { return }
            summaries = [:]
            summaryError = error.localizedDescription
        }
    }

    /// 分页补齐后重新核对"每日笔数"与服务端一致；完全加载时才要求逐日相等。
    private func recheckSummaryCounts() {
        guard !summaries.isEmpty else { return }
        do {
            try LedgerDaySummaryPage.validateCounts(rows: items, total: total, summaries: summaries)
        } catch {
            summaries = [:]
            summaryError = error.localizedDescription
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

    /// 默认进入「本月」；显式传入查询（账户/分类/标签入口）保留其自己的日期范围。
    init(api: APIClient, initialQuery: LedgerBillQuery = LedgerBillDates.monthQuery(containing: Date())) {
        self.api = api
        _query = State(initialValue: initialQuery)
    }

    private var grouped: [(String, [LedgerTransaction])] {
        let groups = Dictionary(grouping: store.items) { LedgerFormat.dayKey($0.date) }
        return groups.keys.sorted(by: >).map { ($0, groups[$0] ?? []) }
    }

    var body: some View {
        ZStack {
            list
            if let selection = selectedBill {
                LedgerBillDetailOverlay(api: api, transactionID: selection.id, metadata: store.metadata,
                                        onDismiss: dismissBill)
                    .ignoresSafeArea()
                    .zIndex(1)
                    .transition(.opacity)
            }
        }
        .navigationTitle("账单")
        .searchable(text: $query.text, prompt: "搜索备注、分类或标签")
        .safeAreaInset(edge: .top, spacing: 0) { filterControls }
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

    private var list: some View {
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
                Section {
                    LedgerDaySummaryHeader(day: day, summary: store.summaries[day],
                                           summaryAvailable: store.summaryRequested)
                        .listRowInsets(EdgeInsets(top: 8, leading: 20, bottom: 2, trailing: 20))
                        .listRowBackground(Color.clear)
                    ForEach(transactions) { transaction in
                        Button { selectBill(transaction.id) } label: {
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
        .listStyle(.insetGrouped)
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
            dailySummaryStatus
        }.padding(.horizontal, 20).padding(.vertical, 10).background(.bar)
    }

    /// 每日合计的可用性说明：范围不满足整月/32 天时明确提示，读取失败时给出原因。
    @ViewBuilder private var dailySummaryStatus: some View {
        if !store.summaryRequested {
            Text(LedgerBillDates.dailySummaryHint)
                .font(.caption).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityLabel("每日合计不可用：" + LedgerBillDates.dailySummaryHint)
        } else if let error = store.summaryError {
            Text("每日合计暂不可用：" + error)
                .font(.caption).foregroundStyle(.red)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityLabel("每日合计暂不可用")
        }
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

    private func selectBill(_ id: String) {
        withAnimation(.spring(response: 0.32, dampingFraction: 0.86)) {
            selectedBill = LedgerBillSelection(id: id)
        }
    }

    private func dismissBill() {
        withAnimation(.easeOut(duration: 0.2)) { selectedBill = nil }
    }
}

private struct LedgerBillsReadKey: Hashable { let query: LedgerBillQuery; let revision: Int }
struct LedgerBillSelection: Identifiable { let id: String }

/// 按天分组的分区头：日期 + 服务端权威的「支出 / 收入 / 笔数」。
///
/// `summary` 为空时：当前筛选无法被服务端汇总（全部日期 / 自定义区间 / 超过 32 天）就只显示
/// 日期，由顶部提示说明原因；可以汇总但还没读到时显示占位符。任何情况下都不做本地行求和。
struct LedgerDaySummaryHeader: View {
    let day: String
    let summary: LedgerDaySummary?
    /// 当前查询是否具备请求每日合计的条件。为 `false` 时连占位符也不显示。
    var summaryAvailable = true

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(LedgerFormat.date(dayStart, time: false))
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
            if summaryAvailable {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 10) { metrics }
                    VStack(alignment: .leading, spacing: 2) { metrics }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityText)
    }

    @ViewBuilder private var metrics: some View {
        Text("支出 " + (summary.map { LedgerFormat.money($0.expenseCents) } ?? "—"))
            .foregroundStyle(Color(red: 0.87, green: 0.29, blue: 0.22))
        Text("收入 " + (summary.map { LedgerFormat.money($0.incomeCents) } ?? "—"))
            .foregroundStyle(AppTheme.accent)
        Text((summary.map { "\($0.count)" } ?? "—") + " 笔")
            .foregroundStyle(.secondary)
    }

    private var dayStart: Int64 {
        LedgerDaySummaryPage.dayStart(day).map { $0 + 12 * 3_600_000 } ?? 0
    }

    private var accessibilityText: String {
        guard summaryAvailable else { return LedgerFormat.date(dayStart) }
        guard let summary else { return LedgerFormat.date(dayStart) + "，每日合计暂不可用" }
        return LedgerFormat.date(dayStart) + "，支出 " + LedgerFormat.money(summary.expenseCents)
            + "，收入 " + LedgerFormat.money(summary.incomeCents) + "，共 \(summary.count) 笔"
    }
}

/// 系统 sheet 内的账单详情（物品详情等既有入口复用同一张卡片）。
@MainActor struct LedgerBillDetailSheet: View {
    let api: APIClient
    let transactionID: String
    let metadata: LedgerMetadata
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        LedgerBillDetailCard(api: api, transactionID: transactionID, metadata: metadata,
                             onClose: { dismiss() })
            .padding(24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Color.black.opacity(0.28).ignoresSafeArea())
            .presentationDetents([.large])
            .presentationDragIndicator(.visible)
    }
}

/// 编辑表单冲突核对与其它只读场景复用的账单摘要（保持既有排版）。
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
