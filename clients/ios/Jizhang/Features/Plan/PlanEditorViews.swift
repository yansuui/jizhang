import SwiftUI

@MainActor struct PlanIncomeEditor: View {
    let api: APIClient
    @ObservedObject var state: PlanEditorState
    @ObservedObject private var mutation: PlanMutation
    @Environment(\.dismiss) private var dismiss

    init(api: APIClient, state: PlanEditorState) {
        self.api = api
        self.state = state
        self.mutation = state.mutation
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("收入金额（元）", text: $state.amount).keyboardType(.decimalPad)
                        .accessibilityIdentifier("plan.income.amount")
                    Picker("到账账户", selection: $state.accountId) {
                        if state.accountId.isEmpty { Text("请选择账户").tag("") }
                        ForEach(state.accounts) { Text($0.name).tag($0.id) }
                    }
                    DatePicker("收入日期", selection: $state.date, in: Date(timeIntervalSince1970: 0)...Date.distantFuture, displayedComponents: .date)
                    TextField("备注（可选）", text: $state.note, axis: .vertical).lineLimit(2...4)
                } header: { Text("新增收入分配") } footer: {
                    Text("将新增一笔到账收入，并按下方比例分配。已记过的收入请到“收入分配记录”核对，避免重复记入。")
                }.disabled(mutation.locked)
                if let config = state.config {
                    Section("本次使用的比例") {
                        PlanRatioRows(ratios: config.ratiosBps)
                        Text("分配金额由服务器精确计算。确认后的记录保留本次比例。")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
                if state.accounts.isEmpty && !state.loading && state.error == nil {
                    Text("请先在账户中添加可用的到账账户。").foregroundStyle(.orange)
                }
                if !state.amount.isEmpty && (PlanInput.hundredths(state.amount) ?? 0) <= 0 {
                    Text("请输入大于 0 的金额，最多两位小数。").foregroundStyle(.orange)
                }
                editorStatus
                Section {
                    Button(mutation.pending == nil ? "确认收入并分配" : "核对结果并重试") {
                        Task {
                            guard let request = mutation.pending ?? state.salaryRequest else { return }
                            if await mutation.submit(request, api: api) {
                                state.didCreateSalary()
                                dismiss()
                            }
                        }
                    }.disabled(mutation.busy || state.loading || mutation.conflict ||
                               (mutation.pending == nil && (state.salaryRequest == nil || state.error != nil)))
                        .accessibilityIdentifier("plan.income.confirm")
                }
            }.navigationTitle("收入分配").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() }.disabled(mutation.busy) } }
                .interactiveDismissDisabled(mutation.busy)
                .task { await state.load(api: api) }
        }
    }

    @ViewBuilder private var editorStatus: some View {
        if state.loading || mutation.busy { ProgressView(state.loading ? "读取当前设置…" : "正在核对保存结果…") }
        if let error = state.error ?? mutation.error {
            Section {
                Text(error).foregroundStyle(.orange)
                if !mutation.locked {
                    Button("重新读取比例和账户（保留草稿）") { Task { await state.load(api: api) } }
                }
            }
        }
        if mutation.pending != nil && !mutation.busy {
            Text("这笔收入的请求已保留。重新打开此页仍可核对原操作，请勿另建相同收入。")
                .font(.footnote).foregroundStyle(.secondary)
        }
    }
}

@MainActor struct PlanRatioEditor: View {
    let api: APIClient
    @ObservedObject var state: PlanEditorState
    @ObservedObject private var mutation: PlanMutation
    @Environment(\.dismiss) private var dismiss

    init(api: APIClient, state: PlanEditorState) {
        self.api = api; self.state = state; self.mutation = state.mutation
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ForEach(LedgerPurpose.allCases) { purpose in
                        HStack {
                            Label(purpose.title, systemImage: purpose.symbol)
                            Spacer()
                            TextField("比例", text: Binding(get: { state.ratios[purpose] ?? "" }, set: { state.ratios[purpose] = $0 }))
                                .keyboardType(.decimalPad).multilineTextAlignment(.trailing).frame(width: 84)
                                .accessibilityLabel(purpose.title + "百分比")
                            Text("%").foregroundStyle(.secondary)
                        }
                    }
                } header: { Text("四用途比例") } footer: {
                    Text("合计必须为 100%，每项可填到小数点后两位。只影响以后新增的分配，已有记录保持确认时的比例。")
                }.disabled(mutation.locked || state.loading)
                if !state.ratios.isEmpty && PlanInput.ratios(state.ratios) == nil {
                    Text("请检查四项比例：每项 0–100%，合计 100%。").foregroundStyle(.orange)
                }
                if state.loading || mutation.busy { ProgressView("正在读取或保存…") }
                if let error = state.error ?? mutation.error {
                    Section {
                        Text(error).foregroundStyle(.orange)
                        if !mutation.locked {
                            Button("读取最新设置（保留填写的比例）") { Task { await state.load(api: api, needsAccounts: false) } }
                        }
                    }
                }
                if let config = state.config {
                    Section("服务器当前比例") { PlanRatioRows(ratios: config.ratiosBps) }
                }
                Section {
                    Button(mutation.pending == nil ? "保存以后使用的比例" : "核对结果并重试") {
                        Task {
                            let request: PlanWriteRequest
                            if let pending = mutation.pending { request = pending }
                            else if let config = state.config, let ratios = PlanInput.ratios(state.ratios) {
                                request = .configuration(config, ratios: ratios)
                            } else { return }
                            if await mutation.submit(request, api: api) { state.didSaveRatios(); dismiss() }
                        }
                    }.disabled(state.loading || mutation.busy || mutation.conflict ||
                               (mutation.pending == nil && (state.config == nil || PlanInput.ratios(state.ratios) == nil || state.error != nil)))
                        .accessibilityIdentifier("plan.ratios.confirm")
                }
            }.navigationTitle("修改分配比例").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() }.disabled(mutation.busy) } }
                .interactiveDismissDisabled(mutation.busy)
                .task { await state.load(api: api, needsAccounts: false) }
        }
    }
}

struct PlanRatioRows: View {
    let ratios: LedgerPurposeAmounts
    var body: some View {
        ForEach(LedgerPurpose.allCases) { purpose in
            HStack {
                Label(purpose.title, systemImage: purpose.symbol)
                Spacer()
                Text(LedgerFormat.ratio(bps: ratios[purpose])).monospacedDigit()
            }.font(.subheadline)
        }
    }
}
