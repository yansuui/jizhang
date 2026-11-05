import Combine
import Foundation

@MainActor
final class AppSession: ObservableObject {
    @Published private(set) var api: APIClient?
    @Published private(set) var isBusy = false
    @Published private(set) var isRestoring = false
    @Published private(set) var canRetryRestore = false
    @Published private(set) var errorMessage: String?
    @Published private(set) var username = ""
    @Published private(set) var user: AuthenticatedUser?

    private let preferences: UserDefaults
    private let credentialStore: SessionCredentialStore
    private let configuration: () -> URLSessionConfiguration
    private var operation = UUID()
    private var candidate: APIClient?
    private var attemptedRestore = false

    init(preferences: UserDefaults = .standard, credentialStore: SessionCredentialStore = KeychainSessionStore(),
         configuration: @escaping () -> URLSessionConfiguration = { .ephemeral }) {
        self.preferences = preferences
        self.credentialStore = credentialStore
        self.configuration = configuration
    }

    var savedServerAddress: String {
        preferences.string(forKey: "jizhang.serverAddress") ?? ServerAddress.defaultAddress
    }

    var savedUsername: String {
        preferences.string(forKey: "jizhang.username") ?? ""
    }

    func restore(force: Bool = false) async {
        guard !isBusy, api == nil, force || !attemptedRestore else { return }
        attemptedRestore = true
        let ticket = begin(restoring: true)
        defer { finish(ticket) }
        do {
            let address = try ServerAddress.parse(savedServerAddress)
            let client = try APIClient(baseURL: address, credentialStore: credentialStore, configuration: configuration())
            candidate = client
            guard client.hasSession else {
                client.invalidate()
                canRetryRestore = false
                return
            }
            let user: AuthenticatedUser = try await client.request("/auth/me")
            guard operation == ticket, !Task.isCancelled else { client.invalidate(); return }
            try activate(client, user: user)
        } catch is CancellationError {
            // Cancellation belongs to this attempt; a newer attempt owns UI state.
        } catch {
            guard operation == ticket else { return }
            canRetryRestore = candidate?.hasSession == true
            errorMessage = error.localizedDescription
            candidate?.invalidate()
        }
    }

    func signIn(serverAddress: String, username: String, password: String) async {
        guard !isBusy else { return }
        let trimmedUsername = username.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedUsername.isEmpty, !password.isEmpty else {
            errorMessage = "请输入账号和密码。"
            return
        }
        await authenticate(serverAddress: serverAddress, path: "/auth/login", body: .object([
            "username": .string(trimmedUsername), "password": .string(password)
        ]))
    }

    func register(serverAddress: String, draft: RegistrationDraft) async {
        guard !isBusy else { return }
        do {
            let body = try draft.payload()
            await authenticate(serverAddress: serverAddress, path: "/auth/register", body: body)
        } catch { errorMessage = error.localizedDescription }
    }

    func clearError() { if !isBusy { errorMessage = nil } }

    private func authenticate(serverAddress: String, path: String, body: JSONValue) async {
        let ticket = begin(restoring: false)
        defer { finish(ticket) }
        do {
            let address = try ServerAddress.parse(serverAddress)
            // Login and registration never send a previous account's cookie.
            let client = try APIClient(baseURL: address, credentialStore: credentialStore, restoreSession: false,
                                       configuration: configuration())
            candidate = client
            let user: AuthenticatedUser = try await client.request(path, method: "POST", body: body)
            guard operation == ticket, !Task.isCancelled else { client.invalidate(); return }
            guard path != "/auth/register" || user.id != nil else { throw APIError.invalidResponse }
            try activate(client, user: user)
        } catch is CancellationError {
        } catch {
            guard operation == ticket else { return }
            errorMessage = error.localizedDescription
            candidate?.invalidate()
        }
    }

    func cancelRestore() {
        guard isRestoring else { return }
        operation = UUID()
        candidate?.invalidate()
        candidate = nil
        isBusy = false
        isRestoring = false
        canRetryRestore = true
        errorMessage = nil
    }

    func signOut() async {
        guard !isBusy, let client = api else { return }
        let ticket = begin(restoring: false)
        var logoutNotice: String?
        do {
            let _: EmptyResponse = try await client.request("/auth/logout", method: "POST")
        } catch is CancellationError {
        } catch {
            logoutNotice = "已退出本机登录。服务器会话暂未注销，将按服务器有效期到期。"
        }
        guard operation == ticket else { return }
        do { try client.clearStoredSession() }
        catch { logoutNotice = "无法清除设备安全存储，请解锁设备后再次登录并退出。" }
        client.invalidate()
        api = nil
        username = ""
        user = nil
        canRetryRestore = false
        errorMessage = logoutNotice
        finish(ticket)
    }

    private func begin(restoring: Bool) -> UUID {
        candidate?.invalidate()
        candidate = nil
        operation = UUID()
        errorMessage = nil
        isBusy = true
        isRestoring = restoring
        return operation
    }

    private func finish(_ ticket: UUID) {
        guard operation == ticket else { return }
        if candidate?.identity != api?.identity { candidate?.invalidate() }
        candidate = nil
        isBusy = false
        isRestoring = false
    }

    private func activate(_ client: APIClient, user: AuthenticatedUser) throws {
        guard client.hasSession, user.expiresAt > Int64(Date().timeIntervalSince1970 * 1_000) else {
            throw APIError.sessionMissing
        }
        api?.invalidate()
        let identity = client.identity
        client.onUnauthorized = { [weak self] in
            guard let self, self.api?.identity == identity else { return }
            self.operation = UUID()
            self.api = nil
            self.username = ""
            self.user = nil
            self.isBusy = false
            self.isRestoring = false
            self.canRetryRestore = false
            self.errorMessage = APIError.unauthorized.localizedDescription
        }
        preferences.set(client.baseURL.absoluteString, forKey: "jizhang.serverAddress")
        preferences.set(user.username, forKey: "jizhang.username")
        username = user.username
        self.user = user
        canRetryRestore = false
        errorMessage = nil
        api = client
    }
}
