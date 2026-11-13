import SwiftUI

/// One fund-purpose write for one bill. The exact body is kept so an unknown outcome can be
/// retried as the same operation instead of writing a second purpose revision.
struct LedgerPurposeAssignment: Equatable {
    let transactionId: String
    let purpose: LedgerPurpose
    let operationId: String
    let body: JSONValue

    init(transactionId: String, purpose: LedgerPurpose, facts: LedgerBillPurposeSnapshot.Facts,
         operationId: String = UUID().uuidString.lowercased()) {
        self.transactionId = transactionId
        self.purpose = purpose
        self.operationId = operationId
        self.body = .object([
            "operationId": .string(operationId),
            "fundPurpose": .string(purpose.rawValue),
            "expectedFundPurposeRevision": .integer(facts.fundPurposeRevision),
            "expectedTransactionToken": .string(facts.transactionToken)
        ])
    }

    /// A 4xx other than a timeout is a rejection: nothing was written. Everything else leaves
    /// the outcome unknown, so the frozen body must be replayed rather than rebuilt.
    static func isAmbiguous(_ error: Error) -> Bool {
        guard let failure = error as? APIError else { return true }
        return !(400..<500).contains(failure.status) || failure.status == 408
    }
}

/// Bills the four-purpose summary cannot split because their 资金用途 is still empty.
/// The endpoint has no purpose filter, so matching rows are selected from authoritative pages.
@MainActor final class LedgerUnclassifiedBillsStore: ObservableObject {
    @Published private(set) var items: [LedgerTransaction] = []
    @Published private(set) var metadata = LedgerMetadata.empty
    @Published private(set) var loading = false
    @Published private(set) var loadingMore = false
    @Published private(set) var hasLoaded = false
    @Published private(set) var error: String?
    @Published private(set) var assigning: String?
    @Published private(set) var rowErrors: [String: String] = [:]
    @Published private(set) var needsRetry: Set<String> = []
    /// Bills looked at, so an empty page cannot be mistaken for "everything is classified".
    @Published private(set) var scanned = 0
    private let pageSize = 100
    private var offset = 0
    private var total = 0
    private var pending: [String: LedgerPurposeAssignment] = [:]
    private var generation = 0

    var hasMore: Bool { offset < total }

