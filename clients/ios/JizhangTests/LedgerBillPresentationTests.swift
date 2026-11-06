import XCTest
import SwiftUI
import UIKit
@testable import Jizhang

/// Exercises the native presentation boundary, rather than rendering an isolated overlay.
final class LedgerBillPresentationTests: XCTestCase {
    override func tearDown() {
        CoreMockURLProtocol.setHandler(nil)
        super.tearDown()
    }

    @MainActor
    func testModalCoversTabBarRoutesTouchesAndPreservesUnderlyingScroll() async throws {
        let ready = expectation(description: "Modal detail requested")
        let pageReads = BillFirstPageReads()
        let api = try client(ready: ready, pageReads: pageReads); defer { api.invalidate() }
        let state = BillPresentationState()
        try await withWindow(state: state, api: api) { window, host in
            try await self.waitUntil { state.store.hasLoaded && !state.store.loading }
            await state.store.next(api: api)
            XCTAssertEqual(state.store.items.count, 55)
            try await self.waitUntil { self.views(host.view, of: UIScrollView.self).contains { $0.contentSize.height > $0.bounds.height + 300 } }
            let scroll = try XCTUnwrap(self.views(host.view, of: UIScrollView.self).first { $0.contentSize.height > $0.bounds.height + 300 })
            scroll.setContentOffset(CGPoint(x: 0, y: 240), animated: false)
            let offset = scroll.contentOffset
            let tabBar = try XCTUnwrap(self.views(host.view, of: UITabBar.self).first)
            let tabPoint = tabBar.convert(CGPoint(x: tabBar.bounds.midX, y: tabBar.bounds.midY), to: window)

            state.selection = LedgerBillSelection(id: "expense")
            try await self.waitUntil { host.presentedViewController?.viewIfLoaded?.window != nil && host.presentedViewController?.isBeingPresented == false }
            let modal = try XCTUnwrap(host.presentedViewController)
            await self.fulfillment(of: [ready], timeout: 5)
            try await Task.sleep(for: .milliseconds(150))
            window.layoutIfNeeded()
            let modalFrame = modal.view.convert(modal.view.bounds, to: window)
            XCTAssertTrue(modalFrame.contains(CGPoint(x: window.bounds.midX, y: window.bounds.midY)))
            XCTAssertTrue(modalFrame.contains(tabPoint), "The presentation must cover the native tab bar")
            for point in [tabPoint, CGPoint(x: 2, y: window.bounds.midY), CGPoint(x: window.bounds.midX, y: 32)] {
                let hit = try XCTUnwrap(window.hitTest(point, with: nil))
                XCTAssertTrue(hit.isDescendant(of: modal.view), "Background navigation, tabs and scrolling must not receive modal touches")
                XCTAssertFalse(hit.isDescendant(of: scroll))
            }
            XCTAssertEqual(state.tab, 0)
            self.capture(window, name: "bill-modal-above-native-tab-bar")

            state.selection = nil
            try await self.waitUntil { host.presentedViewController == nil }
            try await Task.sleep(for: .milliseconds(250))
            try await self.waitUntil { !state.store.loading }
            XCTAssertEqual(state.tab, 0)
            XCTAssertEqual(pageReads.count, 1, "Closing a bill must not silently fetch page one again")
            XCTAssertEqual(state.store.items.count, 55, "Closing a bill must not reset the real Bills store to page one")
            XCTAssertTrue(self.views(host.view, of: UIScrollView.self).contains { $0 === scroll }, "Dismissing must retain the original scroll view")
            XCTAssertEqual(scroll.contentOffset.y, offset.y, accuracy: 1)
        }
    }

    @MainActor
    func testLargeTextModalKeepsScrollableContentWithinScreen() async throws {
        let ready = expectation(description: "Large text detail requested")
        let api = try client(ready: ready); defer { api.invalidate() }
        let state = BillPresentationState()
        try await withWindow(state: state, api: api, largeText: true) { window, host in
            state.selection = LedgerBillSelection(id: "expense")
            try await self.waitUntil { host.presentedViewController?.viewIfLoaded?.window != nil && host.presentedViewController?.isBeingPresented == false }
            let modal = try XCTUnwrap(host.presentedViewController)
            await self.fulfillment(of: [ready], timeout: 5)
            try await Task.sleep(for: .milliseconds(150))
            try await self.waitUntil { !self.views(modal.view, of: UIScrollView.self).isEmpty }
            let scroll = try XCTUnwrap(self.views(modal.view, of: UIScrollView.self).first)
            XCTAssertGreaterThan(scroll.bounds.height, 60)
            let frame = scroll.convert(scroll.bounds, to: window)
            XCTAssertGreaterThanOrEqual(frame.minY, window.bounds.minY)
            XCTAssertLessThanOrEqual(frame.maxY, window.bounds.maxY)
            self.capture(window, name: "bill-modal-large-text-native-screen")
            state.selection = nil
            try await self.waitUntil { host.presentedViewController == nil }
        }
    }

