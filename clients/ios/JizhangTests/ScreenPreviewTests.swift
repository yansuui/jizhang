import SwiftUI
import UIKit
import XCTest
@testable import Jizhang

/// These attachments are real simulator renders with explicitly labelled synthetic data.
/// They support visual review; they do not claim live-provider or physical-device acceptance.
final class ScreenPreviewTests: XCTestCase {
    @MainActor
    func testInvitationRegistrationAtCompactIPhoneWidth() async throws {
        let ready = expectation(description: "Registration form ready")
        ready.fulfill()
        let session = AppSession(credentialStore: CoreMemoryCredentialStore())
        try await capture("invite-registration-compact", ready: ready) {
            RegistrationView(session: session, serverAddress: "https://example.com")
        }
    }

    @MainActor
    func testAdminInvitationsWithLargeText() async throws {
        let ready = expectation(description: "Invitation list loaded")
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CoreMockURLProtocol.self]
        let api = try APIClient(baseURL: ServerAddress.parse("https://example.com"),
                                credentialStore: CoreMemoryCredentialStore(), configuration: configuration)
        defer { api.invalidate(); CoreMockURLProtocol.setHandler(nil) }
        let user = try JSONDecoder().decode(AuthenticatedUser.self, from: Data(#"{"id":"preview-owner","username":"我的账号","role":"admin","capabilities":["manageInvitations"],"expiresAt":4102444800000}"#.utf8))
        CoreMockURLProtocol.setHandler { request in
            let response = try XCTUnwrap(HTTPURLResponse(url: XCTUnwrap(request.url), statusCode: 200,
                httpVersion: nil, headerFields: ["Content-Type": "application/json"]))
            let json = #"{"invitations":[{"id":"preview-invite","createdAt":1793750400000,"expiresAt":4102444800000,"status":"active","usedAt":null}]}"#
            ready.fulfill()
            return (response, Data(json.utf8))
        }
        try await capture("invitation-management-large", ready: ready) {
            InvitationManagementView(api: api, user: user)
                .environment(\.dynamicTypeSize, .xxxLarge)
        }
    }

    @MainActor
    func testConversationListAtCompactIPhoneWidth() async throws {
        let ready = expectation(description: "History and provider summary loaded")
        ready.expectedFulfillmentCount = 2
        let api = try previewClient { ready.fulfill() }
        defer { api.invalidate(); ScreenPreviewProtocol.setHandler(nil) }
        try await capture("conversation-list-compact", ready: ready) {
            AssistantView(api: api)
        }
    }

    @MainActor
    func testCompactProviderConfiguration() async throws {
        let ready = expectation(description: "Provider summary loaded")
        let api = try previewClient { ready.fulfill() }
        defer { api.invalidate(); ScreenPreviewProtocol.setHandler(nil) }
        try await capture("provider-settings-compact", ready: ready) {
            ProviderSettingsView(api: api)
        }
    }

    @MainActor
    func testProviderConfigurationWithLargeTextAndDarkAppearance() async throws {
        let ready = expectation(description: "Provider summary loaded")
        let api = try previewClient { ready.fulfill() }
        defer { api.invalidate(); ScreenPreviewProtocol.setHandler(nil) }
        try await capture("provider-settings-large-dark", ready: ready) {
            ProviderSettingsView(api: api)
                .environment(\.dynamicTypeSize, .xxxLarge)
                .preferredColorScheme(.dark)
        }
    }

    @MainActor
    private func capture<Content: View>(_ name: String, ready: XCTestExpectation,
                                      @ViewBuilder content: () -> Content) async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previousWindow = scene.windows.first { $0.isKeyWindow }
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        let controller = UIHostingController(rootView:
            NavigationStack { content() }
                .tint(AppTheme.accent)
                .safeAreaInset(edge: .top, spacing: 0) {
                    Text("界面预览 · 测试数据")
                        .font(.caption2).frame(maxWidth: .infinity)
                        .padding(4).background(Color.yellow.opacity(0.25))
                }
        )
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer { window.isHidden = true; previousWindow?.makeKeyAndVisible() }
        await fulfillment(of: [ready], timeout: 10)
        // Give SwiftUI a render cycle after the asynchronous fixture response.
        try await Task.sleep(nanoseconds: 500_000_000)
        controller.view.setNeedsLayout()
        controller.view.layoutIfNeeded()
        XCTAssertGreaterThan(controller.view.bounds.width, 300)
        let renderer = UIGraphicsImageRenderer(bounds: controller.view.bounds)
        let screenshot = renderer.image { _ in
            controller.view.drawHierarchy(in: controller.view.bounds, afterScreenUpdates: true)
        }
        let attachment = XCTAttachment(image: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    @MainActor
    private func previewClient(onResponse: @escaping () -> Void) throws -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ScreenPreviewProtocol.self]
        ScreenPreviewProtocol.setHandler { request in
            let path = try XCTUnwrap(request.url?.path)
            let object: [String: Any]
            switch path {
            case "/api/v1/ai/config":
                object = [
                    "configured": true, "enabled": true, "encryptionKeyConfigured": true,
                    "hasSecret": true, "mode": "chat-completions", "name": "",
                    "url": "https://api.example.com/v1/chat/completions", "method": "POST",
                    "model": "my-chat-model", "timeoutMs": 20_000, "headers": [String: String](),
                    "auth": ["kind": "bearer"], "bodyTemplate": NSNull(),
                    "responsePath": "choices[0].message.content", "updatedAt": 1_793_750_400_000
                ]
            case "/api/v1/assistant/conversations":
                let now = Int64(Date().timeIntervalSince1970 * 1_000)
                let titles = ["这个月的支出主要花在哪里？", "梳理最近几个月的生活开销，看看哪些地方可以更从容地安排",
                              "周末出行预算", "给未来留一点余地"]
                object = ["items": titles.enumerated().map { index, title -> [String: Any] in
                    let date = now - Int64(index) * 86_400_000
                    return ["id": "preview-\(index)", "title": title, "archived": false,
                            "createdAt": date, "updatedAt": date]
                }]
            default:
                XCTFail("Unexpected preview request: \(path)")
                throw URLError(.unsupportedURL)
            }
            let data = try JSONSerialization.data(withJSONObject: object)
            let response = try XCTUnwrap(HTTPURLResponse(url: XCTUnwrap(request.url), statusCode: 200,
                httpVersion: nil, headerFields: ["Content-Type": "application/json"]))
            onResponse()
            return (response, data)
        }
        return try APIClient(baseURL: URL(string: "https://preview.example")!,
                             restoreSession: false, configuration: configuration)
    }
}

private final class ScreenPreviewProtocol: URLProtocol {
    typealias Handler = (URLRequest) throws -> (HTTPURLResponse, Data)
    private static let lock = NSLock()
    private static var handler: Handler?

    static func setHandler(_ value: Handler?) {
        lock.lock(); handler = value; lock.unlock()
    }
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "preview.example" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock(); let work = Self.handler; Self.lock.unlock()
        do {
            guard let work else { throw URLError(.cancelled) }
            let (response, data) = try work(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}
