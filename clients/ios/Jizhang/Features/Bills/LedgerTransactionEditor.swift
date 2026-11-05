import SwiftUI

@MainActor struct LedgerTransactionEditor: View {
    let api: APIClient
    let onSaved: () -> Void
    private let editing: Bool
    @Environment(\.dismiss) private var dismiss
    @StateObject private var store: LedgerTransactionEditorStore

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
                                .keyboardType(.decimalPad).monospacedDigit().accessibilityLabel("金额，单位元")
                        }.padding(.vertical, 8)
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
                    Section {
                        TextField("备注（选填）", text: $store.draft.note, axis: .vertical).lineLimit(2...5)
                        TextField("标签，用逗号分隔（选填）", text: $store.draft.tags)
                    }
                    if store.draft.isRefund {
                        Section("关联原支出") {
                            Text("已关联 \(store.draft.refundLinkedTxIds.count) 笔原始支出。保存后可在详情中双向查看。")
                            Text("退款单独计入收入，原支出金额保持不变。")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
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
        }
    }

    private func save() { Task { if await store.save(api: api) { finish() } } }
    private func finish() { onSaved(); dismiss() }
}
