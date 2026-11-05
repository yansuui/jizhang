import SwiftUI
import Combine

@MainActor struct LedgerCategoriesView: View {
    let api: APIClient
    var body: some View {
        LedgerReadList(api: api, title: "分类", path: "/categories") { (category: LedgerCategory, metadata) in
            NavigationLink {
                BillsView(api: api, initialQuery: LedgerBillQuery(categoryId: category.id))
            } label: {
                LedgerCatalogRow(title: category.name,
                                 subtitle: (category.type == 1 ? "收入" : "支出") + (category.parentId.map { " · " + metadata.categoryName($0) } ?? ""),
                                 symbol: category.type == 1 ? "arrow.down.left" : "square.grid.2x2")
            }
        }
    }
}

@MainActor struct LedgerTagsView: View {
    let api: APIClient
    var body: some View {
        LedgerReadList(api: api, title: "标签", path: "/tags/hierarchy", needsMetadata: false,
                       footer: "标签可用于标记和筛选账单。旧模板名称保留在标签目录中；原有分类和历史分配不变。") { (tag: LedgerTag, _) in
            NavigationLink { BillsView(api: api, initialQuery: LedgerBillQuery(tag: tag.name)) } label: {
                LedgerCatalogRow(title: tag.name, subtitle: "记录标签", symbol: "tag", detail: "\(tag.count) 笔")
            }
        }
    }
}

@MainActor struct LedgerSalariesView: View {
    let api: APIClient
    var body: some View {
        LedgerReadList(api: api, title: "工资记录", path: "/salaries", footer: "按服务端提供的最近 200 条记录展示。工资计入账户余额与普通收入统计。") { (salary: LedgerSalary, metadata) in
            NavigationLink { LedgerSalaryDetailView(api: api, salaryID: salary.id, metadata: metadata) } label: {
                LedgerCatalogRow(title: salary.note.isEmpty ? "工资收入" : salary.note,
                                 subtitle: LedgerFormat.date(salary.date) + " · " + metadata.accountName(salary.accountId),
                                 symbol: "banknote", detail: LedgerFormat.money(salary.amountCents))
            }
        }
    }
}

