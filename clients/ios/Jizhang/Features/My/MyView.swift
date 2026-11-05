import SwiftUI

@MainActor struct MyView: View {
    let api: APIClient
    let user: AuthenticatedUser
    let onLogout: () -> Void
    @State private var confirmingLogout = false

    var body: some View {
        List {
            Section {
                HStack(spacing: 16) {
                    LedgerSymbol(name: "person.crop.circle.fill")
                    VStack(alignment: .leading, spacing: 6) {
                        Text(user.username).font(.title3.weight(.semibold))
                        if user.canManageInvitations {
                            Text("管理员").font(.caption).foregroundStyle(AppTheme.accent)
                        }
                        Text(api.baseURL.host ?? "已连接记账服务")
                            .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                    }
                }.padding(.vertical, 10)
            }
            Section("AI 助手") {
                NavigationLink { ProviderSettingsView(api: api) } label: {
                    menuRow("助手配置", subtitle: "服务地址、密钥与模型", symbol: "sparkles")
                }
            }
            if user.canManageInvitations {
                Section("账号管理") {
                    NavigationLink { InvitationManagementView(api: api, user: user) } label: {
                        menuRow("邀请码管理", subtitle: "邀请新用户，账本各自独立", symbol: "person.badge.plus")
                    }
                }
            }
            Section("账本资料") {
                NavigationLink { LedgerAccountsView(api: api) } label: {
                    menuRow("账户", subtitle: "余额与资金流向", symbol: "creditcard")
                }
                NavigationLink { LedgerCategoriesView(api: api) } label: {
                    menuRow("分类", subtitle: "收入与支出分类", symbol: "square.grid.2x2")
                }
                NavigationLink { LedgerTagsView(api: api) } label: {
                    menuRow("标签", subtitle: "按标签查看账单", symbol: "tag")
                }
                NavigationLink { LedgerStatisticsView(api: api) } label: {
                    menuRow("收支统计", subtitle: "趋势与分类占比", symbol: "chart.bar.xaxis")
                }
                NavigationLink { LedgerItemsView(api: api) } label: {
                    menuRow("物品", subtitle: "持有状态与使用成本", symbol: "shippingbox")
                }
            }
            Section("计划与记录") {
                NavigationLink { LedgerSalariesView(api: api) } label: { menuRow("工资记录", symbol: "banknote") }
                NavigationLink { LedgerTemplatesView(api: api) } label: { menuRow("分配模板", symbol: "square.stack.3d.up") }
                NavigationLink { LedgerRecurringView(api: api) } label: { menuRow("周期账单", symbol: "repeat") }
                NavigationLink { LedgerPendingView(api: api) } label: { menuRow("待确认账单", symbol: "clock") }
                NavigationLink { LedgerTransfersView(api: api) } label: { menuRow("账户转账", symbol: "arrow.left.arrow.right") }
                NavigationLink { LedgerTrashView(api: api) } label: { menuRow("回收站", symbol: "trash") }
            }
            Section {
                NavigationLink {
                    LedgerAvailabilityView(title: "导入与导出", symbol: "square.and.arrow.down", message: "导入文件、导出账本与批量整理将在后续版本提供。")
                } label: { menuRow("导入与导出", subtitle: "后续版本提供", symbol: "square.and.arrow.down") }
                NavigationLink {
                    LedgerAvailabilityView(title: "备份与恢复", symbol: "externaldrive", message: "创建、下载和恢复备份暂未在 iOS 开放。")
                } label: { menuRow("备份与恢复", subtitle: "后续版本提供", symbol: "externaldrive") }
            } header: { Text("数据管理") } footer: {
                Text("账本功能先提供浏览，新增、修改与确认可继续使用现有客户端。AI 对话与助手配置已开放。")
            }
            Section {
                Button("退出登录", role: .destructive) { confirmingLogout = true }
                    .frame(maxWidth: .infinity, minHeight: 32)
            }
        }
        .navigationTitle("我的")
        .confirmationDialog("退出当前账本？", isPresented: $confirmingLogout, titleVisibility: .visible) {
            Button("退出登录", role: .destructive, action: onLogout)
            Button("取消", role: .cancel) {}
        } message: { Text("服务器上的账本和对话会保留。") }
    }

