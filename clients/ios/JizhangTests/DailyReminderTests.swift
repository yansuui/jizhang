import XCTest
@testable import Jizhang

final class DailyReminderTests: XCTestCase {
    @MainActor func testDefaultClockSchedulesExactlyTwoAuthorizedReminders() async throws {
        let (storage, name) = preferences(); defer { storage.removePersistentDomain(forName: name) }
        let center = ReminderCenterFixture()
        let api = try client(); defer { api.invalidate() }
        let store = DailyReminderStore(center: center, preferences: storage, outbox: ReminderOutboxFixture(preferences: storage))
        store.updateSession(api: api, user: try user())
        await store.waitForScheduling()
        XCTAssertEqual(center.pending.count, 2)
        XCTAssertEqual(center.pending.values.first { $0.kind == .recording }?.clock, DailyReminderClock(hour: 20, minute: 0))
        XCTAssertEqual(center.pending.values.first { $0.kind == .review }?.clock, DailyReminderClock(hour: 21, minute: 0))
        XCTAssertEqual(store.scheduledKinds, Set([.recording, .review]))
        XCTAssertEqual(center.permissionRequests, 0)
    }

    @MainActor func testClockEditReplacesStableRequestAndDisableRemovesOnlyOne() async throws {
        let (storage, name) = preferences(); defer { storage.removePersistentDomain(forName: name) }
        let center = ReminderCenterFixture()
        let api = try client(); defer { api.invalidate() }
        let store = DailyReminderStore(center: center, preferences: storage, outbox: ReminderOutboxFixture(preferences: storage))
        store.updateSession(api: api, user: try user())
        await store.waitForScheduling()
        let initialIDs = Set(center.pending.keys)
        let clock = DailyReminderClock(hour: 19, minute: 35)
        store.setRecordingTime(clock.date)
        await store.waitForScheduling()
        XCTAssertEqual(Set(center.pending.keys), initialIDs)
        XCTAssertEqual(center.pending.values.first { $0.kind == .recording }?.clock, clock)
        store.setReviewEnabled(false)
        await store.waitForScheduling()
        XCTAssertEqual(center.pending.count, 1)
        XCTAssertEqual(center.pending.values.first?.kind, .recording)
    }

    @MainActor func testDeniedPermissionRetainsPreferencesWithoutClaimingScheduled() async throws {
        let (storage, name) = preferences(); defer { storage.removePersistentDomain(forName: name) }
        let center = ReminderCenterFixture(); center.permission = .denied
        let api = try client(); defer { api.invalidate() }
        let store = DailyReminderStore(center: center, preferences: storage, outbox: ReminderOutboxFixture(preferences: storage))
        store.updateSession(api: api, user: try user())
        await store.waitForScheduling()
        await store.allowNotifications()
        XCTAssertTrue(store.preferences.recordingEnabled)
        XCTAssertEqual(store.preferences.reviewTime.text, "21:00")
        XCTAssertTrue(center.pending.isEmpty)
        XCTAssertTrue(store.scheduledKinds.isEmpty)
        XCTAssertTrue(store.statusText.contains("系统通知已关闭"))
        XCTAssertEqual(center.permissionRequests, 0)
    }

    @MainActor func testPermissionIsRequestedOnlyByExplicitEnableAction() async throws {
        let (storage, name) = preferences(); defer { storage.removePersistentDomain(forName: name) }
        let center = ReminderCenterFixture(); center.permission = .notDetermined
        let api = try client(); defer { api.invalidate() }
        let store = DailyReminderStore(center: center, preferences: storage, outbox: ReminderOutboxFixture(preferences: storage))
        store.updateSession(api: api, user: try user())
        await store.waitForScheduling()
        XCTAssertEqual(center.permissionRequests, 0)
        XCTAssertTrue(center.pending.isEmpty)
        await store.allowNotifications()
        XCTAssertEqual(center.permissionRequests, 1)
        XCTAssertEqual(center.pending.count, 2)
    }

    @MainActor func testLateAddAfterLogoutIsDrainedAndDeliveredNotificationsAreRemoved() async throws {
        let (storage, name) = preferences(); defer { storage.removePersistentDomain(forName: name) }
        let center = ReminderCenterFixture()
        let api = try client(); defer { api.invalidate() }
        let started = expectation(description: "First scheduling callback is held")
        var release: CheckedContinuation<Void, Never>?
        var waited = false
        center.beforeAdd = { _ in
            if !waited {
                waited = true
                await withCheckedContinuation { continuation in release = continuation; started.fulfill() }
            }
        }
        let store = DailyReminderStore(center: center, preferences: storage, outbox: ReminderOutboxFixture(preferences: storage))
        store.updateSession(api: api, user: try user())
        await fulfillment(of: [started], timeout: 3)
        let owner = try XCTUnwrap(store.owner)
        center.delivered = [DailyReminderRequest.prefix + owner.key + ".review", "unrelated-feature"]
        store.deactivate()
        release?.resume()
        await store.waitForScheduling()
        XCTAssertTrue(center.pending.isEmpty)
        XCTAssertEqual(center.delivered, ["unrelated-feature"])
        XCTAssertNil(store.owner)
        XCTAssertTrue(store.scheduledKinds.isEmpty)
    }

