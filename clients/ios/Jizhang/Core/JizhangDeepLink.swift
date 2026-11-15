import Foundation

/// The tab the shell shows. It is file-scoped so the app can route a widget link into an existing
/// tab instead of rebuilding the whole shell for one deep link.
enum JizhangTab: Hashable {
    case home, bills, plan, assistant, my
}

/// Parses `jizhang://<tab>`. An unknown scheme, host or path returns nil, so a malformed URL can
/// never change the tab or fabricate navigation state.
struct JizhangDeepLink: Equatable {
    static let scheme = "jizhang"

    let tab: JizhangTab

    static func parse(_ url: URL) -> JizhangDeepLink? {
        guard url.scheme?.lowercased() == scheme else { return nil }
        let host = (url.host ?? "").trimmingCharacters(in: .whitespaces).lowercased()
        let path = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/")).lowercased()
        let value: String
        if host.isEmpty {
            // `jizhang:///plan` still names one tab; anything else after the host is not a command.
            value = path
        } else {
            guard path.isEmpty else { return nil }
            value = host
        }
        switch value {
        case "", "home": return JizhangDeepLink(tab: .home)
        case "bills": return JizhangDeepLink(tab: .bills)
        case "plan": return JizhangDeepLink(tab: .plan)
        case "assistant": return JizhangDeepLink(tab: .assistant)
        case "my": return JizhangDeepLink(tab: .my)
        default: return nil
        }
    }
}
