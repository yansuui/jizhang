import Foundation
import Combine

enum AssistantWorkspacePath {
    static func base(_ conversation: String) -> String { AssistantPath.conversation(conversation) + "/workspace" }
}

struct AssistantWorkspaceGenerationResponse: Decodable {
    let generation: AssistantGenerationSnapshot
}

struct AssistantWorkspaceMutationResponse: Decodable {
    struct Action: Decodable { let id: String; let conversationId: String; let status: String }
    let messages: [AssistantMessage]
    let action: Action
}

enum AssistantToolPresentation {
    static func title(_ name: String) -> String {
        let parts = name.split(separator: ".").map(String.init)
        let domains = ["transaction": "账单", "transactions": "账单", "account": "账户", "accounts": "账户",
            "category": "分类", "tag": "标签", "master-data": "基础资料", "transfer": "转账", "transfers": "转账",
            "trash": "回收站", "recurring": "周期账单", "funds": "四用途资金", "salary": "收入分配", "salaries": "收入分配",
            "plan": "计划", "planning": "资金执行", "goals": "储蓄与投资", "stats": "统计", "budget": "预算",
            "settings": "设置", "item": "物品", "items": "物品", "organization": "分类标签整理", "spending": "历史账单整理",
            "backup": "备份", "backups": "备份", "daily": "每日复盘", "monthly": "月度复盘", "workspace": "工作区",
            "capabilities": "功能目录", "platform-import": "账单导入"]
        let actions = ["create": "新增", "update": "修改", "delete": "删除", "remove": "移除", "restore": "恢复",
            "read": "查看", "query": "查询", "recent": "最近记录", "details": "详情", "daily": "日汇总", "balances": "余额",
            "list": "列表", "preview": "预览", "apply": "应用建议", "undo": "撤销整理", "status": "进度", "card": "建议",
            "resume": "继续分析", "evidence": "金额依据", "configure": "设置", "review": "核对", "save": "保存",
            "opening": "期初设置", "summary": "汇总", "overview": "概览", "monthly": "月度趋势", "evaluate": "复盘",
            "rules": "规则", "pending": "待处理", "generate": "生成待记账单", "confirm": "确认入账", "ignore": "忽略",
            "toggle": "启用状态", "sell": "出售", "retire": "停用", "move": "调整顺序", "rename": "重命名",
            "restore-all": "恢复全部", "purge": "永久删除", "purge-all": "清空", "export-links": "导出", "cycle": "周期",
            "mapping": "分类映射", "reconcile": "核对执行", "purpose": "用途", "refund-splits": "退款分摊", "select": "选择", "open": "打开"]
        return [domains[parts.first ?? ""] ?? "账本", actions[parts.last ?? ""] ?? "操作"].joined(separator: " · ")
    }

    static func rowTitle(_ item: JSONValue, index: Int) -> String {
        for field in ["title", "name", "note", "description", "dateLabel"] {
            if let value = item[field].stringValue, !value.isEmpty { return value }
        }
        if let month = item["month"].stringValue, !month.isEmpty { return month }
        if let date = item["date"].intValue, date > 1_000_000_000_000 { return LedgerFormat.date(date) }
        return "第 \(index + 1) 项"
    }

    static func rows(_ data: JSONValue) -> [JSONValue] {
        for field in ["items", "rows", "entries", "transactions", "records"] {
            if let values = data[field].arrayValue { return values }
        }
        return []
    }
}

@MainActor final class AssistantSelectionStore: ObservableObject {
    let api: APIClient
    let conversationID: String
    let interactionID: String
    @Published private(set) var value: JSONValue
    @Published var selected = Set<String>()
    @Published var query = ""
    @Published var from = Date()
    @Published var to = Date()
    @Published private(set) var loading = false
    @Published private(set) var submitting = false
    @Published private(set) var error: String?
    private var ticket = UUID()
    private var frozenBody: JSONValue?
    private var finished = false

    init(api: APIClient, conversationID: String, value: JSONValue) {
        self.api = api; self.conversationID = conversationID
        interactionID = value["id"].stringValue ?? ""
        self.value = value
    }
    var isRange: Bool { value["kind"].stringValue == "date-range" }
    var multiple: Bool { value["multiple"].boolValue == true }
    var expired: Bool { (value["expiresAt"].intValue ?? 0) <= Int64(Date().timeIntervalSince1970 * 1_000) }
    var canAnswer: Bool { !finished && !submitting && !loading && !interactionID.isEmpty && (frozenBody != nil || (!expired && value["status"].stringValue == "pending")) && (isRange ? from <= to : !selected.isEmpty) }
    var editingLocked: Bool { frozenBody != nil || submitting || finished }

    func choose(_ id: String) {
        guard !editingLocked, !id.isEmpty else { return }
        if multiple {
            if selected.contains(id) { selected.remove(id) }
            else if selected.count < 100 { selected.insert(id) }
        } else { selected = [id] }
    }