    @MainActor func testReplacementSeparatesSameNamedUsersAndRestoresOnlyTheirPreference() async throws {
        let (storage, name) = preferences(); defer { storage.removePersistentDomain(forName: name) }
        let center = ReminderCenterFixture()
        let apiA = try client(); let apiB = try client(); defer { apiA.invalidate(); apiB.invalidate() }
        let store = DailyReminderStore(center: center, preferences: storage, outbox: ReminderOutboxFixture(preferences: storage))
        store.updateSession(api: apiA, user: try user(id: "a", username: "same"))
        await store.waitForScheduling()
        let firstKey = try XCTUnwrap(store.owner?.key)
        store.setRecordingTime(DailyReminderClock(hour: 18, minute: 20).date)
        await store.waitForScheduling()
        store.updateSession(api: apiB, user: try user(id: "b", username: "same"))
        await store.waitForScheduling()
        XCTAssertNotEqual(store.owner?.key, firstKey)
        XCTAssertEqual(store.preferences.recordingTime.text, "20:00")
        XCTAssertTrue(center.pending.values.allSatisfy { $0.ownerKey != firstKey })
        store.updateSession(api: apiA, user: try user(id: "a", username: "same"))
        await store.waitForScheduling()
        XCTAssertEqual(store.preferences.recordingTime.text, "18:20")
    }

    @MainActor func testColdTapWaitsForMatchingLoginAndRecordingIsOpenedOnce() async throws {
        let (storage, name) = preferences(); defer { storage.removePersistentDomain(forName: name) }
        let api = try client(); defer { api.invalidate() }
        let currentUser = try user()
        let owner = DailyReminderOwner(api: api, user: currentUser)
        let store = DailyReminderStore(center: ReminderCenterFixture(), preferences: storage, outbox: ReminderOutboxFixture(preferences: storage))
        let delivery = DailyReminderDelivery(ownerKey: owner.key, kind: .recording, deliveredAt: Date())
        store.receive(delivery)
        XCTAssertNil(store.recordingLaunch)
        store.updateSession(api: api, user: currentUser)
        let first = try XCTUnwrap(store.recordingLaunch)
        XCTAssertEqual(first.apiIdentity, api.identity)
        store.receive(delivery)
        XCTAssertEqual(store.recordingLaunch, first)
        await store.waitForScheduling()
    }

    @MainActor func testWrongOwnerTapCannotLaunchReview() async throws {
        let (storage, name) = preferences(); defer { storage.removePersistentDomain(forName: name) }
        let api = try client(); defer { api.invalidate() }
        let store = DailyReminderStore(center: ReminderCenterFixture(), preferences: storage, outbox: ReminderOutboxFixture(preferences: storage))
        store.updateSession(api: api, user: try user())
        store.receive(DailyReminderDelivery(ownerKey: String(repeating: "0", count: 64), kind: .review, deliveredAt: Date()))
        XCTAssertNil(store.reviewLaunch)
        XCTAssertTrue(store.notice?.contains("其他账本") == true)
        await store.waitForScheduling()
    }

    @MainActor func testReviewTapPersistsOneFrozenRequestAndCheckpointsBeforeSubmission() async throws {
        let (storage, name) = preferences(); defer { storage.removePersistentDomain(forName: name) }
        let api = try client(); defer { api.invalidate() }
        let store = DailyReminderStore(center: ReminderCenterFixture(), preferences: storage, outbox: ReminderOutboxFixture(preferences: storage))
        store.updateSession(api: api, user: try user())
        let owner = try XCTUnwrap(store.owner)
        let delivery = DailyReminderDelivery(ownerKey: owner.key, kind: .review, deliveredAt: date("2026-11-05T15:55:00Z"))
        store.receive(delivery)
        let first = try XCTUnwrap(store.reviewLaunch)
        XCTAssertEqual(first.date, "2026-11-05")
        XCTAssertEqual(first.timeZone, "Asia/Shanghai")
        XCTAssertTrue(first.mayStart)
        XCTAssertFalse(store.checkpoint(first, .submitting("unknown")))
        XCTAssertTrue(store.checkpoint(first, .conversation("daily-a")))
        XCTAssertTrue(store.checkpoint(first, .submitting("daily-a")))
        XCTAssertTrue(store.checkpoint(first, .accepted("generation-a")))
        store.receive(delivery)
        let replay = try XCTUnwrap(store.reviewLaunch)
        XCTAssertEqual(replay.clientRequestID, first.clientRequestID)
        XCTAssertEqual(replay.conversationID, "daily-a")
        XCTAssertFalse(replay.mayStart)
        await store.waitForScheduling()
    }