    func reload(api: APIClient) async {
        generation += 1
        let ticket = generation
        loading = true
        error = nil
        rowErrors = [:]
        offset = 0
        total = 0
        scanned = 0
        defer { if generation == ticket { loading = false } }
        do {
            metadata = try await LedgerMetadata.load(api: api)
            var found: [LedgerTransaction] = []
            // Keep paging while the sampled range holds nothing to classify, so the screen does
            // not claim completion after one unrepresentative page.
            while found.isEmpty {
                let expected = offset
                let page: LedgerTransactionPage = try await api.request(LedgerBillQuery().path(offset: expected, limit: pageSize))
                try page.validate(expectedOffset: expected, expectedLimit: pageSize)
                guard generation == ticket, !Task.isCancelled else { return }
                total = page.total
                offset += page.items.count
                scanned += page.items.count
                found = page.items.filter(\.isUnclassifiedForFunds)
                if page.items.isEmpty || offset >= total { break }
            }
            guard generation == ticket else { return }
            items = found
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
                let known = Set(items.map(\.id))
                found = page.items.filter { $0.isUnclassifiedForFunds && !known.contains($0.id) }
            }
            guard generation == ticket else { return }
            items.append(contentsOf: found)
        } catch is CancellationError {
        } catch {
            guard generation == ticket else { return }
            self.error = error.localizedDescription
        }
    }

    func assign(_ purpose: LedgerPurpose, to bill: LedgerTransaction, api: APIClient) async {
        guard assigning == nil else { return }
        if let retained = pending[bill.id] { await submit(retained, for: bill, api: api); return }
        assigning = bill.id
        rowErrors[bill.id] = nil
        do {
            let snapshot: LedgerBillPurposeSnapshot = try await api.request(
                "/financial-planning/bill-purposes/" + LedgerURL.segment(bill.id))
            guard snapshot.billPurpose.transactionId == bill.id else { throw LedgerDataError.invalidResponse }
            let assignment = LedgerPurposeAssignment(transactionId: bill.id, purpose: purpose, facts: snapshot.billPurpose)
            assigning = nil
            await submit(assignment, for: bill, api: api)
        } catch is CancellationError {
            assigning = nil
        } catch {
            assigning = nil
            rowErrors[bill.id] = error.localizedDescription
        }
    }

    /// Replays a frozen assignment after an unknown outcome; the operation id makes it idempotent.
    func retry(_ bill: LedgerTransaction, api: APIClient) async {
        guard assigning == nil, let retained = pending[bill.id] else { return }
        await submit(retained, for: bill, api: api)
    }

    /// Drops a row once another surface finished converting or classifying it.
    func forget(_ id: String) { items.removeAll { $0.id == id } }

    private func submit(_ assignment: LedgerPurposeAssignment, for bill: LedgerTransaction, api: APIClient) async {
        assigning = bill.id
        rowErrors[bill.id] = nil
        defer { assigning = nil }
        do {
            let saved: LedgerTransaction = try await api.request("/transactions/" + LedgerURL.segment(bill.id),
                                                                 method: "PATCH", body: assignment.body)
            guard saved.id == bill.id, saved.fundPurpose == assignment.purpose else {
                throw LedgerDataError.invalidResponse
            }
            pending[bill.id] = nil
            needsRetry.remove(bill.id)
            items.removeAll { $0.id == bill.id }
            api.notifyLedgerChanged()
        } catch is CancellationError {
        } catch {
            if LedgerPurposeAssignment.isAmbiguous(error) {
                pending[bill.id] = assignment
                needsRetry.insert(bill.id)
                rowErrors[bill.id] = "提交结果尚未确认。请点「重试」用同一请求核实，或下拉刷新列表再判断。"
            } else {
                pending[bill.id] = nil
                needsRetry.remove(bill.id)
                rowErrors[bill.id] = error.localizedDescription
            }
        }
    }
}

extension LedgerTransaction {
    /// Mirrors the summary's rule: live rows only, and a refund is income that carries no purpose.
    var isUnclassifiedForFunds: Bool { !isRefund && fundPurpose == nil }
}

@MainActor struct LedgerUnclassifiedBillsView: View {
    let api: APIClient
    @StateObject private var store = LedgerUnclassifiedBillsStore()
    @StateObject private var converter = LedgerIncomeConverter()
    @State private var confirmConvert: LedgerTransaction?