@MainActor private struct LedgerSalaryDetailView: View {
    let api: APIClient
    let salaryID: String
    let metadata: LedgerMetadata
    @StateObject private var resource = LedgerResource<LedgerSalaryDetail>()
    @StateObject private var refreshedMetadata = LedgerResource<LedgerMetadata>()
    var body: some View {
        List {
            if let salary = resource.value {
                Section("工资记录") {
                    LedgerFieldRow(title: "金额", value: LedgerFormat.money(salary.amountCents))
                    LedgerFieldRow(title: "账户", value: (refreshedMetadata.value ?? metadata).accountName(salary.accountId))
                    LedgerFieldRow(title: "日期", value: LedgerFormat.date(salary.date, time: true))
                    if !salary.note.isEmpty { LedgerFieldRow(title: "备注", value: salary.note) }
                }
                if let grant = salary.fundGrant {
                    Section("确认时的四用途分配") {
                        if grant.status == "review-required" {
                            Label("这笔分配需要核对，金额仅作记录参考", systemImage: "exclamationmark.circle")
                                .font(.footnote).foregroundStyle(.orange)
                        }
                        ForEach(LedgerPurpose.allCases) { purpose in
                            LedgerFieldRow(title: purpose.title + " · " + LedgerFormat.ratio(bps: grant.ratiosBps[purpose]), value: LedgerFormat.money(grant.targets[purpose]))
                        }
                        Text("按工资确认时保存的分配记录展示，当前配置变化不会重算这笔工资。")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
                if !salary.allocations.isEmpty {
                    Section("旧分类分配记录") {
                        ForEach(salary.allocations) { allocation in
                            LedgerFieldRow(title: (refreshedMetadata.value ?? metadata).categoryName(allocation.categoryId), value: LedgerFormat.money(allocation.amountCents))
                        }
                    }
                }
            } else if resource.loading { LedgerLoadingView() }
            if let error = resource.error {
                LedgerErrorView(message: error, showingPrevious: resource.value != nil) { Task { await load() } }
            }
            if let error = refreshedMetadata.error {
                LedgerErrorView(message: "账户和分类资料：" + error, showingPrevious: true) {
                    Task { await refreshedMetadata.load { try await LedgerMetadata.load(api: api) } }
                }
            }
        }.navigationTitle("工资详情").navigationBarTitleDisplayMode(.inline)
            .task { await load() }.refreshable { await load() }
            .onReceive(api.$ledgerRevision.dropFirst()) { _ in
                Task {
                    await load()
                    await refreshedMetadata.load { try await LedgerMetadata.load(api: api) }
                }
            }
    }
    private func load() async { await resource.load { try await api.request("/salaries/" + LedgerURL.segment(salaryID)) } }
}

@MainActor struct LedgerRecurringView: View {
    let api: APIClient
    var body: some View {
        LedgerReadList(api: api, title: "周期账单", path: "/recurring/rules", footer: "展示已有规则及服务端计算的到期时间。本页不会生成或确认账单。") { (rule: LedgerRecurringRule, metadata) in
            NavigationLink {
                LedgerLiveDetail(api: api, initial: rule, metadata: metadata, source: .list("/recurring/rules")) { rule, metadata in
                    List {
                        Section {
                            LedgerFieldRow(title: "名称", value: rule.name)
                            LedgerFieldRow(title: "状态", value: rule.enabled ? "已启用" : "已停用")
                            LedgerFieldRow(title: "收支类型", value: rule.type.title)
                            LedgerFieldRow(title: "金额", value: LedgerFormat.money(rule.amountCents))
                            LedgerFieldRow(title: "分类", value: metadata.categoryName(rule.categoryId))
                            LedgerFieldRow(title: "账户", value: metadata.accountName(rule.accountId))
                        }
                        Section("周期") {
                            LedgerFieldRow(title: "频率", value: rule.frequency.title)
                            LedgerFieldRow(title: "起始日期", value: LedgerFormat.date(rule.anchorDate))
                            LedgerFieldRow(title: "下次到期", value: LedgerFormat.date(rule.nextDueDate))
                            if rule.hasOlderDue {
                                Text("还有更早的到期记录待处理，请在现有客户端查看。")
                                    .font(.footnote).foregroundStyle(.orange)
                            }
                        }
                    }.navigationTitle(rule.name).navigationBarTitleDisplayMode(.inline)
                }
            } label: {
                LedgerCatalogRow(title: rule.name, subtitle: rule.frequency.title + " · " + (rule.enabled ? LedgerFormat.date(rule.nextDueDate) + " 到期" : "已停用"), symbol: "repeat", detail: LedgerFormat.money(rule.amountCents))
            }
        }
    }
}

@MainActor struct LedgerPendingView: View {
    let api: APIClient
    var body: some View {
        LedgerReadList(api: api, title: "待确认账单", path: "/recurring/pending", footer: "这些记录尚未记入账本。当前可查看明细，确认、忽略与补生成请使用现有客户端。") { (pending: LedgerPendingOccurrence, metadata) in
            NavigationLink {
                LedgerLiveDetail(api: api, initial: pending, metadata: metadata, source: .list("/recurring/pending")) { pending, metadata in
                    List {
                        Section {
                            LedgerFieldRow(title: "收支类型", value: pending.type.title)
                            LedgerFieldRow(title: "金额", value: LedgerFormat.money(pending.amountCents))
                            LedgerFieldRow(title: "计划日期", value: LedgerFormat.date(pending.plannedDate))
                            LedgerFieldRow(title: "分类", value: metadata.categoryName(pending.categoryId))
                            LedgerFieldRow(title: "账户", value: metadata.accountName(pending.accountId))
                            LedgerFieldRow(title: "备注", value: pending.note.isEmpty ? "无" : pending.note)
                        }
                        Section { Text("待确认记录不会自动加入账户余额或收支统计。").font(.footnote).foregroundStyle(.secondary) }
                    }.navigationTitle("待确认明细").navigationBarTitleDisplayMode(.inline)
                }
            } label: {
                LedgerCatalogRow(title: pending.note.isEmpty ? metadata.categoryName(pending.categoryId) : pending.note,
                                 subtitle: LedgerFormat.date(pending.plannedDate) + " · " + pending.type.title,
                                 symbol: "clock", detail: LedgerFormat.money(pending.amountCents))
            }
        }
    }
}

@MainActor struct LedgerTransfersView: View {
    let api: APIClient
    var body: some View {
        LedgerReadList(api: api, title: "账户转账", path: "/transfers", paginated: true, footer: "转账改变两个账户的余额，不计入收入或支出。") { (transfer: LedgerTransfer, metadata) in
            NavigationLink {
                LedgerLiveDetail(api: api, initial: transfer, metadata: metadata, source: .item("/transfers/" + LedgerURL.segment(transfer.id))) { transfer, metadata in
                    List {
                        Section {
                            LedgerFieldRow(title: "转出账户", value: metadata.accountName(transfer.fromAccountId))
                            LedgerFieldRow(title: "转入账户", value: metadata.accountName(transfer.toAccountId))
                            LedgerFieldRow(title: "金额", value: LedgerFormat.money(transfer.amountCents))
                            LedgerFieldRow(title: "日期", value: LedgerFormat.date(transfer.date, time: true))
                            LedgerFieldRow(title: "备注", value: transfer.note.isEmpty ? "无" : transfer.note)
                        }
                    }.navigationTitle("转账详情").navigationBarTitleDisplayMode(.inline)
                }
            } label: {
                LedgerCatalogRow(title: metadata.accountName(transfer.fromAccountId) + " → " + metadata.accountName(transfer.toAccountId),
                                 subtitle: LedgerFormat.date(transfer.date), symbol: "arrow.left.arrow.right", detail: LedgerFormat.money(transfer.amountCents))
            }
        }
    }
}

@MainActor struct LedgerTrashView: View {
    let api: APIClient
    var body: some View {
        LedgerReadList(api: api, title: "回收站", path: "/trash", footer: "已删除账单不参与当前统计。恢复与永久删除暂未在 iOS 开放。") { (transaction: LedgerTransaction, metadata) in
            NavigationLink {
                LedgerLiveDetail(api: api, initial: transaction, metadata: metadata, source: .list("/trash")) { transaction, metadata in
                    ScrollView {
                        VStack(spacing: 18) {
                            Label("已删除的账单记录", systemImage: "trash").font(.subheadline).foregroundStyle(.secondary)
                            LedgerBillDetailContent(transaction: transaction, metadata: metadata)
                        }.padding(20)
                    }.background(Color(uiColor: .systemGroupedBackground))
                        .navigationTitle("回收站详情").navigationBarTitleDisplayMode(.inline)
                }
            } label: { LedgerTransactionRow(transaction: transaction, metadata: metadata) }
        }
    }
}
