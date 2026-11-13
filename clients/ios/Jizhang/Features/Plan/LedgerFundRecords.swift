import SwiftUI

/// Evidence behind one purpose's cumulative balance: the recorded income allocations that funded
/// it and the live bills classified into it. Totals stay the summary's; this list never sums rows
/// into a balance of its own.
@MainActor final class LedgerFundRecordsStore: ObservableObject {
    let purpose: LedgerPurpose
    @Published private(set) var allocations: [PlanSalary] = []
    @Published private(set) var bills: [LedgerTransaction] = []
    @Published private(set) var metadata = LedgerMetadata.empty
    /// Frozen share of each allocation for this purpose, read from `/salaries/:id`.
    @Published private(set) var shares: [String: Int64] = [:]
    @Published private(set) var sharesBps: [String: Int64] = [:]
    @Published private(set) var readingShares: Set<String> = []
    @Published private(set) var loading = false
    @Published private(set) var loadingMore = false
    @Published private(set) var hasLoaded = false
    @Published private(set) var error: String?
    @Published private(set) var scanned = 0
    private let pageSize = 100
    private var offset = 0
    private var total = 0
    private var generation = 0

    var hasMore: Bool { offset < total }

    init(purpose: LedgerPurpose) { self.purpose = purpose }

    func load(api: APIClient) async {
        generation += 1
        let ticket = generation
        loading = true
        error = nil
        offset = 0
        total = 0
        scanned = 0
        defer { if generation == ticket { loading = false } }
        do {
            metadata = try await LedgerMetadata.load(api: api)
            async let salaryPage: LedgerPage<PlanSalary> = api.request("/salaries")
            async let firstPage: LedgerTransactionPage = api.request(LedgerBillQuery().path(offset: 0, limit: pageSize))
            let (salaries, page) = try await (salaryPage, firstPage)
            try page.validate(expectedOffset: 0, expectedLimit: pageSize)
            guard generation == ticket, !Task.isCancelled else { return }
            allocations = salaries.items
            total = page.total
            offset += page.items.count
            scanned += page.items.count
            bills = page.items.filter { $0.fundPurpose == purpose }
            // One unrepresentative page must not read as "nothing was ever classified here".
            while bills.isEmpty && offset < total {
                let expected = offset
                let next: LedgerTransactionPage = try await api.request(LedgerBillQuery().path(offset: expected, limit: pageSize))
                try next.validate(expectedOffset: expected, expectedLimit: pageSize)
                guard generation == ticket, !Task.isCancelled else { return }
                guard next.total == total, !next.items.isEmpty else { throw LedgerDataError.changedPage }
                offset += next.items.count
                scanned += next.items.count
                bills = next.items.filter { $0.fundPurpose == purpose }
            }
            hasLoaded = true
        } catch is CancellationError {
        } catch {
            guard generation == ticket else { return }
            self.error = error.localizedDescription
        }
    }

    func loadMore(api: APIClient) async {
        guard hasMore, !loading, !loadingMore else { return }
        let ticket = generation
        loadingMore = true
        error = nil
        defer { if generation == ticket { loadingMore = false } }
        do {
            var found: [LedgerTransaction] = []
            while found.isEmpty && offset < total {
                let expected = offset
                let page: LedgerTransactionPage = try await api.request(LedgerBillQuery().path(offset: expected, limit: pageSize))
                try page.validate(expectedOffset: expected, expectedLimit: pageSize)
                guard generation == ticket, !Task.isCancelled else { return }
                guard page.total == total, !page.items.isEmpty else { throw LedgerDataError.changedPage }
                offset += page.items.count
                scanned += page.items.count
                let known = Set(bills.map(\.id))
                found = page.items.filter { $0.fundPurpose == purpose && !known.contains($0.id) }
            }
            guard generation == ticket else { return }
            bills.append(contentsOf: found)
        } catch is CancellationError {
        } catch {
            guard generation == ticket else { return }
            self.error = error.localizedDescription
        }
    }

    /// `/salaries` omits the frozen grant, so the exact share is read per visible row.
    func loadShare(for salary: PlanSalary, api: APIClient) async {
        guard shares[salary.id] == nil, !readingShares.contains(salary.id) else { return }
        readingShares.insert(salary.id)
        defer { readingShares.remove(salary.id) }
        do {
            let detail: PlanSalary = try await api.request("/salaries/" + LedgerURL.segment(salary.id))
            guard detail.id == salary.id, let grant = detail.fundGrant else { throw LedgerDataError.invalidResponse }
            shares[salary.id] = grant.targets[purpose]
            sharesBps[salary.id] = grant.ratiosBps[purpose]
        } catch is CancellationError {
        } catch {
            // The total above already comes from the summary; a failed row stays unread.
        }
    }

