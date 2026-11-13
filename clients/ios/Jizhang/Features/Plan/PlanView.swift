import SwiftUI

@MainActor struct PlanView: View {
    @ObservedObject var api: APIClient
    @StateObject private var summary = LedgerResource<LedgerFundSummary>()
    @StateObject private var configuration = LedgerResource<LedgerFundConfiguration>()
    @StateObject private var incomeEditor = PlanEditorState()
    @StateObject private var ratioEditor = PlanEditorState()
    @StateObject private var history = PlanHistoryStore()
    @State private var activeSheet: EditorSheet?

    private enum EditorSheet: String, Identifiable {
        case income, ratios, history
        var id: String { rawValue }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("为生活留足空间，也为未来做好准备。")
                        .font(.subheadline).foregroundStyle(.secondary)
                    Label("余额持续结转，不按月清零", systemImage: "arrow.triangle.2.circlepath")
                        .font(.caption.weight(.medium)).foregroundStyle(AppTheme.accent)
                }
                LedgerCard {
                    Button { activeSheet = .income } label: {
                        Label("新增收入分配", systemImage: "plus.circle.fill")
                            .font(.headline).frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 8)
                    }.accessibilityIdentifier("plan.addIncome")
                    Divider()
                    Button { activeSheet = .history } label: {
                        Label("收入分配记录与核对", systemImage: "list.bullet.clipboard")
                            .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 8)
                    }.accessibilityIdentifier("plan.history")
                }
                if let value = summary.value {
                    if !value.coverage.complete { coverageNotice(value.coverage) }
                    ForEach(LedgerPurpose.allCases) { purpose in
                        NavigationLink {
                            LedgerFundDetailView(purpose: purpose, summary: value)
                        } label: {
                            fundCard(purpose, summary: value)
                        }.buttonStyle(.plain)
                    }
                    Text("更新于 " + LedgerFormat.date(value.asOf, time: true))
                        .font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity)
                } else if summary.loading {
                    LedgerCard { LedgerLoadingView(title: "正在读取四用途资金…") }
                }
                if let error = summary.error {
                    LedgerErrorView(message: error, showingPrevious: summary.value != nil) { Task { await loadSummary() } }
                }
                if let value = configuration.value {
                    LedgerCard {
                        LedgerSectionHeading(title: "收入分配比例", subtitle: "当前设置用于之后的收入分配")
                        Button("修改分配比例", systemImage: "slider.horizontal.3") { activeSheet = .ratios }
                            .accessibilityIdentifier("plan.editRatios")
                        ForEach(LedgerPurpose.allCases) { purpose in
                            HStack {
                                Label(purpose.title, systemImage: purpose.symbol).font(.subheadline)
                                Spacer()
                                Text(LedgerFormat.ratio(bps: value.config.ratiosBps[purpose]))
                                    .font(.subheadline.weight(.semibold)).monospacedDigit()
                            }
                        }
                        Text("已有分配以确认时的记录为准，不会随当前比例重新计算。")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
                if let error = configuration.error {
                    LedgerErrorView(message: "分配设置：" + error, showingPrevious: configuration.value != nil) { Task { await loadConfiguration() } }
                }
                LedgerCard {
                    LedgerSectionHeading(title: "历史参考")
                    NavigationLink { LedgerMonthlyPlanView(api: api) } label: {
                        Label("旧月计划", systemImage: "calendar")
                    }
                    Divider()
                    NavigationLink { LedgerBudgetView(api: api) } label: {
                        Label("旧分类预算", systemImage: "square.stack.3d.up")
                    }
                    Text("旧计划与分类预算单独展示，不叠加到四用途资金余额。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }.padding(20)
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .navigationTitle("计划")
        .task { await loadSummary() }
        .task { await loadConfiguration() }
        .refreshable { await loadSummary(); await loadConfiguration() }
        .onChange(of: api.ledgerRevision) { _, _ in
            Task { await loadSummary(); await loadConfiguration() }
        }
        .sheet(item: $activeSheet) { sheet in
            switch sheet {
            case .income: PlanIncomeEditor(api: api, state: incomeEditor)
            case .ratios: PlanRatioEditor(api: api, state: ratioEditor)
            case .history: PlanHistoryView(api: api, history: history)
            }
        }
    }

    private func fundCard(_ purpose: LedgerPurpose, summary: LedgerFundSummary) -> some View {
        LedgerCard {
            HStack {
                LedgerSymbol(name: purpose.symbol, color: purposeColor(purpose))
                VStack(alignment: .leading, spacing: 5) {
                    Text(purpose.title).font(.headline)
                    Text(summary.coverage.complete ? "当前余额" : "已确认部分 · 暂计余额")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
            }
            Text(LedgerFormat.money(summary.balances[purpose]))
                .font(.system(.title, design: .rounded).weight(.semibold)).monospacedDigit()
                .foregroundStyle(summary.balances[purpose] < 0 ? Color.orange : Color.primary)
                .minimumScaleFactor(0.6).lineLimit(1)
            HStack {
                Text("已分配 " + LedgerFormat.money(summary.totals.funded[purpose]))
                Spacer(minLength: 8)
                Text("支出 " + LedgerFormat.money(summary.totals.grossSpent[purpose]))
            }.font(.caption).foregroundStyle(.secondary)
        }
    }

    private func purposeColor(_ purpose: LedgerPurpose) -> Color {
        switch purpose {
        case .growth: return .indigo
        case .reserve: return .blue
        case .essentials: return AppTheme.accent
        case .joy: return .orange
        }
    }

    private func coverageNotice(_ coverage: LedgerFundSummary.Coverage) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("部分资金待核对", systemImage: "exclamationmark.circle.fill").font(.headline)
            Text("下面的余额仅反映已归类部分，尚不能作为完整可用额度。")
                .font(.subheadline)
            if coverage.unallocatedSalaryCount > 0 {
                Button { activeSheet = .history } label: {
                    coverageLine("待分配工资 \(coverage.unallocatedSalaryCount) 笔 · " +
                                 LedgerFormat.money(coverage.unallocatedSalaryCents), action: "去核对")
                }.buttonStyle(.plain)
            }
            if coverage.unassignedTransactionCount > 0 {
                NavigationLink { LedgerUnclassifiedBillsView(api: api) } label: {
                    coverageLine("未归类账单 \(coverage.unassignedTransactionCount) 笔 · " +
                                 LedgerFormat.money(coverage.unassignedTransactionCents), action: "选用途",
                                 detail: "含收入和支出。工资请用「新增收入分配」，由服务器按比例拆开。")
                }.buttonStyle(.plain)
            }
            if coverage.invalidRefundCount > 0 {
                Text("退款待核对 \(coverage.invalidRefundCount) 笔 · " + LedgerFormat.money(coverage.unresolvedRefundCents))
            }
            if coverage.unknownUnallocatedSalaryCount > 0 {
                Text("另有 \(coverage.unknownUnallocatedSalaryCount) 笔工资金额需要核对")
            }
            if coverage.issueCount > 0 { Text("其他待核对项 \(coverage.issueCount) 项") }
        }.font(.footnote).foregroundStyle(Color.orange)
            .frame(maxWidth: .infinity, alignment: .leading).padding(18)
            .background(Color.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 22))
    }

    private func coverageLine(_ text: String, action: String, detail: String? = nil) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(text)
                Spacer(minLength: 8)
                Text(action).fontWeight(.semibold)
                Image(systemName: "chevron.right").font(.caption2.weight(.semibold)).foregroundStyle(.tertiary)
            }
            if let detail {
                Text(detail).font(.caption2).foregroundStyle(Color.orange.opacity(0.85))
            }
        }.contentShape(Rectangle())
    }

    private func loadSummary() async {
        await summary.load {
            let result: LedgerFundSummary = try await api.request("/financial-funds/summary")
            try result.validate()
            return result
        }
    }
    private func loadConfiguration() async {
        await configuration.load {
            let result: LedgerFundConfiguration = try await api.request("/financial-funds/config")
            try result.validate()
            return result
        }
    }
}

