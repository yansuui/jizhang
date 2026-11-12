import Foundation
import Combine

enum LedgerBillEditError: LocalizedError, Equatable {
    case invalidAmount, missingCategory, missingAccount, staleSource, invalidRefund
    var errorDescription: String? {
        switch self {
        case .invalidAmount: return "金额需大于 0，最多两位小数，且不超过 90,071,992,547,409.91 元。"
        case .missingCategory: return "请选择对应收支类型的分类。"
        case .missingAccount: return "请选择记账账户。"
        case .staleSource: return "原账单已变化，请重新读取后核对再保存。"
        case .invalidRefund: return "退款必须至少关联一笔原支出。"
        }
    }
}

/// A calculator-style amount: decimal terms joined by `+` / `-`, evaluated left to right.
///
/// Every term keeps the single-amount contract (positive, at most two decimals, safe integer
/// cents) and the total must also be a positive safe integer amount of cents, so the wire body is
/// always one integer — never an expression the server would have to interpret.
enum LedgerAmountExpression {
    static let maximumTerms = 20

    static func containsOperator(_ text: String) -> Bool {
        text.contains("+") || text.contains("-") || text.contains("−") || text.contains("＋")
    }

    /// A running total to show under the field, or nil when this is a plain amount.
    static func totalText(_ text: String) -> String? {
        guard containsOperator(text), let cents = try? cents(text) else { return nil }
        return LedgerFormat.money(cents)
    }

    static func cents(_ text: String) throws -> Int64 {
        let normalized = text
            .replacingOccurrences(of: "＋", with: "+")
            .replacingOccurrences(of: "−", with: "-")
            .replacingOccurrences(of: "－", with: "-")
        var terms: [(sign: Int64, value: String)] = []
        var sign: Int64 = 1
        var current = ""
        for character in normalized {
            guard character == "+" || character == "-" else {
                current.append(character)
                continue
            }
            let term = current.trimmingCharacters(in: .whitespaces)
            if term.isEmpty {
                // Only a leading sign may stand alone; "5++3" is not a number.
                guard terms.isEmpty, current.isEmpty else { throw LedgerBillEditError.invalidAmount }
            } else {
                terms.append((sign, term))
                current = ""
            }
            sign = character == "-" ? -1 : 1
        }
        let tail = current.trimmingCharacters(in: .whitespaces)
        guard !tail.isEmpty else { throw LedgerBillEditError.invalidAmount }
        terms.append((sign, tail))
        guard terms.count <= maximumTerms else { throw LedgerBillEditError.invalidAmount }
        var total: Int64 = 0
        for term in terms {
            let value = try LedgerTransactionDraft.cents(term.value)
            let (signed, multiplyOverflow) = value.multipliedReportingOverflow(by: term.sign)
            guard !multiplyOverflow else { throw LedgerBillEditError.invalidAmount }
            let (sum, addOverflow) = total.addingReportingOverflow(signed)
            guard !addOverflow else { throw LedgerBillEditError.invalidAmount }
            total = sum
        }
        guard total > 0, total <= 9_007_199_254_740_991 else { throw LedgerBillEditError.invalidAmount }
        return total
    }
}

struct LedgerBillPurposeSnapshot: Decodable {
    struct Facts: Decodable {
        let transactionId: String
        let transactionToken: String
        let fundPurposeRevision: Int64
        let fundPurpose: LedgerPurpose?
    }
    let billPurpose: Facts
}

struct LedgerTransactionDraft: Equatable {
    var type: LedgerBillKind = .expense
    var amount = ""
    var categoryId = ""
    var accountId = ""
    var date = Date()
    var note = ""
    var tags = ""
    var purpose: LedgerPurpose?
    var isRefund = false
    var refundLinkedTxIds: [String] = []

    init(transaction: LedgerTransaction? = nil, refundOf: LedgerTransaction? = nil) {
        if let transaction {
            type = transaction.type
            amount = Self.amountText(transaction.amountCents)
            categoryId = transaction.categoryId
            accountId = transaction.accountId
            date = Date(timeIntervalSince1970: Double(transaction.date) / 1_000)
            note = transaction.note
            tags = transaction.tags.joined(separator: "，")
            purpose = transaction.fundPurpose
            isRefund = transaction.isRefund
            refundLinkedTxIds = transaction.refundLinkedTxIds ?? []
        } else if let refundOf {
            type = .income
            isRefund = true
            accountId = refundOf.accountId
            refundLinkedTxIds = [refundOf.id]
            note = refundOf.note.isEmpty ? "退款" : "退款：" + refundOf.note
        }
    }

