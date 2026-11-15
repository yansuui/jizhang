import Foundation

/// The four continuous funding purposes. Shared by the app and its widget extension so both
/// surfaces use one set of wire keys, titles and symbols.
enum LedgerPurpose: String, Decodable, CaseIterable, Identifiable {
    case growth, reserve, essentials, joy
    var id: String { rawValue }
    var title: String {
        switch self {
        case .growth: return "长期增长"
        case .reserve: return "应急储备"
        case .essentials: return "日常必要"
        case .joy: return "随心生活"
        }
    }
    var symbol: String {
        switch self {
        case .growth: return "chart.line.uptrend.xyaxis"
        case .reserve: return "shield.lefthalf.filled"
        case .essentials: return "house.fill"
        case .joy: return "sparkles"
        }
    }
}
