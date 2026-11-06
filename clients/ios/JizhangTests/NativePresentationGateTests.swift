import UIKit
import XCTest
@testable import Jizhang

final class NativePresentationGateTests: XCTestCase {
    @MainActor func testWaitsForActualAvailabilityWithoutConsumingTheQueuedRoute() async throws {
        let owner = UUID()
        let queue = NativePresentationQueue(ownerIdentity: owner)
        queue.enqueue(.workspace(NativeWorkspaceRoute(destination: .reminders)), owner: owner)
        let id = try XCTUnwrap(queue.first?.id)
        var observations = 0
        var pauses = 0
        let gate = NativePresentationGate(available: {
            observations += 1
            return observations >= 4
        }, maximumChecks: 8, pause: { pauses += 1 })
        let result = await gate.wait { queue.first?.id == id }
        XCTAssertEqual(result, .ready)
        XCTAssertEqual(pauses, 3)
        XCTAssertEqual(queue.first?.id, id)
        XCTAssertFalse(queue.acknowledgeAppearance(id))
        XCTAssertTrue(queue.beginPresentation(id))
        XCTAssertEqual(queue.requests.count, 1, "Changing a presentation binding must not consume the intent")
        XCTAssertTrue(queue.acknowledgeAppearance(id))
        XCTAssertTrue(queue.requests.isEmpty)
    }

    @MainActor func testBoundedWaitRetainsIntentAndExplicitRetryCanOpenItLater() async throws {
        let owner = UUID()
        let queue = NativePresentationQueue(ownerIdentity: owner)
        queue.enqueue(.workspace(NativeWorkspaceRoute(destination: .dataExport)), owner: owner)
        let id = try XCTUnwrap(queue.first?.id)
        let blocked = NativePresentationGate(available: { false }, maximumChecks: 3, pause: {})
        let result = await blocked.wait { queue.first?.id == id }
        XCTAssertEqual(result, .timedOut)
        queue.deferPresentation(id)
        XCTAssertEqual(queue.first?.id, id)
        XCTAssertNotNil(queue.notice)
        let oldObservation = queue.observationID
        queue.retry()
        XCTAssertNotEqual(queue.observationID, oldObservation)
        let ready = NativePresentationGate(available: { true }, maximumChecks: 1, pause: {})
        let retried = await ready.wait { queue.first?.id == id }
        XCTAssertEqual(retried, .ready)
        XCTAssertEqual(queue.first?.id, id)
    }

    @MainActor func testOwnerReplacementCancelsObservationBeforeRouteBecomesAvailable() async throws {
        let owner = UUID()
        let queue = NativePresentationQueue(ownerIdentity: owner)
        queue.enqueue(.recording(DailyRecordingIntent(apiIdentity: owner)), owner: owner)
        let id = try XCTUnwrap(queue.first?.id)
        var currentOwner = owner
        var available = false
        let gate = NativePresentationGate(available: { available }, maximumChecks: 4, pause: {
            currentOwner = UUID(); available = true
        })
        let result = await gate.wait { currentOwner == owner }
        XCTAssertEqual(result, .cancelled)
        XCTAssertEqual(queue.first?.id, id)
        XCTAssertFalse(queue.enqueue(.recording(DailyRecordingIntent(apiIdentity: currentOwner)), owner: currentOwner))
    }

    @MainActor func testCancelledObserverDoesNotPresentOrDiscardAnIntent() async throws {
        let owner = UUID()
        let queue = NativePresentationQueue(ownerIdentity: owner)
        queue.enqueue(.workspace(NativeWorkspaceRoute(destination: .password)), owner: owner)
        let id = try XCTUnwrap(queue.first?.id)
        let waiting = expectation(description: "Presentation observer paused")
        var release: CheckedContinuation<Void, Never>?
        let gate = NativePresentationGate(available: { false }, maximumChecks: 4, pause: {
            await withCheckedContinuation { continuation in release = continuation; waiting.fulfill() }
        })
        let observation = Task { await gate.wait { queue.first?.id == id } }
        await fulfillment(of: [waiting], timeout: 3)
        observation.cancel()
        release?.resume()
        let result = await observation.value
        XCTAssertEqual(result, .cancelled)
        XCTAssertEqual(queue.first?.id, id)
    }

