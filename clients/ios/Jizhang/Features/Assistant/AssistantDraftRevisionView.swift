import SwiftUI

struct AssistantDraftRevisionView: View {
    @ObservedObject var assistant: AssistantStore
    let conversationID: String
    let card: JSONValue
    @Environment(\.dismiss) private var dismiss
    @State private var source: JSONValue?
    @State private var edits: [String: String] = [:]
    @State private var loading = true
    @State private var error: String?
    private var actionID: String { card["actionId"].stringValue ?? "" }
    private var key: String { "revise:" + actionID }
    private var fields: [String] { (source?["inputSchema"]["properties"].objectValue ?? [:]).keys.filter { !AssistantDraftEditing.immutable($0) }.sorted() }
    private var frozen: Bool { assistant.workspacePendingBodies[key] != nil }
    var body: some View {
        List {
            Section {
                Text(card["summary"].stringValue ?? "调整草案").font(.headline)
                Text("修改后会生成新的预览并关闭原草案；此处不会直接修改账本。")
                    .font(.subheadline).foregroundStyle(.secondary)
            }
            if loading { ProgressView("正在核对原草案…") }
            if let source {
                Section("修改内容") {
                    ForEach(fields, id: \.self) { field in
                        AssistantDraftField(api: assistant.api, field: field, schema: source["inputSchema"]["properties"][field],
                            original: source["arguments"][field], context: source["toolName"].stringValue ?? "",
                            transactionType: source["arguments"]["type"].intValue,
                            text: Binding(get: { edits[field] ?? AssistantDraftEditing.text(source["arguments"][field]) }, set: { edits[field] = $0 }))
                    }
                }.disabled(frozen || assistant.workspaceBusy.contains(key))
                Section("原始预览") { AssistantPreviewValues(value: card["preview"], context: source["toolName"].stringValue ?? "") }
                if frozen { Text("上次请求的结果仍需核对，修改内容已冻结。重试会使用同一份请求。").font(.caption).foregroundStyle(.secondary) }
                Section {
                    Button {
                        Task {
                            do {
                                let arguments = try AssistantDraftEditing.arguments(original: source["arguments"], schema: source["inputSchema"], edits: edits)
                                if await assistant.reviseDraft(card, in: conversationID, arguments: arguments) { dismiss() }
                            } catch { self.error = "请检查输入的金额、数字和明细格式，再重新预览。" }
                        }
                    } label: {
                        HStack { if assistant.workspaceBusy.contains(key) { ProgressView() }; Text(frozen ? "核对并重试原请求" : "生成新的确认预览") }
                    }.disabled(assistant.workspaceBusy.contains(key) || !assistant.canAct(on: card, in: conversationID))
                }
            }
            if let error { Text(error).foregroundStyle(.secondary) }
            if let notice = assistant.thread(conversationID).actionNotice { Text(notice).font(.caption).foregroundStyle(.secondary) }
        }.navigationTitle("调整草案").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } } }
            .interactiveDismissDisabled(assistant.workspaceBusy.contains(key))
            .task { await load() }
    }
    private func load() async {
        loading = true; defer { loading = false }
        do {
            let value: JSONValue = try await assistant.api.request(AssistantWorkspacePath.base(conversationID) + "/actions/" + AssistantPath.segment(actionID))
            let action = value["action"]
            guard !Task.isCancelled, action["id"].stringValue == actionID,
                  action["conversationId"].stringValue == conversationID, action["status"].stringValue == "pending",
                  action["arguments"].objectValue != nil, action["inputSchema"]["properties"].objectValue != nil else { throw AssistantProtocolError.invalidSnapshot }
            source = action; error = nil
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
}

private struct AssistantDraftField: View {
    let api: APIClient
    let field: String
    let schema: JSONValue
    let original: JSONValue
    let context: String
    let transactionType: Int64?
    @Binding var text: String
    @State private var choosingResource = false
    private var resource: String? {
        if field.lowercased().contains("accountid") { return "accounts" }
        if field == "categoryId" || (field == "parentId" && context.hasPrefix("category")) { return "categories" }
        return nil
    }
    var body: some View {
        Group {
            if let resource {
                Button { choosingResource = true } label: {
                    HStack { Text(AssistantPreviewFormat.label(field)); Spacer(); Text(text.isEmpty || text == "null" ? "请选择" : "已选择，可更换").foregroundStyle(.secondary); Image(systemName: "chevron.right") }
                }.sheet(isPresented: $choosingResource) {
                    NavigationStack { AssistantDraftResourcePicker(api: api, resource: resource, type: transactionType, selected: text) { text = $0; choosingResource = false } }
                }
            } else if let options = schema["enum"].arrayValue {
                Picker(AssistantPreviewFormat.label(field), selection: $text) {
                    ForEach(Array(options.enumerated()), id: \.offset) { _, option in
                        Text(AssistantPreviewFormat.scalar(option, key: field, context: context) ?? AssistantDraftEditing.text(option)).tag(AssistantDraftEditing.text(option))
                    }
                }
            } else if field.hasSuffix("Cents") {
                AssistantMoneyDraftField(label: AssistantPreviewFormat.label(field), original: original.intValue ?? 0, value: $text)
            } else if field == "date", original.intValue != nil {
                DatePicker("日期", selection: Binding(get: { Date(timeIntervalSince1970: Double(Int64(text) ?? original.intValue ?? 0) / 1_000) },
                    set: { text = String(Int64($0.timeIntervalSince1970 * 1_000)) }), displayedComponents: .date)
            } else if schema["type"].stringValue == "boolean" || original.boolValue != nil {
                Toggle(AssistantPreviewFormat.label(field), isOn: Binding(get: { text == "true" }, set: { text = $0 ? "true" : "false" }))
            } else if schema["type"].stringValue == "object" || schema["type"].stringValue == "array" || original.objectValue != nil || original.arrayValue != nil {
                DisclosureGroup(AssistantPreviewFormat.label(field)) {
                    TextEditor(text: $text).font(.system(.footnote, design: .monospaced)).frame(minHeight: 130)
                    Text("调整明细后重新预览，确认前不会执行。").font(.caption).foregroundStyle(.secondary)
                }
            } else {
                TextField(AssistantPreviewFormat.label(field), text: $text, axis: .vertical)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
            }
        }
    }
}

private struct AssistantMoneyDraftField: View {
    let label: String
    let original: Int64
    @Binding var value: String
    @State private var display = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            TextField(label + "（元）", text: Binding(get: { display }, set: { next in
                display = next; value = AssistantDraftEditing.moneyCents(next).map { String($0) } ?? "invalid-money"
            })).keyboardType(.decimalPad)
            if !display.isEmpty && AssistantDraftEditing.moneyCents(display) == nil { Text("请输入最多两位小数的有效金额。").font(.caption).foregroundStyle(.red) }
        }.onAppear { if display.isEmpty { display = NSDecimalNumber(value: Int64(value) ?? original).dividing(by: NSDecimalNumber(value: 100)).stringValue } }
    }
}

