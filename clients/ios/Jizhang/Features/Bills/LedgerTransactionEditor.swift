import SwiftUI

@MainActor struct LedgerTransactionEditor: View {
    let api: APIClient
    let onSaved: () -> Void
    private let editing: Bool
    @Environment(\.dismiss) private var dismiss
    @StateObject private var store: LedgerTransactionEditorStore
    @State private var availableTags: [LedgerTag] = []
    @State private var tagLoadError: String?
    @State private var activeSheet: EditorSheet?

    /// One sheet binding for the whole editor: stacking a second `.sheet` on the same presenter
    /// is what silently drops a presentation on iOS.
    private enum EditorSheet: String, Identifiable {
        case tags, refundSources
        var id: String { rawValue }
    }

    init(api: APIClient, transaction: LedgerTransaction? = nil, refundOf: LedgerTransaction? = nil, onSaved: @escaping () -> Void) {
        self.api = api
        self.onSaved = onSaved
        editing = transaction != nil
        _store = StateObject(wrappedValue: LedgerTransactionEditorStore(transaction: transaction, refundOf: refundOf))
    }

    private var categories: [LedgerCategory] { store.metadata.categories.filter { $0.type == store.draft.type.rawValue } }
    private var blocked: Bool { store.loading || store.saving || store.awaitingReconciliation || !store.ready }