    static func amountText(_ cents: Int64) -> String {
        "\(cents / 100)." + String(format: "%02lld", cents % 100)
    }

    /// Rebase only untouched fields after a conflict; keep the user's actual edits for review.
    mutating func mergeUnedited(from previous: Self, latest: Self) {
        if type == previous.type { type = latest.type }
        if amount == previous.amount { amount = latest.amount }
        if categoryId == previous.categoryId { categoryId = latest.categoryId }
        if accountId == previous.accountId { accountId = latest.accountId }
        if date == previous.date { date = latest.date }
        if note == previous.note { note = latest.note }
        if tags == previous.tags { tags = latest.tags }
        if purpose == previous.purpose { purpose = latest.purpose }
        if isRefund == previous.isRefund { isRefund = latest.isRefund }
        if refundLinkedTxIds == previous.refundLinkedTxIds { refundLinkedTxIds = latest.refundLinkedTxIds }
    }

    static func cents(_ text: String) throws -> Int64 {
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let parts = value.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 1 || parts.count == 2,
              !parts[0].isEmpty, parts.allSatisfy({ $0.allSatisfy { $0 >= "0" && $0 <= "9" } }),
              parts.count == 1 || (1...2).contains(parts[1].count),
              let whole = Int64(parts[0]), whole <= 90_071_992_547_409 else { throw LedgerBillEditError.invalidAmount }
        let fraction = parts.count == 2 ? (Int64(parts[1]) ?? 0) * (parts[1].count == 1 ? 10 : 1) : 0
        let amount = whole * 100 + fraction
        guard amount > 0, amount <= 9_007_199_254_740_991 else { throw LedgerBillEditError.invalidAmount }
        return amount
    }

    func body(operationId: String, snapshot: LedgerBillPurposeSnapshot.Facts? = nil) throws -> JSONValue {
        guard !categoryId.isEmpty else { throw LedgerBillEditError.missingCategory }
        guard !accountId.isEmpty else { throw LedgerBillEditError.missingAccount }
        guard !isRefund || (type == .income && (!refundLinkedTxIds.isEmpty || snapshot != nil)) else { throw LedgerBillEditError.invalidRefund }
        let tagValues = tags.components(separatedBy: CharacterSet(charactersIn: ",，\n"))
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        var body: [String: JSONValue] = [
            "type": .integer(Int64(type.rawValue)), "amountCents": .integer(try LedgerAmountExpression.cents(amount)),
            "categoryId": .string(categoryId), "accountId": .string(accountId),
            "date": .integer(LedgerBillDates.milliseconds(date)), "note": .string(note),
            "tags": .array(Array(Set(tagValues)).sorted().map(JSONValue.string)),
            "isRefund": .bool(isRefund),
            "refundLinkedTxIds": .array(isRefund ? refundLinkedTxIds.map(JSONValue.string) : []),
            // Explicit null also opts into the server's existing idempotent writer.
            "fundPurpose": isRefund ? .null : (purpose.map { .string($0.rawValue) } ?? .null),
            "operationId": .string(operationId)
        ]
        if let snapshot {
            body["expectedFundPurposeRevision"] = .integer(snapshot.fundPurposeRevision)
            body["expectedTransactionToken"] = .string(snapshot.transactionToken)
        }
        return .object(body)
    }
}

private struct LedgerBillPendingWrite {
    let operationId: String
    let path: String
    let method: String
    let body: JSONValue
    let draft: LedgerTransactionDraft
}

/// Pending writes belong to one authenticated API session and survive editor dismissal.
/// Never migrate these records to another server/login or manufacture a replacement UUID.
@MainActor private enum LedgerBillPendingWrites {
    static var records: [UUID: [String: LedgerBillPendingWrite]] = [:]
}

