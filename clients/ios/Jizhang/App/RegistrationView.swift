import SwiftUI

@MainActor
struct RegistrationView: View {
    @ObservedObject var session: AppSession
    let serverAddress: String
    @Environment(\.dismiss) private var dismiss
    @State private var draft = RegistrationDraft()
    @State private var showsPassword = false
    @FocusState private var focusedField: Field?
    private enum Field: Hashable { case invitation, username, password, confirmation }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("用邀请码开启自己的账本")
                        .font(.headline)
                    Text("账单、AI 对话和助手配置只属于当前账号。")
                        .font(.subheadline).foregroundStyle(.secondary)
                    Text((try? ServerAddress.parse(serverAddress).host) ?? "请先在登录页设置服务器地址")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Section {
                    TextField("邀请码", text: $draft.invitationCode)
                        .focused($focusedField, equals: .invitation)
                        .submitLabel(.next).onSubmit { focusedField = .username }
                    TextField("账号", text: $draft.username)
                        .textContentType(.username)
                        .focused($focusedField, equals: .username)
                        .submitLabel(.next).onSubmit { focusedField = .password }
                    Group {
                        if showsPassword { TextField("密码", text: $draft.password) }
                        else { SecureField("密码", text: $draft.password) }
                    }
                    .textContentType(.newPassword)
                    .focused($focusedField, equals: .password)
                    .submitLabel(.next).onSubmit { focusedField = .confirmation }
                    Group {
                        if showsPassword { TextField("再次输入密码", text: $draft.confirmation) }
                        else { SecureField("再次输入密码", text: $draft.confirmation) }
                    }
                    .textContentType(.newPassword)
                    .focused($focusedField, equals: .confirmation)
                    .submitLabel(.go).onSubmit(submit)
                    Toggle("显示密码", isOn: $showsPassword)
                } footer: {
                    Text("账号为 3–64 位英文字母、数字、点、下划线或短横线；密码为 8–128 位。邀请码只能使用一次。")
                }
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .disabled(session.isBusy)
                if let message = session.errorMessage {
                    Section {
                        Label(message, systemImage: "info.circle")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                }
                Section {
                    Button(action: submit) {
                        HStack {
                            if session.isBusy { ProgressView() }
                            Text(session.isBusy ? "正在创建账本…" : "注册并登录").fontWeight(.semibold)
                        }
                        .frame(maxWidth: .infinity, minHeight: 38)
                    }
                    .disabled(session.isBusy || draft.username.isEmpty || draft.password.isEmpty
                              || draft.confirmation.isEmpty || draft.invitationCode.isEmpty)
                } footer: {
                    Text("如果注册后网络中断，可返回登录页使用刚设置的账号和密码登录。")
                }
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("邀请码注册")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }.disabled(session.isBusy)
                }
            }
        }
        .interactiveDismissDisabled(session.isBusy)
        .onDisappear { draft.password = ""; draft.confirmation = ""; draft.invitationCode = "" }
    }

    private func submit() {
        guard !session.isBusy else { return }
        focusedField = nil
        Task {
            await session.register(serverAddress: serverAddress, draft: draft)
            if session.api != nil {
                draft.password = ""; draft.confirmation = ""; draft.invitationCode = ""
                dismiss()
            }
        }
    }
}
