import Dispatch
import SwiftUI
import UIKit
import XCTest
@testable import Jizhang

/// The widget snapshot is a display contract, not an accounting engine. These tests pin the server
/// totals it copies, its refusal to fabricate values, and the App Group file handoff. The rendered
/// attachments are simulator previews of the shared widget views, not physical Home Screen evidence.
final class LedgerWidgetTests: XCTestCase {
    // MARK: - Snapshot contract

    func testSnapshotRejectsOtherSchemasAndEmptyAggregates() {
        var future = LedgerWidgetSnapshot(ownerKey: "owner", updatedAt: 1_700_000_000_000, schemaVersion: 2)
        future.totalBalanceCents = 1_000
        XCTAssertNil(future.sanitized)

        XCTAssertNil(LedgerWidgetSnapshot(ownerKey: "owner", updatedAt: 1_700_000_000_000).sanitized)
        XCTAssertNil(LedgerWidgetSnapshot(ownerKey: "", updatedAt: 1_700_000_000_000).sanitized)

        var huge = LedgerWidgetSnapshot(ownerKey: "owner", updatedAt: 1_700_000_000_000)
        huge.totalBalanceCents = LedgerWidgetSnapshot.maximumCents + 1
        XCTAssertNil(huge.sanitized)

        var badMonth = LedgerWidgetSnapshot(ownerKey: "owner", updatedAt: 1_700_000_000_000)
        badMonth.totalBalanceCents = 1
        badMonth.month = "2026-13"
        XCTAssertNil(badMonth.sanitized)
    }

    func testSnapshotDropsUnknownAndImpossiblePurposes() throws {
        let json = """
        {"schemaVersion":1,"ownerKey":"owner","updatedAt":1700000000000,
         "purposes":{"growth":{"balanceCents":100,"fundedCents":200,"spentCents":50},
                     "unknown":{"balanceCents":1,"fundedCents":1,"spentCents":1},
                     "joy":{"balanceCents":5,"fundedCents":-1,"spentCents":0}}}
        """
        let snapshot = try XCTUnwrap(LedgerWidgetSnapshot.decode(Data(json.utf8)))
        XCTAssertEqual(snapshot.purpose(.growth)?.balanceCents, 100)
        XCTAssertEqual(snapshot.purpose(.growth)?.fundedCents, 200)
        XCTAssertNil(snapshot.purpose(.joy), "A negative funded amount is not displayable")
        XCTAssertEqual(snapshot.purposes?.count, 1)
        XCTAssertNil(LedgerWidgetSnapshot.decode(Data("{\"schemaVersion\":1}".utf8)))
        XCTAssertNil(LedgerWidgetSnapshot.decode(Data("not json".utf8)))
    }

    func testSnapshotRoundTripKeepsEveryServerValue() throws {
        let encoded = try JSONEncoder().encode(LedgerWidgetSnapshot.previewSample)
        let decoded = try XCTUnwrap(LedgerWidgetSnapshot.decode(encoded))
        XCTAssertEqual(decoded, LedgerWidgetSnapshot.previewSample)
    }

    // MARK: - Shared container