    func shareText(_ salary: PlanSalary) -> String {
        guard let share = shares[salary.id] else { return "读取中…" }
        return "+" + LedgerFormat.money(share)
    }

    func shareCaption(_ salary: PlanSalary) -> String {
        guard let bps = sharesBps[salary.id] else { return " · 正在读取当时的比例" }
        return " · 本类 " + LedgerFormat.ratio(bps: bps)
    }
}

@MainActor struct LedgerFundDetailView: View {
    let api: APIClient
    let purpose: LedgerPurpose
    let summary: LedgerFundSummary
    @StateObject private var records: LedgerFundRecordsStore

    init(api: APIClient, purpose: LedgerPurpose, summary: LedgerFundSummary) {
        self.api = api
        self.purpose = purpose
        self.summary = summary
        _records = StateObject(wrappedValue: LedgerFundRecordsStore(purpose: purpose))
    }

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 12) {
                    Label(purpose.title, systemImage: purpose.symbol).font(.headline).foregroundStyle(AppTheme.accent)
                    Text(LedgerFormat.money(summary.balances[purpose]))
                        .font(.system(.largeTitle, design: .rounded).weight(.semibold)).monospacedDigit()
                    Text(summary.coverage.complete ? "当前累计余额" : "已确认部分的暂计余额，仍有数据待核对")
                        .font(.footnote).foregroundStyle(.secondary)
                }.padding(.vertical, 12)
            }
            Section("累计构成") {
                LedgerFieldRow(title: "工资分配", value: LedgerFormat.money(summary.totals.funded[purpose]))
                LedgerFieldRow(title: "其他已归类收入", value: LedgerFormat.money(summary.totals.income[purpose]))
                LedgerFieldRow(title: "原始支出", value: LedgerFormat.money(summary.totals.grossSpent[purpose]))
                LedgerFieldRow(title: "已确认归属退款", value: LedgerFormat.money(summary.totals.refunded[purpose]))
            }
            if records.loading && !records.hasLoaded { LedgerLoadingView(title: "正在读取这一类的记录…") }
            if let error = records.error {
                LedgerErrorView(message: error, showingPrevious: !records.allocations.isEmpty || !records.bills.isEmpty) {
                    Task { await records.load(api: api) }
                }
            }
            Section {
                if records.allocations.isEmpty && records.hasLoaded && records.error == nil {
                    Text("还没有收入分配记录。计划页「新增收入分配」会按当前比例分配到这一类。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                ForEach(records.allocations) { salary in
                    HStack(alignment: .firstTextBaseline) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(salary.note.isEmpty ? "收入分配" : salary.note).lineLimit(2)
                            Text(LedgerFormat.date(salary.date) + records.shareCaption(salary))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 8)
                        Text(records.shareText(salary)).monospacedDigit()
                    }
                    .task { await records.loadShare(for: salary, api: api) }
                }
            } header: {
                Text("本类收到的收入分配 · \(records.allocations.count)")
            } footer: {
                Text(records.allocations.count >= 200
                     ? "列表最多显示最近 200 笔收入分配。金额是那一笔收入按确认当时比例分到本类的部分。"
                     : "金额是那一笔收入按确认当时比例分到本类的部分。完整的四用途拆分可在「计划 → 收入分配记录」里查看。")
            }
            Section {
                if records.bills.isEmpty && records.hasLoaded && records.error == nil && !records.hasMore {
                    Text("还没有归到这一类的账单。记账时选「\(purpose.title)」作为资金用途就会出现在这里。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                ForEach(records.bills) { bill in
                    LedgerTransactionRow(transaction: bill, metadata: records.metadata)
                }
                if records.hasMore {
                    Button { Task { await records.loadMore(api: api) } } label: {
                        HStack {
                            Spacer()
                            if records.loadingMore { ProgressView() } else { Text("继续查找这一类账单") }
                            Spacer()
                        }
                    }.disabled(records.loading || records.loadingMore)
                }
            } header: {
                Text("本类已归类账单 · \(records.bills.count)")
            } footer: {
                Text("只显示资金用途选了「\(purpose.title)」的账单；退款按原支出的用途回补，不单独列在这里。已检查 \(records.scanned) 笔账单。")
            }
            Section {
                Text("资金余额按累计记录持续结转。账户之间的转账不计为收入或支出，退款按确认归属计入对应用途。")
                    .font(.footnote).foregroundStyle(.secondary)
                Text("数据时间：" + LedgerFormat.date(summary.asOf, time: true))
                    .font(.caption).foregroundStyle(.secondary)
            }
        }.navigationTitle(purpose.title).navigationBarTitleDisplayMode(.inline)
            .refreshable { await records.load(api: api) }
            .task { if !records.hasLoaded { await records.load(api: api) } }
    }
}
