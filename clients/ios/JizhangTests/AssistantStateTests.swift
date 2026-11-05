import XCTest
import Combine
@testable import Jizhang

extension AssistantStateTests {
    private static func actionHistory(_ conversation: String, status: String = "pending") -> [String: Any] {
        ["items": [["id": "card-1", "conversationId": conversation, "role": "assistant", "kind": "tool-card",
                    "content": ["version": 1, "card": ["version": 1, "actionId": "action-1", "toolName": "transaction.create",
                        "summary": "记录午餐 28 元", "status": status, "writes": true, "fingerprint": "fingerprint-1",
                        "affected": ["count": 1], "values": ["amountCents": 2800], "preview": [:], "warnings": []]], "createdAt": 1_000]]]
    }

    @MainActor
    func testActionDoubleTapWritesOnceAndRefreshesLedger() async throws {
        let started = expectation(description: "confirm waiting")
        let lock = NSLock()
        var pending: AssistantTestURLProtocol?
        var posts = 0
        var confirmed = false
        AssistantTestURLProtocol.configure { transport in
            let path = transport.request.url?.path ?? ""
            if path.hasSuffix("/action-1/confirm") {
                lock.withLock { posts += 1; pending = transport }
                started.fulfill()
            } else if path.hasSuffix("/a/messages") {
                let status = lock.withLock { confirmed ? "confirmed" : "pending" }
                transport.respond(Self.actionHistory("a", status: status))
            } else { transport.respond(["items": []]) }
        }
        let api = try makeClient(); defer { api.invalidate() }
        let store = AssistantStore(api: api)
        await store.open("a")
        let card = try XCTUnwrap(store.thread("a").messages.first?.content.card)
        let first = Task { await store.performAction(card, in: "a", confirm: true) }
        await fulfillment(of: [started], timeout: 3)
        await store.performAction(card, in: "a", confirm: true)
        XCTAssertEqual(lock.withLock { posts }, 1)
        XCTAssertEqual(api.ledgerRevision, 0)
        let request = lock.withLock { confirmed = true; return pending }
        request?.respond(["action": ["id": "action-1", "conversationId": "a", "status": "confirmed"]])
        await first.value
        XCTAssertEqual(api.ledgerRevision, 1)
        XCTAssertNil(store.thread("a").actingID)
        XCTAssertEqual(store.thread("a").messages.first?.content.card?["status"].stringValue, "confirmed")
        XCTAssertFalse(store.canAct(on: card, in: "a"))
    }

    @MainActor
    func testLostConfirmationReconcilesWithoutSecondWrite() async throws {
        let lock = NSLock()
        var confirmed = false
        var posts = 0
        AssistantTestURLProtocol.configure { transport in
            let path = transport.request.url?.path ?? ""
            if path.hasSuffix("/action-1/confirm") {
                lock.withLock { confirmed = true; posts += 1 }
                transport.fail(URLError(.networkConnectionLost))
            } else if path.hasSuffix("/a/messages") {
                transport.respond(Self.actionHistory("a", status: lock.withLock { confirmed ? "confirmed" : "pending" }))
            } else { transport.respond(["items": []]) }
        }
        let api = try makeClient(); defer { api.invalidate() }
        let store = AssistantStore(api: api)
        await store.open("a")
        let card = try XCTUnwrap(store.thread("a").messages.first?.content.card)
        await store.performAction(card, in: "a", confirm: true)
        XCTAssertEqual(lock.withLock { posts }, 1)
        XCTAssertEqual(api.ledgerRevision, 1)
        XCTAssertNil(store.thread("a").uncertainActionID)
        XCTAssertFalse(store.canAct(on: card, in: "a"))
    }

