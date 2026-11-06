import SwiftUI
import UIKit
import XCTest
@testable import Jizhang

/// These attachments are real simulator renders with explicitly labelled synthetic data.
/// They support visual review; they do not claim live-provider or physical-device acceptance.
final class ScreenPreviewTests: XCTestCase {
    @MainActor
    func testAssistantPagedAccountSelectionAtCompactWidth() async throws {
        let ready = expectation(description: "Authoritative account selection page loaded")
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [CoreMockURLProtocol.self]
        let api = try APIClient(baseURL: ServerAddress.parse("https://example.com"), credentialStore: CoreMemoryCredentialStore(),
                                restoreSession: false, configuration: config)
        defer { api.invalidate(); CoreMockURLProtocol.setHandler(nil) }
        let names = ["日常账户", "日常账户", "工资账户", "备用金", "储蓄账户", "现金", "旅行账户"]
        let object: [String: Any] = ["id": "account-choice-preview", "version": 1, "type": "selection", "kind": "account",
            "title": "选择这笔午餐支出的支付账户", "status": "pending", "multiple": false, "expiresAt": 4102444800000,
            "items": names.enumerated().map { index, name in
                ["id": "account-\(index)", "title": name, "subtitle": "测试账本 · 账户 \(index + 1)"]
            }, "page": ["offset": 0, "limit": 7, "total": 18, "hasMore": true]]
        let value = try JSONDecoder().decode(JSONValue.self, from: JSONSerialization.data(withJSONObject: object))
        CoreMockURLProtocol.setHandler { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/api/v1/assistant/conversations/selection-preview/workspace/interactions/account-choice-preview")
            let response = try XCTUnwrap(HTTPURLResponse(url: XCTUnwrap(request.url), statusCode: 200,
                httpVersion: nil, headerFields: ["Content-Type": "application/json"]))
            ready.fulfill()
            return (response, try JSONSerialization.data(withJSONObject: ["interaction": object]))
        }
        try await capture("assistant-account-selection-paged-compact", ready: ready) {
            ScrollView {
                AssistantSelectionCard(api: api, conversationID: "selection-preview", value: value, enabled: true,
                                       onGeneration: { _ in XCTFail("A read-only preview must not create a generation") })
                    .padding()
            }.navigationTitle("AI 助手")
        }
    }