    private func menuRow(_ title: String, subtitle: String? = nil, symbol: String) -> some View {
        HStack(spacing: 13) {
            LedgerSymbol(name: symbol)
            VStack(alignment: .leading, spacing: 5) {
                Text(title).font(.subheadline.weight(.medium)).foregroundStyle(.primary)
                if let subtitle { Text(subtitle).font(.caption).foregroundStyle(.secondary) }
            }
        }.padding(.vertical, 4)
    }
}

@MainActor struct LedgerAccountsView: View {
    let api: APIClient
    @StateObject private var resource = LedgerResource<LedgerBalances>()

    var body: some View {
        List {
            if let value = resource.value {
                Section {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("账户总余额").font(.subheadline).foregroundStyle(.secondary)
                        Text(LedgerFormat.money(value.totalBalanceCents))
                            .font(.system(.largeTitle, design: .rounded).weight(.semibold)).monospacedDigit()
                            .minimumScaleFactor(0.6).lineLimit(1)
                        HStack {
                            LedgerMetric(title: "总资产", value: LedgerFormat.money(value.totalAssetsCents), tint: AppTheme.accent)
                            LedgerMetric(title: "总负债", value: LedgerFormat.money(value.totalLiabilitiesCents))
                        }
                    }.padding(.vertical, 14)
                }
                Section("全部账户") {
                    if value.items.isEmpty { LedgerEmptyView(title: "暂无账户", symbol: "creditcard") }
                    ForEach(value.items) { account in
                        NavigationLink {
                            accountDetail(account)
                        } label: {
                            HStack(spacing: 12) {
                                LedgerSymbol(name: "creditcard")
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(account.name).font(.subheadline.weight(.medium))
                                    Text(LedgerFormat.accountType(account.type)).font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Text(LedgerFormat.money(account.balanceCents)).font(.subheadline.weight(.semibold)).monospacedDigit()
                            }.padding(.vertical, 5)
                        }
                    }
                }
            } else if resource.loading { LedgerLoadingView() }
            if let error = resource.error {
                LedgerErrorView(message: error, showingPrevious: resource.value != nil) { Task { await load() } }
            }
        }.navigationTitle("账户").navigationBarTitleDisplayMode(.inline)
            .task { await load() }.refreshable { await load() }
    }

    private func accountDetail(_ account: LedgerAccountBalance) -> some View {
        List {
            Section {
                LedgerFieldRow(title: "账户类型", value: LedgerFormat.accountType(account.type))
                LedgerFieldRow(title: "当前余额", value: LedgerFormat.money(account.balanceCents))
            }
            Section("余额构成") {
                LedgerFieldRow(title: "初始余额", value: LedgerFormat.money(account.initialBalanceCents))
                LedgerFieldRow(title: "账单收入（含退款）", value: LedgerFormat.money(account.incomeCents))
                LedgerFieldRow(title: "工资收入", value: LedgerFormat.money(account.salaryCents))
                LedgerFieldRow(title: "账单支出", value: LedgerFormat.money(account.expenseCents))
                LedgerFieldRow(title: "转入", value: LedgerFormat.money(account.transferInCents))
                LedgerFieldRow(title: "转出", value: LedgerFormat.money(account.transferOutCents))
            }
            Section {
                NavigationLink("查看账户账单") { BillsView(api: api, initialQuery: LedgerBillQuery(accountId: account.id)) }
                Text("转账仅改变账户余额，不计为收入或支出。")
                    .font(.footnote).foregroundStyle(.secondary)
            }
        }.navigationTitle(account.name).navigationBarTitleDisplayMode(.inline)
    }
    private func load() async { await resource.load { try await api.request("/accounts/balances") } }
}