    @MainActor
    func testLateActionOnlyChangesOriginConversation() async throws {
        let started = expectation(description: "confirm waiting")
        let lock = NSLock()
        var pending: AssistantTestURLProtocol?
        AssistantTestURLProtocol.configure { transport in
            let path = transport.request.url?.path ?? ""
            if path.hasSuffix("/confirm") { lock.withLock { pending = transport }; started.fulfill() }
            else if path.hasSuffix("/a/messages") { transport.respond(Self.actionHistory("a")) }
            else if path.hasSuffix("/b/messages") { transport.respond(Self.history("b", text: "only-B")) }
            else { transport.respond(["items": []]) }
        }
        let api = try makeClient(); defer { api.invalidate() }
        let store = AssistantStore(api: api)
        await store.open("a")
        let card = try XCTUnwrap(store.thread("a").messages.first?.content.card)
        let write = Task { await store.performAction(card, in: "a", confirm: true) }
        await fulfillment(of: [started], timeout: 3)
        await store.open("b")
        lock.withLock { pending }?.respond(["action": ["id": "action-1", "conversationId": "a", "status": "confirmed"]])
        await write.value
        XCTAssertEqual(store.selectedID, "b")
        XCTAssertEqual(store.thread("b").messages.map { $0.content.text }, ["only-B"])
        XCTAssertEqual(store.thread("a").messages.first?.content.card?["status"].stringValue, "confirmed")
        XCTAssertEqual(api.ledgerRevision, 1)
    }

    func testHistoricalSelectionRejectsUnshownNoteAndExpiredChanges() throws {
        let card: JSONValue = .object(["runId": .string("run"), "status": .string("ready"), "expiresAt": .integer(5_000),
            "actions": .array([.object(["actionId": .string("category"), "kind": .string("category")]),
                               .object(["actionId": .string("note"), "kind": .string("note")])])])
        let now = Date(timeIntervalSince1970: 1)
        XCTAssertNotNil(AssistantSpendingSelection.prompt(card: card, selected: ["category"], now: now))
        XCTAssertNil(AssistantSpendingSelection.prompt(card: card, selected: ["note"], now: now))
        XCTAssertNil(AssistantSpendingSelection.prompt(card: card, selected: ["invented"], now: now))
        XCTAssertNil(AssistantSpendingSelection.prompt(card: card, selected: [], now: now))
        XCTAssertNil(AssistantSpendingSelection.prompt(card: card, selected: ["category"], now: Date(timeIntervalSince1970: 6)))
        XCTAssertEqual(AssistantPreviewFormat.scalar(.integer(9_007_199_254_740_991), key: "amountCents"), "¥90,071,992,547,409.91")
        XCTAssertEqual(AssistantPreviewFormat.scalar(.integer(0), key: "type", context: "account.create"), "现金")
        XCTAssertEqual(AssistantPreviewFormat.scalar(.integer(0), key: "type", context: "transaction.create"), "支出")
        XCTAssertEqual(AssistantImportSelection.limitedNote(String(repeating: "🙂", count: 101)).utf16.count, 200)
    }

    func testImportSelectionRequiresOriginalFileAndExplicitEligibleRows() throws {
        let file = AssistantBillFile(name: "bills.csv", data: Data("synthetic-bill".utf8))
        let card: JSONValue = .object(["attachment": .object(["sha256": .string(file.digest), "sizeBytes": .integer(Int64(file.data.count))]),
            "preview": .object(["rows": .array([
                .object(["id": .string("eligible"), "amountCents": .integer(2800), "type": .integer(0)]),
                .object(["id": .string("duplicate"), "amountCents": .integer(2800), "alreadyExists": .bool(true)]),
                .object(["id": .string("ignored"), "amountCents": .integer(2800), "ignored": .bool(true)])])])])
        var selection = AssistantImportSelection()
        XCTAssertNil(selection.body(card: card, file: file))
        selection.selected = ["eligible"]
        XCTAssertNotNil(selection.body(card: card, file: file))
        XCTAssertNil(selection.body(card: card, file: nil))
        XCTAssertNil(selection.body(card: card, file: AssistantBillFile(name: "bills.csv", data: Data("different".utf8))))
        for invalid in ["duplicate", "ignored", "invented"] {
            selection.selected = [invalid]
            XCTAssertNil(selection.body(card: card, file: file))
        }
    }