private struct LedgerFundDetailView: View {
    let purpose: LedgerPurpose
    let summary: LedgerFundSummary
    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 12) {
                    Label(purpose.title, systemImage: purpose.symbol).font(.headline).foregroundStyle(AppTheme.accent)
                    Text(LedgerFormat.money(summary.balances[purpose]))
                        .font(.system(.largeTitle, design: .rounded).weight(.semibold)).monospacedDigit()
                    Text(summary.coverage.complete ? "当前累计余额" : "已确认部分的暂计余额，仍有数据待核对")
                        .font(.footnote).foregroundStyle(.secondary)
                }.padding(.vertical, 12)
            }
            Section("累计构成") {
                LedgerFieldRow(title: "工资分配", value: LedgerFormat.money(summary.totals.funded[purpose]))
                LedgerFieldRow(title: "其他已归类收入", value: LedgerFormat.money(summary.totals.income[purpose]))
                LedgerFieldRow(title: "原始支出", value: LedgerFormat.money(summary.totals.grossSpent[purpose]))
                LedgerFieldRow(title: "已确认归属退款", value: LedgerFormat.money(summary.totals.refunded[purpose]))
            }
            Section {
                Text("资金余额按累计记录持续结转。账户之间的转账不计为收入或支出，退款按确认归属计入对应用途。")
                    .font(.footnote).foregroundStyle(.secondary)
                Text("数据时间：" + LedgerFormat.date(summary.asOf, time: true))
                    .font(.caption).foregroundStyle(.secondary)
            }
        }.navigationTitle(purpose.title).navigationBarTitleDisplayMode(.inline)
    }
}