    @MainActor func testRestartDoesNotGenerateButNewTapRecoversUncertainSameRequest() async throws {
        let (storage, name) = preferences(); defer { storage.removePersistentDomain(forName: name) }
        let apiA = try client(); let apiB = try client(); defer { apiA.invalidate(); apiB.invalidate() }
        let currentUser = try user()
        let firstStore = DailyReminderStore(center: ReminderCenterFixture(), preferences: storage, outbox: ReminderOutboxFixture(preferences: storage))
        firstStore.updateSession(api: apiA, user: currentUser)
        let owner = try XCTUnwrap(firstStore.owner)
        let delivery = DailyReminderDelivery(ownerKey: owner.key, kind: .review, deliveredAt: date("2026-11-06T13:00:00Z"))
        firstStore.receive(delivery)
        let first = try XCTUnwrap(firstStore.reviewLaunch)
        XCTAssertTrue(firstStore.checkpoint(first, .conversation("daily-b")))
        XCTAssertTrue(firstStore.checkpoint(first, .submitting("daily-b")))
        XCTAssertTrue(firstStore.checkpoint(first, .uncertain("daily-b")))
        firstStore.deactivate()
        await firstStore.waitForScheduling()
        let restored = DailyReminderStore(center: ReminderCenterFixture(), preferences: storage, outbox: ReminderOutboxFixture(preferences: storage))
        restored.updateSession(api: apiB, user: currentUser)
        XCTAssertNil(restored.reviewLaunch)
        restored.receive(delivery)
        let recovered = try XCTUnwrap(restored.reviewLaunch)
        XCTAssertEqual(recovered.apiIdentity, apiB.identity)
        XCTAssertEqual(recovered.clientRequestID, first.clientRequestID)
        XCTAssertEqual(recovered.conversationID, "daily-b")
        XCTAssertFalse(recovered.mayStart)
        await restored.waitForScheduling()
    }

    @MainActor func testOldSessionCannotCheckpointIntoReplacementOwner() async throws {
        let (storage, name) = preferences(); defer { storage.removePersistentDomain(forName: name) }
        let apiA = try client(); let apiB = try client(); defer { apiA.invalidate(); apiB.invalidate() }
        let store = DailyReminderStore(center: ReminderCenterFixture(), preferences: storage, outbox: ReminderOutboxFixture(preferences: storage))
        store.updateSession(api: apiA, user: try user(id: "a"))
        let owner = try XCTUnwrap(store.owner)
        store.receive(DailyReminderDelivery(ownerKey: owner.key, kind: .review, deliveredAt: Date()))
        let launch = try XCTUnwrap(store.reviewLaunch)
        store.updateSession(api: apiB, user: try user(id: "b"))
        XCTAssertFalse(store.checkpoint(launch, .conversation("foreign")))
        XCTAssertNil(store.reviewLaunch)
        await store.waitForScheduling()
    }

    @MainActor func testLegacyLoginSupportsRecordingWithoutAutomaticReviewIdentity() async throws {
        let (storage, name) = preferences(); defer { storage.removePersistentDomain(forName: name) }
        let center = ReminderCenterFixture()
        let api = try client(); defer { api.invalidate() }
        let store = DailyReminderStore(center: center, preferences: storage, outbox: ReminderOutboxFixture(preferences: storage))
        store.updateSession(api: api, user: try user(id: nil))
        await store.waitForScheduling()
        let owner = try XCTUnwrap(store.owner)
        XCTAssertEqual(center.pending.values.map(\.kind), [.recording])
        store.receive(DailyReminderDelivery(ownerKey: owner.key, kind: .review, deliveredAt: Date()))
        XCTAssertNil(store.reviewLaunch)
        XCTAssertTrue(store.notice?.contains("暂不支持通知复盘") == true)
    }

    func testDeliveryDecoderRejectsUnknownOrChangedNotificationIdentity() {
        let owner = String(repeating: "a", count: 64)
        let payload: [AnyHashable: Any] = ["version": 1, "owner": owner, "kind": "review"]
        XCTAssertNotNil(DailyReminderDelivery(identifier: DailyReminderRequest.prefix + owner + ".review", userInfo: payload, date: Date()))
        XCTAssertNil(DailyReminderDelivery(identifier: "arbitrary-route", userInfo: payload, date: Date()))
        XCTAssertNil(DailyReminderDelivery(identifier: DailyReminderRequest.prefix + owner + ".review", userInfo: ["version": 2, "owner": owner, "kind": "review"], date: Date()))
    }

