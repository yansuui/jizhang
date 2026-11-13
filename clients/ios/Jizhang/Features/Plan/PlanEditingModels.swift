import Foundation

enum PlanInput {
    /// Exact decimal-to-minor-unit parsing for money and percentage basis points.
    static func hundredths(_ text: String) -> Int64? {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let parts = value.split(separator: ".", omittingEmptySubsequences: false)
        guard (1...2).contains(parts.count), !parts[0].isEmpty,
              parts.allSatisfy({ $0.allSatisfy { $0.isASCII && $0.isNumber } }),
              parts.count == 1 || (1...2).contains(parts[1].count),
              let whole = Int64(parts[0]), whole <= 90_071_992_547_409 else { return nil }
        let fraction = parts.count == 1 ? 0 : Int64(parts[1])! * (parts[1].count == 1 ? 10 : 1)
        let result = whole * 100 + fraction
        return result <= 9_007_199_254_740_991 ? result : nil
    }

    static func decimal(_ value: Int64) -> String {
        let remainder = value % 100
        return remainder == 0 ? "\(value / 100)" : String(format: "%lld.%02lld", value / 100, remainder)
    }

    static func ratios(_ values: [LedgerPurpose: String]) -> LedgerPurposeAmounts? {
        let parsed = LedgerPurpose.allCases.compactMap { hundredths(values[$0] ?? "") }
        guard parsed.count == 4, parsed.allSatisfy({ (0...10_000).contains($0) }),
              parsed.reduce(0, +) == 10_000 else { return nil }
        return LedgerPurposeAmounts(growth: parsed[0], reserve: parsed[1], essentials: parsed[2], joy: parsed[3])
    }
}

extension LedgerPurposeAmounts {
    var planJSON: JSONValue {
        .object(Dictionary(uniqueKeysWithValues: LedgerPurpose.allCases.map { ($0.rawValue, .integer(self[$0])) }))
    }
    var planDraft: [LedgerPurpose: String] {
        Dictionary(uniqueKeysWithValues: LedgerPurpose.allCases.map { ($0, PlanInput.decimal(self[$0])) })
    }
    func validateRatios() throws {
        guard LedgerPurpose.allCases.allSatisfy({ (0...10_000).contains(self[$0]) }),
              growth + reserve + essentials + joy == 10_000 else { throw LedgerDataError.invalidResponse }
    }
}

struct PlanSalary: Decodable, Identifiable {
    let id: String
    let amountCents: Int64
    let date: Int64
    let note: String
    let accountId: String
    let updatedAt: Int64
    let fundGrant: PlanGrant?

    func validate() throws {
        guard !id.isEmpty, !accountId.isEmpty, amountCents > 0,
              amountCents <= 9_007_199_254_740_991, date >= 0 else { throw LedgerDataError.invalidResponse }
        try fundGrant?.validate()
    }
}

struct PlanGrant: Decodable {
    let grantId: String
    let revision: Int
    let status: String?
    let sourceAmountCents: Int64
    let ratiosBps: LedgerPurposeAmounts
    let targets: LedgerPurposeAmounts

    var canReconfirm: Bool { grantId.hasPrefix("legacy-group:") && status == "review-required" }
    var statusTitle: String {
        switch status {
        case "active": return "已确认"
        case "review-required": return "来源已变化，待核对"
        case "inactive": return "已停用"
        default: return "请核对分配状态"
        }
    }
    func validate() throws {
        guard !grantId.isEmpty, revision > 0, sourceAmountCents > 0,
              sourceAmountCents <= 9_007_199_254_740_991 else { throw LedgerDataError.invalidResponse }
        try ratiosBps.validateRatios()
        try targets.validate(nonnegative: true)
        guard LedgerPurpose.allCases.reduce(Int64(0), { $0 + targets[$1] }) == sourceAmountCents else {
            throw LedgerDataError.invalidResponse
        }
    }
}

struct PlanSalarySource: Decodable, Identifiable {
    let salaryId: String
    let amountCents: Int64
    let date: Int64
    let accountId: String
    let sourceToken: String
    var id: String { salaryId }
    var reference: JSONValue {
        .object(["salaryId": .string(salaryId), "expectedSourceToken": .string(sourceToken)])
    }
    func validate() throws {
        guard !salaryId.isEmpty, !accountId.isEmpty, !sourceToken.isEmpty,
              amountCents > 0, amountCents <= 9_007_199_254_740_991, date >= 0 else {
            throw LedgerDataError.invalidResponse
        }
    }
}

