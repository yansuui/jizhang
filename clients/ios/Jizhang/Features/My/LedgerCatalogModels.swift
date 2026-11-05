import Foundation

struct LedgerTag: Decodable, Identifiable {
    let name: String
    let count: Int
    var id: String { name }
}

struct LedgerSalary: Decodable, Identifiable {
    let id: String
    let amountCents: Int64
    let date: Int64
    let note: String
    let accountId: String
    let updatedAt: Int64
}

struct LedgerSalaryDetail: Decodable {
    struct Allocation: Decodable, Identifiable {
        let categoryId: String
        let amountCents: Int64
        var id: String { categoryId }
    }
    struct Grant: Decodable {
        let grantId: String
        let revision: Int
        let status: String
        let sourceAmountCents: Int64
        let ratiosBps: LedgerPurposeAmounts
        let targets: LedgerPurposeAmounts
    }
    let id: String
    let amountCents: Int64
    let date: Int64
    let note: String
    let accountId: String
    let allocations: [Allocation]
    let fundGrant: Grant?
}

struct LedgerRecurringRule: Decodable, Identifiable {
    enum Frequency: String, Decodable {
        case daily, weekly, monthly, quarterly, yearly
        var title: String {
            switch self {
            case .daily: return "每天"
            case .weekly: return "每周"
            case .monthly: return "每月"
            case .quarterly: return "每季度"
            case .yearly: return "每年"
            }
        }
    }
    let id: String
    let name: String
    let type: LedgerBillKind
    let amountCents: Int64
    let categoryId: String
    let accountId: String
    let frequency: Frequency
    let anchorDate: Int64
    let nextDueDate: Int64
    let hasOlderDue: Bool
    let enabled: Bool
    let updatedAt: Int64
}

struct LedgerPendingOccurrence: Decodable, Identifiable {
    enum Status: String, Decodable { case pending, confirmed, ignored }
    let id: String
    let ruleId: String
    let plannedDate: Int64
    let status: Status
    let transactionId: String?
    let type: LedgerBillKind
    let amountCents: Int64
    let categoryId: String
    let accountId: String
    let note: String
    let updatedAt: Int64
}

struct LedgerTransfer: Decodable, Identifiable {
    let id: String
    let fromAccountId: String
    let toAccountId: String
    let amountCents: Int64
    let date: Int64
    let note: String
    let updatedAt: Int64
}

struct LedgerItem: Decodable, Identifiable {
    enum Status: String, Decodable, CaseIterable {
        case active, idle, sold, retired
        var title: String {
            switch self {
            case .active: return "在用"
            case .idle: return "闲置"
            case .sold: return "已售出"
            case .retired: return "已退役"
            }
        }
    }
    let id: String
    let name: String
    let category: String
    let brand: String
    let model: String
    let note: String
    let purchasePriceCents: Int64?
    let purchaseDate: Int64
    let status: Status
    let closedDate: Int64?
    let salePriceCents: Int64?
    let purchaseTransactionId: String?
    let saleTransactionId: String?
    let photoUrl: String?
    let heldDays: Int
    let netCostCents: Int64?
    let dailyCostCents: Int64?
    let createdAt: Int64
    let updatedAt: Int64
}

struct LedgerItemSummary: Decodable {
    let totalItems: Int
    let activeItems: Int
    let idleItems: Int
    let soldItems: Int
    let retiredItems: Int
    let cumulativePurchaseCents: Int64
    let currentDailyCostCents: Int64
}
