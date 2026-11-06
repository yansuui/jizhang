import Combine
import Foundation

struct APIBinaryResponse {
    let data: Data
    let mimeType: String
    let status: Int
}

enum APIRequestBuilder {
    static func make(baseURL: URL, path: String, method: String = "GET", body: JSONValue? = nil,
                     cookie: SessionCookie? = nil) throws -> URLRequest {
        let destination = try ServerAddress.endpoint(baseURL: baseURL, path: path)
        let verb = method.uppercased()
        guard ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].contains(verb) else {
            throw APIError.invalidPath
        }
        var request = URLRequest(url: destination, cachePolicy: .reloadIgnoringLocalCacheData,
                                 timeoutInterval: path == "/auth/logout" ? 15 : 90)
        request.httpMethod = verb
        request.httpShouldHandleCookies = false
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        if verb != "GET" && verb != "HEAD" {
            request.setValue("fetch", forHTTPHeaderField: "X-Requested-With")
        }
        if let body {
            request.httpBody = try JSONEncoder().encode(body)
            request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
        }
        if let cookie, cookie.matches(destination) {
            request.setValue(cookie.requestHeader, forHTTPHeaderField: "Cookie")
        }
        return request
    }
}

/// A client belongs to one server and one authentication attempt/session for its entire lifetime.
/// Invalidated instances cannot save cookies, expire a newer session, or publish late responses.
@MainActor
final class APIClient: ObservableObject {
    let identity = UUID()
    @Published private(set) var ledgerRevision = 0
    let baseURL: URL
    var onUnauthorized: (() -> Void)?

    private let credentialStore: SessionCredentialStore
    private let session: URLSession
    private let redirectDelegate: APINoRedirectDelegate
    private let maximumJSONResponseBytes: Int
    private var cookie: SessionCookie?
    private var invalidated = false

    /// Successful mutations invalidate views only within this authenticated session.
    func notifyLedgerChanged() {
        guard !invalidated else { return }
        ledgerRevision &+= 1
    }

    init(baseURL: URL, credentialStore: SessionCredentialStore = KeychainSessionStore(),
         restoreSession: Bool = true, configuration: URLSessionConfiguration = .ephemeral,
         maximumJSONResponseBytes: Int = 32 * 1_024 * 1_024) throws {
        guard maximumJSONResponseBytes > 0 else { throw APIError.invalidResponse }
        self.baseURL = try ServerAddress.parse(baseURL.absoluteString)
        self.credentialStore = credentialStore
        self.maximumJSONResponseBytes = maximumJSONResponseBytes
        let delegate = APINoRedirectDelegate()
        redirectDelegate = delegate
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 90
        configuration.timeoutIntervalForResource = 300
        session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
        if restoreSession, let saved = try credentialStore.load(server: self.baseURL.absoluteString) {
            let authURL = try ServerAddress.endpoint(baseURL: self.baseURL, path: "/auth/me")
            if saved.matches(authURL) {
                cookie = saved
            } else {
                try credentialStore.save(nil, server: self.baseURL.absoluteString)
            }
        }
    }

    var hasSession: Bool {
        guard !invalidated, let cookie,
              let destination = try? ServerAddress.endpoint(baseURL: baseURL, path: "/auth/me") else { return false }
        return cookie.matches(destination)
    }

    func request<Response: Decodable>(_ path: String, method: String = "GET", body: JSONValue? = nil) async throws -> Response {
        do {
            try requireCurrent()
            let publicAuthentication = method.uppercased() == "POST" && ["/auth/login", "/auth/register"].contains(path)
            let request = try APIRequestBuilder.make(baseURL: baseURL, path: path, method: method, body: body,
                                                     cookie: publicAuthentication ? nil : cookie)
            let (data, response) = try await session.data(for: request)
            try requireCurrent()
            let http = try checkedResponse(response)
            try checkStatus(http.statusCode, data: data, expiresSession: !publicAuthentication)
            guard data.count <= maximumJSONResponseBytes else { throw APIError.invalidResponse }
            if !data.isEmpty {
                let type = http.value(forHTTPHeaderField: "Content-Type")?.lowercased().components(separatedBy: ";").first?.trimmingCharacters(in: .whitespaces) ?? ""
                guard type == "application/json" || (type.hasPrefix("application/") && type.hasSuffix("+json")) else {
                    throw APIError.invalidResponse
                }
            }
            let decoded = try JSONDecoder().decode(Response.self, from: data.isEmpty ? Data("null".utf8) : data)
            if publicAuthentication, let user = decoded as? AuthenticatedUser {
                guard user.expiresAt > Int64(Date().timeIntervalSince1970 * 1_000),
                      path != "/auth/register" || user.id != nil else { throw APIError.invalidResponse }
            }
            try captureCookie(http)
            return decoded
        } catch {
            throw APIError.transport(error)
        }
    }

