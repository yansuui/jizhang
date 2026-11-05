import XCTest
@testable import Jizhang

final class CoreAPIClientTests: XCTestCase {
    override func tearDown() {
        CoreMockURLProtocol.setHandler(nil)
        super.tearDown()
    }

    @MainActor
    func testLoginStoresCookieAndUsesItForSubsequentRequest() async throws {
        let store = CoreMemoryCredentialStore()
        let client = try makeClient(store: store)
        defer { client.invalidate() }
        CoreMockURLProtocol.setHandler { request in
            let cookieHeader = "jizhang_session=fixture-token; Path=/; Max-Age=3600; Secure; HttpOnly; SameSite=Lax"
            if request.url?.path == "/api/v1/auth/login" {
                XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
                XCTAssertEqual(request.value(forHTTPHeaderField: "X-Requested-With"), "fetch")
                return try Self.response(request, headers: ["Set-Cookie": cookieHeader], json: #"{"username":"fixture","expiresAt":4102444800000}"#)
            }
            XCTAssertEqual(request.value(forHTTPHeaderField: "Cookie"), "jizhang_session=fixture-token")
            return try Self.response(request, json: #"{"username":"fixture","expiresAt":4102444800000}"#)
        }
        let _: AuthenticatedUser = try await client.request("/auth/login", method: "POST", body: .object(["username": .string("fixture"), "password": .string("in-memory")]))
        XCTAssertTrue(client.hasSession)
        XCTAssertEqual(try store.load(server: "https://example.com")?.value, "fixture-token")
        let current: AuthenticatedUser = try await client.request("/auth/me")
        XCTAssertEqual(current.username, "fixture")
    }

    @MainActor
    func testUnauthorizedInvalidatesOnlyItsClientAndClearsStoredCookie() async throws {
        let store = CoreMemoryCredentialStore()
        try store.save(Self.cookie(), server: "https://example.com")
        let client = try makeClient(store: store)
        var callbacks = 0
        client.onUnauthorized = { callbacks += 1 }
        CoreMockURLProtocol.setHandler { request in
            try Self.response(request, status: 401, json: #"{"error":{"code":"UNAUTHORIZED","message":"untrusted"}}"#)
        }
        do {
            let _: JSONValue = try await client.request("/auth/me")
            XCTFail("Expected unauthorized")
        } catch let error as APIError {
            XCTAssertEqual(error.status, 401)
        }
        XCTAssertEqual(callbacks, 1)
        XCTAssertFalse(client.hasSession)
        XCTAssertNil(try store.load(server: "https://example.com"))
        do {
            let _: JSONValue = try await client.request("/accounts")
            XCTFail("Invalidated client must reject new work")
        } catch is CancellationError {}
        XCTAssertEqual(callbacks, 1)
    }

    @MainActor
    func testAnInvalidatedClientCannotExpireOrClearAnotherClient() async throws {
        let store = CoreMemoryCredentialStore()
        try store.save(Self.cookie(), server: "https://example.com")
        let oldClient = try makeClient(store: store)
        let newClient = try makeClient(store: store)
        defer { newClient.invalidate() }
        var callbacks = 0
        oldClient.onUnauthorized = { callbacks += 1 }
        oldClient.invalidate()
        do {
            let _: JSONValue = try await oldClient.request("/auth/me")
            XCTFail("Must reject an obsolete owner")
        } catch is CancellationError {}
        XCTAssertNotEqual(oldClient.identity, newClient.identity)
        XCTAssertTrue(newClient.hasSession)
        XCTAssertNotNil(try store.load(server: "https://example.com"))
        XCTAssertEqual(callbacks, 0)
    }

    @MainActor
    func testExpiredPersistedCookieIsNotRestored() throws {
        let store = CoreMemoryCredentialStore()
        let expired = SessionCookie(value: "fixture", domain: "example.com", path: "/", secure: true, hostOnly: true, expiresAt: Date(timeIntervalSince1970: 1))
        try store.save(expired, server: "https://example.com")
        let client = try makeClient(store: store)
        defer { client.invalidate() }
        XCTAssertFalse(client.hasSession)
        XCTAssertNil(try store.load(server: "https://example.com"))
    }

    @MainActor
    func testFreshLoginDoesNotLoadStoredCredentials() throws {
        let store = CoreMemoryCredentialStore()
        try store.save(Self.cookie(), server: "https://example.com")
        let client = try makeClient(store: store, restoreSession: false)
        defer { client.invalidate() }
        XCTAssertFalse(client.hasSession)
        XCTAssertEqual(store.loadCount, 0)
    }

    @MainActor
    func testRejectedPublicRegistrationDoesNotExpireSavedAccount() async throws {
        let store = CoreMemoryCredentialStore()
        try store.save(Self.cookie(), server: "https://example.com")
        let client = try makeClient(store: store)
        defer { client.invalidate() }
        var callbacks = 0
        client.onUnauthorized = { callbacks += 1 }
        CoreMockURLProtocol.setHandler { request in
            XCTAssertEqual(request.url?.path, "/api/v1/auth/register")
            XCTAssertNil(request.value(forHTTPHeaderField: "Cookie"))
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Requested-With"), "fetch")
            return try Self.response(request, status: 401, json: #"{"error":{"code":"INVALID_INVITATION"}}"#)
        }
        do {
            let _: AuthenticatedUser = try await client.request("/auth/register", method: "POST")
            XCTFail("Expected rejection")
        } catch let error as APIError { XCTAssertEqual(error.code, "INVALID_INVITATION") }
        XCTAssertEqual(callbacks, 0)
        XCTAssertTrue(client.hasSession)
        XCTAssertEqual(try store.load(server: "https://example.com")?.value, "fixture")
    }

    @MainActor
    func testRegistrationMustReturnStableIdentityBeforeSavingCookie() async throws {
        let store = CoreMemoryCredentialStore()
        let client = try makeClient(store: store, restoreSession: false)
        defer { client.invalidate() }
        CoreMockURLProtocol.setHandler { request in
            try Self.response(request, status: 201, headers: ["Set-Cookie": "jizhang_session=unaccepted; Path=/; Max-Age=3600; Secure"],
                              json: #"{"username":"fixture","expiresAt":4102444800000}"#)
        }
        do {
            let _: AuthenticatedUser = try await client.request("/auth/register", method: "POST")
            XCTFail("Registration cannot activate a legacy identity envelope")
        } catch let error as APIError { XCTAssertEqual(error.code, "INVALID_RESPONSE") }
        XCTAssertFalse(client.hasSession)
        XCTAssertNil(try store.load(server: "https://example.com"))
    }

    @MainActor
    func testWrongOriginResponseIsRejectedBeforeCookiePersistence() async throws {
        let store = CoreMemoryCredentialStore()
        let client = try makeClient(store: store)
        defer { client.invalidate() }
        CoreMockURLProtocol.setHandler { _ in
            let response = try XCTUnwrap(HTTPURLResponse(url: URL(string: "https://other.test/api/v1/auth/login")!, statusCode: 200, httpVersion: nil,
                headerFields: ["Content-Type": "application/json", "Set-Cookie": "jizhang_session=wrong; Path=/; Max-Age=3600; Secure"]))
            return (response, Data(#"{"username":"fixture","expiresAt":4102444800000}"#.utf8))
        }
        do {
            let _: AuthenticatedUser = try await client.request("/auth/login", method: "POST")
            XCTFail("Cross-origin response must fail")
        } catch let error as APIError {
            XCTAssertEqual(error.code, "INVALID_RESPONSE")
        }
        XCTAssertFalse(client.hasSession)
        XCTAssertNil(try store.load(server: "https://example.com"))
    }

    @MainActor
    func testMalformedLoginResponseDoesNotPersistItsCookie() async throws {
        let store = CoreMemoryCredentialStore()
        let client = try makeClient(store: store)
        defer { client.invalidate() }
        CoreMockURLProtocol.setHandler { request in
            try Self.response(request, headers: ["Set-Cookie": "jizhang_session=fixture; Path=/; Max-Age=3600; Secure"], json: #"{"unrecognized":true}"#)
        }
        do {
            let _: AuthenticatedUser = try await client.request("/auth/login", method: "POST")
            XCTFail("Invalid DTO must fail")
        } catch let error as APIError {
            XCTAssertEqual(error.code, "INVALID_RESPONSE")
        }
        XCTAssertFalse(client.hasSession)
        XCTAssertNil(try store.load(server: "https://example.com"))
    }

    @MainActor
    func testHTMLSuccessIsNotDecodedAsAPIData() async throws {
        let client = try makeClient(store: CoreMemoryCredentialStore())
        defer { client.invalidate() }
        CoreMockURLProtocol.setHandler { request in
            try Self.response(request, headers: ["Content-Type": "text/html"], json: #"{"items":[]}"#)
        }
        do {
            let _: JSONValue = try await client.request("/accounts")
            XCTFail("HTML response cannot pass as API JSON")
        } catch let error as APIError {
            XCTAssertEqual(error.code, "INVALID_RESPONSE")
        }
    }

    @MainActor
    func testOversizedResponseIsRejectedWithoutPersistingItsCookie() async throws {
        let store = CoreMemoryCredentialStore()
        let client = try makeClient(store: store, maximumJSONResponseBytes: 64)
        defer { client.invalidate() }
        CoreMockURLProtocol.setHandler { request in
            try Self.response(request, headers: ["Set-Cookie": "jizhang_session=fixture; Path=/; Max-Age=3600; Secure"],
                              json: "{\"text\":\"" + String(repeating: "a", count: 200) + "\"}")
        }
        do {
            let _: JSONValue = try await client.request("/assistant/conversations")
            XCTFail("Response cap must be enforced")
        } catch let error as APIError {
            XCTAssertEqual(error.code, "INVALID_RESPONSE")
        }
        XCTAssertNil(try store.load(server: "https://example.com"))
    }

    @MainActor
    private func makeClient(store: CoreMemoryCredentialStore, restoreSession: Bool = true,
                            maximumJSONResponseBytes: Int = 32 * 1_024 * 1_024) throws -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CoreMockURLProtocol.self]
        return try APIClient(baseURL: ServerAddress.parse("https://example.com"), credentialStore: store,
                             restoreSession: restoreSession, configuration: configuration,
                             maximumJSONResponseBytes: maximumJSONResponseBytes)
    }

    private static func cookie() -> SessionCookie {
        SessionCookie(value: "fixture", domain: "example.com", path: "/", secure: true, hostOnly: true, expiresAt: Date().addingTimeInterval(3_600))
    }

    private static func response(_ request: URLRequest, status: Int = 200, headers: [String: String] = [:], json: String) throws -> (HTTPURLResponse, Data) {
        let fields = ["Content-Type": "application/json"].merging(headers) { _, new in new }
        let response = try XCTUnwrap(HTTPURLResponse(url: XCTUnwrap(request.url), statusCode: status, httpVersion: nil, headerFields: fields))
        return (response, Data(json.utf8))
    }
}

final class CoreMemoryCredentialStore: SessionCredentialStore {
    private var items: [String: SessionCookie] = [:]
    private(set) var loadCount = 0
    func load(server: String) throws -> SessionCookie? { loadCount += 1; return items[server] }
    func save(_ cookie: SessionCookie?, server: String) throws { items[server] = cookie }
}

final class CoreMockURLProtocol: URLProtocol {
    typealias Handler = (URLRequest) throws -> (HTTPURLResponse, Data)
    private static let lock = NSLock()
    private static var handler: Handler?

    static func setHandler(_ value: Handler?) {
        lock.lock()
        handler = value
        lock.unlock()
    }

    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "example.com" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock()
        let handler = Self.handler
        Self.lock.unlock()
        do {
            guard let handler else { throw URLError(.badServerResponse) }
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }
    override func stopLoading() {}
}