    var body: some View {
        List {
            Section {
                Text("这些账单还没有选择「资金用途」，四用途余额只能按已归类的部分统计。给每笔选一个用途后，它会立即计入对应用途。")
                    .font(.footnote).foregroundStyle(.secondary)
                Text("收入行分两种：「这是工资」才转成收入分配，按当前比例拆到四用途；其他收入直接选一个计入的用途，和支出一样只进一类。退款不在这里，它按原支出的用途回补。")
                    .font(.caption).foregroundStyle(.secondary)
                if store.scanned > 0 {
                    Text("已检查 \(store.scanned) 笔账单，找到 \(store.items.count) 笔未归类。")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            if store.loading && !store.hasLoaded { LedgerLoadingView(title: "正在读取未归类账单…") }
            if let error = store.error {
                LedgerErrorView(message: error, showingPrevious: !store.items.isEmpty) {
                    Task { await store.reload(api: api) }
                }
            }
            if store.hasLoaded && store.items.isEmpty && store.error == nil && !store.hasMore {
                LedgerEmptyView(title: "没有未归类账单",
                                message: "所有账单都已选好资金用途，四用途余额可以按已归类部分统计。",
                                symbol: "checkmark.seal")
            }
            ForEach(store.items) { bill in
                VStack(alignment: .leading, spacing: 10) {
                    LedgerTransactionRow(transaction: bill, metadata: store.metadata)
                    if bill.type == .income {
                        incomeAction(bill)
                    } else if store.needsRetry.contains(bill.id) {
                        Button { Task { await store.retry(bill, api: api) } } label: {
                            Label("重试上次提交", systemImage: "arrow.clockwise").font(.footnote)
                        }.disabled(store.assigning != nil)
                    } else {
                        LedgerPurposeChoices(busy: store.assigning != nil) { purpose in
                            Task { await store.assign(purpose, to: bill, api: api) }
                        }
                    }
                    if store.assigning == bill.id || converter.busyId == bill.id {
                        HStack(spacing: 6) {
                            ProgressView()
                            Text("正在保存…").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    if let message = store.rowErrors[bill.id] ?? converter.errors[bill.id] {
                        Text(message).font(.caption).foregroundStyle(.orange)
                    }
                }.padding(.vertical, 4)
            }
            if store.hasMore {
                Button { Task { await store.loadMore(api: api) } } label: {
                    HStack {
                        Spacer()
                        if store.loadingMore { ProgressView() } else { Text("继续查找未归类账单") }
                        Spacer()
                    }
                }.disabled(store.loading || store.loadingMore)
            }
        }
        .navigationTitle("未归类账单")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("这笔收入是工资吗？",
                            isPresented: Binding(get: { confirmConvert != nil },
                                                 set: { if !$0 { confirmConvert = nil } }),
                            titleVisibility: .visible, presenting: confirmConvert) { bill in
            Button("是工资，按比例分配") { Task { await convert(bill) } }
            Button("取消", role: .cancel) {}
        } message: { _ in
            Text("转换会把它记成一条工资收入分配（按当前比例拆分，出现在「工资记录」），并删除原收入账单，避免同一笔钱算两次。不是工资请直接选上面的用途。")
        }
        .refreshable { await store.reload(api: api) }
        .task { if !store.hasLoaded { await store.reload(api: api) } }
    }

    /// Income is only salary when it is recorded as a salary. Other income is a bill and reaches
    /// exactly one purpose, exactly like an expense; refunds are never listed here.
    @ViewBuilder private func incomeAction(_ bill: LedgerTransaction) -> some View {
        if converter.needsRetry.contains(bill.id) {
            Button { Task { await convert(bill) } } label: {
                Label("重试上次转换", systemImage: "arrow.clockwise").font(.footnote)
            }.disabled(converter.busyId != nil)
        } else if store.needsRetry.contains(bill.id) {
            Button { Task { await store.retry(bill, api: api) } } label: {
                Label("重试上次提交", systemImage: "arrow.clockwise").font(.footnote)
            }.disabled(store.assigning != nil)
        } else {
            VStack(alignment: .leading, spacing: 8) {
                Text("其他收入：选择计入的用途")
                    .font(.caption).foregroundStyle(.secondary)
                LedgerPurposeChoices(busy: store.assigning != nil) { purpose in
                    Task { await store.assign(purpose, to: bill, api: api) }
                }
                Button { confirmConvert = bill } label: {
                    Label(converter.busyId == bill.id ? "正在转换…" : "这是工资，转为收入分配",
                          systemImage: "banknote")
                        .font(.footnote)
                }
                .buttonStyle(.bordered)
                .disabled(converter.busyId != nil)
                .accessibilityHint("仅当这笔收入是工资时使用；转换后按当前比例分到四用途，并删除原账单")
            }
        }
    }

    private func convert(_ bill: LedgerTransaction) async {
        if await converter.convert(bill, api: api) { store.forget(bill.id) }
    }
}

@MainActor private struct LedgerPurposeChoices: View {
    let busy: Bool
    let choose: (LedgerPurpose) -> Void
    private var columns: [GridItem] {
        [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)]
    }

    var body: some View {
        LazyVGrid(columns: columns, spacing: 8) {
            ForEach(LedgerPurpose.allCases) { purpose in
                Button { choose(purpose) } label: {
                    Label(purpose.title, systemImage: purpose.symbol)
                        .font(.caption)
                        .frame(maxWidth: .infinity, minHeight: 32)
                }
                .buttonStyle(.bordered)
                .disabled(busy)
                .accessibilityLabel("归入" + purpose.title)
            }
        }
    }
}