    /// Files use the same authenticated, no-redirect session and owner fences as JSON.
    /// Callers supply an allowlisted route; no cookie is handed to a system browser.
    func binary(_ path: String, method: String = "GET", body: Data? = nil,
                contentType: String? = nil, accept: String = "application/octet-stream",
                maximumBytes: Int = 32 * 1_024 * 1_024) async throws -> APIBinaryResponse {
        do {
            try requireCurrent()
            guard maximumBytes > 0 else { throw APIError.invalidResponse }
            var request = try APIRequestBuilder.make(baseURL: baseURL, path: path, method: method, cookie: cookie)
            request.setValue(accept, forHTTPHeaderField: "Accept")
            request.httpBody = body
            if let contentType { request.setValue(contentType, forHTTPHeaderField: "Content-Type") }
            let (data, response) = try await session.data(for: request)
            try requireCurrent()
            let http = try checkedResponse(response)
            try checkStatus(http.statusCode, data: data)
            guard data.count <= maximumBytes else { throw APIError.invalidResponse }
            try captureCookie(http)
            let type = http.value(forHTTPHeaderField: "Content-Type")?.lowercased()
                .components(separatedBy: ";").first?.trimmingCharacters(in: .whitespaces) ?? ""
            return APIBinaryResponse(data: data, mimeType: type, status: http.statusCode)
        } catch { throw APIError.transport(error) }
    }

    func rawJSON<Response: Decodable>(_ path: String, method: String = "POST", body: Data,
                                      contentType: String) async throws -> Response {
        do {
            let response = try await binary(path, method: method, body: body, contentType: contentType,
                                            accept: "application/json", maximumBytes: maximumJSONResponseBytes)
            guard response.mimeType == "application/json" ||
                    (response.mimeType.hasPrefix("application/") && response.mimeType.hasSuffix("+json")) else {
                throw APIError.invalidResponse
            }
            return try JSONDecoder().decode(Response.self, from: response.data)
        } catch { throw APIError.transport(error) }
    }

    /// The feature owns the returned task and must cancel it when leaving a conversation.
    /// Cancelling this HTTP subscription is deliberately separate from POST /cancel.
    func stream(_ path: String) async throws -> URLSession.AsyncBytes {
        do {
            try requireCurrent()
            var request = try APIRequestBuilder.make(baseURL: baseURL, path: path, cookie: cookie)
            request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
            request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
            request.setValue("fetch", forHTTPHeaderField: "X-Requested-With")
            let (bytes, response) = try await session.bytes(for: request)
            do {
                try requireCurrent()
                let http = try checkedResponse(response)
                guard (200..<300).contains(http.statusCode) else {
                    if http.statusCode == 401 {
                        try checkStatus(http.statusCode, data: Data())
                    }
                    var errorData = Data()
                    for try await byte in bytes {
                        try requireCurrent()
                        errorData.append(byte)
                        if errorData.count >= 65_536 { break }
                    }
                    try checkStatus(http.statusCode, data: errorData)
                    throw APIError.invalidResponse
                }
                let type = http.value(forHTTPHeaderField: "Content-Type")?.lowercased() ?? ""
                guard type.components(separatedBy: ";").first?.trimmingCharacters(in: .whitespaces) == "text/event-stream" else {
                    throw APIError.invalidResponse
                }
                try captureCookie(http)
                return bytes
            } catch {
                bytes.task.cancel()
                throw error
            }
        } catch {
            throw APIError.transport(error)
        }
    }

    func clearStoredSession() throws {
        cookie = nil
        try credentialStore.save(nil, server: baseURL.absoluteString)
    }

    /// Cancel only this client's work. Keep stored credentials for a later network-retry restore.
    func invalidate() {
        guard !invalidated else { return }
        invalidated = true
        onUnauthorized = nil
        session.invalidateAndCancel()
    }

    private func requireCurrent() throws {
        try Task.checkCancellation()
        if invalidated { throw CancellationError() }
    }

    private func checkedResponse(_ response: URLResponse) throws -> HTTPURLResponse {
        guard let http = response as? HTTPURLResponse, let url = http.url,
              ServerAddress.sameOrigin(baseURL, url) else { throw APIError.invalidResponse }
        return http
    }

    private func checkStatus(_ status: Int, data: Data, expiresSession: Bool = true) throws {
        guard (200..<300).contains(status) else {
            let error = APIError.response(status: status, data: data)
            if status == 401 && expiresSession {
                cookie = nil
                try? credentialStore.save(nil, server: baseURL.absoluteString)
                let callback = onUnauthorized
                invalidate()
                callback?()
            }
            throw error
        }
    }

    private func captureCookie(_ response: HTTPURLResponse) throws {
        guard let url = response.url,
              let header = response.value(forHTTPHeaderField: "Set-Cookie") else { return }
        let parsed = HTTPCookie.cookies(withResponseHeaderFields: ["Set-Cookie": header], for: url)
        let hostOnly = header.range(of: "(?:^|;)\\s*domain\\s*=", options: [.regularExpression, .caseInsensitive]) == nil
        for parsedCookie in parsed where parsedCookie.name == SessionCookie.name {
            guard let received = SessionCookie.from(parsedCookie, origin: baseURL, hostOnly: hostOnly) else { continue }
            if received.value.isEmpty || received.expiresAt.map({ $0 <= Date() }) == true {
                try clearStoredSession()
            } else {
                try credentialStore.save(received, server: baseURL.absoluteString)
                cookie = received
            }
        }
    }

}

/// Refuse every redirect, so neither a cookie nor a login body can reach a redirected destination.
private final class APINoRedirectDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

struct EmptyResponse: Decodable {
    init(from decoder: Decoder) throws {}
}