    @MainActor
    func testDailyReminderSettingsAtCompactWidth() async throws {
        let ready = expectation(description: "Authorized reminder fixture scheduled")
        let suite = "reminder-preview-" + UUID().uuidString
        let preferences = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { preferences.removePersistentDomain(forName: suite) }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [CoreMockURLProtocol.self]
        let api = try APIClient(baseURL: ServerAddress.parse("https://example.com"), credentialStore: CoreMemoryCredentialStore(),
                                restoreSession: false, configuration: config)
        defer { api.invalidate() }
        let user = try JSONDecoder().decode(AuthenticatedUser.self,
            from: Data(#"{"id":"reminder-preview-owner","username":"界面预览","expiresAt":4102444800000}"#.utf8))
        let center = ReminderCenterFixture()
        let store = DailyReminderStore(center: center, preferences: preferences,
                                      outbox: ReminderOutboxFixture(preferences: preferences))
        store.updateSession(api: api, user: user)
        await store.waitForScheduling()
        XCTAssertEqual(store.scheduledKinds, Set([.recording, .review]))
        XCTAssertEqual(center.permissionRequests, 0)
        ready.fulfill()
        try await capture("daily-reminders-authorized-compact", ready: ready) {
            DailyReminderSettingsView().environmentObject(store)
        }
    }

    @MainActor
    func testDailyReminderPermissionDeniedAtLargeText() async throws {
        let ready = expectation(description: "Denied permission fixture ready")
        let suite = "reminder-denied-preview-" + UUID().uuidString
        let preferences = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { preferences.removePersistentDomain(forName: suite) }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [CoreMockURLProtocol.self]
        let api = try APIClient(baseURL: ServerAddress.parse("https://example.com"), credentialStore: CoreMemoryCredentialStore(),
                                restoreSession: false, configuration: config)
        defer { api.invalidate() }
        let user = try JSONDecoder().decode(AuthenticatedUser.self,
            from: Data(#"{"id":"reminder-preview-owner","username":"界面预览","expiresAt":4102444800000}"#.utf8))
        let center = ReminderCenterFixture(); center.permission = .denied
        let store = DailyReminderStore(center: center, preferences: preferences,
                                      outbox: ReminderOutboxFixture(preferences: preferences))
        store.updateSession(api: api, user: user)
        await store.waitForScheduling()
        XCTAssertTrue(store.scheduledKinds.isEmpty)
        XCTAssertTrue(center.pending.isEmpty)
        ready.fulfill()
        try await capture("daily-reminders-denied-large-dark", ready: ready) {
            DailyReminderSettingsView().environmentObject(store)
                .environment(\.dynamicTypeSize, .xxxLarge).preferredColorScheme(.dark)
        }
    }

    @MainActor
    func testNativeCSVImportPreviewAtCompactWidth() async throws {
        let ready = expectation(description: "Read-only CSV preview loaded")
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [CoreMockURLProtocol.self]
        let api = try APIClient(baseURL: ServerAddress.parse("https://example.com"), credentialStore: CoreMemoryCredentialStore(),
                                restoreSession: false, configuration: config)
        defer { NativeWorkspaceSessions.clear(apiIdentity: api.identity); api.invalidate(); CoreMockURLProtocol.setHandler(nil) }
        CoreMockURLProtocol.setHandler { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/api/v1/assistant/data-import/preview")
            let response = try XCTUnwrap(HTTPURLResponse(url: XCTUnwrap(request.url), statusCode: 200,
                httpVersion: nil, headerFields: ["Content-Type": "application/json"]))
            let value: [String: Any] = ["preview": ["id": "csv-preview", "kind": "transactions",
                "expiresAt": 4102444800000, "columns": ["账户", "分类", "金额", "备注"],
                "rows": [["日常账户", "餐饮", "35.00", "午餐"], ["日常账户", "交通", "6.00", "地铁"]],
                "totalRows": 2, "rowsOmitted": false, "result": ["inserted": 2, "skipped": 0]]]
            return (response, try JSONSerialization.data(withJSONObject: value))
        }
        let store = NativeWorkspaceSessions.csv(api)
        store.choose(NativeBillFile(name: "账单预览.csv", bytes: Data("account,category,amount,note\nfixture,food,35.00,lunch\n".utf8)))
        await store.prepare()
        XCTAssertNotNil(store.preview)
        XCTAssertNil(store.result)
        XCTAssertEqual(api.ledgerRevision, 0)
        ready.fulfill()
        try await capture("native-csv-import-review-compact", ready: ready) {
            NativeCSVImportView(api: api)
        }
    }

    @MainActor
    func testBackgroundSpendingTaskCardAtCompactWidth() async throws {
        let ready = expectation(description: "Read-only background progress loaded")
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [CoreMockURLProtocol.self]
        let api = try APIClient(baseURL: ServerAddress.parse("https://example.com"), credentialStore: CoreMemoryCredentialStore(),
                                restoreSession: false, configuration: config)
        defer { api.invalidate(); CoreMockURLProtocol.setHandler(nil) }
        CoreMockURLProtocol.setHandler { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/api/v1/ai/organization-runs/preview-run")
            let response = try XCTUnwrap(HTTPURLResponse(url: XCTUnwrap(request.url), statusCode: 200,
                httpVersion: nil, headerFields: ["Content-Type": "application/json"]))
            let value: [String: Any] = ["runId": "preview-run", "status": "ready", "eligibleCount": 36, "completedCount": 36, "canResume": false]
            ready.fulfill()
            return (response, try JSONSerialization.data(withJSONObject: value))
        }
        try await capture("assistant-background-run-card-compact", ready: ready) {
            List {
                AssistantSpendingRunStatus(api: api, runID: "preview-run", initial: .null, onSuggestion: { _ in })
            }.navigationTitle("历史账单整理")
        }
    }

    @MainActor
    func testActionConfirmationAtCompactWidth() async throws {
        let ready = expectation(description: "Action preview ready")
        ready.fulfill()
        let api = try APIClient(baseURL: ServerAddress.parse("https://example.com"), credentialStore: CoreMemoryCredentialStore())
        defer { api.invalidate() }
        let store = AssistantStore(api: api)
        let card: JSONValue = .object(["version": .integer(1), "actionId": .string("preview-action"),
            "toolName": .string("transaction.create"), "status": .string("pending"), "writes": .bool(true),
            "summary": .string("记录今天的午餐支出 28 元"), "affected": .object(["count": .integer(1)]),
            "values": .object(["amountCents": .integer(2800), "accountName": .string("日常账户"), "categoryName": .string("餐饮"), "date": .integer(1793808000000)]),
            "preview": .object(["note": .string("午餐"), "fundPurpose": .string("essentials")]),
            "warnings": .array([])])
        try await capture("assistant-action-confirm-compact", ready: ready) {
            AssistantActionReviewView(store: store, conversationID: "preview", review: AssistantActionReview(card: card))
        }
    }

    @MainActor
    func testHistoricalSuggestionsAtLargeText() async throws {
        let ready = expectation(description: "Historical preview ready")
        ready.fulfill()
        let card: JSONValue = .object(["runId": .string("preview-run"), "status": .string("ready"), "expiresAt": .integer(4102444800000),
            "actions": .array([.object(["actionId": .string("preview-category"), "kind": .string("category"),
                "transactionDateLabel": .string("2026-11-05"), "transactionAmountCents": .integer(2800),
                "afterCategoryName": .string("餐饮"), "reason": .string("备注为午餐，建议归入餐饮分类。")])]), "templateProposals": .array([])])
        try await capture("assistant-history-review-large", ready: ready) {
            ScrollView { AssistantSpendingReview(card: card, onSuggestion: { _ in }).padding() }
                .environment(\.dynamicTypeSize, .xxxLarge)
        }
    }

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
