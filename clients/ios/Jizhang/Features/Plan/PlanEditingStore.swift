import Foundation
import Combine

/// Owned by the retained Plan tab. Dismissing/reopening an editor retains an unresolved request.
@MainActor final class PlanMutation: ObservableObject {
    @Published private(set) var pending: PlanWriteRequest?
    @Published private(set) var busy = false
    @Published private(set) var error: String?
    @Published private(set) var conflict = false
    @Published private(set) var result: JSONValue?
    private var owner: UUID?

    var locked: Bool { pending != nil || busy }

    func submit(_ request: PlanWriteRequest, api: APIClient) async -> Bool {
        guard !busy, owner == nil || owner == api.identity else { return false }
        if let pending, pending != request { return false }
        let recovering = pending != nil
        owner = api.identity
        pending = request
        busy = true
        error = nil
        conflict = false
        defer { busy = false }
        var attemptedWrite = false
        do {
            let value: JSONValue
            if recovering, let recovered = try await lookup(request, api: api) {
                value = recovered
            } else {
                attemptedWrite = true
                value = try await api.request(request.path, method: request.method, body: request.body)
            }
            try Task.checkCancellation()
            try request.validateResponse(value)
            result = value
            pending = nil
            api.notifyLedgerChanged()
            return true
        } catch is CancellationError {
            // Session invalidation must neither publish success nor release a possibly committed request.
            error = "操作结果尚未确认。回到当前账号后请核对收入记录。"
        } catch {
            if let failure = error as? APIError,
               (400..<500).contains(failure.status), ![408, 429].contains(failure.status) {
                // A recovery endpoint error says nothing about whether the original write committed.
                if attemptedWrite && failure.code != "FINANCIAL_OPERATION_MISMATCH" {
                    pending = nil
                    conflict = failure.status == 409
                }
                self.error = conflict ? "数据已变化，草稿已保留。请重新读取当前设置，再核对后保存。" : failure.localizedDescription
            } else {
                self.error = "暂时无法确认是否保存成功。草稿已锁定，请核对结果并重试；不会重复记入。"
            }
        }
        return false
    }

    func refreshed() { if pending == nil { conflict = false; error = nil } }

    private func lookup(_ request: PlanWriteRequest, api: APIClient) async throws -> JSONValue? {
        struct Operation: Decodable {
            let operationId: String
            let method: String
            let resource: String
            let statusCode: Int
            let response: JSONValue
        }
        do {
            let record: Operation = try await api.request("/financial-planning/operations/" + LedgerURL.segment(request.operationId))
            guard record.operationId.lowercased() == request.operationId.lowercased(), record.method == request.method,
                  record.resource == "/api/v1" + request.path, (200..<300).contains(record.statusCode) else {
                throw LedgerDataError.invalidResponse
            }
            return record.response
        } catch let error as APIError where error.status == 404 { return nil }
    }
}

@MainActor final class PlanEditorState: ObservableObject {
    @Published var amount = ""
    @Published var date = Date()
    @Published var accountId = ""
    @Published var note = ""
    @Published var ratios: [LedgerPurpose: String] = [:]
    @Published private(set) var config: LedgerFundConfiguration.Configuration?
    @Published private(set) var accounts: [LedgerAccount] = []
    @Published private(set) var loading = false
    @Published private(set) var error: String?
    let mutation = PlanMutation()
    private var owner: UUID?

    func load(api: APIClient, needsAccounts: Bool = true) async {
        guard !loading, !mutation.locked, owner == nil || owner == api.identity else { return }
        owner = api.identity
        loading = true
        error = nil
        defer { loading = false }
        do {
            let loaded: LedgerFundConfiguration = try await api.request("/financial-funds/config")
            let page: LedgerPage<LedgerAccount>?
            if needsAccounts { page = try await api.request("/accounts") } else { page = nil }
            try Task.checkCancellation()
            try loaded.validate()
            config = loaded.config
            if let page { accounts = page.items }
            if ratios.isEmpty { ratios = loaded.config.ratiosBps.planDraft }
            if accountId.isEmpty { accountId = accounts.first?.id ?? "" }
            mutation.refreshed()
        } catch is CancellationError {} catch { self.error = error.localizedDescription }
    }

    var salaryRequest: PlanWriteRequest? {
        let milliseconds = date.timeIntervalSince1970 * 1_000
        guard let config, let amount = PlanInput.hundredths(amount), amount > 0,
              accounts.contains(where: { $0.id == accountId }), milliseconds.isFinite,
              milliseconds >= 0, milliseconds <= 9_007_199_254_740_991 else { return nil }
        return .salary(amount: amount, date: Int64(milliseconds), accountId: accountId,
                       note: note, revision: config.revision)
    }

    func didCreateSalary() { amount = ""; note = ""; date = Date() }
    func didSaveRatios() { ratios = [:] }
}

@MainActor final class PlanHistoryStore: ObservableObject {
    @Published private(set) var salaries: [PlanSalary] = []
    @Published private(set) var issues: [PlanFundIssue] = []
    @Published private(set) var issueTotal = 0
    @Published private(set) var loading = false
    @Published private(set) var error: String?
    private var issueOffset = 0
    private var generation = UUID()
    private var reviews: [String: PlanReviewStore] = [:]

    func review(for target: PlanReviewTarget) -> PlanReviewStore {
        if let value = reviews[target.id] { return value }
        let value = PlanReviewStore(target: target)
        reviews[target.id] = value
        return value
    }

    var hasMoreIssues: Bool { issueOffset < issueTotal }

