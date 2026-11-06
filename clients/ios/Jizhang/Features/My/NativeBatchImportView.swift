import SwiftUI
import UniformTypeIdentifiers

@MainActor struct NativeBatchImportView: View {
    @StateObject private var store: NativeBatchImportStore
    @State private var picking = false
    @State private var replacingIndex: Int64?
    @State private var confirmCancel = false
    @State private var removeIndex: Int64?
    @State private var duplicateRow: NativeDuplicateSelection?
    @State private var refresh = UUID()
    @Environment(\.recordJizhangNativeResult) private var recordResult
    init(api: APIClient, conversationID: String?, batchID: String?, sourceMessageID: String? = nil) {
        _store = StateObject(wrappedValue: NativeWorkspaceSessions.batch(api, conversationID: conversationID, batchID: batchID, sourceMessageID: sourceMessageID))
    }
    var body: some View {
        List {
            fileSection
            if store.batchID != nil {
                overview
                if store.result == nil && !store.terminal {
                    categorySection
                    Section("核对记录 · 已选 \(store.selected.count) 条") {
                        Text("逐条选择需要导入的记录。冲突组只保留你明确选择的一条；已有和被忽略的记录不可导入。")
                            .font(.footnote).foregroundStyle(.secondary)
                        ForEach(store.rows, id: \.batchRowIdentity) { row in batchRow(row) }
                        if store.hasMore { Button("加载更多记录") { Task { await store.next() } }.disabled(!store.editable) }
                        Button("生成所选记录的最终预览") { Task { await store.prepareReview() } }
                            .disabled(!store.editable || store.selected.isEmpty || !store.originalsAvailable || store.analysisRunning)
                    }
                }
                if let review = store.review {
                    Section("最终预览 · 尚未写入") {
                        NativeImportReviewSummary(value: review["summary"])
                        if store.result == nil {
                            Button(store.uncertain ? "核对并重试同一确认" : "确认导入上面这些记录") { Task { await store.confirm() } }
                                .buttonStyle(.borderedProminent).disabled(store.busy)
                        }
                    }
                }
                if let result = store.result {
                    Section("导入完成") { Label("已确认写入", systemImage: "checkmark.circle.fill"); AssistantPreviewValues(value: result) }
                }
            }
            if store.busy { ProgressView("正在处理…") }
            if let error = store.error { Text(error).foregroundStyle(.red) }
            if store.mutationPending { Button("重试原文件变更") { Task { await store.retryMutation() } }.disabled(store.busy) }
        }
        .navigationTitle("微信 / 支付宝导入")
        .onAppear { reportResult() }
        .onChange(of: store.result) { _, _ in reportResult() }
        .task { if store.batchID != nil { await store.refresh() } }
        .task(id: (store.batchID ?? "") + refresh.uuidString) {
            for _ in 0..<200 {
                guard !Task.isCancelled, store.analysisRunning else { return }
                do { try await Task.sleep(for: .seconds(3)) } catch { return }
                await store.refresh()
                if store.error != nil { return }
            }
        }
        .fileImporter(isPresented: $picking,
                      allowedContentTypes: [.commaSeparatedText, UTType(filenameExtension: "xlsx") ?? .data],
                      allowsMultipleSelection: replacingIndex == nil) { result in
            do {
                let urls = try result.get()
                let files = try urls.map { try NativeBillFile.read($0) }
                if let index = replacingIndex, let file = files.first {
                    Task { await store.mutateFiles(index: index, replacement: file) }
                } else { Task { await store.attach(files) } }
                replacingIndex = nil
            } catch { if (error as NSError).code != NSUserCancelledError { store.error = error.localizedDescription } }
        }
        .sheet(item: $duplicateRow) { row in
            NavigationStack { NativeDuplicateComparisonView(store: store, row: row.row) }
        }
        .confirmationDialog("取消整个导入批次？", isPresented: $confirmCancel, titleVisibility: .visible) {
            Button("确认取消批次", role: .destructive) { Task { await store.cancel() } }
        } message: { Text("不会修改账本。已经确认导入的批次不能通过取消撤销。") }
        .confirmationDialog("移除此文件并重新融合？", isPresented: Binding(get: { removeIndex != nil }, set: { if !$0 { removeIndex = nil } }), titleVisibility: .visible) {
            Button("确认移除", role: .destructive) {
                if let index = removeIndex { Task { await store.mutateFiles(index: index, replacement: nil) } }
                removeIndex = nil
            }
        } message: { Text("原有选择和审核预览将失效，需要重新核对。") }
    }
    private func reportResult() {
        guard store.result != nil, let id = store.batchID else { return }
        recordResult?(.object(["kind": .string("platform-import"), "batchId": .string(id)]))
    }

