import SwiftUI

@MainActor struct PlanHistoryView: View {
    @ObservedObject var api: APIClient
    @ObservedObject var history: PlanHistoryStore
    @State private var selected: PlanSalary?
    @State private var review: PlanReviewStore?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if history.loading { ProgressView("正在读取分配记录…") }
                if let error = history.error {
                    Section {
                        Text(error).foregroundStyle(.orange)
                        Button("重新读取记录") { Task { await history.load(api: api) } }
                    }
                }
                if !history.issues.isEmpty {
                    Section {
                        ForEach(history.issues) { issue in
                            if issue.canAllocate, let source = issue.source {
                                Button {
                                    review = history.review(for: .salary(source.salaryId))
                                } label: {
                                    VStack(alignment: .leading, spacing: 5) {
                                        HStack {
                                            Text("待分配收入")
                                            Spacer()
                                            Text(LedgerFormat.money(source.amountCents)).monospacedDigit()
                                        }
                                        Text(LedgerFormat.date(source.date) + " · 点击核对并分配")
                                            .font(.caption).foregroundStyle(.secondary)
                                    }.foregroundStyle(.primary)
                                }
                            } else if issue.status != "open" {
                                Label("历史核对项已处理", systemImage: "checkmark.circle")
                                    .font(.subheadline).foregroundStyle(.secondary)
                            } else if issue.needsServerAttention {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text("资金数据待核对")
                                    Text("服务器上仍有无法自动处理的资金数据，处理完才能继续修改分配设置。")
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                            }
                            // Open archival rows are summarized below; they are not tasks.
                        }
                        if archivedIssueCount > 0 {
                            VStack(alignment: .leading, spacing: 5) {
                                Text("另有 \(archivedIssueCount) 项历史记录已归档")
                                Text("升级时无法自动归类的旧记录。现在余额是否完整由账单的「资金用途」和收入的分配记录决定，这里不需要逐条处理。")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        if history.hasMoreIssues {
                            Button("加载更多核对记录") { Task { await history.loadMoreIssues(api: api) } }.disabled(history.loading)
                        }
                    } header: { Text("历史核对记录 · \(history.issueTotal)") } footer: {
                        Text("分配已有收入不会再次记入到账金额。确认比例后，由服务器计算四用途分配。")
                    }
                }
                Section {
                    if history.salaries.isEmpty && !history.loading && history.error == nil {
                        Text("还没有收入分配记录。可在计划页新增收入分配。").foregroundStyle(.secondary)
                    }
                    ForEach(history.salaries) { salary in
                        Button { selected = salary } label: {
                            VStack(alignment: .leading, spacing: 6) {
                                HStack {
                                    Text(salary.note.isEmpty ? "收入分配" : salary.note).lineLimit(2)
                                    Spacer()
                                    Text(LedgerFormat.money(salary.amountCents)).monospacedDigit()
                                }
                                Text(LedgerFormat.date(salary.date) + " · 查看分配与状态")
                                    .font(.caption).foregroundStyle(.secondary)
                            }.foregroundStyle(.primary)
                        }
                    }
                } header: { Text("全部收入分配记录") } footer: {
                    Text("这里只列出工资收入分配记录。其他收入留在账单里，按单一用途计入；退款按原支出用途回补。只有工资才应转成收入分配。")
                }
            }.navigationTitle("收入分配记录").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } } }
                .refreshable { await history.load(api: api) }
                .task { await history.load(api: api) }
                .onChange(of: api.ledgerRevision) { _, _ in Task { await history.load(api: api) } }
                .sheet(item: $selected) { salary in PlanSalaryDetailView(api: api, salaryID: salary.id, history: history) }
                .sheet(item: $review) { PlanReviewView(api: api, state: $0) }
        }
    }

    private var archivedIssueCount: Int { history.issues.filter(\.isArchived).count }
}

