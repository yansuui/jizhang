import Foundation

// Wire models mirror the read APIs. Financial totals are never rebuilt from a page of rows.
struct LedgerPage<Item: Decodable>: Decodable {
    let items: [Item]
    let total: Int?
    let limit: Int?
    let offset: Int?
}

enum LedgerDataError: LocalizedError {
    case invalidResponse
    case changedPage
    case unsupportedSearch

    var errorDescription: String? {
        switch self {
        case .invalidResponse: return "服务器返回的数据不完整，请刷新重试。"
        case .changedPage: return "账单数据已变化，请下拉刷新后继续浏览。"
        case .unsupportedSearch: return "当前服务器尚不支持完整账单搜索，请升级服务后重试。仍可清空搜索并按账户、分类浏览。"
        }
    }
}

enum LedgerBillKind: Int, Decodable, CaseIterable {
    case expense = 0
    case income = 1
    var title: String { self == .expense ? "支出" : "收入" }
}

struct LedgerTransaction: Decodable, Identifiable {
    let id: String
    let type: LedgerBillKind
    let amountCents: Int64
    let categoryId: String
    let accountId: String
    let date: Int64
    let note: String
    let tags: [String]
    let isRefund: Bool
    let fundPurpose: LedgerPurpose?
    /// Present only when the server confirmed this income into the four-purpose split by ratio.
    let fundIncomeAllocated: Bool?
    let refundSummary: LedgerRefundSummary?
    let refundDetails: [LedgerRefundDetail]?
    let refundLinkedTxIds: [String]?
    let updatedAt: Int64

    var kindTitle: String { isRefund ? "退款收入" : type.title }
    var sign: String { type == .income ? "+" : "−" }
}

struct LedgerRefundSummary: Decodable {
    let totalRefundCents: Int64
    let refundCount: Int
}

struct LedgerRefundDetail: Decodable, Identifiable {
    let id: String
    let amountCents: Int64
    let date: Int64
    let note: String
}

struct LedgerCategory: Decodable, Identifiable {
    let id: String
    let name: String
    let type: Int
    let parentId: String?
    let icon: String
    let color: Int64
    let isBuiltin: Bool
}

struct LedgerAccount: Decodable, Identifiable {
    let id: String
    let name: String
    let type: Int
    let initialBalanceCents: Int64
    let isBuiltin: Bool
}

struct LedgerAccountBalance: Decodable, Identifiable {
    let accountId: String
    let name: String
    let type: Int
    let balanceCents: Int64
    let initialBalanceCents: Int64
    let incomeCents: Int64
    let expenseCents: Int64
    let salaryCents: Int64
    let transferInCents: Int64
    let transferOutCents: Int64
    var id: String { accountId }
}

struct LedgerBalances: Decodable {
    let items: [LedgerAccountBalance]
    let totalBalanceCents: Int64
    let totalAssetsCents: Int64
    let totalLiabilitiesCents: Int64
}

struct LedgerMetadata {
    let categories: [LedgerCategory]
    let accounts: [LedgerAccount]

    static let empty = LedgerMetadata(categories: [], accounts: [])

    func categoryName(_ id: String) -> String {
        categories.first { $0.id == id }?.name ?? "历史分类"
    }

    func accountName(_ id: String) -> String {
        accounts.first { $0.id == id }?.name ?? "历史账户"
    }

    @MainActor static func load(api: APIClient) async throws -> LedgerMetadata {
        let categories: LedgerPage<LedgerCategory> = try await api.request("/categories?includeDeleted=true")
        let accounts: LedgerPage<LedgerAccount> = try await api.request("/accounts?includeDeleted=true")
        return LedgerMetadata(categories: categories.items, accounts: accounts.items)
    }
}

struct LedgerTrendPoint: Decodable, Identifiable {
    let month: String
    let monthStart: Int64
    let incomeCents: Int64
    let netExpenseCents: Int64
    let salaryIncomeCents: Int64?
    let refundIncomeCents: Int64?
    var id: String { month }
}

struct LedgerTrendRange: Decodable {
    let from: Int64
    let to: Int64
    let months: Int
    let endMonth: String
    let label: String
}

struct LedgerTrend: Decodable {
    let items: [LedgerTrendPoint]
    let range: LedgerTrendRange?
}

struct LedgerStatsWindow: Decodable {
    let kind: String
    let from: Int64
    let to: Int64
    let timeZone: String
    let label: String
}

struct LedgerCategoryShare: Decodable {
    struct Item: Decodable, Identifiable {
        let categoryId: String
        let categoryName: String
        let amountCents: Int64
        let ratio: Double
        var id: String { categoryId }
    }
    let items: [Item]
    let totalCents: Int64
    let expenseCents: Int64
    let expenseCount: Int
    let refundIncomeCents: Int64
    let from: Int64
    let to: Int64
}

struct LedgerBillQuery: Equatable, Hashable {
    var text = ""
    var type: Int? = nil
    var accountId: String? = nil
    var categoryId: String? = nil
    var tag: String? = nil
    // Inclusive start / exclusive end, matching the server's date predicates.
    var from: Int64? = nil
    var to: Int64? = nil

    func path(offset: Int = 0, limit: Int = 50) -> String {
        var values: [(String, String)] = [("limit", String(limit)), ("offset", String(offset))]
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { values.append(("search", trimmed)) }
        if let type { values.append(("type", String(type))) }
        if let accountId { values.append(("accountId", accountId)) }
        if let categoryId { values.append(("categoryId", categoryId)) }
        if let tag { values.append(("tag", tag)) }
        if let from { values.append(("from", String(from))) }
        if let to { values.append(("to", String(to))) }
        return LedgerURL.path("/transactions", values)
    }
}

enum LedgerURL {
    static func path(_ path: String, _ values: [(String, String)]) -> String {
        var components = URLComponents()
        components.path = path
        components.queryItems = values.map { URLQueryItem(name: $0.0, value: $0.1) }
        // '+' is legal in a query but many servers interpret it as a space.
        let query = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        return path + (query.map { "?" + $0 } ?? "")
    }

    static func segment(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~")) ?? ""
    }
}
