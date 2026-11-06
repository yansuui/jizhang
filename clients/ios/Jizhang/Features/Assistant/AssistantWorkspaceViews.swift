import SwiftUI

struct AssistantSelectionCard: View {
    @StateObject private var selection: AssistantSelectionStore
    let enabled: Bool
    let onGeneration: (AssistantGenerationSnapshot) -> Void
    init(api: APIClient, conversationID: String, value: JSONValue, enabled: Bool,
         onGeneration: @escaping (AssistantGenerationSnapshot) -> Void) {
        _selection = StateObject(wrappedValue: AssistantSelectionStore(api: api, conversationID: conversationID, value: value))
        self.enabled = enabled; self.onGeneration = onGeneration
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(selection.value["title"].stringValue ?? "请选择", systemImage: "checklist").font(.headline)
            if selection.isRange {
                Text("按账本日期选择（北京时间）").font(.caption).foregroundStyle(.secondary)
                DatePicker("开始日期", selection: $selection.from, displayedComponents: .date)
                    .environment(\.calendar, LedgerBillDates.calendar).environment(\.timeZone, LedgerBillDates.calendar.timeZone)
                    .disabled(selection.editingLocked)
                    .onChange(of: selection.from) { _, value in if selection.to < value { selection.to = value } }
                DatePicker("结束日期", selection: $selection.to, in: selection.from..., displayedComponents: .date)
                    .environment(\.calendar, LedgerBillDates.calendar).environment(\.timeZone, LedgerBillDates.calendar.timeZone)
                    .disabled(selection.editingLocked)
            } else {
                HStack {
                    TextField("搜索名称或备注", text: $selection.query).textFieldStyle(.roundedBorder)
                        .onSubmit { Task { await selection.page(0) } }
                    Button("搜索") { Task { await selection.page(0) } }
                }
                ForEach(Array((selection.value["items"].arrayValue ?? []).enumerated()), id: \.offset) { _, item in
                    if let id = item["id"].stringValue {
                        Button { selection.choose(id) } label: {
                            HStack(alignment: .top, spacing: 9) {
                                Image(systemName: selection.selected.contains(id) ? "checkmark.circle.fill" : "circle")
                                    .foregroundStyle(AppTheme.accent)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(item["title"].stringValue ?? "记录").foregroundStyle(.primary)
                                    if let subtitle = item["subtitle"].stringValue { Text(subtitle).font(.caption).foregroundStyle(.secondary) }
                                    if let cents = item["amountCents"].intValue { Text(LedgerFormat.money(cents)).font(.subheadline.monospacedDigit()) }
                                }
                                Spacer(minLength: 0)
                            }.padding(.vertical, 5).frame(maxWidth: .infinity, alignment: .leading)
                        }.buttonStyle(.plain)
                    }
                }
                HStack {
                    let offset = selection.value["page"]["offset"].intValue ?? 0
                    let limit = selection.value["page"]["limit"].intValue ?? 30
                    Button("上一页") { Task { await selection.page(max(0, offset - limit)) } }.disabled(offset == 0 || selection.loading)
                    Spacer()
                    if let total = selection.value["page"]["total"].intValue { Text("共 \(total) 项").font(.caption).foregroundStyle(.secondary) }
                    Spacer()
                    Button("下一页") { Task { await selection.page(offset + limit) } }
                        .disabled(selection.value["page"]["hasMore"].boolValue != true || selection.loading)
                }
            }
            if selection.expired { Text("选择卡已过期，请重新读取，账本尚未修改。").font(.caption).foregroundStyle(.secondary) }
            if let error = selection.error { Text(error).font(.caption).foregroundStyle(.secondary) }
            Button {
                Task { if let generation = await selection.answer() { onGeneration(generation) } }
            } label: {
                HStack { if selection.submitting { ProgressView() }; Text(selection.editingLocked && !selection.submitting ? "核对并重试同一选择" : "使用所选，继续处理") }
            }.buttonStyle(.borderedProminent).disabled(!enabled || !selection.canAnswer)
            Text("选择用于继续处理；涉及修改时仍会先展示草案。")
                .font(.caption2).foregroundStyle(.secondary)
        }.disabled(!enabled && !selection.submitting)
            .task { await selection.page(selection.value["page"]["offset"].intValue ?? 0) }
    }
}

