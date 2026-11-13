import SwiftUI

/// A confirmed ratio split for one income transaction. It funds the four purposes exactly like a
/// salary grant but is **not** a salary record: `/salaries` never returns it and 工资记录 stays
/// wage-only. The amount, date, account and note stay on the bill itself.
struct LedgerIncomeAllocation: Decodable {
    let transactionId: String
    let revision: Int
    let amountCents: Int64
    let ratiosBps: LedgerPurposeAmounts
    let targets: LedgerPurposeAmounts
    let createdAt: Int64

    func validate() throws {
        guard !transactionId.isEmpty, revision > 0, amountCents > 0,
              amountCents <= 9_007_199_254_740_991, createdAt >= 0 else { throw LedgerDataError.invalidResponse }
        try ratiosBps.validateRatios()
        try targets.validate(nonnegative: true)
        guard LedgerPurpose.allCases.reduce(Int64(0), { $0 + targets[$1] }) == amountCents else {
            throw LedgerDataError.invalidResponse
        }
    }
}

struct LedgerIncomeAllocationResponse: Decodable {
    let contractVersion: Int
    let allocation: LedgerIncomeAllocation
}

/// One allocation request, frozen so an unknown outcome replays the same operation instead of
/// splitting the same income twice.
struct LedgerIncomeAllocationRequest: Equatable {
    let transactionId: String
    let operationId: String
    let body: JSONValue

    init(transactionId: String, facts: LedgerBillPurposeSnapshot.Facts, configRevision: Int,
         operationId: String = UUID().uuidString.lowercased()) {
        self.transactionId = transactionId
        self.operationId = operationId
        self.body = .object([
            "operationId": .string(operationId),
            "transactionId": .string(transactionId),
            "expectedTransactionToken": .string(facts.transactionToken),
            "expectedFundConfigRevision": .integer(Int64(configRevision))
        ])
    }

    /// A 4xx other than a timeout is a rejection: nothing was written. Everything else leaves the
    /// outcome unknown, so the frozen body must be replayed rather than rebuilt.
    static func isAmbiguous(_ error: Error) -> Bool {
        guard let failure = error as? APIError else { return true }
        return !(400..<500).contains(failure.status) || failure.status == 408
    }
}

/// Shared state machine for "split this income by the current ratios". Used by the unclassified
/// list, the refund list and the bill card, so a half-finished confirmation is resumable anywhere.
@MainActor final class LedgerIncomeAllocationStore: ObservableObject {
    @Published private(set) var busyId: String?
    @Published private(set) var errors: [String: String] = [:]
    @Published private(set) var needsRetry: Set<String> = []
    private var pending: [String: LedgerIncomeAllocationRequest] = [:]

    /// Reads the current ratio revision and the bill's source token, then writes the split.
    func allocate(_ bill: LedgerTransaction, api: APIClient) async -> Bool {
        guard busyId == nil else { return false }
        if let retained = pending[bill.id] { return await submit(retained, api: api) }
        busyId = bill.id
        errors[bill.id] = nil
        do {
            async let snapshot: LedgerBillPurposeSnapshot = api.request(
                "/financial-planning/bill-purposes/" + LedgerURL.segment(bill.id))
            async let configuration: LedgerFundConfiguration = api.request("/financial-funds/config")
            let (facts, config) = try await (snapshot, configuration)
            try config.validate()
            guard facts.billPurpose.transactionId == bill.id else { throw LedgerDataError.invalidResponse }
            let request = LedgerIncomeAllocationRequest(transactionId: bill.id, facts: facts.billPurpose,
                                                        configRevision: config.config.revision)
            pending[bill.id] = request
            busyId = nil
            return await submit(request, api: api)
        } catch is CancellationError {
            busyId = nil
            return false
        } catch {
            busyId = nil
            errors[bill.id] = error.localizedDescription
            return false
        }
    }

    /// Replays a frozen request after an unknown outcome; the operation id makes it idempotent.
    func retry(_ bill: LedgerTransaction, api: APIClient) async -> Bool {
        guard busyId == nil, let retained = pending[bill.id] else { return false }
        return await submit(retained, api: api)
    }

    private func submit(_ request: LedgerIncomeAllocationRequest, api: APIClient) async -> Bool {
        busyId = request.transactionId
        errors[request.transactionId] = nil
        defer { busyId = nil }
        do {
            let response: LedgerIncomeAllocationResponse = try await api.request(
                "/financial-funds/income-allocations", method: "POST", body: request.body)
            guard response.contractVersion == 1, response.allocation.transactionId == request.transactionId else {
                throw LedgerDataError.invalidResponse
            }
            try response.allocation.validate()
            pending[request.transactionId] = nil
            needsRetry.remove(request.transactionId)
            api.notifyLedgerChanged()
            return true
        } catch is CancellationError {
            return false
        } catch {
            if LedgerIncomeAllocationRequest.isAmbiguous(error) {
                pending[request.transactionId] = request
                needsRetry.insert(request.transactionId)
                errors[request.transactionId] = "提交结果尚未确认。请点「重试」用同一请求核实，不会重复分配。"
            } else {
                pending[request.transactionId] = nil
                needsRetry.remove(request.transactionId)
                errors[request.transactionId] = error.localizedDescription
            }
            return false
        }
    }
}