    func load(api: APIClient) async {
        let ticket = UUID()
        generation = ticket
        loading = true
        error = nil
        defer { if generation == ticket { loading = false } }
        do {
            async let salaryPage: LedgerPage<PlanSalary> = api.request("/salaries")
            async let issuePage: PlanIssuePage = api.request("/financial-funds/migration-issues?limit=50&offset=0")
            let (rows, page) = try await (salaryPage, issuePage)
            try Task.checkCancellation()
            try validate(page, expectedOffset: 0)
            for salary in rows.items { try salary.validate() }
            guard generation == ticket else { return }
            salaries = rows.items
            issues = page.items
            issueTotal = page.total
            issueOffset = page.items.count
        } catch is CancellationError {} catch { if generation == ticket { self.error = error.localizedDescription } }
    }

    func loadMoreIssues(api: APIClient) async {
        guard !loading, hasMoreIssues else { return }
        let ticket = generation
        let offset = issueOffset
        loading = true
        error = nil
        defer { if generation == ticket { loading = false } }
        do {
            let page: PlanIssuePage = try await api.request("/financial-funds/migration-issues?limit=50&offset=\(offset)")
            try validate(page, expectedOffset: offset)
            guard generation == ticket else { return }
            guard page.total == issueTotal, !page.items.isEmpty,
                  Set(issues.map(\.id)).isDisjoint(with: page.items.map(\.id)) else { throw LedgerDataError.changedPage }
            issues += page.items
            issueOffset += page.items.count
        } catch is CancellationError {} catch { if generation == ticket { self.error = error.localizedDescription } }
    }

    private func validate(_ page: PlanIssuePage, expectedOffset: Int) throws {
        guard page.contractVersion == 1, page.offset == expectedOffset, page.limit == 50,
              page.total >= page.offset + page.items.count,
              Set(page.items.map(\.id)).count == page.items.count else { throw LedgerDataError.invalidResponse }
        for issue in page.items { try issue.source?.validate() }
    }
}

enum PlanReviewTarget: Identifiable {
    case salary(String)
    case legacy(PlanGrant)
    var id: String {
        switch self { case .salary(let id): return id; case .legacy(let grant): return grant.grantId }
    }
}

@MainActor final class PlanReviewStore: ObservableObject, Identifiable {
    let target: PlanReviewTarget
    var id: String { target.id }
    let mutation = PlanMutation()
    @Published private(set) var sources: [PlanSalarySource] = []
    @Published private(set) var ratios: LedgerPurposeAmounts?
    @Published private(set) var revision: Int?
    @Published private(set) var loading = false
    @Published private(set) var error: String?
    private var owner: UUID?

    init(target: PlanReviewTarget) { self.target = target }

    var request: PlanWriteRequest? {
        guard let ratios, let revision, !sources.isEmpty, error == nil else { return nil }
        switch target {
        case .salary: return .review(sources: sources, ratios: ratios, revision: revision)
        case .legacy(let grant): return .review(sources: sources, ratios: ratios, revision: revision, grantId: grant.grantId)
        }
    }

    func load(api: APIClient) async {
        guard !loading, !mutation.locked, owner == nil || owner == api.identity else { return }
        owner = api.identity
        loading = true
        error = nil
        defer { loading = false }
        do {
            struct SourceResponse: Decodable { let source: PlanSalarySource }
            var sourceIDs: [String]
            let loadedRatios: LedgerPurposeAmounts
            let loadedRevision: Int
            switch target {
            case .salary(let id):
                let salary: PlanSalary = try await api.request("/salaries/" + LedgerURL.segment(id))
                try salary.validate()
                guard salary.id == id else { throw LedgerDataError.invalidResponse }
                guard salary.fundGrant == nil else {
                    throw APIError(status: 409, code: "ALREADY_ALLOCATED", message: "这笔收入已有分配，请关闭后刷新分配记录。")
                }
                let config: LedgerFundConfiguration = try await api.request("/financial-funds/config")
                try config.validate()
                loadedRatios = config.config.ratiosBps
                loadedRevision = config.config.revision
                sourceIDs = [id]
            case .legacy(let grant):
                struct PeriodResponse: Decodable {
                    struct Period: Decodable {
                        struct Source: Decodable { let salaryId: String }
                        let sources: [Source]
                    }
                    let period: Period
                }
                let periodId = String(grant.grantId.dropFirst("legacy-group:".count))
                let period: PeriodResponse = try await api.request("/financial-planning/periods/" + LedgerURL.segment(periodId))
                sourceIDs = period.period.sources.map(\.salaryId)
                // Frozen grant membership and ratios remain authoritative; the server rejects a changed group.
                guard !sourceIDs.isEmpty, Set(sourceIDs).count == sourceIDs.count else { throw LedgerDataError.invalidResponse }
                let current: PlanSalary = try await api.request("/salaries/" + LedgerURL.segment(sourceIDs[0]))
                guard let currentGrant = current.fundGrant, currentGrant.grantId == grant.grantId else {
                    throw LedgerDataError.changedPage
                }
                try currentGrant.validate()
                loadedRatios = currentGrant.ratiosBps
                loadedRevision = currentGrant.revision
            }
            var loadedSources: [PlanSalarySource] = []
            for id in sourceIDs {
                let value: SourceResponse = try await api.request("/financial-planning/sources/salaries/" + LedgerURL.segment(id))
                try value.source.validate()
                guard value.source.salaryId == id else { throw LedgerDataError.invalidResponse }
                loadedSources.append(value.source)
            }
            try Task.checkCancellation()
            sources = loadedSources
            ratios = loadedRatios
            revision = loadedRevision
            mutation.refreshed()
        } catch is CancellationError {} catch { self.error = error.localizedDescription }
    }
}