private struct AssistantDraftResourcePicker: View {
    let api: APIClient
    let resource: String
    let type: Int64?
    let selected: String
    let onSelect: (String) -> Void
    @State private var items: [JSONValue] = []
    @State private var query = ""
    @State private var loading = false
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        List {
            if loading { ProgressView() }
            if let error { Text(error); Button("重试") { Task { await load() } } }
            ForEach(Array(items.filter { item in
                (resource != "categories" || type == nil || item["type"].intValue == type) &&
                (query.isEmpty || (item["name"].stringValue ?? "").localizedCaseInsensitiveContains(query))
            }.enumerated()), id: \.offset) { _, item in
                if let id = item["id"].stringValue {
                    Button { onSelect(id) } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(item["name"].stringValue ?? "记录").foregroundStyle(.primary)
                                if let parent = item["parentId"].stringValue, let name = items.first(where: { $0["id"].stringValue == parent })?["name"].stringValue { Text(name).font(.caption).foregroundStyle(.secondary) }
                                if resource == "accounts", let kind = item["type"].intValue { Text(LedgerFormat.accountType(Int(kind))).font(.caption).foregroundStyle(.secondary) }
                            }
                            Spacer(); if id == selected { Image(systemName: "checkmark") }
                        }
                    }
                }
            }
        }.searchable(text: $query, prompt: "搜索名称").navigationTitle(resource == "accounts" ? "选择账户" : "选择分类")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } } }.task { await load() }
    }
    private func load() async {
        loading = true; defer { loading = false }
        do {
            let response: JSONValue = try await api.request("/" + resource)
            guard !Task.isCancelled, let rows = response["items"].arrayValue else { throw AssistantProtocolError.invalidSnapshot }
            items = rows; error = nil
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
}