/// The button (plus retry state) for splitting one income across the four purposes.
@MainActor struct LedgerAllocationAction: View {
    let api: APIClient
    let bill: LedgerTransaction
    @ObservedObject var store: LedgerIncomeAllocationStore
    var onAllocated: (() -> Void)? = nil
    var compact = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if store.needsRetry.contains(bill.id) {
                Button { Task { await run() } } label: {
                    Label("重试上次分配", systemImage: "arrow.clockwise").font(.footnote)
                }
                .buttonStyle(.bordered)
                .disabled(store.busyId != nil)
            } else {
                Button { Task { await run() } } label: {
                    Label(store.busyId == bill.id ? "正在分配…" : "按当前比例拆四份",
                          systemImage: "chart.pie")
                        .font(compact ? .footnote : .subheadline.weight(.medium))
                        .frame(maxWidth: compact ? nil : .infinity, minHeight: compact ? nil : 36)
                }
                .buttonStyle(.borderedProminent)
                .disabled(store.busyId != nil)
                .accessibilityIdentifier("income-allocate")
                .accessibilityHint("按当前四用途比例把这一笔收入拆成四份；不会记成工资")
            }
            if let message = store.errors[bill.id] {
                Text(message).font(.caption).foregroundStyle(.orange)
            }
        }
    }

    private func run() async {
        let done: Bool
        if store.needsRetry.contains(bill.id) {
            done = await store.retry(bill, api: api)
        } else {
            done = await store.allocate(bill, api: api)
        }
        if done { onAllocated?() }
    }
}

/// Refunds the fund summary still counts as uncredited because no ratio split was confirmed.
@MainActor final class LedgerUnallocatedRefundStore: ObservableObject {
    @Published private(set) var items: [LedgerTransaction] = []
    @Published private(set) var metadata = LedgerMetadata.empty
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

    func reload(api: APIClient) async {
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
            var found: [LedgerTransaction] = []
            while found.isEmpty {
                let expected = offset
                let page: LedgerTransactionPage = try await api.request(Self.query.path(offset: expected, limit: pageSize))
                try page.validate(expectedOffset: expected, expectedLimit: pageSize)
                guard generation == ticket, !Task.isCancelled else { return }
                total = page.total
                offset += page.items.count
                scanned += page.items.count
                found = page.items.filter(Self.needsAllocation)
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
                let page: LedgerTransactionPage = try await api.request(Self.query.path(offset: expected, limit: pageSize))
                try page.validate(expectedOffset: expected, expectedLimit: pageSize)
                guard generation == ticket, !Task.isCancelled else { return }
                guard page.total == total, !page.items.isEmpty else { throw LedgerDataError.changedPage }
                offset += page.items.count
                scanned += page.items.count
                let known = Set(items.map(\.id))
                found = page.items.filter { Self.needsAllocation($0) && !known.contains($0.id) }
            }
            guard generation == ticket else { return }
            items.append(contentsOf: found)
        } catch is CancellationError {
        } catch {
            guard generation == ticket else { return }
            self.error = error.localizedDescription
        }
    }

    /// A refund has no single purpose by design; it needs a confirmed ratio split to be credited.
    nonisolated static func needsAllocation(_ bill: LedgerTransaction) -> Bool {
        bill.isRefund && bill.fundIncomeAllocated != true
    }

    private static var query: LedgerBillQuery {
        var query = LedgerBillQuery()
        query.type = LedgerBillKind.income.rawValue
        return query
    }
}

@MainActor struct LedgerUnallocatedRefundView: View {
    let api: APIClient
    @StateObject private var store = LedgerUnallocatedRefundStore()
    @StateObject private var allocation = LedgerIncomeAllocationStore()

    var body: some View {
        List {
            Section {
                Text("退款不占用单一用途：确认后按当前比例拆进四用途。未确认的退款会在计划页显示为「退款待核对」，且不计入余额。")
                    .font(.footnote).foregroundStyle(.secondary)
                if store.scanned > 0 {
                    Text("已检查 \(store.scanned) 笔收入，找到 \(store.items.count) 笔待分配退款。")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            if store.loading && !store.hasLoaded { LedgerLoadingView(title: "正在读取退款…") }
            if let error = store.error {
                LedgerErrorView(message: error, showingPrevious: !store.items.isEmpty) {
                    Task { await store.reload(api: api) }
                }
            }
            if store.hasLoaded && store.items.isEmpty && store.error == nil && !store.hasMore {
                LedgerEmptyView(title: "没有待分配的退款",
                                message: "所有退款都已按比例分配。",
                                symbol: "checkmark.seal")
            }
            ForEach(store.items) { bill in
                VStack(alignment: .leading, spacing: 8) {
                    LedgerTransactionRow(transaction: bill, metadata: store.metadata)
                    LedgerAllocationAction(api: api, bill: bill, store: allocation) {
                        store.remove(bill.id)
                    }
                }.padding(.vertical, 4)
            }
            if store.hasMore {
                Button { Task { await store.loadMore(api: api) } } label: {
                    HStack {
                        Spacer()
                        if store.loadingMore { ProgressView() } else { Text("继续查找待分配退款") }
                        Spacer()
                    }
                }.disabled(store.loading || store.loadingMore)
            }
        }
        .navigationTitle("退款分配")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await store.reload(api: api) }
        .task { if !store.hasLoaded { await store.reload(api: api) } }
    }
}

extension LedgerUnallocatedRefundStore {
    func remove(_ id: String) { items.removeAll { $0.id == id } }
}
