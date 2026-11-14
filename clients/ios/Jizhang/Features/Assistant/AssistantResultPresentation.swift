import SwiftUI

/// Turns an assistant tool result into the facts a person reads.
///
/// Tool payloads are transport data: they carry UUIDs, enum ids and revision
/// counters. The conversation may keep those facts, but the visible card must
/// answer "what did the assistant do" in the same words the rest of the ledger
/// uses. The raw object is never the primary presentation.
enum AssistantResultPresentation {
    static let rowKeys = ["items", "rows", "entries", "transactions", "records"]
    static let structuralKeys: Set<String> = Set(rowKeys).union(["nativeAction", "transaction"])
    static let pagingKeys: Set<String> = ["total", "offset", "limit", "hasMore", "nextOffset", "pageReducedForDisplay"]

    /// A single written/read bill. A full `LedgerTransaction` decode keeps the
    /// display on the shared field semantics instead of re-implementing cents,
    /// refund and purpose rules in the assistant.
    static func transaction(from data: JSONValue) -> LedgerTransaction? {
        guard data["transaction"].objectValue != nil else { return nil }
        return try? data["transaction"].decode(LedgerTransaction.self)
    }

    /// A page of bills. Only a complete decode is used; a mixed page falls back
    /// to the generic labelled rows so an unknown row shape is never hidden.
    static func transactions(from data: JSONValue) -> [LedgerTransaction]? {
        for key in rowKeys {
            guard let rows = data[key].arrayValue, !rows.isEmpty else { continue }
            let decoded = rows.compactMap { try? $0.decode(LedgerTransaction.self) }
            return decoded.count == rows.count ? decoded : nil
        }
        return nil
    }

    /// A result that only reports an identifier/flag has no card of its own.
    /// The server summary already says what happened.
    static func isTrivial(_ data: JSONValue) -> Bool {
        let ignored: Set<String> = ["version", "toolName", "id", "deleted", "completed", "checkedAt", "actionId", "transactionId"]
        return Set((data.objectValue ?? [:]).keys).subtracting(ignored).isEmpty
    }

    /// One known domain object behind a wrapper key (`category`, `transfer`, …).
    /// Rendering its fields directly avoids a pointless "展开分类" step.
    static func primaryObject(from data: JSONValue) -> JSONValue? {
        let containers: Set<String> = ["transfer", "category", "account", "item", "salary", "goal", "rule", "budget",
            "record", "settings", "funds", "plan"]
        guard let object = data.objectValue else { return nil }
        let present = object.keys.filter { containers.contains($0) && object[$0]?.objectValue != nil }
        guard present.count == 1, let key = present.first else { return nil }
        let others = object.keys.filter { $0 != key }
        guard others.allSatisfy({ structuralKeys.contains($0) || pagingKeys.contains($0) || object[$0]?.stringValue != nil }) else { return nil }
        return object[key]
    }

    /// Top-level facts worth reading next to a result, without the page envelope.
    static func facts(_ data: JSONValue, excluding: Set<String> = []) -> JSONValue {
        guard let object = data.objectValue else { return .object([:]) }
        var output: [String: JSONValue] = [:]
        for (key, value) in object where !structuralKeys.contains(key) && !pagingKeys.contains(key) && !excluding.contains(key) {
            output[key] = value
        }
        return .object(output)
    }

    static func hasFacts(_ value: JSONValue) -> Bool {
        guard let object = value.objectValue else { return false }
        return object.contains { !AssistantPreviewFormat.isInternal($0.key) }
    }
}

private struct AssistantLedgerMetadataKey: EnvironmentKey {
    static let defaultValue: LedgerMetadata? = nil
}

extension EnvironmentValues {
    /// Read metadata is resolved once per assistant store, not fetched per card.
    var assistantLedgerMetadata: LedgerMetadata? {
        get { self[AssistantLedgerMetadataKey.self] }
        set { self[AssistantLedgerMetadataKey.self] = newValue }
    }
}

/// The compact receipt used for one written/updated bill.
struct AssistantTransactionReceipt: View {
    let transaction: LedgerTransaction
    let metadata: LedgerMetadata?

    private var category: String { metadata?.categoryName(transaction.categoryId) ?? "分类未知" }
    private var account: String { metadata?.accountName(transaction.accountId) ?? "账户未知" }
    private var symbol: String {
        transaction.isRefund ? "arrow.uturn.backward" : (transaction.type == .income ? "arrow.down.left" : "arrow.up.right")
    }
    private var tint: Color { transaction.type == .income ? AppTheme.accent : .primary }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: symbol).font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(tint).frame(width: 32, height: 32)
                    .background(tint.opacity(0.10), in: RoundedRectangle(cornerRadius: 10))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text(transaction.note.isEmpty ? category : transaction.note)
                        .font(.subheadline.weight(.semibold)).lineLimit(2)
                    Text([category, account, LedgerFormat.date(transaction.date)].joined(separator: " · "))
                        .font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
                Spacer(minLength: 6)
                Text(transaction.sign + LedgerFormat.money(transaction.amountCents))
                    .font(.headline).monospacedDigit().foregroundStyle(tint)
                    .minimumScaleFactor(0.7).lineLimit(1)
            }
            HStack(spacing: 12) {
                Text(transaction.kindTitle)
                Text("资金用途 " + (transaction.fundPurpose?.title ?? "未设置"))
                if !transaction.tags.isEmpty { Text("标签 " + transaction.tags.joined(separator: "、")).lineLimit(1) }
            }.font(.caption).foregroundStyle(.secondary)
            if let refund = transaction.refundSummary, refund.refundCount > 0 {
                Text("已关联退款 \(refund.refundCount) 笔，共 \(LedgerFormat.money(refund.totalRefundCents))")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(12)
        .background(Color(uiColor: .systemBackground), in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color.primary.opacity(0.06), lineWidth: 1))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(transaction.kindTitle)，\(transaction.note.isEmpty ? category : transaction.note)，\(category)，\(account)，\(LedgerFormat.date(transaction.date))，\(transaction.sign + LedgerFormat.money(transaction.amountCents))")
    }
}

/// One line in a paged bill result. The receipt is too tall to repeat 30 times;
/// note, category, account, date and amount are enough to recognise a row.
struct AssistantTransactionLine: View {
    let transaction: LedgerTransaction
    let metadata: LedgerMetadata?

    private var category: String { metadata?.categoryName(transaction.categoryId) ?? "分类未知" }
    private var account: String { metadata?.accountName(transaction.accountId) ?? "账户未知" }
    private var symbol: String {
        transaction.isRefund ? "arrow.uturn.backward" : (transaction.type == .income ? "arrow.down.left" : "arrow.up.right")
    }
    private var tint: Color { transaction.type == .income ? AppTheme.accent : .primary }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: symbol).font(.system(size: 12, weight: .semibold))
                .foregroundStyle(tint).frame(width: 28, height: 28)
                .background(tint.opacity(0.10), in: RoundedRectangle(cornerRadius: 9))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(transaction.note.isEmpty ? category : transaction.note)
                    .font(.subheadline.weight(.medium)).lineLimit(2)
                Text([category, account, LedgerFormat.date(transaction.date)].joined(separator: " · "))
                    .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 6)
            Text(transaction.sign + LedgerFormat.money(transaction.amountCents))
                .font(.subheadline.weight(.semibold)).monospacedDigit().foregroundStyle(tint)
                .minimumScaleFactor(0.75).lineLimit(1)
        }
        .padding(.vertical, 5)
        .accessibilityElement(children: .combine)
    }
}