    private var fileSection: some View {
        Section("原始账单文件") {
            Text("选择 1–5 个微信 XLSX / 支付宝 CSV，单个不超过 5 MiB、合计不超过 8 MiB。文件只发送到当前服务器。")
                .font(.footnote).foregroundStyle(.secondary)
            if store.batchID == nil || !store.originalsAvailable {
                Button(store.batchID == nil ? "选择文件并解析" : "重新附加本批次原文件") { replacingIndex = nil; picking = true }
                    .disabled(!store.editable)
            }
            ForEach(store.batch["files"].arrayValue ?? [], id: \.batchFileIdentity) { file in
                VStack(alignment: .leading, spacing: 6) {
                    Text(file["fileName"].stringValue ?? "文件").font(.subheadline.weight(.medium))
                    Text(file["parseStatus"].stringValue == "ok" ? "解析成功" : "解析未完成").font(.caption).foregroundStyle(.secondary)
                    if file["parseStatus"].stringValue != "ok" { Text("请核对格式或替换原文件。").font(.footnote).foregroundStyle(.red) }
                    if store.originalsAvailable, let index = file["fileIndex"].intValue {
                        HStack {
                            Button("替换文件") { replacingIndex = index; picking = true }
                            if (store.batch["files"].arrayValue?.count ?? 0) > 1 { Button("移除", role: .destructive) { removeIndex = index } }
                        }.disabled(!store.editable)
                    }
                }
            }
        }
    }
    private var overview: some View {
        Section("批次状态") {
            Text(statusTitle)
            AssistantPreviewValues(value: store.batch["summary"])
            if let message = store.batch["analysis"]["message"].stringValue { Text(message).font(.footnote).foregroundStyle(.secondary) }
            Button("刷新批次与进度") { Task { await store.refresh(); refresh = UUID() } }.disabled(store.busy)
            if !store.terminal {
                Button(store.analysisRunning ? "AI 正在分析" : "用 AI 分析分类建议") {
                    Task { await store.analyse(); refresh = UUID() }
                }.disabled(!store.editable || !store.originalsAvailable || store.analysisRunning)
                Text("AI 分析只提供建议；每次点击才会调用模型，仍需你选中并确认导入。").font(.footnote).foregroundStyle(.secondary)
                Button("取消批次", role: .destructive) { confirmCancel = true }.disabled(!store.editable)
            } else {
                Button("开始新的导入") { store.startNew() }.disabled(store.busy)
            }
            if !store.originalsAvailable && !store.terminal { Text("请附加全部原文件后进行分析、文件变更或最终确认。").font(.footnote).foregroundStyle(.secondary) }
        }
    }
    private var statusTitle: String {
        switch store.batch["status"].stringValue {
        case "confirmed": return "已导入"
        case "cancelled": return "已取消"
        case "expired": return "批次已过期"
        case "failed": return "批次未完成"
        case "reviewed": return "预览已生成，等待确认"
        default: return store.analysisRunning ? "正在分析建议" : "待核对"
        }
    }
    @ViewBuilder private var categorySection: some View {
        let suggestions = store.categories["items"].arrayValue ?? []
        if !suggestions.isEmpty {
            Section("新分类建议 · 需明确批准") {
                ForEach(suggestions, id: \.suggestionIdentity) { suggestion in
                    if let id = suggestion["suggestionId"].stringValue {
                        VStack(alignment: .leading, spacing: 8) {
                            Toggle(suggestion["name"].stringValue ?? "分类建议", isOn: Binding(
                                get: { store.approved[id] != nil }, set: { store.approve(suggestion, on: $0) }))
                            if let approved = store.approved[id] {
                                TextField("分类名称", text: Binding(get: { store.approved[id]?["name"].stringValue ?? "" },
                                    set: { store.editApproval(id, key: "name", value: .string($0)) }))
                                Picker("创建或复用", selection: Binding(get: { store.approved[id]?["reuseCategoryId"].stringValue ?? "" },
                                    set: { store.editApproval(id, key: "reuseCategoryId", value: $0.isEmpty ? .null : .string($0)) })) {
                                    Text("创建此新分类").tag("")
                                    ForEach(leafCategories(type: approved["type"].intValue), id: \.categoryIdentity) { category in
                                        Text(category["name"].stringValue ?? "").tag(category["id"].stringValue ?? "")
                                    }
                                }
                            }
                        }.disabled(!store.editable)
                    }
                }
            }
        }
    }
    private func leafCategories(type: Int64?) -> [JSONValue] {
        let all = store.categories["categories"].arrayValue ?? []
        return all.filter { item in
            item["type"].intValue == type && !all.contains { $0["parentId"].stringValue == item["id"].stringValue }
        }
    }
    @ViewBuilder private func batchRow(_ row: JSONValue) -> some View {
        if let id = row["itemId"].stringValue {
            VStack(alignment: .leading, spacing: 9) {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(row["dateLabel"].stringValue ?? "日期未提供").font(.caption).foregroundStyle(.secondary)
                        Text(row["note"].stringValue ?? "").lineLimit(3)
                    }
                    Spacer()
                    if let amount = row["amountCents"].intValue { Text(LedgerFormat.money(amount)).monospacedDigit() }
                }
                if row["isRefund"].boolValue == true { Label("退款计入收入", systemImage: "arrow.uturn.backward").font(.caption) }
                if row["existing"].boolValue == true { Text("已导入，不能重复选择").font(.caption).foregroundStyle(.secondary) }
                else if row["ignored"].boolValue == true { Text(row["ignoreReason"].stringValue ?? "已被规则忽略").font(.caption).foregroundStyle(.secondary) }
                else {
                    Toggle(row["conflictGroup"].stringValue == nil ? "选择此记录" : "本冲突组仅采用此记录",
                           isOn: Binding(get: { store.selected.contains(id) }, set: { store.toggle(row, on: $0) }))
                        .disabled(!store.editable)
                }
                if row["possibleDuplicate"].boolValue == true || row["conflictGroup"].stringValue != nil {
                    Button("对比来源与现有账单") { duplicateRow = NativeDuplicateSelection(row: row) }
                }
                DisclosureGroup("来源与完整备注") {
                    Text(row["note"].stringValue ?? "").textSelection(.enabled)
                    AssistantPreviewValues(value: row["sources"])
                    if let warning = row["refundWarning"].stringValue { Text(warning).font(.footnote) }
                }
                if store.selected.contains(id) {
                    Picker("分类", selection: Binding(get: { store.assignment(id) }, set: { store.setAssignment(id, value: $0) })) {
                        Text("采用当前有效建议").tag("")
                        ForEach(leafCategories(type: row["type"].intValue), id: \.categoryIdentity) { category in
                            Text(category["name"].stringValue ?? "").tag(category["id"].stringValue ?? "")
                        }
                        ForEach((store.categories["items"].arrayValue ?? []).filter { $0["type"] == row["type"] }, id: \.suggestionIdentity) { suggestion in
                            Text("建议：" + (suggestion["name"].stringValue ?? "")).tag("suggestion:" + (suggestion["suggestionId"].stringValue ?? ""))
                        }
                    }.disabled(!store.editable)
                    TextField("修改备注（留空表示清空）", text: Binding(get: { store.notes[id] ?? row["note"].stringValue ?? "" },
                        set: { store.setNote(id, note: $0) }), axis: .vertical).disabled(!store.editable)
                    Text(store.notes[id] == nil ? "未修改时保留原始完整备注。" : "修改后的备注最多 200 字，最终预览会显示实际写入内容。")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }.padding(.vertical, 7)
        }
    }
}