    @MainActor
    func testImportAmbiguousRetryKeepsOriginalSelectionAndFileBody() async throws {
        let lock = NSLock()
        var posts: [[String: Any]] = []
        var confirmed = false
        AssistantTestURLProtocol.configure { transport in
            let path = transport.request.url?.path ?? ""
            if path.hasSuffix("/confirm") {
                let count = lock.withLock { posts.append(transport.body()); return posts.count }
                if count == 1 { transport.fail(URLError(.networkConnectionLost)) }
                else {
                    lock.withLock { confirmed = true }
                    transport.respond(["action": ["id": "action-1", "conversationId": "a", "status": "confirmed"]])
                }
            } else if path.hasSuffix("/messages") { transport.respond(Self.actionHistory("a", status: lock.withLock { confirmed ? "confirmed" : "pending" })) }
            else { transport.respond(["items": []]) }
        }
        let api = try makeClient(); defer { api.invalidate() }
        let store = AssistantStore(api: api)
        await store.open("a")
        let card = try XCTUnwrap(store.thread("a").messages.first?.content.card)
        let body: JSONValue = .object(["selectedIds": .array([.string("row-1")]), "fileBase64": .string("ZmlsZQ==")])
        await store.performAction(card, in: "a", confirm: true, body: body)
        XCTAssertFalse(store.canAct(on: card, in: "a", confirm: false))
        await store.performAction(card, in: "a", confirm: true, body: .object(["selectedIds": .array([.string("different")])]))
        let payloads = lock.withLock { posts }
        XCTAssertEqual(payloads.count, 2)
        XCTAssertEqual(payloads[0]["selectedIds"] as? [String], ["row-1"])
        XCTAssertEqual(payloads[1]["selectedIds"] as? [String], ["row-1"])
        XCTAssertEqual(payloads[1]["fileBase64"] as? String, "ZmlsZQ==")
        XCTAssertEqual(api.ledgerRevision, 1)
    }

    @MainActor
    func testDefiniteActionRejectionUnlocksEditsWithoutLedgerChange() async throws {
        AssistantTestURLProtocol.configure { transport in
            let path = transport.request.url?.path ?? ""
            if path.hasSuffix("/confirm") { transport.respond(["error": ["code": "VALIDATION_ERROR", "message": "分类无效"]], status: 400) }
            else if path.hasSuffix("/messages") { transport.respond(Self.actionHistory("a")) }
            else { transport.respond(["items": []]) }
        }
        let api = try makeClient(); defer { api.invalidate() }
        let store = AssistantStore(api: api)
        await store.open("a")
        let card = try XCTUnwrap(store.thread("a").messages.first?.content.card)
        await store.performAction(card, in: "a", confirm: true)
        XCTAssertNil(store.confirmationBodies["action-1"])
        XCTAssertNil(store.thread("a").uncertainActionID)
        XCTAssertFalse(store.thread("a").composerLocked)
        XCTAssertTrue(store.canAct(on: card, in: "a", confirm: false))
        XCTAssertEqual(api.ledgerRevision, 0)
    }

    @MainActor
    func testRejectedFileUploadDoesNotLockComposer() async throws {
        AssistantTestURLProtocol.configure { transport in
            if transport.request.httpMethod == "POST" { transport.respond(["error": ["code": "VALIDATION_ERROR", "message": "无效账单"]], status: 422) }
            else { transport.respond(["items": []]) }
        }
        let api = try makeClient(); defer { api.invalidate() }
        let store = AssistantStore(api: api)
        await store.open("a")
        await store.sendFile(AssistantBillFile(name: "bills.csv", data: Data("fixture".utf8)), in: "a")
        XCTAssertNil(store.thread("a").pendingFileSubmission)
        XCTAssertFalse(store.thread("a").composerLocked)
        XCTAssertEqual(api.ledgerRevision, 0)
    }

