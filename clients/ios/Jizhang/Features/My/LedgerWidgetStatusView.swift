import SwiftUI

/// The in-app explanation of the home-screen widgets: whether this installed signature can share
/// data at all, what the widgets currently show, and how to add them.
@MainActor struct LedgerWidgetStatusView: View {
    let api: APIClient
    let userID: String
    @State private var snapshot: LedgerWidgetSnapshot?
    @State private var syncing = false
    @State private var notice: String?

    private var store: LedgerWidgetSnapshotStore { .shared }

    var body: some View {
        List {
            Section {
                if store.isAvailable {
                    Label("小组件可以读取本机汇总数据", systemImage: "checkmark.seal.fill")
                        .foregroundStyle(AppTheme.accent)
                } else {
                    Label("当前安装无法共享小组件数据", systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                }
                Text(store.isAvailable
                     ? "记账在 App 内读到服务器汇总后才会更新小组件；账单明细、备注和登录凭证不会进入共享文件。"
                     : "小组件依赖 App Group 共享容器。当前签名（例如免费 Apple ID 自签）通常不带该权限，因此小组件只能显示「尚未同步」。要使用小组件，请换用支持 App Groups 的签名重新安装。")
                    .font(.footnote).foregroundStyle(.secondary)
            } header: {
                Text("共享数据")
            }

            Section("小组件当前显示") {
                if let snapshot {
                    LedgerFieldRow(title: "账户总余额", value: snapshot.totalBalanceCents.map { LedgerFormat.money($0) } ?? "无")
                    LedgerFieldRow(title: "本月收入", value: snapshot.monthIncomeCents.map { LedgerFormat.money($0) } ?? "无")
                    LedgerFieldRow(title: "本月支出", value: snapshot.monthExpenseCents.map { LedgerFormat.money($0) } ?? "无")
                    ForEach(LedgerPurpose.allCases) { purpose in
                        LedgerFieldRow(title: purpose.title,
                                       value: snapshot.purpose(purpose).map { LedgerFormat.money($0.balanceCents) } ?? "无")
                    }
                    LedgerFieldRow(title: "最近同步", value: LedgerFormat.date(snapshot.updatedAt, time: true))
                } else {
                    LedgerEmptyView(title: "还没有同步数据",
                                    message: store.isAvailable
                                        ? "登录后点「立即同步」，桌面小组件就会显示汇总金额。"
                                        : "当前安装无法共享小组件数据；要先支持 App Groups 的签名安装，小组件才会显示金额。",
                                    symbol: "rectangle.3.group")
                }
            }

            Section {
                Button {
                    Task { await syncNow() }
                } label: {
                    HStack {
                        Label("立即同步", systemImage: "arrow.triangle.2.circlepath")
                        Spacer(minLength: 8)
                        if syncing { ProgressView() }
                    }
                }
                .disabled(syncing || !store.isAvailable)
                if !store.isAvailable {
                    Text("当前安装的签名没有 App Group 共享权限，同步不会生效。")
                        .font(.footnote).foregroundStyle(.orange)
                } else if let notice {
                    Text(notice).font(.footnote).foregroundStyle(.secondary)
                }
            } footer: {
                Text("同步只读取服务器汇总：账户余额、本月趋势与四用途资金汇总。")
            }

            Section("添加到桌面") {
                Text("1. 回到桌面，长按空白处 → 左上角「+」\n2. 搜索「记账」，选择「记账概览」或「四用途」\n3. 选择小、中、大尺寸后点「添加小组件」")
                    .font(.subheadline)
                Text("小组件内容来自服务器汇总，不会自行加减账单。")
                    .font(.footnote).foregroundStyle(.secondary)
            }
        }
        .navigationTitle("桌面小组件")
        .navigationBarTitleDisplayMode(.inline)
        .task { snapshot = store.load() }
        .refreshable { snapshot = store.load() }
    }

    private func syncNow() async {
        guard store.isAvailable else {
            notice = "当前安装不支持小组件数据共享。"
            return
        }
        syncing = true
        notice = nil
        let wrote = await LedgerWidgetSync.shared.refresh(api: api, userID: userID)
        snapshot = store.load()
        syncing = false
        if wrote {
            notice = "已同步，返回桌面即可看到最新金额。"
        } else if snapshot != nil {
            notice = "暂时读不到服务器汇总，小组件保留上次同步的金额。"
        } else {
            notice = "暂时读不到服务器汇总，请检查网络后重试。"
        }
    }
}