@MainActor final class AssistantResultPageStore: ObservableObject {
    let api: APIClient; let conversationID: String; let messageID: String
    @Published private(set) var result: JSONValue
    @Published private(set) var loading = false
    @Published private(set) var error: String?
    init(api: APIClient, conversationID: String, messageID: String, result: JSONValue) {
        self.api = api; self.conversationID = conversationID; self.messageID = messageID; self.result = result
    }
    func page(_ offset: Int64) async {
        guard !loading else { return }; loading = true; error = nil; defer { loading = false }
        do {
            let response: JSONValue = try await api.request(AssistantWorkspacePath.base(conversationID) + "/results/" + AssistantPath.segment(messageID) + "/page", method: "POST",
                body: .object(["offset": .integer(max(0, offset)), "limit": .integer(30)]))
            guard !Task.isCancelled, response["result"]["toolName"].stringValue == result["toolName"].stringValue,
                  response["result"]["data"].objectValue != nil else { throw AssistantProtocolError.invalidSnapshot }
            result = response["result"]
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
}

struct AssistantWorkspaceResultCard: View {
    @ObservedObject var assistant: AssistantStore
    @StateObject private var page: AssistantResultPageStore
    let conversationID: String
    let messageID: String
    @Environment(\.openJizhangWorkspace) private var openWorkspace
    @Environment(\.jizhangCanManageInvitations) private var canManageInvitations
    init(assistant: AssistantStore, conversationID: String, messageID: String, result: JSONValue) {
        self.assistant = assistant; self.conversationID = conversationID; self.messageID = messageID
        _page = StateObject(wrappedValue: AssistantResultPageStore(api: assistant.api, conversationID: conversationID, messageID: messageID, result: result))
    }
    private var data: JSONValue { page.result["data"] }
    private var nativeRoute: NativeWorkspaceRoute? {
        guard var action = data["nativeAction"].objectValue else { return nil }
        action["conversationId"] = .string(conversationID)
        return NativeWorkspaceRoute(value: .object(action))
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if data["workspace"]["type"].stringValue == "selection" {
                AssistantSelectionCard(api: assistant.api, conversationID: conversationID, value: data["workspace"],
                    enabled: !assistant.thread(conversationID).composerLocked) { assistant.acceptWorkspaceGeneration($0, in: conversationID) }
            } else if let runID = data["run"]["runId"].stringValue {
                AssistantSpendingRunStatus(api: assistant.api, runID: runID, initial: data["run"],
                    assistant: assistant, conversationID: conversationID, messageID: messageID, onSuggestion: { _ in })
                    .id("\(assistant.api.identity):\(runID)")
            } else if data["actions"].arrayValue != nil {
                AssistantOrganizationCard(assistant: assistant, conversationID: conversationID, messageID: messageID, initial: data)
            } else {
                readableFacts
            }
            if let route = nativeRoute {
                    Button("打开相关功能", systemImage: "arrow.up.forward.app") { openWorkspace?(route) }
                        .buttonStyle(.bordered).disabled(openWorkspace == nil || (route.destination == .invitations && !canManageInvitations))
            }
        }
    }
    private var readableFacts: some View {
        VStack(alignment: .leading, spacing: 10) {
            let rows = AssistantToolPresentation.rows(data)
            ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                DisclosureGroup {
                    AssistantPreviewValues(value: row, context: page.result["toolName"].stringValue ?? "")
                } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(AssistantToolPresentation.rowTitle(row, index: index)).lineLimit(2)
                        HStack {
                            if let account = row["accountName"].stringValue { Text(account) }
                            if let category = row["categoryName"].stringValue { Text(category) }
                            if let cents = row["amountCents"].intValue ?? row["balanceCents"].intValue { Text(LedgerFormat.money(cents)).monospacedDigit() }
                        }.font(.caption).foregroundStyle(.secondary)
                    }
                }.padding(.vertical, 3)
            }
            if rows.isEmpty || data.objectValue?.keys.contains(where: { !["items", "rows", "entries", "transactions", "records"].contains($0) }) == true {
                DisclosureGroup(rows.isEmpty ? "查看结果" : "汇总与范围") {
                    let excluded = Set(["items", "rows", "entries", "transactions", "records", "nativeAction"])
                    AssistantPreviewValues(value: .object((data.objectValue ?? [:]).filter { !excluded.contains($0.key) }), context: page.result["toolName"].stringValue ?? "")
                }
            }
            if let offset = data["offset"].intValue, let total = data["total"].intValue {
                HStack {
                    Button("上一页") { Task { await page.page(max(0, offset - (data["limit"].intValue ?? 30))) } }.disabled(offset == 0 || page.loading)
                    Spacer()
                    Text("本页 \(rows.count) / 共 \(total) 项").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Button("下一页") { Task { await page.page(data["nextOffset"].intValue ?? (offset + Int64(rows.count))) } }
                        .disabled(data["hasMore"].boolValue != true || page.loading)
                }
            }
            if page.loading { ProgressView("正在读取…") }
            if let error = page.error { Text(error).font(.caption).foregroundStyle(.secondary) }
        }
    }
}

