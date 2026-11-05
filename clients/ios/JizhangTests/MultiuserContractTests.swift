import XCTest
@testable import Jizhang

final class MultiuserContractTests: XCTestCase {
    override func tearDown() {
        CoreMockURLProtocol.setHandler(nil)
        super.tearDown()
    }

    func testLegacyAndIncompleteCapabilitiesNeverGrantAdminUI() throws {
        let legacy = try decodeUser(#"{"username":"owner","expiresAt":4102444800000}"#)
        XCTAssertNil(legacy.id)
        XCTAssertFalse(legacy.canManageInvitations)
        let adminWithoutCapability = try decodeUser(#"{"id":"one","username":"owner","role":"admin","expiresAt":4102444800000}"#)
        XCTAssertFalse(adminWithoutCapability.canManageInvitations)
        let memberWithCapability = try decodeUser(#"{"id":"two","username":"member","role":"member","capabilities":["manageInvitations"],"expiresAt":4102444800000}"#)
        XCTAssertFalse(memberWithCapability.canManageInvitations)
        XCTAssertTrue(try decodeUser(Self.adminJSON).canManageInvitations)
        XCTAssertThrowsError(try decodeUser(#"{"id":"","username":"owner","expiresAt":4102444800000}"#))
    }

    func testRegistrationValidationPreservesPasswordAndNormalizesOnlyOuterWhitespace() throws {
        var draft = RegistrationDraft(username: "  new.user\n", password: " secret88 ", confirmation: " secret88 ", invitationCode: "  invite-code\n")
        let body = try draft.payload()
        XCTAssertEqual(body["username"].stringValue, "new.user")
        XCTAssertEqual(body["password"].stringValue, " secret88 ")
        XCTAssertEqual(body["invitationCode"].stringValue, "invite-code")
        XCTAssertNil(body.objectValue?["confirmation"])
        draft.confirmation = "secret88"
        XCTAssertThrowsError(try draft.payload())
        draft.confirmation = draft.password
        draft.username = "ab"
        XCTAssertThrowsError(try draft.payload())
        draft.username = "中文账号"
        XCTAssertThrowsError(try draft.payload())
        draft.username = "valid"
        draft.password = String(repeating: "🪴", count: 65); draft.confirmation = draft.password
        XCTAssertThrowsError(try draft.payload())
    }

    @MainActor
    func testRegistrationActivatesIndependentIdentityAndReplacesOldClient() async throws {
        let suite = UUID().uuidString
        let preferences = UserDefaults(suiteName: suite)!
        defer { preferences.removePersistentDomain(forName: suite) }
        let store = CoreMemoryCredentialStore()
        let session = AppSession(preferences: preferences, credentialStore: store, configuration: Self.configuration)
        CoreMockURLProtocol.setHandler { request in
            XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
            let registering = request.url?.path == "/api/v1/auth/register"
            return try Self.response(request, status: registering ? 201 : 200,
                json: registering ? Self.memberJSON : Self.adminJSON,
                cookie: registering ? "member-cookie" : "owner-cookie")
        }
        await session.signIn(serverAddress: "https://example.com", username: "owner", password: "password8")
        let oldClient = try XCTUnwrap(session.api)
        XCTAssertTrue(try XCTUnwrap(session.user).canManageInvitations)
        await session.register(serverAddress: "https://example.com", draft: Self.validDraft)
        let newClient = try XCTUnwrap(session.api)
        XCTAssertNotEqual(oldClient.identity, newClient.identity)
        XCTAssertEqual(session.user?.id, "member-id")
        XCTAssertFalse(try XCTUnwrap(session.user).canManageInvitations)
        XCTAssertEqual(preferences.string(forKey: "jizhang.username"), "member")
        XCTAssertEqual(try store.load(server: "https://example.com")?.value, "member-cookie")
        do {
            let _: JSONValue = try await oldClient.request("/accounts")
            XCTFail("Previous account must be invalidated")
        } catch is CancellationError {}
        newClient.invalidate()
    }

    @MainActor
    func testRegistrationNeedsSessionCookieAndDoesNotSaveFormSecrets() async throws {
        let suite = UUID().uuidString
        let preferences = UserDefaults(suiteName: suite)!
        defer { preferences.removePersistentDomain(forName: suite) }
        let session = AppSession(preferences: preferences, credentialStore: CoreMemoryCredentialStore(), configuration: Self.configuration)
        CoreMockURLProtocol.setHandler { request in try Self.response(request, status: 201, json: Self.memberJSON) }
        await session.register(serverAddress: "https://example.com", draft: Self.validDraft)
        XCTAssertNil(session.api)
        XCTAssertNil(session.user)
        XCTAssertEqual(session.errorMessage, APIError.sessionMissing.message)
        XCTAssertTrue(preferences.persistentDomain(forName: suite)?.isEmpty ?? true)
    }

    @MainActor
    func testInvitationCreateCopyOnceAndRevokeContract() async throws {
        let api = try makeClient()
        defer { api.invalidate() }
        let store = InvitationStore(api: api, user: try decodeUser(Self.adminJSON))
        CoreMockURLProtocol.setHandler { request in
            switch request.httpMethod {
            case "GET":
                return try Self.response(request, json: "{\"invitations\":[\(Self.invitationJSON)]}")
            case "POST":
                XCTAssertEqual(request.value(forHTTPHeaderField: "X-Requested-With"), "fetch")
                return try Self.response(request, status: 201, json: "{\"invitation\":\(Self.invitationJSON),\"code\":\"one-time-secret\"}")
            case "DELETE":
                XCTAssertEqual(request.url?.path, "/api/v1/admin/invitations/invite-id")
                return try Self.response(request, json: #"{"ok":true}"#)
            default: throw URLError(.badURL)
            }
        }
        await store.load()
        XCTAssertEqual(store.invitations.count, 1)
        XCTAssertNil(store.created)
        await store.create()
        XCTAssertEqual(store.created?.code, "one-time-secret")
        XCTAssertEqual(store.invitations.count, 1)
        store.dismissCode()
        XCTAssertNil(store.created)
        await store.revoke(try XCTUnwrap(store.invitations.first))
        XCTAssertEqual(store.invitations.first?.status, .revoked)
        XCTAssertNil(store.error)
    }

    @MainActor
    func testInvitationPermissionRejectionClearsSensitivePresentation() async throws {
        let api = try makeClient()
        defer { api.invalidate() }
        let store = InvitationStore(api: api, user: try decodeUser(Self.adminJSON))
        CoreMockURLProtocol.setHandler { request in
            if request.httpMethod == "POST" {
                return try Self.response(request, status: 201, json: "{\"invitation\":\(Self.invitationJSON),\"code\":\"secret\"}")
            }
            return try Self.response(request, status: 403, json: #"{"error":{"code":"FORBIDDEN"}}"#)
        }
        await store.create()
        XCTAssertNotNil(store.created)
        await store.load()
        XCTAssertTrue(store.permissionDenied)
        XCTAssertFalse(store.canManage)
        XCTAssertNil(store.created)
        XCTAssertTrue(store.invitations.isEmpty)
    }

    @MainActor
    func testMemberNeverRequestsInvitationAdministration() async throws {
        let api = try makeClient()
        defer { api.invalidate() }
        CoreMockURLProtocol.setHandler { _ in XCTFail("Member must not issue an admin request"); throw URLError(.badURL) }
        let store = InvitationStore(api: api, user: try decodeUser(Self.memberJSON))
        await store.load()
        await store.create()
        XCTAssertTrue(store.permissionDenied)
        XCTAssertNil(store.created)
    }

    @MainActor
    func testDuplicateCreateAndLateResponseAfterLeavingCannotRevealCode() async throws {
        let api = try makeClient()
        defer { api.invalidate() }
        let store = InvitationStore(api: api, user: try decodeUser(Self.adminJSON))
        let started = expectation(description: "Single create request started")
        started.assertForOverFulfill = true
        let gate = DispatchSemaphore(value: 0)
        CoreMockURLProtocol.setHandler { request in
            started.fulfill()
            XCTAssertEqual(gate.wait(timeout: .now() + 5), .success)
            return try Self.response(request, status: 201, json: "{\"invitation\":\(Self.invitationJSON),\"code\":\"late-secret\"}")
        }
        let pending = Task { await store.create() }
        await fulfillment(of: [started], timeout: 5)
        XCTAssertTrue(store.busy)
        await store.create()
        store.leave()
        gate.signal()
        await pending.value
        XCTAssertFalse(store.busy)
        XCTAssertNil(store.created)
        XCTAssertTrue(store.invitations.isEmpty)
    }

    func testInvitationExpiryAndSafeIdentifierPath() throws {
        let invitation = try JSONDecoder().decode(Invitation.self, from: Data(Self.invitationJSON.utf8))
        XCTAssertEqual(invitation.currentStatus(now: Date(timeIntervalSince1970: 4_102_444_801)), .expired)
        XCTAssertEqual(invitation.currentStatus(now: Date(timeIntervalSince1970: 1)), .active)
        let hostile = Invitation(id: "../other?x=1", createdAt: 1, expiresAt: 10, status: .active, usedAt: nil)
        let path = try hostile.revokePath
        XCTAssertFalse(path.contains("?"))
        XCTAssertFalse(path.contains("../"))
    }

    private func decodeUser(_ json: String) throws -> AuthenticatedUser {
        try JSONDecoder().decode(AuthenticatedUser.self, from: Data(json.utf8))
    }

    @MainActor private func makeClient() throws -> APIClient {
        try APIClient(baseURL: ServerAddress.parse("https://example.com"), credentialStore: CoreMemoryCredentialStore(),
                      restoreSession: false, configuration: Self.configuration())
    }

    private static func configuration() -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CoreMockURLProtocol.self]
        return configuration
    }

    private static func response(_ request: URLRequest, status: Int = 200, json: String, cookie: String? = nil) throws -> (HTTPURLResponse, Data) {
        var headers = ["Content-Type": "application/json"]
        if let cookie { headers["Set-Cookie"] = "jizhang_session=\(cookie); Path=/; Max-Age=3600; Secure; HttpOnly" }
        let response = try XCTUnwrap(HTTPURLResponse(url: XCTUnwrap(request.url), statusCode: status, httpVersion: nil, headerFields: headers))
        return (response, Data(json.utf8))
    }

    private static let adminJSON = #"{"id":"owner-id","username":"owner","role":"admin","capabilities":["manageInvitations"],"expiresAt":4102444800000}"#
    private static let memberJSON = #"{"id":"member-id","username":"member","role":"member","capabilities":[],"expiresAt":4102444800000}"#
    private static let invitationJSON = #"{"id":"invite-id","createdAt":1793750400000,"expiresAt":4102444800000,"status":"active","usedAt":null}"#
    private static let validDraft = RegistrationDraft(username: "member", password: "password8", confirmation: "password8", invitationCode: "invite-code")
}
