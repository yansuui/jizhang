import SwiftUI

@MainActor struct NativeWorkspaceView: View {
    let api: APIClient
    let user: AuthenticatedUser
    let route: NativeWorkspaceRoute
    let onLogout: () -> Void
    var onCompletion: ((NativeWorkspaceCompletion) -> Void)? = nil
    @Environment(\.dismiss) private var dismiss
    @State private var completed = false
    var body: some View {
        NavigationStack {
            content
                .toolbar { ToolbarItem(placement: .cancellationAction) {
                    Button(completed && route.sourceMessageID != nil ? "完成并继续对话" : "完成") { dismiss() }
                } }
        }
        .environment(\.recordJizhangNativeResult, { reference in
            guard let completion = NativeWorkspaceCompletion(apiIdentity: api.identity, route: route, reference: reference) else { return }
            completed = true
            // App retains this receipt and publishes only after the actual sheet dismissal.
            onCompletion?(completion)
        })
    }
    @ViewBuilder private var content: some View {
        switch route.destination {
        case .providerSettings: ProviderSettingsView(api: api)
        case .invitations:
            if user.canManageInvitations { InvitationManagementView(api: api, user: user) }
            else { ContentUnavailableView("当前账号没有邀请码管理权限", systemImage: "lock") }
        case .password: NativePasswordView(api: api, onLogout: onLogout)
        case .dataImport: NativeCSVImportView(api: api, sourceMessageID: route.sourceMessageID)
        case .platformImport: NativeBatchImportView(api: api, conversationID: route.conversationID, batchID: route.batchID, sourceMessageID: route.sourceMessageID)
        case .dataExport: NativeExportView(api: api)
        case .itemPhoto, .itemCutout:
            if let item = route.itemID {
                NativeItemPhotoView(api: api, itemID: item, cutout: route.destination == .itemCutout)
            } else { NativePhotoItemChooser(api: api, cutout: route.destination == .itemCutout) }
        case .reminders: DailyReminderSettingsView()
        case .logout, .serverSwitch:
            Form {
                Section {
                    Text(route.destination == .serverSwitch ? "退出当前账号后，可以在登录页修改服务器地址或切换账号。" : "退出后保留服务器上的账本和对话。")
                    Button(route.destination == .serverSwitch ? "退出并切换服务器或账号" : "确认退出当前账号",
                           role: .destructive, action: onLogout)
                }
            }.navigationTitle(route.destination == .serverSwitch ? "切换服务器" : "退出登录")
        }
    }
}

@MainActor struct NativePasswordView: View {
    let api: APIClient
    let onLogout: () -> Void
    @State private var current = ""
    @State private var password = ""
    @State private var repeated = ""
    @State private var busy = false
    @State private var error: String?
    var body: some View {
        Form {
            Section("修改登录密码") {
                SecureField("当前密码", text: $current).textContentType(.password)
                SecureField("新密码（8–128 位）", text: $password).textContentType(.newPassword)
                SecureField("再次输入新密码", text: $repeated).textContentType(.newPassword)
            }
            Text("确认修改会使所有设备上的登录失效。密码只发送到当前服务器，不会进入 AI 对话。")
                .font(.footnote).foregroundStyle(.secondary)
            if let error { Text(error).foregroundStyle(.red) }
            Button {
                Task { await change() }
            } label: { HStack { Text("确认修改密码并重新登录"); if busy { ProgressView() } } }
                .disabled(busy || current.isEmpty || password.utf16.count < 8 || password.utf16.count > 128 || password != repeated)
        }
        .navigationTitle("修改密码")
        .disabled(busy)
        .onDisappear { current = ""; password = ""; repeated = "" }
    }
    private func change() async {
        guard !busy else { return }
        busy = true; error = nil; defer { busy = false }
        do {
            let value: JSONValue = try await api.request("/auth/password", method: "POST",
                body: .object(["currentPassword": .string(current), "newPassword": .string(password)]))
            try Task.checkCancellation()
            guard value["ok"].boolValue == true, value["reauthenticate"].boolValue == true else { throw NativeDataError.invalidResponse }
            current = ""; password = ""; repeated = ""
            try api.clearStoredSession(); api.invalidate(); onLogout()
        } catch {
            guard !Task.isCancelled else { return }
            self.error = (error as? APIError)?.status == 0
                ? "修改结果尚未确认。请尝试使用新密码重新登录核对。" : error.localizedDescription
        }
    }
}

@MainActor struct NativeBackupView: View {
    let api: APIClient
    @State private var files: [String] = []
    @State private var busy = false
    @State private var error: String?
    @State private var notice: String?
    var body: some View {
        List {
            Section {
                Text("创建当前账本的备份，不改变账单。备份文件保留在服务器。")
                Button("确认创建备份") { Task { await create() } }.disabled(busy)
                if let notice { Text(notice).foregroundStyle(AppTheme.accent) }
            }
            Section("服务器备份") {
                if busy { ProgressView() }
                if let error { Text(error).foregroundStyle(.red) }
                ForEach(files, id: \.self) { Text($0).textSelection(.enabled) }
                Button("刷新列表") { Task { await load() } }.disabled(busy)
            }
            Section("恢复备份") {
                Text("恢复需要管理员先停止服务器，核对备份后执行恢复，再启动服务。当前服务不提供在线恢复或备份下载接口。")
                    .font(.footnote).foregroundStyle(.secondary)
            }
        }.navigationTitle("备份").task { await load() }
    }
    private func load() async {
        guard !busy else { return }; busy = true; error = nil; defer { busy = false }
        do {
            let value: JSONValue = try await api.request("/backups")
            try Task.checkCancellation()
            let list = value.arrayValue ?? value["files"].arrayValue ?? value["items"].arrayValue
            guard let list, list.allSatisfy({ $0.stringValue != nil || $0["fileName"].stringValue != nil || $0["name"].stringValue != nil }) else { throw NativeDataError.invalidResponse }
            files = list.compactMap { $0.stringValue ?? $0["fileName"].stringValue ?? $0["name"].stringValue }
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
    private func create() async {
        guard !busy else { return }; busy = true; error = nil
        do {
            let _: JSONValue = try await api.request("/backups", method: "POST")
            try Task.checkCancellation(); notice = "备份已创建。"
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
        busy = false; await load()
    }
}