    var body: some View {
        NavigationStack {
            Form {
                if store.loading { ProgressView("正在读取分类和账户…") }
                if let error = store.error {
                    Section {
                        Text(error).font(.subheadline).foregroundStyle(.red)
                        if !store.ready && !store.loading && !store.awaitingReconciliation {
                            Button("重新读取") { Task { await store.load(api: api) } }
                        }
                    }
                }
                if store.awaitingReconciliation {
                    Section("待核对的提交") {
                        Text("这份草稿已锁定。关闭后重新打开记账入口，仍可核对原提交。")
                            .font(.footnote).foregroundStyle(.secondary)
                        Button("核对是否已保存") { Task { if await store.reconcile(api: api) { finish() } } }
                        Button("重试原提交") { Task { if await store.save(api: api, retryPending: true) { finish() } } }
                    }.disabled(store.saving)
                }
                if let latest = store.conflictSource {
                    Section("服务器上的最新原单（供核对）") {
                        DisclosureGroup("展开对照最新原单") {
                            LedgerBillDetailContent(transaction: latest, metadata: store.metadata)
                        }
                    }
                }
                Group {
                    Section {
                        if store.draft.isRefund {
                            Label("退款收入", systemImage: "arrow.uturn.backward")
                        } else {
                            Picker("收支类型", selection: Binding(get: { store.draft.type }, set: { type in
                                store.draft.type = type
                                store.draft.categoryId = store.metadata.categories.first { $0.type == type.rawValue }?.id ?? ""
                            })) {
                                Text("支出").tag(LedgerBillKind.expense)
                                Text("收入").tag(LedgerBillKind.income)
                            }.pickerStyle(.segmented)
                        }
                        HStack(alignment: .firstTextBaseline) {
                            Text("¥").font(.title2)
                            TextField("0.00", text: $store.draft.amount)
                                .font(.system(.largeTitle, design: .rounded).weight(.semibold))
                                .keyboardType(.decimalPad).monospacedDigit()
                                .accessibilityLabel("金额，单位元，可用加号减号计算")
                        }.padding(.top, 8)
                        HStack(spacing: 10) {
                            calculatorKey("+", label: "加") { store.appendAmountOperator("+") }
                            calculatorKey("−", label: "减") { store.appendAmountOperator("-") }
                            calculatorKey("=", label: "计算合计", emphasized: true) { store.commitAmountExpression() }
                        }.padding(.vertical, 6)
                        if let total = LedgerAmountExpression.totalText(store.draft.amount) {
                            Text("= " + total).font(.footnote).monospacedDigit().foregroundStyle(.secondary)
                        }
                    }
                    Section("账单信息") {
                        Picker("分类", selection: $store.draft.categoryId) {
                            if !categories.contains(where: { $0.id == store.draft.categoryId }) {
                                Text(store.draft.categoryId.isEmpty ? "请选择分类" : "保留原分类（已停用）").tag(store.draft.categoryId)
                            }
                            ForEach(categories) { Text($0.name).tag($0.id) }
                        }
                        Picker("账户", selection: $store.draft.accountId) {
                            if !store.metadata.accounts.contains(where: { $0.id == store.draft.accountId }) {
                                Text(store.draft.accountId.isEmpty ? "请选择账户" : (editing ? "保留原账户（已停用）" : "请选择有效账户（原账户已停用）")).tag(store.draft.accountId)
                            }
                            ForEach(store.metadata.accounts) { Text($0.name).tag($0.id) }
                        }
                        DatePicker("日期", selection: $store.draft.date, displayedComponents: [.date, .hourAndMinute])
                            .environment(\.timeZone, LedgerBillDates.calendar.timeZone)
                        if !store.draft.isRefund {
                            Picker("资金用途", selection: $store.draft.purpose) {
                                Text("不指定").tag(LedgerPurpose?.none)
                                ForEach(LedgerPurpose.allCases) { Text($0.title).tag(Optional($0)) }
                            }
                        }
                    }
                    if store.draft.type == .income {
                        Section("退款关联") {
                            Toggle("这是退款", isOn: Binding(get: { store.draft.isRefund },
                                                           set: { store.setRefund($0) }))
                            if store.draft.isRefund {
                                Button { activeSheet = .refundSources } label: {
                                    HStack {
                                        Text("关联原支出")
                                        Spacer(minLength: 8)
                                        Text(store.draft.refundLinkedTxIds.isEmpty
                                             ? "请选择" : "已选 \(store.draft.refundLinkedTxIds.count) 笔")
                                            .foregroundStyle(.secondary)
                                    }
                                }
                                Text("退款单独计入收入，原支出金额不会被改写。")
                                    .font(.footnote).foregroundStyle(.secondary)
                            }
                        }
                    }
                    Section {
                        TextField("备注（选填）", text: $store.draft.note, axis: .vertical).lineLimit(2...5)
                        TextField("标签，用逗号分隔（选填）", text: $store.draft.tags)
                        Button("选择已有标签") { activeSheet = .tags }
                    }
                    Section {
                        Button { save() } label: {
                            HStack {
                                Spacer()
                                if store.saving { ProgressView() } else { Text(editing ? "保存修改" : "保存账单").bold() }
                                Spacer()
                            }.padding(.vertical, 6)
                        }.disabled(blocked)
                    }
                }.disabled(blocked)
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle(editing ? "编辑账单" : (store.draft.isRefund ? "记录退款" : "记一笔"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(store.awaitingReconciliation ? "暂时关闭" : "取消") { dismiss() }.disabled(store.saving)
                }
                ToolbarItem(placement: .confirmationAction) { Button("保存") { save() }.disabled(blocked) }
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("收起键盘") { UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil) }
                }
            }
            .interactiveDismissDisabled(store.saving || store.awaitingReconciliation)
            .task { await store.load(api: api) }
            .sheet(item: $activeSheet) { sheet in
                switch sheet {
                case .tags: tagPicker
                case .refundSources:
                    LedgerRefundSourcePicker(api: api, metadata: store.metadata,
                                             selectedIds: $store.draft.refundLinkedTxIds)
                }
            }
        }
    }

    /// Calculator keys: `+` / `-` edit the amount text, `=` collapses it into one number.
    private func calculatorKey(_ title: String, label: String, emphasized: Bool = false,
                               action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.title3.weight(.semibold))
                .foregroundStyle(emphasized ? AppTheme.accent : Color.primary)
                .frame(maxWidth: .infinity, minHeight: 40)
                .background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    private var tagPicker: some View {
        NavigationStack {
            List {
                if let tagLoadError {
                    Text(tagLoadError).foregroundStyle(.secondary)
                    Button("重试") { Task { await loadTags() } }
                } else if availableTags.isEmpty {
                    Text("暂无标签，可以在账单中手动填写。")
                        .foregroundStyle(.secondary)
                }
                ForEach(availableTags) { tag in
                    Button {
                        store.draft.tags = LedgerBillTagSelection.toggling(tag.name, in: store.draft.tags)
                    } label: {
                        HStack {
                            Text(tag.name)
                            Spacer()
                            if LedgerBillTagSelection.names(in: store.draft.tags).contains(tag.name) {
                                Image(systemName: "checkmark")
                            }
                        }
                    }
                }
            }
            .navigationTitle("选择标签")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { activeSheet = nil } } }
            .task { await loadTags() }
        }
    }

    private func loadTags() async {
        do {
            let page: LedgerPage<LedgerTag> = try await api.request("/tags/hierarchy")
            guard !Task.isCancelled else { return }
            availableTags = page.items
            tagLoadError = nil
        } catch {
            guard !Task.isCancelled else { return }
            tagLoadError = error.localizedDescription
        }
    }

    private func save() { Task { if await store.save(api: api) { finish() } } }
    private func finish() { onSaved(); dismiss() }
}

/// Preserve manually entered tags while allowing a catalog label to be toggled.
enum LedgerBillTagSelection {
    static func names(in text: String) -> [String] {
        text.components(separatedBy: CharacterSet(charactersIn: ",，\n"))
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    static func toggling(_ name: String, in text: String) -> String {
        var values = names(in: text)
        if values.contains(name) { values.removeAll { $0 == name } }
        else { values.append(name) }
        return values.joined(separator: "，")
    }
}