    @MainActor func testScheduleFailureDoesNotClaimDeliveryWasArmed() async throws {
        let (storage, name) = preferences(); defer { storage.removePersistentDomain(forName: name) }
        let center = ReminderCenterFixture(); center.failAdds = true
        let api = try client(); defer { api.invalidate() }
        let store = DailyReminderStore(center: center, preferences: storage, outbox: ReminderOutboxFixture(preferences: storage))
        store.updateSession(api: api, user: try user())
        await store.waitForScheduling()
        XCTAssertTrue(store.scheduledKinds.isEmpty)
        XCTAssertTrue(store.notice?.contains("未能安排") == true)
    }

    @MainActor func testOutboxWriteFailurePreventsAutomaticReviewLaunch() async throws {
        let (storage, name) = preferences(); defer { storage.removePersistentDomain(forName: name) }
        let outbox = ReminderOutboxFixture(preferences: storage); outbox.failWrites = true
        let api = try client(); defer { api.invalidate() }
        let store = DailyReminderStore(center: ReminderCenterFixture(), preferences: storage, outbox: outbox)
        store.updateSession(api: api, user: try user())
        let owner = try XCTUnwrap(store.owner)
        store.receive(DailyReminderDelivery(ownerKey: owner.key, kind: .review, deliveredAt: Date()))
        XCTAssertNil(store.reviewLaunch)
        XCTAssertTrue(store.notice?.contains("无法保存") == true)
        await store.waitForScheduling()
    }

    @MainActor func testAtomicFileOutboxSurvivesNewStorageInstanceAndRejectsPaths() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("daily-review-" + UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let first = FileDailyReviewOutbox(directory: directory)
        let id = String(repeating: "a", count: 64) + ".2026-11-06"
        let data = Data("persisted-request-id".utf8)
        try first.write(data, id: id)
        let second = FileDailyReviewOutbox(directory: directory)
        XCTAssertEqual(try second.read(id), data)
        XCTAssertThrowsError(try second.write(data, id: "../../outside"))
    }

    @MainActor private func client() throws -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CoreMockURLProtocol.self]
        return try APIClient(baseURL: URL(string: "https://example.com")!, credentialStore: CoreMemoryCredentialStore(),
                             restoreSession: false, configuration: configuration)
    }

    private func user(id: String? = "user-a", username: String = "fixture") throws -> AuthenticatedUser {
        var value: [String: Any] = ["username": username, "expiresAt": 9_999_999_999_999 as Int64]
        if let id { value["id"] = id }
        return try JSONDecoder().decode(AuthenticatedUser.self, from: JSONSerialization.data(withJSONObject: value))
    }

    private func date(_ value: String) -> Date { ISO8601DateFormatter().date(from: value)! }
    private func preferences() -> (UserDefaults, String) {
        let name = "daily-reminder-tests-" + UUID().uuidString
        return (UserDefaults(suiteName: name)!, name)
    }
}

@MainActor final class ReminderOutboxFixture: DailyReviewOutboxStorage {
    let preferences: UserDefaults
    var failWrites = false
    init(preferences: UserDefaults) { self.preferences = preferences }
    func read(_ id: String) throws -> Data? { preferences.data(forKey: "fixture-outbox." + id) }
    func write(_ data: Data, id: String) throws {
        if failWrites { throw DailyReviewOutboxError.invalid }
        preferences.set(data, forKey: "fixture-outbox." + id)
    }
}

@MainActor final class ReminderCenterFixture: DailyNotificationScheduling {
    var permission = DailyReminderAuthorization.authorized
    var permissionRequests = 0
    var pending: [String: DailyReminderRequest] = [:]
    var delivered: [String] = []
    var failAdds = false
    var beforeAdd: ((DailyReminderRequest) async -> Void)?
    func authorization() async -> DailyReminderAuthorization { permission }
    func requestAuthorization() async throws -> Bool { permissionRequests += 1; permission = .authorized; return true }
    func add(_ request: DailyReminderRequest) async throws {
        await beforeAdd?(request)
        if failAdds { throw URLError(.notConnectedToInternet) }
        pending[request.identifier] = request
    }
    func pendingIdentifiers() async -> [String] { Array(pending.keys) }
    func deliveredIdentifiers() async -> [String] { delivered }
    func removePending(_ identifiers: [String]) { for id in identifiers { pending.removeValue(forKey: id) } }
    func removeDelivered(_ identifiers: [String]) { delivered.removeAll { identifiers.contains($0) } }
}
