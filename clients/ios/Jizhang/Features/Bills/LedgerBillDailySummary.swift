import Foundation

/// One authoritative per-day bucket returned by `GET /api/v1/transactions/daily-summary`.
///
/// Amounts arrive as integer cents exactly as the server computed them. The client never
/// adds rows together: a missing, duplicated or inconsistent payload becomes an error so
/// the bill screen can say "unavailable" instead of showing a fabricated total.
struct LedgerDaySummary: Equatable, Identifiable {
    let day: String
    let expenseCents: Int64
    let incomeCents: Int64
    let count: Int

    var id: String { day }
}

enum LedgerDaySummaryError: LocalizedError {
    case invalidResponse
    case changedSnapshot

    var errorDescription: String? {
        switch self {
        case .invalidResponse: return "服务器返回的每日合计不完整，请刷新后重试。"
        case .changedSnapshot: return "账单已变化，请刷新后重试。"
        }
    }
}

/// Wire shape: `{items:[{day:"yyyy-MM-dd", expenseCents, incomeCents, count}], searchVersion?, searchRevision?}`.
struct LedgerDaySummaryPage: Decodable {
    struct Item: Decodable {
        let day: String
        let expenseCents: Int64
        let incomeCents: Int64
        let count: Int
    }

    let items: [Item]
    let searchVersion: Int?
    let searchRevision: String?

    /// Largest amount the server itself accepts (`Number.isSafeInteger`) and the client can
    /// render without losing cents.
    static let maximumCents: Int64 = 9_007_199_254_740_991
}

extension LedgerDaySummaryPage {
    /// Validates the additive payload and returns it keyed by day.
    ///
    /// Mirrors the Android `TransactionMonthLoader.decodeTransactionDaySummaries` rules:
    /// every field is checked, unknown/重复 days and out-of-scope days are rejected, and a
    /// search snapshot must carry the same revision as the list rows it is drawn beside.
    func validate(searching: Bool,
                  expectedSearchRevision: String?,
                  scope: (from: Int64, to: Int64)) throws -> [String: LedgerDaySummary] {
        if searching {
            guard searchVersion == 1, let revision = searchRevision, Self.isRevision(revision) else {
                throw LedgerDaySummaryError.invalidResponse
            }
            if let expected = expectedSearchRevision {
                guard Self.isRevision(expected),
                      revision.lowercased() == expected.lowercased() else {
                    throw LedgerDaySummaryError.changedSnapshot
                }
            }
        } else if let revision = searchRevision, !Self.isRevision(revision) {
            throw LedgerDaySummaryError.invalidResponse
        }

        var result: [String: LedgerDaySummary] = [:]
        result.reserveCapacity(items.count)
        for item in items {
            guard let start = Self.dayStart(item.day) else { throw LedgerDaySummaryError.invalidResponse }
            // A summary may only describe days inside the exact queried [from,to) window.
            guard start >= scope.from, start < scope.to else { throw LedgerDaySummaryError.invalidResponse }
            guard item.expenseCents >= 0, item.incomeCents >= 0,
                  item.expenseCents <= Self.maximumCents, item.incomeCents <= Self.maximumCents,
                  item.count >= 0 else { throw LedgerDaySummaryError.invalidResponse }
            guard result[item.day] == nil else { throw LedgerDaySummaryError.invalidResponse }
            result[item.day] = LedgerDaySummary(day: item.day,
                                                expenseCents: item.expenseCents,
                                                incomeCents: item.incomeCents,
                                                count: item.count)
        }
        return result
    }

    /// Count-only consistency check between the authoritative buckets and the rows already
    /// loaded. It deliberately performs no money arithmetic.
    ///
    /// The list pages 50 rows at a time, so a partially loaded day can legitimately show
    /// fewer rows than its bucket. Only a fully loaded scope must match exactly.
    static func validateCounts(rows: [LedgerTransaction],
                               total: Int,
                               summaries: [String: LedgerDaySummary]) throws {
        guard total >= 0, rows.count <= total else { throw LedgerDaySummaryError.invalidResponse }
        var rowCounts: [String: Int] = [:]
        for row in rows {
            rowCounts[LedgerFormat.dayKey(row.date), default: 0] += 1
        }
        let fullyLoaded = rows.count == total
        for (day, rowCount) in rowCounts {
            guard let summary = summaries[day], summary.day == day, summary.count >= rowCount else {
                throw LedgerDaySummaryError.invalidResponse
            }
            if fullyLoaded, summary.count != rowCount {
                throw LedgerDaySummaryError.invalidResponse
            }
        }
        if fullyLoaded {
            for day in summaries.keys where rowCounts[day] == nil {
                throw LedgerDaySummaryError.invalidResponse
            }
        }
    }

    /// Parses a `yyyy-MM-dd` bucket key in the displayed (Asia/Shanghai) calendar.
    /// Returns nil for malformed keys and for impossible dates such as `2026-02-31`.
    static func dayStart(_ day: String) -> Int64? {
        let parts = day.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3,
              parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
              parts.allSatisfy({ $0.allSatisfy { $0.isASCII && $0.isNumber } }),
              let year = Int(parts[0]), let month = Int(parts[1]), let date = Int(parts[2]),
              let value = LedgerBillDates.calendar.date(from: DateComponents(year: year, month: month, day: date))
        else { return nil }
        let roundTrip = LedgerBillDates.calendar.dateComponents([.year, .month, .day], from: value)
        guard roundTrip.year == year, roundTrip.month == month, roundTrip.day == date else { return nil }
        return LedgerBillDates.milliseconds(value)
    }

    static func isRevision(_ value: String) -> Bool {
        value.count == 64 && value.allSatisfy { character in
            guard let ascii = character.asciiValue else { return false }
            return (48...57).contains(ascii) || (97...102).contains(ascii) || (65...70).contains(ascii)
        }
    }
}

/// Builds the summary request for exactly the same filters as the visible list page.
/// The time zone must be an IANA name: the server rejects values that start with `+`/`-`.
enum LedgerDaySummaryRequest {
    static func path(for query: LedgerBillQuery, scope: (from: Int64, to: Int64)) -> String {
        var values: [(String, String)] = []
        let trimmed = query.text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { values.append(("search", trimmed)) }
        if let type = query.type { values.append(("type", String(type))) }
        if let accountId = query.accountId { values.append(("accountId", accountId)) }
        if let categoryId = query.categoryId { values.append(("categoryId", categoryId)) }
        if let tag = query.tag { values.append(("tag", tag)) }
        values.append(("from", String(scope.from)))
        values.append(("to", String(scope.to)))
        values.append(("timeZone", LedgerBillDates.summaryTimeZone))
        return LedgerURL.path("/transactions/daily-summary", values)
    }
}
