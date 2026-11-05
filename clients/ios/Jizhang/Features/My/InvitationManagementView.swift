import SwiftUI
import UIKit

@MainActor
struct InvitationManagementView: View {
    @StateObject private var store: InvitationStore
    @State private var revoking: Invitation?
    @State private var copied = false
    @State private var mutation: Task<Void, Never>?

    init(api: APIClient, user: AuthenticatedUser) {
        _store = StateObject(wrappedValue: InvitationStore(api: api, user: user))
    }

    var body: some View {
        List {
            if store.permissionDenied {
                Section { Label("当前账号没有管理邀请码的权限。", systemImage: "lock") }
            } else {
                Section {
                    Button {
                        copied = false
                        mutation = Task { await store.create() }
                    } label: {
                        Label("创建邀请码", systemImage: "plus.circle.fill")
                            .frame(minHeight: 36)
                    }
                    .disabled(store.busy || store.created != nil)
                } footer: { Text("每个邀请码可注册一个账号，7 天后过期。新用户拥有独立的账本和 AI 配置。") }

                if let created = store.created {
                    Section {
                        Text(created.code)
                            .font(.system(.body, design: .monospaced)).textSelection(.enabled)
                            .accessibilityLabel("邀请码：\(created.code)")
                        Button {
                            UIPasteboard.general.setItems([[UIPasteboard.typeAutomatic: created.code]], options: [
                                .localOnly: true,
                                .expirationDate: min(created.invitation.expiryDate, Date().addingTimeInterval(600))
                            ])
                            copied = true
                        } label: { Label(copied ? "已复制" : "复制邀请码", systemImage: copied ? "checkmark" : "doc.on.doc") }
                        Button("已保存，收起邀请码") { store.dismissCode(); copied = false }
                    } header: { Text("刚创建的邀请码") } footer: {
                        Text("完整邀请码只显示这一次，请复制给受邀者。离开页面后无法再次查看。")
                    }
                }

                if let error = store.error {
                    Section {
                        Label(error, systemImage: "info.circle").font(.subheadline).foregroundStyle(.secondary)
                        Button("刷新列表") { mutation = Task { await store.load() } }.disabled(store.busy)
                    }
                }

                Section("邀请码记录") {
                    if store.busy { ProgressView().frame(maxWidth: .infinity) }
                    if store.hasLoaded && store.invitations.isEmpty {
                        Text("还没有邀请码").foregroundStyle(.secondary)
                    }
                    ForEach(store.invitations) { invitation in
                        invitationRow(invitation)
                    }
                }
            }
        }
        .navigationTitle("邀请码管理")
        .navigationBarTitleDisplayMode(.inline)
        .task { await store.load() }
        .refreshable { await store.load() }
        .onDisappear { mutation?.cancel(); mutation = nil; store.leave() }
        .confirmationDialog("撤销这个邀请码？", isPresented: Binding(
            get: { revoking != nil }, set: { if !$0 { revoking = nil } }
        ), titleVisibility: .visible, presenting: revoking) { invitation in
            Button("撤销邀请码", role: .destructive) {
                mutation = Task { await store.revoke(invitation) }
                revoking = nil
            }
            Button("取消", role: .cancel) { revoking = nil }
        } message: { _ in Text("撤销后将无法用它注册。") }
    }

    private func invitationRow(_ invitation: Invitation) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(invitation.currentStatus().title).font(.subheadline.weight(.medium))
                Spacer()
                if invitation.currentStatus() == .active {
                    Button("撤销", role: .destructive) { revoking = invitation }
                        .buttonStyle(.borderless).disabled(store.busy)
                }
            }
            Text("创建于 \(Date(timeIntervalSince1970: Double(invitation.createdAt) / 1_000).formatted(date: .abbreviated, time: .shortened))")
                .font(.caption).foregroundStyle(.secondary)
            Text("有效期至 \(invitation.expiryDate.formatted(date: .abbreviated, time: .shortened))")
                .font(.caption).foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
    }
}