    @MainActor
    func testLostCancellationCanOnlyRetryCancellation() async throws {
        AssistantTestURLProtocol.configure { transport in
            let path = transport.request.url?.path ?? ""
            if path.hasSuffix("/cancel") { transport.fail(URLError(.networkConnectionLost)) }
            else if path.hasSuffix("/messages") { transport.respond(Self.actionHistory("a")) }
            else { transport.respond(["items": []]) }
        }
        let api = try makeClient(); defer { api.invalidate() }
        let store = AssistantStore(api: api)
        await store.open("a")
        let card = try XCTUnwrap(store.thread("a").messages.first?.content.card)
        await store.performAction(card, in: "a", confirm: false)
        XCTAssertFalse(store.canAct(on: card, in: "a", confirm: true))
        XCTAssertTrue(store.canAct(on: card, in: "a", confirm: false))
        XCTAssertEqual(api.ledgerRevision, 0)
    }
}

private struct AssistantTestCredentialStore: SessionCredentialStore {
    func load(server: String) throws -> SessionCookie? { nil }
    func save(_ cookie: SessionCookie?, server: String) throws {}
}

private final class AssistantTestURLProtocol: URLProtocol {
    private static let handlerLock = NSLock()
    private static var storedHandler: ((AssistantTestURLProtocol) -> Void)?

    static func configure(_ handler: @escaping (AssistantTestURLProtocol) -> Void) {
        handlerLock.lock(); storedHandler = handler; handlerLock.unlock()
    }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.handlerLock.lock(); let callback = Self.storedHandler; Self.handlerLock.unlock()
        if let callback { callback(self) }
        else { fail(URLError(.badServerResponse)) }
    }
    override func stopLoading() {}

    func respond(_ object: Any, status: Int = 200) {
        do {
            let data = try JSONSerialization.data(withJSONObject: object)
            respond(data: data, contentType: "application/json", status: status)
        } catch { fail(error) }
    }

    func respond(data: Data, contentType: String, status: Int = 200) {
        guard let url = request.url,
              let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": contentType]) else {
            fail(URLError(.badURL)); return
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    func fail(_ error: Error) { client?.urlProtocol(self, didFailWithError: error) }

    func body() -> [String: Any] {
        let data: Data
        if let body = request.httpBody { data = body }
        else if let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var result = Data()
            var buffer = [UInt8](repeating: 0, count: 1_024)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                result.append(contentsOf: buffer.prefix(count))
            }
            data = result
        } else { data = Data() }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }
}