struct AssistantOrganizationCard: View {
    @ObservedObject var assistant: AssistantStore
    let conversationID: String
    let messageID: String
    @State private var card: JSONValue
    @State private var selected = Set<String>()
    @State private var loading = false
    @State private var error: String?
    init(assistant: AssistantStore, conversationID: String, messageID: String, initial: JSONValue) {
        self.assistant = assistant; self.conversationID = conversationID; self.messageID = messageID
        _card = State(initialValue: initial)
    }
    private var runID: String? { card["runId"].stringValue }
    private var actions: [JSONValue] { (card["actions"].arrayValue ?? []).filter {
        ["category", "category-suggestion", "tag", "category-merge", "tag-merge"].contains($0["kind"].stringValue ?? "") && $0["status"].stringValue != "blocked"
    } }
    private var key: String { "organization:" + messageID }
    private var expired: Bool { runID != nil && (card["expiresAt"].intValue ?? 0) <= Int64(Date().timeIntervalSince1970 * 1_000) }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("选择整理建议").font(.headline)
            Text("已选 \(selected.count) 项，最多 100 项。生成草案只预览，确认后才修改。")
                .font(.caption).foregroundStyle(.secondary)
            ForEach(Array(actions.enumerated()), id: \.offset) { index, action in
                if let id = action["actionId"].stringValue {
                    Toggle(isOn: Binding(get: { selected.contains(id) }, set: { on in
                        if on && selected.count < 100 { selected.insert(id) } else { selected.remove(id) }
                    })) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(action["sourceName"].stringValue.map { "\($0) → \(action["targetName"].stringValue ?? "")" }
                                ?? action["afterCategoryName"].stringValue.map { "分类改为\($0)" }
                                ?? action["proposedCategoryName"].stringValue.map { "建议分类：\($0)" }
                                ?? "第 \(index + 1) 项 · 更新标签")
                            if let cents = action["transactionAmountCents"].intValue { Text(LedgerFormat.money(cents)).font(.caption.monospacedDigit()) }
                            if let reason = action["reason"].stringValue { Text(reason).font(.caption).foregroundStyle(.secondary) }
                        }
                    }.tint(AppTheme.accent).disabled(assistant.workspacePendingBodies[key] != nil)
                    DisclosureGroup("修改前后与范围") { AssistantPreviewValues(value: action) }.font(.caption)
                }
            }
            if actions.isEmpty { Text("当前没有可应用的建议。").foregroundStyle(.secondary) }
            if let notes = card["noteSuggestions"].arrayValue, !notes.isEmpty {
                DisclosureGroup("备注参考（不会应用）") { AssistantPreviewValues(value: .array(notes)) }
            }
            if card["hasMore"].boolValue == true || (card["offset"].intValue ?? 0) > 0 {
                HStack {
                    let offset = card["offset"].intValue ?? 0
                    Button("上一页") { Task { await load(max(0, offset - (card["limit"].intValue ?? 30))) } }.disabled(offset == 0 || loading)
                    Spacer()
                    Button("下一页") { Task { await load(offset + (card["limit"].intValue ?? 30)) } }.disabled(card["hasMore"].boolValue != true || loading)
                }
            }
            Button {
                Task { _ = await assistant.prepareOrganization(in: conversationID, messageID: messageID, runID: runID, selected: selected) }
            } label: { HStack { if assistant.workspaceBusy.contains(key) { ProgressView() }; Text("为所选 \(selected.count) 项生成确认草案") } }
                .buttonStyle(.bordered).disabled(selected.isEmpty || expired || assistant.thread(conversationID).composerLocked || assistant.workspaceBusy.contains(key))
            if expired { Text("建议已过期，请重新分析后再选择。").font(.caption).foregroundStyle(.secondary) }
            if let error { Text(error).font(.caption).foregroundStyle(.secondary) }
        }
    }
    private func load(_ offset: Int64) async {
        guard !loading else { return }; loading = true; error = nil; defer { loading = false }
        do {
            let path: String
            var fields: [String: JSONValue] = ["offset": .integer(offset), "limit": .integer(30)]
            if let runID { path = "/organization/card"; fields["runId"] = .string(runID) }
            else { path = "/results/" + AssistantPath.segment(messageID) + "/page" }
            let response: JSONValue = try await assistant.api.request(AssistantWorkspacePath.base(conversationID) + path, method: "POST", body: .object(fields))
            guard !Task.isCancelled, response["result"]["data"]["actions"].arrayValue != nil else { throw AssistantProtocolError.invalidSnapshot }
            card = response["result"]["data"]
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
}

struct AssistantCapabilityView: View {
    @ObservedObject var assistant: AssistantStore
    let onTool: (JSONValue) -> Void
    @Environment(\.openJizhangWorkspace) private var openWorkspace
    @Environment(\.jizhangCanManageInvitations) private var canManageInvitations
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var itemAction: String?
    @State private var items: [JSONValue] = []
    @State private var itemError: String?
    var body: some View {
        List {
            if let error = assistant.workspaceError { Section { Text(error); Button("重试") { Task { await assistant.loadCapabilities() } } } }
            if itemAction != nil {
                Section("选择物品") {
                    if let itemError { Text(itemError) }
                    ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                        if let id = item["id"].stringValue, let destination = itemAction {
                            Button(AssistantToolPresentation.rowTitle(item, index: index)) {
                                open(.object(["destination": .string(destination), "itemId": .string(id)]))
                            }
                        }
                    }
                    Button("取消物品选择") { itemAction = nil }
                }
            }
            Section("在对话中处理") {
                ForEach(Array((assistant.workspaceCapabilities?["items"].arrayValue ?? []).filter(matches).enumerated()), id: \.offset) { _, item in
                    if let name = item["name"].stringValue {
                        Button { onTool(item); dismiss() } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(AssistantToolPresentation.title(name)).foregroundStyle(.primary)
                                Text(item["description"].stringValue ?? "").font(.caption).foregroundStyle(.secondary)
                                Text(item["access"].stringValue == "write" ? "修改前需要你的确认" : "读取与分析").font(.caption2).foregroundStyle(AppTheme.accent)
                            }.padding(.vertical, 3)
                        }
                    }
                }
            }
            Section("打开完整功能") {
                ForEach(Array((assistant.workspaceCapabilities?["nativeActions"].arrayValue ?? []).enumerated()), id: \.offset) { _, item in
                    Button(item["title"].stringValue ?? "打开功能") {
                        if item["requiresItem"].boolValue == true {
                            itemAction = item["destination"].stringValue
                            Task { await loadItems() }
                        } else { open(item) }
                    }.disabled(openWorkspace == nil || (item["requiresCapability"].stringValue == "manageInvitations" && !canManageInvitations))
                    if item["requiresCapability"].stringValue == "manageInvitations" && !canManageInvitations { Text("当前账户没有邀请管理权限").font(.caption).foregroundStyle(.secondary) }
                }
            }
        }.navigationTitle("助手能做什么").searchable(text: $query, prompt: "搜索功能")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } } }
            .task { await assistant.loadCapabilities() }
    }
    private func matches(_ item: JSONValue) -> Bool {
        query.isEmpty || AssistantToolPresentation.title(item["name"].stringValue ?? "").localizedCaseInsensitiveContains(query)
            || (item["description"].stringValue ?? "").localizedCaseInsensitiveContains(query)
    }
    private func open(_ value: JSONValue) {
        guard let route = NativeWorkspaceRoute(value: value) else { return }
        dismiss(); openWorkspace?(route)
    }
    private func loadItems() async {
        do { let response: JSONValue = try await assistant.api.request("/items"); items = response["items"].arrayValue ?? []; itemError = nil }
        catch { itemError = error.localizedDescription }
    }
}