    @MainActor func testModalRequestsStayInOrderAndStaleAppearanceCannotAcknowledgeTheNextOne() throws {
        let owner = UUID()
        let queue = NativePresentationQueue(ownerIdentity: owner)
        let route = NativeWorkspaceRoute(destination: .providerSettings)
        queue.enqueue(.workspace(route), owner: owner)
        queue.enqueue(.workspace(route), owner: owner)
        let first = try XCTUnwrap(queue.first?.id)
        let recording = DailyRecordingIntent(apiIdentity: owner)
        queue.enqueue(.recording(recording), owner: owner)
        XCTAssertEqual(queue.requests.count, 2)
        XCTAssertTrue(queue.beginPresentation(first))
        XCTAssertTrue(queue.acknowledgeAppearance(first))
        let second = try XCTUnwrap(queue.first?.id)
        XCTAssertNotEqual(first, second)
        XCTAssertFalse(queue.acknowledgeAppearance(first))
        XCTAssertEqual(queue.first?.target, .recording(recording))
    }

    @MainActor func testCoveredTabReappearanceDoesNotReplayAnAlreadyOpenedNotification() throws {
        let owner = UUID()
        let queue = NativePresentationQueue(ownerIdentity: owner)
        let recording = DailyRecordingIntent(apiIdentity: owner)
        queue.enqueue(.recording(recording), owner: owner)
        let id = try XCTUnwrap(queue.first?.id)
        queue.beginPresentation(id); queue.acknowledgeAppearance(id)
        XCTAssertFalse(queue.enqueue(.recording(recording), owner: owner))
        XCTAssertTrue(queue.requests.isEmpty)
    }

    @MainActor func testRepeatReviewTapUpdatesPresentationButKeepsOneFrozenLogicalRequest() throws {
        let owner = UUID()
        let queue = NativePresentationQueue(ownerIdentity: owner)
        let first = AssistantLaunchIntent(id: "same-day", apiIdentity: owner, date: "2026-11-06", timeZone: "Asia/Shanghai",
            clientRequestID: "frozen-request", conversationID: "conversation", mayStart: false)
        let repeatTap = AssistantLaunchIntent(id: first.id, apiIdentity: owner, date: first.date, timeZone: first.timeZone,
            clientRequestID: first.clientRequestID, conversationID: first.conversationID, mayStart: false)
        queue.enqueue(.review(first), owner: owner)
        let id = try XCTUnwrap(queue.first?.id)
        queue.enqueue(.review(repeatTap), owner: owner)
        XCTAssertEqual(queue.requests.count, 1)
        XCTAssertEqual(queue.first?.id, id)
        XCTAssertEqual(queue.first?.target, .review(repeatTap))
        queue.beginPresentation(id); queue.acknowledgeAppearance(id)
        XCTAssertFalse(queue.enqueue(.review(repeatTap), owner: owner))
        let newTap = AssistantLaunchIntent(id: first.id, apiIdentity: owner, date: first.date, timeZone: first.timeZone,
            clientRequestID: first.clientRequestID, conversationID: first.conversationID, mayStart: false)
        XCTAssertTrue(queue.enqueue(.review(newTap), owner: owner))
    }

    @MainActor func testNestedUIKitPresenterBlocksTheGateEvenWhenRootHasNoPresentedController() {
        let root = PresentationControllerFixture()
        let child = PresentationControllerFixture()
        root.addChild(child)
        XCTAssertTrue(UIKitPresentationStatus.controllerTreeIsFree(root))
        child.modal = UIViewController()
        XCTAssertNil(root.presentedViewController)
        XCTAssertFalse(UIKitPresentationStatus.controllerTreeIsFree(root))
        child.modal = nil
        XCTAssertTrue(UIKitPresentationStatus.controllerTreeIsFree(root))
    }