@MainActor struct LedgerBudgetView: View {
    let api: APIClient
    @StateObject private var resource = LedgerResource<LedgerBudgetOverview>()
    var body: some View {
        List {
            Section {
                Text("旧分类预算口径，作为独立参考；不计入四用途资金余额。")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            if let value = resource.value {
                Section("服务器返回的预算概览") {
                    LedgerFieldRow(title: "预算总额", value: LedgerFormat.money(value.totalBudgetCents))
                    LedgerFieldRow(title: "已支出", value: LedgerFormat.money(value.totalSpentCents))
                    LedgerFieldRow(title: "旧结余池", value: LedgerFormat.money(value.carryoverPoolCents))
                }
                if !value.hasBudget {
                    LedgerEmptyView(title: "尚未建立旧分类预算", message: "四用途资金仍可在计划首页独立查看。", symbol: "square.stack.3d.up")
                }
                ForEach(value.modules) { module in
                    Section(module.categoryName) {
                        LedgerFieldRow(title: "预算", value: LedgerFormat.money(module.budgetCents))
                        LedgerFieldRow(title: "支出", value: LedgerFormat.money(module.spentCents))
                        LedgerFieldRow(title: "剩余", value: LedgerFormat.money(module.remainingCents))
                    }
                }
            } else if resource.loading { LedgerLoadingView() }
            if let error = resource.error {
                LedgerErrorView(message: error, showingPrevious: resource.value != nil) { Task { await load() } }
            }
        }.navigationTitle("旧分类预算").navigationBarTitleDisplayMode(.inline)
            .task { await load() }.refreshable { await load() }
    }
    private func load() async { await resource.load { try await api.request("/budget/overview") } }
}

@MainActor struct LedgerMonthlyPlanView: View {
    let api: APIClient
    @StateObject private var resource = LedgerResource<LedgerMonthlyPlan>()
    var body: some View {
        List {
            Section {
                Text("展示服务器当前冻结区间内的旧月计划，独立于四用途累计资金。")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            if let value = resource.value {
                if value.state == .ready, let summary = value.summary, let window = value.window {
                    Section(window.label) {
                        LedgerFieldRow(title: "消费预算", value: LedgerFormat.money(summary.consumptionBudgetCents))
                        LedgerFieldRow(title: "已确认净消费", value: LedgerFormat.money(summary.confirmedNetSpentCents))
                        LedgerFieldRow(title: "还能花", value: summary.displayRemainingCents.map { LedgerFormat.money($0) } ?? "待核对")
                    }
                    if summary.status == .reviewRequired {
                        Text("存在未归类或待核对的消费、退款，暂不展示精确剩余额度。")
                            .font(.footnote).foregroundStyle(.orange)
                    }
                } else {
                    LedgerEmptyView(title: value.state == .disabled ? "旧月计划未启用" : "当前没有旧月计划", message: "四用途资金可在计划首页查看，不需要创建月度周期。", symbol: "calendar")
                }
            } else if resource.loading { LedgerLoadingView() }
            if let error = resource.error {
                LedgerErrorView(message: error, showingPrevious: resource.value != nil) { Task { await load() } }
            }
        }.navigationTitle("旧月计划").navigationBarTitleDisplayMode(.inline)
            .task { await load() }.refreshable { await load() }
    }
    private func load() async {
        await resource.load {
            let result: LedgerMonthlyPlan = try await api.request("/monthly-plan")
            try result.validate()
            return result
        }
    }
}