private extension JSONValue {
    var batchRowIdentity: String { self["itemId"].stringValue ?? "" }
    var batchFileIdentity: String { self["fileIndex"].intValue.map(String.init) ?? "" }
    var categoryIdentity: String { self["id"].stringValue ?? "" }
    var suggestionIdentity: String { self["suggestionId"].stringValue ?? "" }
}

private struct NativeDuplicateSelection: Identifiable {
    let row: JSONValue
    var id: String { row["itemId"].stringValue ?? "" }
}

@MainActor private struct NativeDuplicateComparisonView: View {
    let store: NativeBatchImportStore
    let row: JSONValue
    @Environment(\.dismiss) private var dismiss
    @State private var pages: [JSONValue] = []
    @State private var cursor: String?
    @State private var busy = false
    @State private var error: String?
    var body: some View {
        List {
            Section("待导入记录") { AssistantPreviewValues(value: row) }
            ForEach(Array(pages.enumerated()), id: \.offset) { _, page in
                Section("服务器比对") { AssistantPreviewValues(value: page) }
            }
            if busy { ProgressView() }
            if let error { Text(error).foregroundStyle(.red) }
            if cursor != nil { Button("加载更多对比") { Task { await load() } }.disabled(busy) }
        }.navigationTitle("重复与冲突对比")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("完成") { dismiss() } } }
            .task { await load() }
    }
    private func load() async {
        guard !busy else { return }; busy = true; error = nil; defer { busy = false }
        do {
            let page = try await store.duplicates(row, cursor: cursor)
            try Task.checkCancellation(); pages.append(page); cursor = page["nextCursor"].stringValue
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
}

@MainActor private struct NativeImportReviewSummary: View {
    let value: JSONValue
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let count = value["selected"].intValue { Text("确认将导入 \(count) 条").font(.headline) }
            if let expense = value["expenseCents"].intValue { LabeledContent("支出", value: LedgerFormat.money(expense)) }
            if let income = value["incomeCents"].intValue { LabeledContent("收入（含退款）", value: LedgerFormat.money(income)) }
            if let refund = value["refundIncomeCents"].intValue { LabeledContent("其中退款收入", value: LedgerFormat.money(refund)) }
            DisclosureGroup("逐条查看最终分类、备注与范围") { AssistantPreviewValues(value: value) }
        }
    }
}
