import SwiftUI

@MainActor
struct LoginView: View {
    @ObservedObject var session: AppSession
    @State private var username = ""
    @State private var password = ""
    @State private var serverAddress = ServerAddress.defaultAddress
    @State private var showsPassword = false
    @State private var showsConnection = false
    @State private var loadedPreferences = false
    @State private var showsRegistration = false
    @FocusState private var focusedField: Field?

    private enum Field: Hashable { case username, password, server }

    var body: some View {
        ScrollView {
            VStack(spacing: 28) {
                brand
                    .padding(.top, 36)
                VStack(alignment: .leading, spacing: 22) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("欢迎回来")
                            .font(.title2.weight(.bold))
                        Text("登录你的账本，让收支一目了然。")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }

                    VStack(spacing: 16) {
                        VStack(alignment: .leading, spacing: 7) {
                            Text("账号").font(.subheadline.weight(.medium))
                            TextField("输入账本账号", text: $username)
                                .textContentType(.username)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .submitLabel(.next)
                                .focused($focusedField, equals: .username)
                                .onSubmit { focusedField = .password }
                                .loginField()
                        }
                        VStack(alignment: .leading, spacing: 7) {
                            Text("密码").font(.subheadline.weight(.medium))
                            HStack {
                                Group {
                                    if showsPassword { TextField("输入密码", text: $password) }
                                    else { SecureField("输入密码", text: $password) }
                                }
                                .textContentType(.password)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .focused($focusedField, equals: .password)
                                .submitLabel(.go)
                                .onSubmit(submit)
                                Button { showsPassword.toggle() } label: {
                                    Image(systemName: showsPassword ? "eye.slash" : "eye")
                                        .foregroundStyle(.secondary)
                                        .frame(width: 44, height: 44)
                                }
                                .accessibilityLabel(showsPassword ? "隐藏密码" : "显示密码")
                            }
                            .padding(.leading, 14)
                            .background(Color(uiColor: .secondarySystemGroupedBackground))
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.quaternary))
                        }
                    }
                    .disabled(session.isBusy)

                    if let message = session.errorMessage {
                        Label(message, systemImage: "info.circle")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityLabel(message)
                    }

                    Button(action: submit) {
                        HStack(spacing: 10) {
                            if session.isBusy { ProgressView().tint(.white) }
                            Text(session.isRestoring ? "正在恢复登录…" : session.isBusy ? "正在登录…" : "登录账本")
                                .fontWeight(.semibold)
                            if !session.isBusy { Image(systemName: "arrow.right") }
                        }
                        .frame(maxWidth: .infinity, minHeight: 52)
                    }
                    .buttonStyle(.borderedProminent)
                    .buttonBorderShape(.roundedRectangle(radius: 14))
                    .disabled(session.isBusy || username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || password.isEmpty)

                    Button("邀请码注册") {
                        focusedField = nil
                        password = ""
                        session.clearError()
                        showsRegistration = true
                    }
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .disabled(session.isBusy)

                    if session.isRestoring {
                        Button("改用账号密码登录") { session.cancelRestore() }
                            .frame(maxWidth: .infinity, minHeight: 44)
                    } else if session.canRetryRestore {
                        Button("重试恢复上次登录") { Task { await session.restore(force: true) } }
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .disabled(session.isBusy)
                    }
                }
                .padding(24)
                .background(.background, in: RoundedRectangle(cornerRadius: 24))

                DisclosureGroup(isExpanded: $showsConnection) {
                    VStack(alignment: .leading, spacing: 12) {
                        TextField("https://你的服务器", text: $serverAddress)
                            .keyboardType(.URL)
                            .textContentType(.URL)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .focused($focusedField, equals: .server)
                            .submitLabel(.done)
                            .loginField()
                        Text("填写记账服务的 HTTPS 地址。AI 模型接口在登录后的 AI 设置中配置。")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.top, 12)
                } label: {
                    Label("连接你的账本", systemImage: "network")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.primary)
                        .frame(minHeight: 44)
                }
                .disabled(session.isBusy)
                .padding(.horizontal, 6)

                Text("看清收支 · 安排生活")
                    .font(.footnote)
                    .foregroundStyle(.tertiary)
                    .padding(.bottom, 24)
            }
            .frame(maxWidth: 460)
            .padding(.horizontal, 24)
            .frame(maxWidth: .infinity)
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .scrollDismissesKeyboard(.interactively)
        .sheet(isPresented: $showsRegistration, onDismiss: { session.clearError() }) {
            RegistrationView(session: session, serverAddress: serverAddress)
        }
        .onAppear {
            guard !loadedPreferences else { return }
            loadedPreferences = true
            serverAddress = session.savedServerAddress
            username = session.savedUsername
        }
    }

    private var brand: some View {
        VStack(spacing: 14) {
            Image(systemName: "leaf.fill")
                .font(.system(size: 34, weight: .semibold))
                .foregroundStyle(AppTheme.accent)
                .frame(width: 76, height: 76)
                .background(AppTheme.accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 24))
                .accessibilityHidden(true)
            Text("记账")
                .font(.system(.largeTitle, design: .rounded, weight: .bold))
            Text("让每一笔，都有答案。")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
    }

    private func submit() {
        guard !session.isBusy else { return }
        focusedField = nil
        Task {
            await session.signIn(serverAddress: serverAddress, username: username, password: password)
            if session.api != nil { password = "" }
        }
    }
}

private extension View {
    func loginField() -> some View {
        padding(.horizontal, 14)
            .frame(minHeight: 48)
            .background(Color(uiColor: .secondarySystemGroupedBackground))
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(.quaternary))
    }
}