    @MainActor func testNativeCompletionWaitsForDismissalAndIsOneShotForItsCurrentOwner() throws {
        let owner = UUID()
        let route = NativeWorkspaceRoute(destination: .dataImport, conversationID: "original-conversation",
                                         sourceMessageID: "original-message")
        let reference: JSONValue = .object(["kind": .string("csv-import"), "operationId": .string("confirmed-operation")])
        let completion = try XCTUnwrap(NativeWorkspaceCompletion(apiIdentity: owner, route: route, reference: reference))
        let relay = NativeWorkspaceCompletionRelay(ownerIdentity: owner)
        XCTAssertTrue(relay.store(completion, currentOwner: owner))
        XCTAssertTrue(relay.hasPending, "A successful native callback must wait for the actual sheet dismissal")
        XCTAssertTrue(relay.store(completion, currentOwner: owner))
        let foreign = try XCTUnwrap(NativeWorkspaceCompletion(apiIdentity: UUID(), route: route, reference: reference))
        XCTAssertFalse(relay.store(foreign, currentOwner: owner))
        XCTAssertTrue(relay.hasPending, "A foreign callback cannot erase the current owner's receipt")
        XCTAssertEqual(relay.takeAfterDismiss(currentOwner: owner), completion)
        XCTAssertNil(relay.takeAfterDismiss(currentOwner: owner))
        XCTAssertFalse(relay.store(completion, currentOwner: owner), "A repeated Done callback cannot emit another event")

        let replaced = NativeWorkspaceCompletionRelay(ownerIdentity: owner)
        XCTAssertTrue(replaced.store(completion, currentOwner: owner))
        XCTAssertNil(replaced.takeAfterDismiss(currentOwner: UUID()))
        XCTAssertFalse(replaced.hasPending)
        let loggedOut = NativeWorkspaceCompletionRelay(ownerIdentity: owner)
        XCTAssertTrue(loggedOut.store(completion, currentOwner: owner))
        loggedOut.clear()
        XCTAssertNil(loggedOut.takeAfterDismiss(currentOwner: nil))
    }

    @MainActor func testLatestPhotoReceiptReplacesEarlierResultOnlyForTheSameConversationAndSource() throws {
        let owner = UUID()
        let route = NativeWorkspaceRoute(destination: .itemPhoto, itemID: "item-1",
                                         conversationID: "conversation", sourceMessageID: "photo-card")
        let original: JSONValue = .object(["kind": .string("item-photo"), "itemId": .string("item-1"),
                                          "sha256": .string("original-photo")])
        let cutout: JSONValue = .object(["kind": .string("item-photo"), "itemId": .string("item-1"),
                                        "sha256": .string("saved-cutout")])
        let first = try XCTUnwrap(NativeWorkspaceCompletion(apiIdentity: owner, route: route, reference: original))
        let latest = try XCTUnwrap(NativeWorkspaceCompletion(apiIdentity: owner, route: route, reference: cutout))
        XCTAssertNotEqual(first.clientRequestID, latest.clientRequestID)
        let relay = NativeWorkspaceCompletionRelay(ownerIdentity: owner)
        XCTAssertTrue(relay.store(first, currentOwner: owner))
        XCTAssertTrue(relay.store(latest, currentOwner: owner))
        let otherSource = NativeWorkspaceRoute(destination: .itemPhoto, itemID: "item-1",
                                               conversationID: "conversation", sourceMessageID: "other-card")
        let otherConversation = NativeWorkspaceRoute(destination: .itemPhoto, itemID: "item-1",
                                                     conversationID: "other-conversation", sourceMessageID: "photo-card")
        for other in [otherSource, otherConversation] {
            let foreign = try XCTUnwrap(NativeWorkspaceCompletion(apiIdentity: owner, route: other, reference: original))
            XCTAssertFalse(relay.store(foreign, currentOwner: owner))
        }
        XCTAssertEqual(relay.takeAfterDismiss(currentOwner: owner), latest)
        XCTAssertNil(relay.takeAfterDismiss(currentOwner: owner))
    }
}

@MainActor private final class PresentationControllerFixture: UIViewController {
    var modal: UIViewController?
    override var presentedViewController: UIViewController? { modal }
}