struct PlanFundIssue: Decodable, Identifiable {
    let sourceKind: String
    let sourceId: String
    let reason: String
    let status: String
    let source: PlanSalarySource?
    var id: String { sourceKind + ":" + sourceId + ":" + reason }
    var canAllocate: Bool { sourceKind == "salary" && reason == "unallocated" && status == "open" && source != nil }
    /// Mirrors the server's archival contract: `salary`/`transaction`/`period` issues are
    /// represented by their live source facts (grant, bill purpose), so an open one has no
    /// corrective action in the app and must not read as an outstanding task.
    var isArchived: Bool { status == "open" && !canAllocate && Self.liveFactKinds.contains(sourceKind) }
    /// Open issues outside those kinds still keep the fund summary incomplete.
    var needsServerAttention: Bool { status == "open" && !canAllocate && !isArchived }
    private static let liveFactKinds: Set<String> = ["salary", "transaction", "period"]
}

struct PlanIssuePage: Decodable {
    let contractVersion: Int
    let items: [PlanFundIssue]
    let total: Int
    let limit: Int
    let offset: Int
}

struct PlanWriteRequest: Equatable {
    let operationId: String
    let path: String
    let method: String
    let body: JSONValue

    init(path: String, method: String = "POST", fields: [String: JSONValue], operationId: String = UUID().uuidString.lowercased()) {
        self.operationId = operationId
        self.path = path
        self.method = method
        var body = fields
        body["operationId"] = .string(operationId)
        self.body = .object(body)
    }

    static func configuration(_ config: LedgerFundConfiguration.Configuration, ratios: LedgerPurposeAmounts) -> Self {
        Self(path: "/financial-funds/config", method: "PUT", fields: [
            "expectedRevision": .integer(Int64(config.revision)), "ratiosBps": ratios.planJSON,
            "timeZone": .string(config.timeZone)
        ])
    }

    static func salary(amount: Int64, date: Int64, accountId: String, note: String, revision: Int) -> Self {
        Self(path: "/salaries", fields: ["contractVersion": .integer(1), "expectedFundConfigRevision": .integer(Int64(revision)),
             "amountCents": .integer(amount), "date": .integer(date), "accountId": .string(accountId), "note": .string(note)])
    }

    static func review(sources: [PlanSalarySource], ratios: LedgerPurposeAmounts, revision: Int, grantId: String? = nil) -> Self {
        var fields: [String: JSONValue] = ["expectedRevision": .integer(Int64(revision)), "ratiosBps": ratios.planJSON,
                                           "sources": .array(sources.map(\.reference))]
        if let grantId { fields["grantId"] = .string(grantId) }
        return Self(path: "/financial-funds/grants/review", fields: fields)
    }

    func validateResponse(_ value: JSONValue) throws {
        let data = try JSONEncoder().encode(value)
        switch path {
        case "/financial-funds/config":
            let configuration = try JSONDecoder().decode(LedgerFundConfiguration.self, from: data)
            try configuration.validate()
            guard case .integer(let expected) = body["expectedRevision"],
                  expected >= 0, expected < 9_007_199_254_740_991,
                  Int64(configuration.config.revision) == expected + 1,
                  configuration.config.ratiosBps.planJSON == body["ratiosBps"],
                  .string(configuration.config.timeZone) == body["timeZone"] else { throw LedgerDataError.invalidResponse }
        case "/salaries":
            let salary = try JSONDecoder().decode(PlanSalary.self, from: data)
            try salary.validate()
            guard salary.fundGrant != nil, .integer(salary.amountCents) == body["amountCents"],
                  .integer(salary.date) == body["date"], .string(salary.accountId) == body["accountId"],
                  .string(salary.note) == body["note"] else { throw LedgerDataError.invalidResponse }
        default:
            struct Response: Decodable { let contractVersion: Int; let grant: PlanGrant }
            let response = try JSONDecoder().decode(Response.self, from: data)
            guard response.contractVersion == 1 else { throw LedgerDataError.invalidResponse }
            try response.grant.validate()
            guard response.grant.ratiosBps.planJSON == body["ratiosBps"] else { throw LedgerDataError.invalidResponse }
            if let grantId = body["grantId"].stringValue {
                guard response.grant.grantId == grantId,
                      case .integer(let revision) = body["expectedRevision"],
                      revision >= 0, revision < 9_007_199_254_740_991,
                      Int64(response.grant.revision) == revision + 1 else { throw LedgerDataError.invalidResponse }
            }
        }
    }
}
