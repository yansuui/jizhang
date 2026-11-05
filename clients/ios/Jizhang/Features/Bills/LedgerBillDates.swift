import Foundation

/// Date filters use the same calendar as the bill's displayed date, not device timezone.
enum LedgerBillDates {
    static var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Shanghai")!
        return calendar
    }

    static func milliseconds(_ date: Date) -> Int64 { Int64((date.timeIntervalSince1970 * 1_000).rounded()) }

    static func month(containing date: Date) -> (from: Int64, to: Int64) {
        let interval = calendar.dateInterval(of: .month, for: date)!
        return (milliseconds(interval.start), milliseconds(interval.end))
    }

    static func range(start: Date, end: Date) -> (from: Int64, to: Int64)? {
        let first = calendar.startOfDay(for: start)
        let last = calendar.startOfDay(for: end)
        guard first <= last, let exclusive = calendar.date(byAdding: .day, value: 1, to: last) else { return nil }
        return (milliseconds(first), milliseconds(exclusive))
    }

    static func title(query: LedgerBillQuery) -> String {
        guard let from = query.from, let to = query.to else { return "全部日期" }
        let date = Date(timeIntervalSince1970: Double(from) / 1_000)
        let month = month(containing: date)
        if month.from == from && month.to == to {
            let parts = calendar.dateComponents([.year, .month], from: date)
            return "\(parts.year ?? 0)年\(parts.month ?? 0)月"
        }
        return LedgerFormat.date(from) + " – " + LedgerFormat.date(to - 1)
    }

    static func isWholeMonth(_ query: LedgerBillQuery) -> Bool {
        guard let from = query.from, let to = query.to else { return false }
        let bounds = month(containing: Date(timeIntervalSince1970: Double(from) / 1_000))
        return bounds.from == from && bounds.to == to
    }

    /// The daily-summary endpoint only groups one calendar month (maximum 32 days).
    static let maximumSummarySpan: Int64 = 32 * 86_400_000

    /// IANA name required by `GET /transactions/daily-summary`.
    /// `Calendar.timeZone.identifier` is used directly: a fixed offset such as `+08:00`
    /// is rejected by the server, and this client never converts one into a guessed zone.
    static var summaryTimeZone: String { calendar.timeZone.identifier }

    /// The exact `[from, to)` window the server may summarise, or `nil` when this query
    /// cannot have authoritative daily totals (all dates, a custom range or more than 32 days).
    static func summaryScope(_ query: LedgerBillQuery) -> (from: Int64, to: Int64)? {
        guard let from = query.from, let to = query.to,
              from < to, to - from <= maximumSummarySpan,
              isWholeMonth(query) else { return nil }
        return (from, to)
    }

    /// Shown instead of per-day totals when the current filter cannot be summarised.
    static let dailySummaryHint = "选择整月后可查看每日合计。"

    /// A brand-new bills screen starts on the current month, while an explicit caller query
    /// (account, category, tag) keeps its own date selection unchanged.
    static func monthQuery(containing date: Date) -> LedgerBillQuery {
        var query = LedgerBillQuery()
        let bounds = month(containing: date)
        query.from = bounds.from
        query.to = bounds.to
        return query
    }
}