@MainActor final class LedgerTransactionEditorStore: ObservableObject {
    @Published var draft: LedgerTransactionDraft
    @Published private(set) var metadata = LedgerMetadata.empty
    @Published private(set) var loading = false
    @Published private(set) var ready = false
    @Published private(set) var saving = false
    @Published private(set) var awaitingReconciliation = false
    @Published private(set) var error: String?
    @Published private(set) var conflictSource: LedgerTransaction?
    private var snapshot: LedgerBillPurposeSnapshot.Facts?
    private var baseline: LedgerTransactionDraft?
    private var needsConflictRefresh = false
    private let transaction: LedgerTransaction?
    private let refundOf: LedgerTransaction?
    private var owner: UUID?
    private var generation = 0
    private var committed = false
    private var pending: LedgerBillPendingWrite?
    private var key: String { transaction.map { "edit:" + $0.id } ?? "create" }

    init(transaction: LedgerTransaction? = nil, refundOf: LedgerTransaction? = nil) {
        self.transaction = transaction
        self.refundOf = refundOf
        draft = LedgerTransactionDraft(transaction: transaction, refundOf: refundOf)
    }

    func load(api: APIClient) async {
        guard !saving, owner == nil || owner == api.identity else { return }
        owner = api.identity
        generation += 1
        let ticket = generation
        loading = true
        ready = false
        error = nil
        defer { if ticket == generation { loading = false } }
        if let retained = LedgerBillPendingWrites.records[api.identity]?[key] {
            pending = retained
            draft = retained.draft
            awaitingReconciliation = true
        }
        do {
            if let refundOf, refundOf.type != .expense || refundOf.isRefund { throw LedgerBillEditError.invalidRefund }
            let categories: LedgerPage<LedgerCategory> = try await api.request("/categories")
            let accounts: LedgerPage<LedgerAccount> = try await api.request("/accounts")
            var latest: LedgerTransaction?
            var facts: LedgerBillPurposeSnapshot.Facts?
            if let transaction, pending == nil {
                let purpose: LedgerBillPurposeSnapshot = try await api.request("/financial-planning/bill-purposes/" + LedgerURL.segment(transaction.id))
                latest = try await api.request("/transactions/" + LedgerURL.segment(transaction.id))
                guard purpose.billPurpose.transactionId == transaction.id else { throw LedgerDataError.invalidResponse }
                facts = purpose.billPurpose
            }
            guard owner == api.identity, generation == ticket, !Task.isCancelled else { return }
            metadata = LedgerMetadata(categories: categories.items, accounts: accounts.items)
            if let latest {
                let fresh = LedgerTransactionDraft(transaction: latest)
                if needsConflictRefresh, let baseline {
                    draft.mergeUnedited(from: baseline, latest: fresh)
                    conflictSource = latest
                    error = "已读取最新原单并保留你的修改。请对照下方原单，核对草稿后再保存。"
                } else { draft = fresh }
                baseline = fresh
                needsConflictRefresh = false
            }
            snapshot = facts
            if pending == nil && transaction == nil {
                if !accounts.items.contains(where: { $0.id == draft.accountId }) {
                    if refundOf != nil { error = "原支出账户已停用，请明确选择退款入账账户。" }
                    else { draft.accountId = accounts.items.first?.id ?? "" }
                }
                if draft.categoryId.isEmpty {
                    let matching = categories.items.filter { $0.type == draft.type.rawValue }
                    draft.categoryId = (draft.isRefund ? matching.first { $0.name.contains("退款") } : nil)?.id ?? matching.first?.id ?? ""
                }
            }
            ready = true
        } catch {
            guard owner == api.identity, generation == ticket, !Task.isCancelled else { return }
            self.error = error.localizedDescription
        }
    }

    /// Calculator-style entry: append `+` / `-`, collapsing a repeated trailing operator.
    func appendAmountOperator(_ operand: String) {
        var text = draft.amount
        while let last = text.last, last == "+" || last == "-" || last == "−" || last == "＋" {
            text.removeLast()
        }
        guard !text.isEmpty else { return }
        draft.amount = text + operand
    }

    /// Commit `12.5+3` into `15.50`; an invalid expression leaves the field untouched for editing.
    func commitAmountExpression() {
        guard LedgerAmountExpression.containsOperator(draft.amount) else { return }
        guard let cents = try? LedgerAmountExpression.cents(draft.amount) else {
            error = LedgerBillEditError.invalidAmount.localizedDescription
            return
        }
        draft.amount = LedgerTransactionDraft.amountText(cents)
        error = nil
    }