@MainActor private struct PlanSalaryDetailView: View {
    @ObservedObject var api: APIClient
    let salaryID: String
    let history: PlanHistoryStore
    @State private var salary: PlanSalary?
    @State private var error: String?
    @State private var loading = false
    @State private var review: PlanReviewStore?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if loading { ProgressView("读取分配详情…") }
                if let error {
                    Text(error).foregroundStyle(.orange)
                    Button("重试") { Task { await load() } }
                }
                if let salary {
                    Section("收入") {
                        LabeledContent("金额", value: LedgerFormat.money(salary.amountCents))
                        LabeledContent("日期", value: LedgerFormat.date(salary.date))
                        if !salary.note.isEmpty { Text(salary.note) }
                    }
                    if let grant = salary.fundGrant {
                        Section("确认时的分配") {
                            Text(grant.statusTitle).foregroundStyle(grant.status == "active" ? Color.secondary : Color.orange)
                            LabeledContent("分配总额", value: LedgerFormat.money(grant.sourceAmountCents))
                            ForEach(LedgerPurpose.allCases) { purpose in
                                VStack(alignment: .leading, spacing: 4) {
                                    LabeledContent(purpose.title, value: LedgerFormat.money(grant.targets[purpose]))
                                    Text(LedgerFormat.ratio(bps: grant.ratiosBps[purpose])).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                            Text(grant.grantId.hasPrefix("legacy-group:") ?
                                 "这是历史合并分配，金额涵盖该组全部收入。当前默认比例不会重算这些金额。" :
                                 "此处保留确认时的比例与金额，修改默认比例不会改变已有分配。")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                        if grant.canReconfirm {
                            Button("核对来源并重新确认这组分配") { review = history.review(for: .legacy(grant)) }
                        } else if grant.status == "review-required" {
                            Text("这笔收入的来源已变化，当前金额暂不代表完整可用额度。请先核对原收入记录。")
                                .font(.footnote).foregroundStyle(.orange)
                        }
                    } else {
                        Section {
                            Text("这笔收入还没有四用途分配。")
                            Button("核对并分配这笔收入") { review = history.review(for: .salary(salary.id)) }
                        }
                    }
                }
            }.navigationTitle("分配详情").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } } }
                .task { await load() }
                .onChange(of: api.ledgerRevision) { _, _ in Task { await load() } }
                .sheet(item: $review) { PlanReviewView(api: api, state: $0) }
        }
    }

    private func load() async {
        guard !loading else { return }
        loading = true
        error = nil
        defer { loading = false }
        do {
            let value: PlanSalary = try await api.request("/salaries/" + LedgerURL.segment(salaryID))
            try value.validate()
            guard value.id == salaryID else { throw LedgerDataError.invalidResponse }
            salary = value
        } catch is CancellationError {} catch { self.error = error.localizedDescription }
    }
}

@MainActor struct PlanReviewView: View {
    let api: APIClient
    @ObservedObject var state: PlanReviewStore
    @ObservedObject private var mutation: PlanMutation
    @Environment(\.dismiss) private var dismiss

    init(api: APIClient, state: PlanReviewStore) {
        self.api = api; self.state = state; self.mutation = state.mutation
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("核对以下收入来源和比例后再确认。此操作只确认资金分配，不会新增到账收入。")
                    if case .legacy = state.target {
                        Text("历史合并分配保留原来的成员和比例，服务器核对来源变化后追加确认记录。")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
                if state.loading || mutation.busy { ProgressView("正在核对…") }
                if let error = state.error ?? mutation.error {
                    Section {
                        Text(error).foregroundStyle(.orange)
                        if !mutation.locked { Button("重新读取来源和比例") { Task { await state.load(api: api) } } }
                    }
                }
                if !state.sources.isEmpty {
                    Section("收入来源") {
                        ForEach(state.sources) { source in
                            LabeledContent(LedgerFormat.date(source.date), value: LedgerFormat.money(source.amountCents))
                        }
                    }
                }
                if let ratios = state.ratios { Section("本次确认比例") { PlanRatioRows(ratios: ratios) } }
                Section {
                    Button(mutation.pending == nil ? "确认分配" : "核对结果并重试") {
                        Task {
                            guard let request = mutation.pending ?? state.request else { return }
                            if await mutation.submit(request, api: api) { dismiss() }
                        }
                    }.disabled(state.loading || mutation.busy || mutation.conflict ||
                               (mutation.pending == nil && state.request == nil))
                }
            }.navigationTitle("核对收入分配").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() }.disabled(mutation.busy) } }
                .interactiveDismissDisabled(mutation.busy)
                .task { await state.load(api: api) }
        }
    }
}