    func page(_ offset: Int64) async {
        guard !interactionID.isEmpty else { return }
        let current = UUID(); ticket = current; loading = true; error = nil
        defer { if ticket == current { loading = false } }
        do {
            var parts = URLComponents()
            parts.queryItems = [URLQueryItem(name: "offset", value: String(max(0, offset))), URLQueryItem(name: "limit", value: "30"), URLQueryItem(name: "q", value: query)]
            let response: JSONValue = try await api.request(AssistantWorkspacePath.base(conversationID) + "/interactions/" + AssistantPath.segment(interactionID) + (parts.string ?? ""))
            guard ticket == current, !Task.isCancelled else { return }
            let next = response["interaction"]
            guard next["id"].stringValue == interactionID, next["version"].intValue == 1,
                  next["items"].arrayValue != nil else { throw AssistantProtocolError.invalidSnapshot }
            value = next
        } catch { if ticket == current, !Task.isCancelled { self.error = error.localizedDescription } }
    }

    func answer() async -> AssistantGenerationSnapshot? {
        guard canAnswer else { return nil }
        let body: JSONValue
        if let frozenBody { body = frozenBody }
        else {
            var fields: [String: JSONValue] = ["clientRequestId": .string(UUID().uuidString)]
            if isRange {
                let format = DateFormatter(); format.locale = Locale(identifier: "en_US_POSIX")
                format.calendar = LedgerBillDates.calendar; format.timeZone = LedgerBillDates.calendar.timeZone; format.dateFormat = "yyyy-MM-dd"
                fields["dateRange"] = .object(["from": .string(format.string(from: from)), "to": .string(format.string(from: to)), "timeZone": .string(LedgerBillDates.summaryTimeZone)])
            } else { fields["selectedIds"] = .array(selected.sorted().map(JSONValue.string)) }
            body = .object(fields); frozenBody = body
        }
        submitting = true; error = nil
        defer { submitting = false }
        do {
            let response: AssistantWorkspaceGenerationResponse = try await api.request(AssistantWorkspacePath.base(conversationID) + "/interactions/" + AssistantPath.segment(interactionID) + "/answer", method: "POST", body: body)
            try response.generation.validate(conversation: conversationID)
            guard !Task.isCancelled else { return nil }
            finished = true
            return response.generation
        } catch {
            if let apiError = error as? APIError, (400..<500).contains(apiError.status), apiError.status != 408 { frozenBody = nil }
            self.error = frozenBody == nil ? error.localizedDescription : "选择结果待核对。重试会使用同一份选择，不会自动发起新任务。"
            return nil
        }
    }
}

enum AssistantDraftEditing {
    static func moneyCents(_ text: String) -> Int64? {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let negative = text.hasPrefix("-")
        let digits = negative ? String(text.dropFirst()) : text
        let parts = digits.split(separator: ".", omittingEmptySubsequences: false)
        guard (1...2).contains(parts.count), !parts[0].isEmpty,
              parts.allSatisfy({ $0.allSatisfy { $0 >= "0" && $0 <= "9" } }),
              parts.count == 1 || (1...2).contains(parts[1].count),
              let whole = Int64(parts[0]), whole <= 90_071_992_547_409 else { return nil }
        let fraction = parts.count == 2 ? Int64(parts[1].padding(toLength: 2, withPad: "0", startingAt: 0)) ?? 0 : 0
        let value = whole * 100 + fraction
        guard value <= 9_007_199_254_740_991 else { return nil }
        return negative ? -value : value
    }
    static func immutable(_ key: String) -> Bool {
        let lower = key.lowercased()
        return key.hasPrefix("__") || lower.contains("token") || lower.contains("revision") || lower.contains("fingerprint") || ["operationid", "contractversion"].contains(lower)
    }
    static func text(_ value: JSONValue) -> String {
        if let value = value.stringValue { return value }
        guard let bytes = try? JSONEncoder().encode(value) else { return "" }
        return String(data: bytes, encoding: .utf8) ?? ""
    }
    static func arguments(original: JSONValue, schema: JSONValue, edits: [String: String]) throws -> JSONValue {
        guard var object = original.objectValue else { throw AssistantProtocolError.invalidSnapshot }
        let properties = schema["properties"].objectValue ?? [:]
        for (key, text) in edits where !immutable(key) && properties[key] != nil {
            let definition = properties[key] ?? .null
            let type = definition["type"].stringValue
            if type == "string" || object[key]?.stringValue != nil { object[key] = .string(text) }
            else if let data = text.data(using: .utf8) {
                let value = try JSONDecoder().decode(JSONValue.self, from: data)
                if type == "integer", value.intValue == nil { throw LedgerDataError.invalidResponse }
                if type == "boolean", value.boolValue == nil { throw LedgerDataError.invalidResponse }
                if type == "array", value.arrayValue == nil { throw LedgerDataError.invalidResponse }
                if type == "object", value.objectValue == nil { throw LedgerDataError.invalidResponse }
                object[key] = value
            }
        }
        return .object(object)
    }
}