    func testStoreRoundTripsInsideAnInjectedContainer() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = LedgerWidgetSnapshotStore(directory: directory)
        XCTAssertTrue(store.isAvailable)
        XCTAssertNil(store.load())
        XCTAssertTrue(store.save(.previewSample))
        let restored = try XCTUnwrap(store.load())
        XCTAssertEqual(restored, LedgerWidgetSnapshot.previewSample)
        store.clear()
        XCTAssertNil(store.load())
    }

    func testStoreRefusesAnUnavailableContainerAndInvalidSnapshots() throws {
        let unavailable = LedgerWidgetSnapshotStore(directory: nil)
        XCTAssertFalse(unavailable.isAvailable)
        XCTAssertNil(unavailable.load())
        XCTAssertFalse(unavailable.save(.previewSample))
        unavailable.clear()

        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = LedgerWidgetSnapshotStore(directory: directory)
        XCTAssertFalse(store.save(LedgerWidgetSnapshot(ownerKey: "owner", updatedAt: 1)))
        var snapshot = LedgerWidgetSnapshot(ownerKey: "owner", updatedAt: 1)
        snapshot.totalBalanceCents = 100
        XCTAssertTrue(store.save(snapshot))
        XCTAssertEqual(store.load()?.totalBalanceCents, 100)
    }

    // MARK: - Sync

    @MainActor
    func testRefreshCopiesTheThreeServerAggregatesAndReloadsWidgets() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = LedgerWidgetSnapshotStore(directory: directory)
        var reloads = 0
        let sync = LedgerWidgetSync(store: store, reload: { reloads += 1 },
                                    now: { Date(timeIntervalSince1970: 1_700_000_000) })
        let api = try makeClient()
        defer { api.invalidate(); CoreMockURLProtocol.setHandler(nil) }
        var paths: [String] = []
        CoreMockURLProtocol.setHandler { request in
            let path = try XCTUnwrap(request.url?.path)
            paths.append(path)
            return try Self.response(request, json: Self.fixture(for: path))
        }

        let wrote = await sync.refresh(api: api, userID: "user-1")

        XCTAssertTrue(wrote)
        XCTAssertEqual(reloads, 1)
        XCTAssertEqual(paths.sorted(),
                       ["/api/v1/accounts/balances", "/api/v1/financial-funds/summary",
                        "/api/v1/stats/monthly-trend"])
        let snapshot = try XCTUnwrap(store.load())
        XCTAssertEqual(snapshot.ownerKey, LedgerWidgetSync.ownerKey(api: api, userID: "user-1"))
        XCTAssertEqual(snapshot.totalBalanceCents, 1_234_567)
        XCTAssertEqual(snapshot.totalAssetsCents, 2_000_000)
        XCTAssertEqual(snapshot.totalLiabilitiesCents, 100_000)
        XCTAssertEqual(snapshot.month, "2026-11")
        XCTAssertEqual(snapshot.monthIncomeCents, 320_000)
        XCTAssertEqual(snapshot.monthExpenseCents, 184_560)
        XCTAssertEqual(snapshot.purpose(.essentials)?.balanceCents, 250_000)
        XCTAssertEqual(snapshot.purpose(.essentials)?.fundedCents, 300_000)
        XCTAssertEqual(snapshot.purposes?.count, 4)
        XCTAssertEqual(snapshot.coverageComplete, false)
        XCTAssertEqual(snapshot.coveragePendingCount, 3)
        XCTAssertEqual(snapshot.updatedAt, 1_700_000_000_000)
    }

    @MainActor
    func testFailedReadsKeepThePreviousSnapshotInsteadOfWritingZero() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = LedgerWidgetSnapshotStore(directory: directory)
        var reloads = 0
        let sync = LedgerWidgetSync(store: store, reload: { reloads += 1 },
                                    now: { Date(timeIntervalSince1970: 1_700_000_100) })
        let api = try makeClient()
        defer { api.invalidate(); CoreMockURLProtocol.setHandler(nil) }
        var seed = LedgerWidgetSnapshot(ownerKey: LedgerWidgetSync.ownerKey(api: api, userID: "user-1"),
                                        updatedAt: 1_600_000_000_000)
        seed.totalBalanceCents = 999
        seed.purposes = [LedgerPurpose.growth.rawValue:
                            LedgerWidgetSnapshot.Purpose(balanceCents: 111, fundedCents: 222, spentCents: 0)]
        XCTAssertTrue(store.save(seed))
        CoreMockURLProtocol.setHandler { request in
            try Self.response(request, status: 500,
                              json: #"{"error":{"code":"READ_FAILED","message":"请重试"}}"#)
        }

        let wrote = await sync.refresh(api: api, userID: "user-1")

        XCTAssertFalse(wrote)
        XCTAssertEqual(reloads, 0)
        let snapshot = try XCTUnwrap(store.load())
        XCTAssertEqual(snapshot.totalBalanceCents, 999)
        XCTAssertEqual(snapshot.purpose(.growth)?.balanceCents, 111)
        XCTAssertEqual(snapshot.updatedAt, 1_600_000_000_000)
    }

    @MainActor
    func testAnotherAccountsSnapshotIsRemovedBeforeItCanBeShown() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = LedgerWidgetSnapshotStore(directory: directory)
        let sync = LedgerWidgetSync(store: store, reload: {},
                                    now: { Date(timeIntervalSince1970: 1_700_000_200) })
        let api = try makeClient()
        defer { api.invalidate(); CoreMockURLProtocol.setHandler(nil) }
        var seed = LedgerWidgetSnapshot(ownerKey: LedgerWidgetSync.ownerKey(api: api, userID: "other-user"),
                                        updatedAt: 1_600_000_000_000)
        seed.totalBalanceCents = 555
        XCTAssertTrue(store.save(seed))
        CoreMockURLProtocol.setHandler { request in
            try Self.response(request, status: 503,
                              json: #"{"error":{"code":"UNAVAILABLE","message":"请重试"}}"#)
        }

        let wrote = await sync.refresh(api: api, userID: "user-1")

        XCTAssertFalse(wrote)
        XCTAssertNil(store.load(), "A previous account's money must not survive an account switch")
    }

    @MainActor
    func testASignedOutAccountCannotBeRepublishedByAnInFlightRead() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = LedgerWidgetSnapshotStore(directory: directory)
        let sync = LedgerWidgetSync(store: store, reload: {},
                                    now: { Date(timeIntervalSince1970: 1_700_000_400) })
        let api = try makeClient()
        defer { api.invalidate(); CoreMockURLProtocol.setHandler(nil) }
        let started = expectation(description: "A widget read is in flight")
        let release = DispatchSemaphore(value: 0)
        let lock = NSLock()
        var calls = 0
        CoreMockURLProtocol.setHandler { request in
            lock.lock()
            calls += 1
            let index = calls
            lock.unlock()
            if index == 1 {
                started.fulfill()
                _ = release.wait(timeout: .now() + 5)
            }
            return try Self.response(request, json: Self.fixture(for: try XCTUnwrap(request.url?.path)))
        }

        let reading = Task { await sync.refresh(api: api, userID: "user-1") }
        await fulfillment(of: [started], timeout: 5)
        sync.clear()
        release.signal()
        let wrote = await reading.value

        XCTAssertFalse(wrote)
        XCTAssertNil(store.load(), "An in-flight read must not republish a signed-out account")
    }

    @MainActor
    func testInvalidFundSummaryIsNotPublished() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = LedgerWidgetSnapshotStore(directory: directory)
        let sync = LedgerWidgetSync(store: store, reload: {},
                                    now: { Date(timeIntervalSince1970: 1_700_000_300) })
        let api = try makeClient()
        defer { api.invalidate(); CoreMockURLProtocol.setHandler(nil) }
        CoreMockURLProtocol.setHandler { request in
            let path = try XCTUnwrap(request.url?.path)
            if path == "/api/v1/financial-funds/summary" {
                return try Self.response(request,
                                         json: Self.fixture(for: path).replacingOccurrences(
                                            of: "\"contractVersion\": 1", with: "\"contractVersion\": 2"))
            }
            return try Self.response(request, json: Self.fixture(for: path))
        }

        let wrote = await sync.refresh(api: api, userID: "user-1")

        XCTAssertTrue(wrote)
        let snapshot = try XCTUnwrap(store.load())
        XCTAssertEqual(snapshot.totalBalanceCents, 1_234_567)
        XCTAssertNil(snapshot.purposes, "An invalid contract must not become a purpose balance")
        XCTAssertNil(snapshot.coverageComplete)
    }

    @MainActor
    func testAnUnusableStoredSessionEndsTheWidgetScope() async throws {
        let suite = "widget-session-end-" + UUID().uuidString
        let preferences = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { preferences.removePersistentDomain(forName: suite) }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CoreMockURLProtocol.self]
        CoreMockURLProtocol.setHandler(nil)
        let session = AppSession(preferences: preferences, credentialStore: CoreMemoryCredentialStore(),
                                 configuration: { configuration })

        XCTAssertEqual(session.endedSessionCount, 0)
        await session.restore()

        XCTAssertNil(session.api)
        XCTAssertEqual(session.endedSessionCount, 1, "A cold start without a usable session must end the account scope")
    }

    @MainActor
    func testLegacyLoginWithoutAnImmutableUserIdUsesTheSessionIdentity() throws {
        let api = try makeClient()
        defer { api.invalidate() }
        let key = LedgerWidgetSync.ownerKey(api: api, userID: "   ")
        XCTAssertTrue(key.hasPrefix(api.baseURL.absoluteString.lowercased()))
        XCTAssertTrue(key.contains("|session:"), key)
    }

    // MARK: - Deep links

    func testWidgetLinksOpenTheirOwnTab() throws {
        XCTAssertEqual(JizhangDeepLink.parse(LedgerWidgetLink.balance)?.tab, JizhangTab.home)
        XCTAssertEqual(JizhangDeepLink.parse(LedgerWidgetLink.purposes)?.tab, JizhangTab.plan)
        XCTAssertEqual(JizhangDeepLink.parse(try XCTUnwrap(URL(string: "jizhang://my")))?.tab, JizhangTab.my)
        XCTAssertEqual(JizhangDeepLink.parse(try XCTUnwrap(URL(string: "jizhang:///plan")))?.tab, JizhangTab.plan)
        XCTAssertNil(JizhangDeepLink.parse(try XCTUnwrap(URL(string: "jizhang://plan/extra"))))
        XCTAssertNil(JizhangDeepLink.parse(try XCTUnwrap(URL(string: "https://plan"))))
        XCTAssertNil(JizhangDeepLink.parse(try XCTUnwrap(URL(string: "jizhang://unknown"))))
    }

    @MainActor
    func testClearReloadsWidgetsOnlyWhenAContainerExists() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        var reloads = 0
        let container = LedgerWidgetSnapshotStore(directory: directory)
        let available = LedgerWidgetSync(store: container, reload: { reloads += 1 })
        XCTAssertTrue(container.isAvailable)
        available.clear()
        XCTAssertEqual(reloads, 1, "Removing a real snapshot must refresh the Home Screen")

        var unavailableReloads = 0
        let unavailable = LedgerWidgetSync(store: LedgerWidgetSnapshotStore(directory: nil),
                                           reload: { unavailableReloads += 1 })
        unavailable.clear()
        XCTAssertEqual(unavailableReloads, 0, "No container means no widget can read the file")
    }

    @MainActor
    func testRefreshDoesNothingWithoutAnAppGroupContainer() async throws {
        var reloads = 0
        let sync = LedgerWidgetSync(store: LedgerWidgetSnapshotStore(directory: nil),
                                    reload: { reloads += 1 },
                                    now: { Date(timeIntervalSince1970: 1_700_000_500) })
        let api = try makeClient()
        defer { api.invalidate(); CoreMockURLProtocol.setHandler(nil) }
        CoreMockURLProtocol.setHandler { request in
            XCTFail("A widget read must not happen without a shared container: \(request)")
            return try Self.response(request, json: "{}")
        }

        let wrote = await sync.refresh(api: api, userID: "user-1")

        XCTAssertFalse(wrote)
        XCTAssertEqual(reloads, 0)
        XCTAssertNil(sync.snapshot)
    }

    @MainActor
    func testAbsurdCoverageCountsAreCappedInsteadOfOverflowing() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = LedgerWidgetSnapshotStore(directory: directory)
        let sync = LedgerWidgetSync(store: store, reload: {},
                                    now: { Date(timeIntervalSince1970: 1_700_000_600) })
        let api = try makeClient()
        defer { api.invalidate(); CoreMockURLProtocol.setHandler(nil) }
        CoreMockURLProtocol.setHandler { request in
            let path = try XCTUnwrap(request.url?.path)
            var json = Self.fixture(for: path)
            if path == "/api/v1/financial-funds/summary" {
                // Three counts that would overflow Int if they were added directly.
                json = json
                    .replacingOccurrences(of: "\"unallocatedSalaryCount\": 1",
                                          with: "\"unallocatedSalaryCount\": 9000000000000000000")
                    .replacingOccurrences(of: "\"unassignedTransactionCount\": 2",
                                          with: "\"unassignedTransactionCount\": 9000000000000000000")
                    .replacingOccurrences(of: "\"invalidRefundCount\": 0",
                                          with: "\"invalidRefundCount\": 9000000000000000000")
            }
            return try Self.response(request, json: json)
        }

        let wrote = await sync.refresh(api: api, userID: "user-1")

        XCTAssertTrue(wrote)
        let snapshot = try XCTUnwrap(store.load())
        XCTAssertEqual(snapshot.coveragePendingCount, 30_000)
        XCTAssertEqual(snapshot.purposes?.count, 4)
    }

    // MARK: - Rendered widget previews

    @MainActor
    func testBalanceWidgetPreviews() async throws {
        try await captureWidgets("widget-balance-small-medium") {
            VStack(spacing: 14) {
                HStack(spacing: 14) {
                    WidgetCanvas(size: CGSize(width: 158, height: 158)) {
                        LedgerBalanceWidgetView(snapshot: LedgerWidgetSnapshot.previewSample, size: .small)
                    }
                    WidgetCanvas(size: CGSize(width: 158, height: 158)) {
                        LedgerBalanceWidgetView(snapshot: nil, size: .small, sharedContainerAvailable: false)
                    }
                }
                WidgetCanvas(size: CGSize(width: 338, height: 158)) {
                    LedgerBalanceWidgetView(snapshot: LedgerWidgetSnapshot.previewSample, size: .medium)
                }
            }
        }
    }

    @MainActor
    func testPurposeWidgetPreviews() async throws {
        var pending = LedgerWidgetSnapshot.previewSample
        pending.coverageComplete = false
        pending.coveragePendingCount = 3
        try await captureWidgets("widget-purposes-compact") {
            VStack(spacing: 14) {
                HStack(spacing: 14) {
                    WidgetCanvas(size: CGSize(width: 158, height: 158)) {
                        LedgerPurposeWidgetView(snapshot: pending, size: .small)
                    }
                    WidgetCanvas(size: CGSize(width: 158, height: 158)) {
                        LedgerPurposeWidgetView(snapshot: nil, size: .small, sharedContainerAvailable: true)
                    }
                }
                WidgetCanvas(size: CGSize(width: 338, height: 158)) {
                    LedgerPurposeWidgetView(snapshot: pending, size: .medium)
                }
            }
        }
        try await captureWidgets("widget-purposes-large") {
            WidgetCanvas(size: CGSize(width: 338, height: 354)) {
                LedgerPurposeWidgetView(snapshot: pending, size: .large)
            }
        }
    }

    // MARK: - Fixtures and helpers

    @MainActor
    private func makeClient() throws -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CoreMockURLProtocol.self]
        return try APIClient(baseURL: ServerAddress.parse("https://example.com"),
                             credentialStore: CoreMemoryCredentialStore(), restoreSession: false,
                             configuration: configuration)
    }

    private static func response(_ request: URLRequest, status: Int = 200,
                                 json: String) throws -> (HTTPURLResponse, Data) {
        let response = try XCTUnwrap(HTTPURLResponse(url: XCTUnwrap(request.url), statusCode: status,
            httpVersion: nil, headerFields: ["Content-Type": "application/json"]))
        return (response, Data(json.utf8))
    }

    private static func fixture(for path: String) -> String {
        switch path {
        case "/api/v1/accounts/balances":
            return #"{"items":[],"totalBalanceCents":1234567,"totalAssetsCents":2000000,"totalLiabilitiesCents":100000}"#
        case "/api/v1/stats/monthly-trend":
            return #"{"items":[{"month":"2026-11","monthStart":1761955200000,"incomeCents":320000,"netExpenseCents":184560,"salaryIncomeCents":300000,"refundIncomeCents":20000}]}"#
        case "/api/v1/financial-funds/summary":
            return #"""
            {"contractVersion": 1, "asOf": 1761955200000,
             "balances": {"growth": 100000, "reserve": 50000, "essentials": 250000, "joy": 10000},
             "totals": {
               "funded": {"growth": 120000, "reserve": 60000, "essentials": 300000, "joy": 12000},
               "income": {"growth": 0, "reserve": 0, "essentials": 0, "joy": 0},
               "grossSpent": {"growth": 20000, "reserve": 10000, "essentials": 50000, "joy": 2000},
               "refunded": {"growth": 0, "reserve": 0, "essentials": 0, "joy": 0}},
             "coverage": {"complete": false, "unallocatedSalaryCount": 1, "unallocatedSalaryCents": 0,
                          "unassignedTransactionCount": 2, "unassignedTransactionCents": 0,
                          "invalidRefundCount": 0, "unresolvedRefundCents": 0, "issueCount": 0,
                          "unknownUnallocatedSalaryCount": 0},
             "snapshotToken": "fixture-token"}
            """#
        default:
            XCTFail("Unexpected widget fixture request: \(path)")
            return "{}"
        }
    }

    @MainActor
    private func captureWidgets<Content: View>(_ name: String,
                                               @ViewBuilder content: () -> Content) async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previousWindow = scene.windows.first { $0.isKeyWindow }
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 390, height: 760)
        let controller = UIHostingController(rootView:
            VStack(spacing: 14) {
                content()
                Text("小组件预览 · 测试数据").font(.caption2).foregroundStyle(.secondary)
            }
            .padding(24)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .background(Color(uiColor: .systemGroupedBackground))
        )
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer { window.isHidden = true; previousWindow?.makeKeyAndVisible() }
        try await Task.sleep(nanoseconds: 300_000_000)
        controller.view.setNeedsLayout()
        controller.view.layoutIfNeeded()
        let renderer = UIGraphicsImageRenderer(bounds: controller.view.bounds)
        let screenshot = renderer.image { _ in
            controller.view.drawHierarchy(in: controller.view.bounds, afterScreenUpdates: true)
        }
        let attachment = XCTAttachment(image: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}

/// Draws a widget view at the approximate Home Screen point size, including the system content
/// margins WidgetKit applies, so the attachment shows the same layout budget as the real widget.
private struct WidgetCanvas<Content: View>: View {
    let size: CGSize
    let content: Content

    init(size: CGSize, @ViewBuilder content: () -> Content) {
        self.size = size
        self.content = content()
    }

    var body: some View {
        content
            .padding(16)
            .frame(width: size.width, height: size.height, alignment: .topLeading)
            .background(LedgerWidgetBackground())
            .clipShape(RoundedRectangle(cornerRadius: 22))
    }
}