final class AssistantStateTests: XCTestCase {
    @MainActor
    private func makeClient() throws -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AssistantTestURLProtocol.self]
        return try APIClient(baseURL: URL(string: "https://unit.example")!, credentialStore: AssistantTestCredentialStore(),
                             restoreSession: false, configuration: configuration)
    }

    private static func history(_ conversation: String, text: String) -> [String: Any] {
        ["items": [["id": "message-\(text)", "conversationId": conversation, "role": "assistant", "kind": "text",
                    "content": ["version": 1, "text": text], "createdAt": 1_000]]]
    }

    @MainActor
    func testAToBToARejectsFirstALateHistory() async throws {
        let firstAStarted = expectation(description: "First A request is pending")
        let lock = NSLock()
        var aReads = 0
        var pendingA: AssistantTestURLProtocol?
        AssistantTestURLProtocol.configure { transport in
            let path = transport.request.url?.path ?? ""
            if path.hasSuffix("/a/messages") {
                lock.lock(); aReads += 1; let number = aReads
                if number == 1 { pendingA = transport }
                lock.unlock()
                if number == 1 { firstAStarted.fulfill() }
                else { transport.respond(Self.history("a", text: "new-A")) }
            } else if path.hasSuffix("/b/messages") { transport.respond(Self.history("b", text: "only-B")) }
            else { transport.respond(["items": []]) }
        }
        let api = try makeClient(); defer { api.invalidate() }
        let store = AssistantStore(api: api)
        let first = Task { await store.open("a") }
        await fulfillment(of: [firstAStarted], timeout: 3)
        await store.open("b")
        XCTAssertEqual(store.thread("b").messages.first?.content.text, "only-B")
        await store.open("a")
        let oldRequest = lock.withLock { pendingA }
        oldRequest?.respond(Self.history("a", text: "old-A"))
        await first.value
        XCTAssertEqual(store.selectedID, "a")
        XCTAssertEqual(store.thread("a").messages.map { $0.content.text }, ["new-A"])
        XCTAssertEqual(store.thread("b").messages.map { $0.content.text }, ["only-B"])
    }

    @MainActor
    func testPendingPostResumesTheReopenedThreadAndReleasesSupersededRead() async throws {
        let postStarted = expectation(description: "Generation POST is held")
        let reopenStarted = expectation(description: "Reopened A history is held")
        let stateSettled = expectation(description: "Terminal generation and current history are applied")
        let eventsRequested = expectation(description: "Current selection subscribes to accepted generation")
        let lock = NSLock()
        var aReads = 0
        var pendingPost: AssistantTestURLProtocol?
        var pendingRead: AssistantTestURLProtocol?
        AssistantTestURLProtocol.configure { transport in
            let path = transport.request.url?.path ?? ""
            if transport.request.httpMethod == "POST" {
                lock.lock(); pendingPost = transport; lock.unlock()
                postStarted.fulfill()
            } else if path.hasSuffix("/events") {
                eventsRequested.fulfill()
                let event = #"{"version":1,"generationId":"g1","seq":1,"type":"terminal","status":"completed","outcome":"answer","messageIds":[],"error":null}"#
                transport.respond(data: Data("id: 1\nevent: terminal\ndata: \(event)\n\n".utf8), contentType: "text/event-stream")
            } else if path.hasSuffix("/a/messages") {
                lock.lock(); aReads += 1; let number = aReads
                if number == 2 { pendingRead = transport }
                lock.unlock()
                if number == 2 { reopenStarted.fulfill() }
                else {
                    transport.respond(Self.history("a", text: number == 1 ? "before" : "current-A"))
                }
            } else if path.hasSuffix("/b/messages") { transport.respond(Self.history("b", text: "only-B")) }
            else { transport.respond(["items": []]) }
        }
        let api = try makeClient(); defer { api.invalidate() }
        let store = AssistantStore(api: api)
        var observedSettledState = false
        let observation = store.$threads.sink { threads in
            guard !observedSettledState, let thread = threads["a"], !thread.loading,
                  thread.generation?.status == .completed,
                  thread.history.first?.content.text == "current-A" else { return }
            observedSettledState = true
            stateSettled.fulfill()
        }
        defer { observation.cancel() }
        await store.open("a")
        store.setDraft("查预算", for: "a")
        let send = Task { await store.sendText(in: "a") }
        await fulfillment(of: [postStarted], timeout: 3)
        store.leave("a")
        await store.open("b")
        let reopen = Task { await store.open("a") }
        await fulfillment(of: [reopenStarted], timeout: 3)
        let (heldPost, heldRead) = lock.withLock { (pendingPost, pendingRead) }
        heldPost?.respond(["created": true, "generation": [
            "version": 1, "id": "g1", "conversationId": "a", "userMessageId": "u1", "userMessage": NSNull(),
            "status": "accepted", "delivery": "stream", "lastSeq": 0, "createdAt": 1_000, "updatedAt": 1_000,
            "partialMessages": [], "messageIds": [], "messages": [], "outcome": NSNull(), "error": NSNull()
        ]])
        await send.value
        await fulfillment(of: [eventsRequested, stateSettled], timeout: 3)
        heldRead?.respond(Self.history("a", text: "stale-A"))
        await reopen.value
        XCTAssertEqual(store.selectedID, "a")
        XCTAssertFalse(store.thread("a").loading)
        XCTAssertFalse(store.thread("a").composerLocked)
        XCTAssertEqual(store.thread("a").generation?.status, .completed)
        XCTAssertEqual(store.thread("a").draft, "")
        XCTAssertEqual(store.thread("a").messages.map { $0.content.text }, ["current-A"])
        XCTAssertEqual(store.thread("b").messages.map { $0.content.text }, ["only-B"])
    }

    @MainActor
    func testUncertainSendOnlyRetriesExplicitlyWithOriginalID() async throws {
        let lock = NSLock()
        var bodies: [[String: Any]] = []
        AssistantTestURLProtocol.configure { transport in
            let path = transport.request.url?.path ?? ""
            if transport.request.httpMethod == "POST" && path.hasSuffix("/generations") {
                let body = transport.body()
                lock.lock(); bodies.append(body); let number = bodies.count; lock.unlock()
                if number == 1 { transport.fail(URLError(.networkConnectionLost)); return }
                let user: [String: Any] = ["id": "u1", "conversationId": "a", "role": "user", "kind": "text", "createdAt": 1_000,
                                           "content": ["version": 1, "text": "查预算"]]
                transport.respond(["created": false, "generation": [
                    "version": 1, "id": "g1", "conversationId": "a", "userMessageId": "u1", "userMessage": user,
                    "status": "completed", "delivery": "buffered", "lastSeq": 2, "createdAt": 1_000, "updatedAt": 1_001,
                    "partialMessages": [], "messageIds": [], "messages": [], "outcome": "answer", "error": NSNull()
                ]])
            } else { transport.respond(["items": []]) }
        }
        let api = try makeClient(); defer { api.invalidate() }
        let store = AssistantStore(api: api)
        await store.open("a")
        store.setDraft("查预算", for: "a")
        await store.sendText(in: "a")
        XCTAssertNotNil(store.thread("a").pendingSubmission)
        let countAfterFailure = lock.withLock { bodies.count }
        XCTAssertEqual(countAfterFailure, 1)
        store.setDraft("不应该替换未知请求", for: "a")
        XCTAssertEqual(store.thread("a").draft, "查预算")
        store.leave("a")
        await store.open("a")
        XCTAssertNotNil(store.thread("a").notice, "Reopening must retain the explicit retry action for an uncertain POST")
        await store.retrySubmission(in: "a")
        let sentBodies = lock.withLock { bodies }
        XCTAssertEqual(sentBodies.count, 2)
        XCTAssertEqual(sentBodies[0]["clientRequestId"] as? String, sentBodies[1]["clientRequestId"] as? String)
        XCTAssertEqual((sentBodies[1]["input"] as? [String: Any])?["text"] as? String, "查预算")
        XCTAssertNil(store.thread("a").pendingSubmission)
        XCTAssertEqual(store.thread("a").draft, "")
    }

    @MainActor
    func testStaleChoiceRejectionUnlocksComposerAndRefreshesLatestGeneration() async throws {
        let lock = NSLock(); var rejected = false
        let question: [String: Any] = ["id": "question-message", "conversationId": "a", "role": "assistant", "kind": "text", "createdAt": 1_000,
            "content": ["version": 1, "generationId": "g1", "text": "请选账户", "clarification": [
                "id": "q1", "selection": "single", "question": "使用哪个账户？", "allowFreeText": true,
                "options": [["id": "one", "label": "账户一"], ["id": "two", "label": "账户二"]]
            ]]]
        AssistantTestURLProtocol.configure { transport in
            let path = transport.request.url?.path ?? ""
            if transport.request.httpMethod == "POST" {
                lock.lock(); rejected = true; lock.unlock()
                transport.respond(["error": ["code": "ASSISTANT_CHOICE_STALE", "message": "stale"]], status: 409)
            } else if path.hasSuffix("/messages") {
                transport.respond(["items": [question]])
            } else {
                lock.lock(); let latest = rejected; lock.unlock()
                transport.respond(["items": [[
                    "version": 1, "id": latest ? "g2" : "g1", "conversationId": "a", "userMessageId": "u1", "userMessage": NSNull(),
                    "status": "completed", "delivery": "buffered", "lastSeq": 2, "createdAt": latest ? 2_000 : 1_000, "updatedAt": 2_000,
                    "partialMessages": [], "messageIds": [], "messages": [], "outcome": latest ? "answer" : "awaiting-choice", "error": NSNull()
                ]]])
            }
        }
        let api = try makeClient(); defer { api.invalidate() }
        let store = AssistantStore(api: api)
        await store.open("a")
        let message = try XCTUnwrap(store.thread("a").messages.first)
        let option = try XCTUnwrap(message.content.clarification?.options.first)
        XCTAssertTrue(store.canAnswer(message, in: "a"))
        store.setDraft("保留这份草稿", for: "a")
        await store.answer(option, message: message, in: "a")
        XCTAssertNil(store.thread("a").pendingSubmission)
        XCTAssertFalse(store.thread("a").composerLocked)
        XCTAssertEqual(store.thread("a").generation?.id, "g2")
        XCTAssertEqual(store.thread("a").draft, "保留这份草稿")
        XCTAssertFalse(store.canAnswer(message, in: "a"))
        store.setDraft("可以继续输入", for: "a")
        XCTAssertEqual(store.thread("a").draft, "可以继续输入")
    }

    @MainActor
    func testCreatedConversationSurvivesARefreshStartedDuringCreation() async throws {
        try await assertListMutationWinsConcurrentRefresh(archiving: false)
    }

    @MainActor
    func testArchivedConversationIsNotRestoredByAConcurrentRefresh() async throws {
        try await assertListMutationWinsConcurrentRefresh(archiving: true)
    }

    @MainActor
    private func assertListMutationWinsConcurrentRefresh(archiving: Bool) async throws {
        let mutationStarted = expectation(description: "List mutation is held")
        let refreshStarted = expectation(description: "Concurrent list read is held")
        let old: [String: Any] = ["id": "old", "title": "已有对话", "archived": false, "createdAt": 1_000, "updatedAt": 1_000]
        let new: [String: Any] = ["id": "new", "title": "新对话", "archived": false, "createdAt": 2_000, "updatedAt": 2_000]
        let lock = NSLock(); var listReads = 0
        var pendingMutation: AssistantTestURLProtocol?
        var pendingRefresh: AssistantTestURLProtocol?
        AssistantTestURLProtocol.configure { transport in
            if transport.request.httpMethod == "POST" || transport.request.httpMethod == "DELETE" {
                lock.lock(); pendingMutation = transport; lock.unlock()
                mutationStarted.fulfill()
            } else {
                lock.lock(); listReads += 1; let number = listReads
                if number > 1 { pendingRefresh = transport }
                lock.unlock()
                if number == 1 { transport.respond(["items": [old]]) }
                else { refreshStarted.fulfill() }
            }
        }
        let api = try makeClient(); defer { api.invalidate() }
        let store = AssistantStore(api: api)
        await store.loadConversations()
        let conversation = try XCTUnwrap(store.conversations.first)
        let mutation = Task {
            if archiving { await store.archive(conversation) }
            else { _ = await store.createConversation() }
        }
        await fulfillment(of: [mutationStarted], timeout: 3)
        let refresh = Task { await store.loadConversations() }
        await fulfillment(of: [refreshStarted], timeout: 3)
        let (heldMutation, heldRefresh) = lock.withLock { (pendingMutation, pendingRefresh) }
        let mutationResponse: [String: Any] = archiving ? ["ok": true] : new
        heldMutation?.respond(mutationResponse)
        await mutation.value
        heldRefresh?.respond(["items": [old]])
        await refresh.value
        XCTAssertEqual(store.conversations.map(\.id), archiving ? [] : ["new", "old"])
        XCTAssertFalse(store.loadingList)
    }
}

