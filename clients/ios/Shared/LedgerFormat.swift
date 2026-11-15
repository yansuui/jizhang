import Foundation

/// Display formatting shared by the app and its widget extension. Money is rendered from integer
/// cents in both surfaces, so a widget can never disagree with the same value on screen.
enum LedgerFormat {
    static func money(_ cents: Int64) -> String {
        // Integer formatting avoids NumberFormatter's floating conversion for large cents.
        // magnitude also handles Int64.min without negating it and overflowing.
        let magnitude = cents.magnitude
        let whole = String(magnitude / 100)
        var groups: [String] = []
        var end = whole.endIndex
        while end > whole.startIndex {
            let start = whole.index(end, offsetBy: -3, limitedBy: whole.startIndex) ?? whole.startIndex
            groups.append(String(whole[start..<end]))
            end = start
        }
        let fraction = magnitude % 100
        return "¥" + (cents < 0 ? "-" : "") + groups.reversed().joined(separator: ",") + "." + (fraction < 10 ? "0" : "") + String(fraction)
    }

    static func date(_ milliseconds: Int64, time: Bool = false) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = TimeZone(identifier: "Asia/Shanghai")
        formatter.dateFormat = time ? "yyyy年M月d日 HH:mm" : "yyyy年M月d日"
        return formatter.string(from: Date(timeIntervalSince1970: Double(milliseconds) / 1_000))
    }

    static func dayKey(_ milliseconds: Int64) -> String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "Asia/Shanghai")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: Date(timeIntervalSince1970: Double(milliseconds) / 1_000))
    }

    static func ratio(bps: Int64) -> String {
        let amount = NSDecimalNumber(decimal: Decimal(bps) / 100)
        return amount.stringValue + "%"
    }

    static func accountType(_ type: Int) -> String {
        switch type {
        case 0: return "现金"
        case 1: return "储蓄卡"
        case 2: return "信用卡"
        case 3: return "支付宝"
        case 4: return "微信"
        default: return "其他账户"
        }
    }
}
