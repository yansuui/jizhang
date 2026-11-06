import XCTest
@testable import Jizhang

final class AssistantWorkspaceTests: XCTestCase {
    override func tearDown() { CoreMockURLProtocol.setHandler(nil); super.tearDown() }

    @MainActor private func client() throws -> APIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [CoreMockURLProtocol.self]
        return try APIClient(baseURL: ServerAddress.parse("https://example.com"), credentialStore: CoreMemoryCredentialStore(), restoreSession: false, configuration: config)
    }
    private static func reply(_ request: URLRequest, _ value: Any) throws -> (HTTPURLResponse, Data) {
        (try XCTUnwrap(HTTPURLResponse(url: XCTUnwrap(request.url), statusCode: 200, httpVersion: nil,
            headerFields: ["Content-Type": "application/json"])), try JSONSerialization.data(withJSONObject: value))
    }
    private static func body(_ request: URLRequest) throws -> [String: Any] {
        let data: Data
        if let bytes = request.httpBody { data = bytes }
        else if let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var bytes = Data(); var buffer = [UInt8](repeating: 0, count: 1024)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                guard count >= 0 else { throw URLError(.cannotDecodeContentData) }
                if count == 0 { break }; bytes.append(buffer, count: count)
            }
            data = bytes
        } else { data = Data("{}".utf8) }
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
    private static func generation(_ conversation: String = "chat") -> [String: Any] {
        ["version": 1, "id": "generation", "conversationId": conversation, "userMessageId": "user",
         "status": "completed", "delivery": "buffered", "lastSeq": 0, "createdAt": 1, "updatedAt": 1,
         "partialMessages": [], "messageIds": [], "messages": [], "outcome": "answer"]
    }
    private static func interaction(offset: Int = 0) -> [String: Any] {
        ["version": 1, "type": "selection", "id": "selection", "kind": "account", "title": "选择账户", "multiple": true,
         "status": "pending", "expiresAt": Int64(Date().timeIntervalSince1970 * 1000) + 60_000,
         "items": (0..<8).map { ["id": "account-\(offset + $0)", "title": "同名账户", "subtitle": "来源 \(offset + $0)"] },
         "page": ["offset": offset, "limit": 8, "total": 16, "hasMore": offset == 0]]
    }
    private static func message(_ actionID: String, status: String) -> [String: Any] {
        ["id": "message-" + actionID, "conversationId": "chat", "role": "assistant", "kind": "tool-card", "createdAt": 1,
         "content": ["version": 1, "card": ["version": 1, "actionId": actionID, "toolName": "transaction.create", "status": status,
            "writes": true, "fingerprint": "guard", "summary": "支出", "values": ["amountCents": 2800], "preview": [:], "warnings": []]]]
    }

    @MainActor func testSelectionKeepsAuthoritativeIDsAcrossPagesAndDoesNotWriteLedger() async throws {
        let requests = WorkspaceRequestCapture()
        CoreMockURLProtocol.setHandler { request in
            requests.record(request)
            if request.httpMethod == "GET" { return try Self.reply(request, ["interaction": Self.interaction(offset: 8)]) }
            let body = try Self.body(request)
            XCTAssertEqual(body["selectedIds"] as? [String], ["account-7", "account-8"])
            XCTAssertNil(body["arguments"])
            return try Self.reply(request, ["generation": Self.generation()])
        }
        let api = try client(); defer { api.invalidate() }
        let selection = AssistantSelectionStore(api: api, conversationID: "chat", value: try JSONValue.decodeData(Self.interaction()))
        selection.choose("account-7"); await selection.page(8); selection.choose("account-8")
        XCTAssertEqual(selection.selected, ["account-7", "account-8"])
        XCTAssertEqual(selection.value["items"].arrayValue?.count, 8)
        let snapshot = await selection.answer()
        XCTAssertEqual(snapshot?.conversationId, "chat")
        XCTAssertEqual(api.ledgerRevision, 0)
        XCTAssertFalse(selection.canAnswer)
        XCTAssertEqual(requests.count, 2)
    }

    @MainActor func testUncertainSelectionFreezesExactRequestAndRequiresExplicitRetry() async throws {
        let bodies = WorkspaceBodyCapture()
        CoreMockURLProtocol.setHandler { request in
            let body = try Self.body(request); let count = bodies.add(body)
            if count == 1 { throw URLError(.networkConnectionLost) }
            return try Self.reply(request, ["generation": Self.generation()])
        }
        let api = try client(); defer { api.invalidate() }
        let selection = AssistantSelectionStore(api: api, conversationID: "chat", value: try JSONValue.decodeData(Self.interaction()))
        selection.choose("account-1")
        let first = await selection.answer(); XCTAssertNil(first)
        selection.choose("account-2")
        XCTAssertEqual(selection.selected, ["account-1"])
        XCTAssertEqual(bodies.count, 1)
        let second = await selection.answer(); XCTAssertNotNil(second)
        XCTAssertEqual(bodies.encoded.first, bodies.encoded.last)
        XCTAssertEqual(api.ledgerRevision, 0)
    }

    @MainActor func testForeignSelectionResponseCannotBecomeTheOwningGeneration() async throws {
        CoreMockURLProtocol.setHandler { try Self.reply($0, ["generation": Self.generation("foreign")]) }
        let api = try client(); defer { api.invalidate() }
        let selection = AssistantSelectionStore(api: api, conversationID: "chat", value: try JSONValue.decodeData(Self.interaction()))
        selection.choose("account-1")
        let result = await selection.answer()
        XCTAssertNil(result); XCTAssertNotNil(selection.error)
        XCTAssertEqual(api.ledgerRevision, 0)
    }

    func testDraftRevisionPreservesOpaqueFactsAndExactCents() throws {
        let original = try JSONValue.decodeData(["amountCents": 2800, "note": "午餐", "expectedRevision": 4, "operationId": "immutable"])
        let schema = try JSONValue.decodeData(["properties": ["amountCents": ["type": "integer"], "note": ["type": "string"], "expectedRevision": ["type": "integer"]]])
        let result = try AssistantDraftEditing.arguments(original: original, schema: schema,
            edits: ["amountCents": "3500", "note": "午餐和饮料", "expectedRevision": "99", "operationId": "changed", "unknown": "1"])
        XCTAssertEqual(result["amountCents"].intValue, 3500)
        XCTAssertEqual(result["expectedRevision"].intValue, 4)
        XCTAssertEqual(result["operationId"].stringValue, "immutable")
        XCTAssertEqual(result["note"].stringValue, "午餐和饮料")
        XCTAssertNil(result["unknown"].intValue)
        XCTAssertThrowsError(try AssistantDraftEditing.arguments(original: original, schema: schema, edits: ["amountCents": "35.1"]))
        XCTAssertEqual(AssistantDraftEditing.moneyCents("90071992547409.91"), 9_007_199_254_740_991)
        XCTAssertNil(AssistantDraftEditing.moneyCents("90071992547409.92"))
        XCTAssertEqual(AssistantDraftEditing.moneyCents("-3.09"), -309)
    }

    @MainActor func testRevisionInstallsNewDraftAndOldCardCannotExecuteWithoutFinancialWrite() async throws {
        let requests = WorkspaceRequestCapture()
        CoreMockURLProtocol.setHandler { request in
            requests.record(request)
            if request.url?.path.hasSuffix("/revise") == true {
                let arguments = try Self.body(request)["arguments"] as? [String: Any]
                XCTAssertEqual(arguments?["amountCents"] as? Int, 3500)
                return try Self.reply(request, ["messages": [Self.message("old", status: "cancelled"), Self.message("new", status: "pending")],
                    "action": ["id": "new", "conversationId": "chat", "status": "pending"]])
            }
            return try Self.reply(request, request.url?.path.hasSuffix("/messages") == true ? ["items": [Self.message("old", status: "pending")]] : ["items": []])
        }
        let api = try client(); defer { api.invalidate() }
        let store = AssistantStore(api: api); await store.open("chat")
        let old = try XCTUnwrap(store.thread("chat").messages.first?.content.card)
        let revised = await store.reviseDraft(old, in: "chat", arguments: .object(["amountCents": .integer(3500)]))
        XCTAssertTrue(revised)
        XCTAssertFalse(store.canAct(on: old, in: "chat"))
        let new = try XCTUnwrap(store.thread("chat").messages.last?.content.card)
        XCTAssertTrue(store.canAct(on: new, in: "chat"))
        XCTAssertEqual(api.ledgerRevision, 0)
        XCTAssertFalse(requests.paths.contains(where: { $0.hasSuffix("/confirm") || $0.hasSuffix("/generations") }))
    }

    @MainActor func testOrganizationPreparationUsesTypedSelectionWithoutModelRequest() async throws {
        let requests = WorkspaceRequestCapture()
        CoreMockURLProtocol.setHandler { request in
            requests.record(request)
            if request.url?.path.hasSuffix("/organization/prepare") == true {
                let body = try Self.body(request)
                XCTAssertEqual(body["kind"] as? String, "spending")
                XCTAssertEqual(body["runId"] as? String, "run")
                XCTAssertEqual(body["actionIds"] as? [String], ["action-b"])
                return try Self.reply(request, ["messages": [Self.message("prepared", status: "pending")], "action": ["id": "prepared", "conversationId": "chat", "status": "pending"]])
            }
            return try Self.reply(request, ["items": []])
        }
        let api = try client(); defer { api.invalidate() }
        let store = AssistantStore(api: api); await store.open("chat")
        let prepared = await store.prepareOrganization(in: "chat", messageID: "result", runID: "run", selected: ["action-b"])
        XCTAssertTrue(prepared)
        XCTAssertEqual(api.ledgerRevision, 0)
        XCTAssertEqual(requests.methods.filter { $0 == "POST" }.count, 1)
        XCTAssertFalse(requests.paths.contains(where: { $0.hasSuffix("/generations") }))
    }

    @MainActor func testDailyReviewLaunchUsesFrozenReadOnlyEndpointAndPersistsBeforeInference() async throws {
        let requests = WorkspaceRequestCapture()
        CoreMockURLProtocol.setHandler { request in
            requests.record(request)
            if request.url?.path.hasSuffix("/daily-review") == true {
                let body = try Self.body(request)
                XCTAssertEqual(body["clientRequestId"] as? String, "stable-daily")
                XCTAssertEqual(body["date"] as? String, "2026-11-06")
                XCTAssertEqual(body["timeZone"] as? String, "Asia/Shanghai")
                return try Self.reply(request, ["generation": Self.generation()])
            }
            return try Self.reply(request, ["items": []])
        }
        let api = try client(); defer { api.invalidate() }
        let store = AssistantStore(api: api)
        let intent = AssistantLaunchIntent(id: "owner.day", apiIdentity: api.identity, date: "2026-11-06", timeZone: "Asia/Shanghai", clientRequestID: "stable-daily", conversationID: "chat", mayStart: true)
        var checkpoints: [String] = []
        let result = await store.launchDailyReview(intent) { _, checkpoint in
            switch checkpoint { case .conversation: checkpoints.append("conversation"); case .submitting: checkpoints.append("submitting"); case .accepted: checkpoints.append("accepted"); case .uncertain: checkpoints.append("uncertain") }
            return true
        }
        XCTAssertEqual(result?.id, "chat")
        XCTAssertEqual(checkpoints, ["conversation", "submitting", "accepted"])
        XCTAssertEqual(requests.methods.filter { $0 == "POST" }.count, 1)
        XCTAssertEqual(api.ledgerRevision, 0)
    }

    @MainActor func testConfirmedActionContinuesOriginalTaskWithStableIdentity() async throws {
        let requests = WorkspaceRequestCapture()
        let bodies = WorkspaceBodyCapture()
        let lock = NSLock(); var confirmed = false
        CoreMockURLProtocol.setHandler { request in
            requests.record(request)
            let path = request.url?.path ?? ""
            if path.hasSuffix("/workspace/capabilities") { return try Self.reply(request, ["version": 1, "items": [], "nativeActions": []]) }
            if path.hasSuffix("/confirm") {
                lock.withLock { confirmed = true }
                return try Self.reply(request, ["action": ["id": "old", "conversationId": "chat", "status": "confirmed"]])
            }
            if path.hasSuffix("/continue") {
                _ = bodies.add(try Self.body(request))
                return try Self.reply(request, ["generation": Self.generation()])
            }
            if path.hasSuffix("/messages") { return try Self.reply(request, ["items": [Self.message("old", status: lock.withLock { confirmed ? "confirmed" : "pending" })]]) }
            return try Self.reply(request, ["items": []])
        }
        let api = try client(); defer { api.invalidate() }
        let store = AssistantStore(api: api); await store.loadCapabilities(); await store.open("chat")
        let card = try XCTUnwrap(store.thread("chat").messages.first?.content.card)
        await store.performAction(card, in: "chat", confirm: true)
        XCTAssertEqual(store.thread("chat").generation?.id, "generation")
        XCTAssertEqual(api.ledgerRevision, 1)
        XCTAssertEqual(requests.paths.filter { $0.hasSuffix("/confirm") }.count, 1)
        await store.continueConfirmed(card, in: "chat")
        XCTAssertEqual(bodies.count, 2)
        XCTAssertEqual(bodies.encoded.first, bodies.encoded.last)
        XCTAssertEqual(api.ledgerRevision, 1)
    }

    @MainActor func testDateSelectionSubmitsExplicitInclusiveRangeWithoutLabels() async throws {
        CoreMockURLProtocol.setHandler { request in
            let body = try Self.body(request)
            let range = try XCTUnwrap(body["dateRange"] as? [String: String])
            XCTAssertEqual(range["from"], "2026-11-01")
            XCTAssertEqual(range["to"], "2026-11-06")
            XCTAssertEqual(range["timeZone"], "Asia/Shanghai")
            XCTAssertNil(body["selectedIds"])
            return try Self.reply(request, ["generation": Self.generation()])
        }
        let api = try client(); defer { api.invalidate() }
        var value = Self.interaction(); value["kind"] = "date-range"
        let selection = AssistantSelectionStore(api: api, conversationID: "chat", value: try JSONValue.decodeData(value))
        let calendar = LedgerBillDates.calendar
        selection.from = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 11, day: 1, hour: 12)))
        selection.to = try XCTUnwrap(calendar.date(from: DateComponents(year: 2026, month: 11, day: 6, hour: 12)))
        let result = await selection.answer(); XCTAssertNotNil(result)
        XCTAssertEqual(api.ledgerRevision, 0)
    }

    @MainActor func testAdditionalWorkspaceResourcesKeepTheirAuthoritativeIDs() throws {
        let api = try client(); defer { api.invalidate() }
        for kind in ["item", "recurring", "recurring-occurrence", "goal", "fund-source", "transfer", "trash"] {
            var value = Self.interaction(); value["kind"] = kind
            value["items"] = [["id": "source-identity", "title": "同名资源", "facts": ["expectedRevision": 4]]]
            let selection = AssistantSelectionStore(api: api, conversationID: "chat", value: try JSONValue.decodeData(value))
            selection.choose("source-identity")
            XCTAssertEqual(selection.value["kind"].stringValue, kind)
            XCTAssertEqual(selection.selected, ["source-identity"])
            XCTAssertFalse(selection.isRange)
            XCTAssertTrue(selection.canAnswer)
        }
        XCTAssertEqual(api.ledgerRevision, 0)
    }

    @MainActor func testDailyReviewCannotInferIfOutboxCheckpointFails() async throws {
        let requests = WorkspaceRequestCapture()
        CoreMockURLProtocol.setHandler { request in requests.record(request); return try Self.reply(request, ["items": []]) }
        let api = try client(); defer { api.invalidate() }
        let store = AssistantStore(api: api)
        let intent = AssistantLaunchIntent(id: "owner.day", apiIdentity: api.identity, date: "2026-11-06", timeZone: "Asia/Shanghai", clientRequestID: "stable", conversationID: "chat", mayStart: true)
        let result = await store.launchDailyReview(intent) { _, _ in false }
        XCTAssertNil(result)
        XCTAssertEqual(requests.count, 0)
        XCTAssertNotNil(store.listError)
    }

    @MainActor func testDailyReviewReopenOrWrongOwnerDoesNotAutomaticallyStartModel() async throws {
        let requests = WorkspaceRequestCapture()
        CoreMockURLProtocol.setHandler { request in requests.record(request); return try Self.reply(request, ["items": []]) }
        let api = try client(); defer { api.invalidate() }
        let store = AssistantStore(api: api)
        let wrong = AssistantLaunchIntent(id: "owner.day", apiIdentity: UUID(), date: "2026-11-06", timeZone: "Asia/Shanghai", clientRequestID: "stable", conversationID: "chat", mayStart: true)
        let rejected = await store.launchDailyReview(wrong) { _, _ in true }; XCTAssertNil(rejected); XCTAssertEqual(requests.count, 0)
        let pending = AssistantLaunchIntent(id: "owner.day", apiIdentity: api.identity, date: "2026-11-06", timeZone: "Asia/Shanghai", clientRequestID: "stable", conversationID: "chat", mayStart: false)
        _ = await store.launchDailyReview(pending) { _, _ in true }
        XCTAssertTrue(requests.methods.allSatisfy { $0 == "GET" })
        XCTAssertEqual(store.thread("chat").pendingSubmission?.requestID, "stable")
        XCTAssertEqual(store.thread("chat").pendingSubmission?.pathSuffix, "/workspace/daily-review")
        XCTAssertEqual(api.ledgerRevision, 0)
    }

    @MainActor func testTraceLiveObservationUsesBoundedReadOnlyRequests() async throws {
        let requests = WorkspaceRequestCapture()
        CoreMockURLProtocol.setHandler { request in requests.record(request); return try Self.reply(request, ["items": []]) }
        let api = try client(); defer { api.invalidate() }
        let trace = AssistantTraceStore(api: api, conversationID: "chat", generationID: "generation")
        await trace.observe(active: true, interval: .zero, maximumReads: 3)
        XCTAssertEqual(requests.count, 3)
        XCTAssertTrue(requests.methods.allSatisfy { $0 == "GET" })
        XCTAssertEqual(api.ledgerRevision, 0)
    }
}

private final class WorkspaceRequestCapture: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [URLRequest] = []
    func record(_ request: URLRequest) { lock.withLock { values.append(request) } }
    var count: Int { lock.withLock { values.count } }
    var paths: [String] { lock.withLock { values.map { $0.url?.path ?? "" } } }
    var methods: [String] { lock.withLock { values.map { $0.httpMethod ?? "" } } }
}
private final class WorkspaceBodyCapture: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [Data] = []
    func add(_ value: [String: Any]) -> Int { lock.withLock { values.append((try? JSONSerialization.data(withJSONObject: value, options: .sortedKeys)) ?? Data()); return values.count } }
    var count: Int { lock.withLock { values.count } }
    var encoded: [Data] { lock.withLock { values } }
}