final class ProviderStateTests: XCTestCase {
    private static func configuration(configured: Bool = true, enabled: Bool = true, model: String = "saved-model", secret: Bool = true) -> [String: Any] {
        ["configured": configured, "enabled": enabled, "encryptionKeyConfigured": true, "hasSecret": secret,
         "mode": "chat-completions", "name": "AI 助手", "url": configured ? "https://provider.example/v1/chat/completions" : "",
         "method": "POST", "model": model, "timeoutMs": 20_000, "headers": [:], "auth": ["kind": "bearer"],
         "bodyTemplate": NSNull(), "responsePath": "choices[0].message.content", "updatedAt": NSNull()]
    }

    @MainActor
    private func makeClient() throws -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [AssistantTestURLProtocol.self]
        return try APIClient(baseURL: URL(string: "https://unit.example")!, credentialStore: AssistantTestCredentialStore(),
                             restoreSession: false, configuration: configuration)
    }

    @MainActor
    func testDiscoveryFailureKeepsSelectedModelAndDoesNotTestProvider() async throws {
        let lock = NSLock(); var tests = 0
        AssistantTestURLProtocol.configure { transport in
            let path = transport.request.url?.path ?? ""
            if path.hasSuffix("/ai/models") {
                transport.respond(["error": ["code": "AI_PROVIDER_ERROR", "message": "safe error"]], status: 502)
            } else {
                if path.hasSuffix("/ai/test") { lock.lock(); tests += 1; lock.unlock() }
                transport.respond(Self.configuration())
            }
        }
        let api = try makeClient(); defer { api.invalidate() }
        let store = ProviderSettingsStore(api: api)
        await store.load()
        await store.fetchModels()
        XCTAssertEqual(store.draft.model, "saved-model")
        XCTAssertNotNil(store.error)
        XCTAssertFalse(store.testPassed)
        let testCalls = lock.withLock { tests }
        XCTAssertEqual(testCalls, 0)
    }

    @MainActor
    func testBootstrapModelSelectionRemainsDraftUntilExplicitSave() async throws {
        let lock = NSLock()
        var writes: [[String: Any]] = []
        var callPaths: [String] = []
        AssistantTestURLProtocol.configure { transport in
            let path = transport.request.url?.path ?? ""
            lock.lock(); callPaths.append(path); lock.unlock()
            if path.hasSuffix("/ai/models") {
                transport.respond(["items": [["id": "chosen-model"], ["id": "other-model"]]])
            } else if transport.request.httpMethod == "PUT" {
                let body = transport.body()
                lock.lock(); writes.append(body); lock.unlock()
                transport.respond(Self.configuration(enabled: body["enabled"] as? Bool ?? false, model: body["model"] as? String ?? ""))
            } else { transport.respond(Self.configuration(configured: false, enabled: false, model: "", secret: false)) }
        }
        let api = try makeClient(); defer { api.invalidate() }
        let store = ProviderSettingsStore(api: api)
        await store.load()
        store.draft.url = "https://provider.example"
        store.draft.secret = "synthetic-test-key"
        await store.fetchModels()
        XCTAssertNil(store.error)
        XCTAssertTrue(store.modelsLoaded)
        XCTAssertFalse(store.saved?.enabled ?? true)
        XCTAssertEqual(store.draft.secret, "")
        store.chooseModel("chosen-model")
        XCTAssertEqual(store.saved?.model, "")
        XCTAssertEqual(store.draft.model, "chosen-model")
        await store.save()
        XCTAssertEqual(store.saved?.model, "chosen-model")
        XCTAssertEqual(store.saved?.enabled, true)
        let (payloads, paths) = lock.withLock { (writes, callPaths) }
        XCTAssertEqual(payloads.count, 2)
        XCTAssertEqual(payloads[0]["enabled"] as? Bool, false)
        XCTAssertEqual(payloads[1]["enabled"] as? Bool, true)
        XCTAssertNil(payloads[1]["secret"])
        XCTAssertFalse(paths.contains { $0.hasSuffix("/ai/test") })
    }
}