    @MainActor
    private func client(ready: XCTestExpectation, pageReads: BillFirstPageReads? = nil) throws -> APIClient {
        CoreMockURLProtocol.setHandler { request in
            XCTAssertEqual(request.httpMethod, "GET", "Presenting a bill must never write accounting data")
            let response = try XCTUnwrap(HTTPURLResponse(url: XCTUnwrap(request.url), statusCode: 200,
                                                       httpVersion: nil, headerFields: ["Content-Type": "application/json"]))
            var row: [String: Any] = ["id": "expense", "type": 0, "amountCents": 12800,
                "categoryId": "food", "accountId": "bank", "date": 1793836800000 as Int64,
                "note": "周末和家人一起吃饭，保留完整备注用于核对账单", "tags": ["家庭", "周末"],
                "isRefund": false, "fundPurpose": "essentials", "updatedAt": 1000,
                "refundLinkedTxIds": [], "refundDetails": [], "refundSummary": ["totalRefundCents": 0, "refundCount": 0]]
            let path = request.url?.path ?? ""
            let object: [String: Any]
            if path.hasSuffix("/transactions") {
                let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
                let offset = Int(query.first { $0.name == "offset" }?.value ?? "0") ?? 0
                if offset == 0 { pageReads?.record() }
                let rows = (offset..<min(offset + 50, 55)).map { index -> [String: Any] in
                    var value = row; value["id"] = "bill-\(index)"; return value
                }
                object = ["items": rows, "total": 55, "offset": offset, "limit": 50]
            } else if path.hasSuffix("/categories") {
                object = ["items": [["id": "food", "name": "餐饮", "type": 0, "parentId": NSNull(), "icon": "food", "color": 0, "isBuiltin": true]]]
            } else if path.hasSuffix("/accounts") {
                object = ["items": [["id": "bank", "name": "日常账户", "type": 0, "initialBalanceCents": 0, "isBuiltin": false]]]
            } else {
                row["id"] = "expense"; object = row; ready.fulfill()
            }
            let data = try JSONSerialization.data(withJSONObject: object)
            return (response, data)
        }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [CoreMockURLProtocol.self]
        return try APIClient(baseURL: URL(string: "https://example.com")!, credentialStore: CoreMemoryCredentialStore(),
                             restoreSession: false, configuration: config)
    }

    @MainActor
    private func withWindow(state: BillPresentationState, api: APIClient, largeText: Bool = false,
                            body: (UIWindow, UIViewController) async throws -> Void) async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first { $0.isKeyWindow }
        let window = UIWindow(windowScene: scene)
        window.frame = scene.coordinateSpace.bounds
        let host = UIHostingController(rootView: BillPresentationHost(state: state, api: api)
            .environment(\.dynamicTypeSize, largeText ? .accessibility2 : .large).tint(AppTheme.accent))
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { host.dismiss(animated: false); window.isHidden = true; previous?.makeKeyAndVisible() }
        try await body(window, host)
    }

    @MainActor private func waitUntil(_ condition: () -> Bool) async throws {
        for _ in 0..<200 {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(25))
        }
        XCTFail("Native bill presentation did not settle")
        throw LedgerDataError.invalidResponse
    }

    @MainActor private func views<T: UIView>(_ view: UIView, of type: T.Type) -> [T] {
        ((view as? T).map { [$0] } ?? []) + view.subviews.flatMap { views($0, of: type) }
    }

    @MainActor private func capture(_ window: UIWindow, name: String) {
        window.layoutIfNeeded()
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        let attachment = XCTAttachment(image: image)
        attachment.name = name + "-synthetic-fixture"
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}

private final class BillFirstPageReads {
    private let lock = NSLock()
    private var value = 0
    var count: Int { lock.lock(); defer { lock.unlock() }; return value }
    func record() { lock.lock(); defer { lock.unlock() }; value += 1 }
}

@MainActor private final class BillPresentationState: ObservableObject {
    let store = LedgerBillsStore()
    @Published var selection: LedgerBillSelection?
    @Published var tab = 0
}

@MainActor private struct BillPresentationHost: View {
    @ObservedObject var state: BillPresentationState
    let api: APIClient
    var body: some View {
        TabView(selection: $state.tab) {
            NavigationStack {
                BillsView(api: api, initialQuery: LedgerBillQuery(), store: state.store)
                .navigationTitle("账单测试")
                .ledgerBillDetail(api: api, selection: $state.selection, metadata: .empty)
            }.tabItem { Label("账单", systemImage: "list.bullet") }.tag(0)
            Text("其他页面").tabItem { Label("我的", systemImage: "person") }.tag(1)
        }
    }
}