    /// A refund is an income row that links back to the expenses it offsets. Turning the flag on
    /// keeps the category legal for income and prefers the built-in 退款 category; turning it off
    /// drops the links so a plain income never carries stale references.
    func setRefund(_ value: Bool) {
        guard draft.isRefund != value else { return }
        draft.isRefund = value
        if value {
            draft.type = .income
            draft.purpose = nil
            let income = metadata.categories.filter { $0.type == LedgerBillKind.income.rawValue }
            if let refundCategory = income.first(where: { $0.name.contains("退款") }) {
                draft.categoryId = refundCategory.id
            } else if !income.contains(where: { $0.id == draft.categoryId }) {
                draft.categoryId = income.first?.id ?? ""
            }
        } else {
            draft.refundLinkedTxIds = []
        }
    }

    /// Only explicit taps call this. A retry always reuses the frozen request verbatim.
    func save(api: APIClient, retryPending: Bool = false) async -> Bool {
        guard owner == api.identity, !saving, !committed,
              (retryPending ? pending != nil : (ready && pending == nil)) else { return false }
        if pending == nil {
            // Freeze the request only after local validation passes. A rejected draft never sent a
            // request, so it must stay editable instead of looking like an ambiguous submission.
            do {
                if transaction != nil && snapshot == nil { throw LedgerBillEditError.staleSource }
                if transaction == nil && !metadata.accounts.contains(where: { $0.id == draft.accountId }) {
                    throw LedgerBillEditError.missingAccount
                }
                let id = UUID().uuidString.lowercased()
                let request = LedgerBillPendingWrite(operationId: id,
                    path: transaction.map { "/transactions/" + LedgerURL.segment($0.id) } ?? "/transactions",
                    method: transaction == nil ? "POST" : "PATCH",
                    body: try draft.body(operationId: id, snapshot: snapshot), draft: draft)
                pending = request
                LedgerBillPendingWrites.records[api.identity, default: [:]][key] = request
            } catch {
                self.error = error.localizedDescription
                return false
            }
        }
        guard let frozen = pending else { return false }
        saving = true
        error = nil
        defer { saving = false }
        do {
            let result: LedgerTransaction = try await api.request(frozen.path, method: frozen.method, body: frozen.body)
            try Task.checkCancellation()
            guard owner == api.identity else { return false }
            guard !result.id.isEmpty else { throw LedgerDataError.invalidResponse }
            complete(api: api)
            return true
        } catch {
            self.error = error.localizedDescription
            // Validation/CAS rejection cannot have committed. A timeout/5xx/malformed success can.
            if let failure = error as? APIError, (400..<500).contains(failure.status), failure.status != 408 {
                clearPending(api: api)
                if failure.status == 409 { ready = false; needsConflictRefresh = true }
            } else {
                awaitingReconciliation = true
                self.error = "提交结果尚未确认。请先核对；如需重试，将沿用同一笔提交，避免重复记账。"
            }
            return false
        }
    }

    func reconcile(api: APIClient) async -> Bool {
        guard owner == api.identity, !saving, let pending else { return false }
        saving = true
        error = nil
        let ticket = generation
        defer { saving = false }
        do {
            let operation: JSONValue = try await api.request("/financial-planning/operations/" + LedgerURL.segment(pending.operationId))
            try Task.checkCancellation()
            guard owner == api.identity, generation == ticket else { return false }
            guard operation["operationId"].stringValue?.lowercased() == pending.operationId.lowercased(),
                  operation["method"].stringValue == pending.method,
                  operation["resource"].stringValue == "/api/v1" + pending.path,
                  let status = operation["statusCode"].intValue, (200..<300).contains(status) else { throw LedgerDataError.invalidResponse }
            let transaction: LedgerTransaction = try operation["response"].decode()
            guard !transaction.id.isEmpty else { throw LedgerDataError.invalidResponse }
            complete(api: api)
            return true
        } catch {
            if let error = error as? APIError, error.status == 404 {
                self.error = "服务器尚无该笔提交的确认记录。可以重试原提交，草稿和提交编号保持不变。"
            } else { self.error = "暂时无法核对提交结果，请联网后再核对。原提交仍已保留。" }
            return false
        }
    }

    private func clearPending(api: APIClient) {
        LedgerBillPendingWrites.records[api.identity]?[key] = nil
        pending = nil
        awaitingReconciliation = false
    }

    private func complete(api: APIClient) {
        clearPending(api: api)
        committed = true
        api.notifyLedgerChanged()
    }
}
