import XCTest
@testable import Jizhang

final class AssistantWorkspaceTests: XCTestCase {
    override func tearDown() { CoreMockURLProtocol.setHandler(nil); WorkspaceLaunchURLProtocol.setHandler(nil); super.tearDown() }

    @MainActor private func client(protocolClass: AnyClass = CoreMockURLProtocol.self) throws -> APIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [protocolClass]
        return try APIClient(baseURL: ServerAddress.parse("https://example.com"), credentialStore: CoreMemoryCredentialStore(), restoreSession: false, configuration: config)
    }
    private static func reply(_ request: URLRequest, _ value: Any) throws -> (HTTPURLResponse, Data) {
        (try XCTUnwrap(HTTPURLResponse(url: XCTUnwrap(request.url), statusCode: 200, httpVersion: nil,
            headerFields: ["Content-Type": "application/json"])), try JSONSerialization.data(withJSONObject: value))
    }
    private static func json(_ value: [String: Any]) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: JSONSerialization.data(withJSONObject: value))
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
    private static func nativeSource(toolName: String = "workspace.open") -> [String: Any] {
        ["id": "native-source", "conversationId": "chat", "role": "assistant", "kind": "result", "createdAt": 1,
         "content": ["version": 1, "result": ["version": 1, "toolName": toolName, "summary": "打开导入工作区",
             "data": ["nativeAction": ["destination": "data-import"]]]]]
    }
    private static func completion(apiIdentity: UUID) throws -> NativeWorkspaceCompletion {
        try XCTUnwrap(NativeWorkspaceCompletion(apiIdentity: apiIdentity,
            route: NativeWorkspaceRoute(destination: .dataImport, conversationID: "chat", sourceMessageID: "native-source"),
            reference: .object(["kind": .string("csv-import"), "previewId": .string("verified-preview")])))
    }
    private static func conversation(_ id: String) -> [String: Any] {
        ["id": id, "title": id, "archived": false, "createdAt": 1, "updatedAt": 1]
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
        let selection = AssistantSelectionStore(api: api, conversationID: "chat", value: try Self.json(Self.interaction()))
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
        let selection = AssistantSelectionStore(api: api, conversationID: "chat", value: try Self.json(Self.interaction()))
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
        let selection = AssistantSelectionStore(api: api, conversationID: "chat", value: try Self.json(Self.interaction()))
        selection.choose("account-1")
        let result = await selection.answer()
        XCTAssertNil(result); XCTAssertNotNil(selection.error)
        XCTAssertEqual(api.ledgerRevision, 0)
    }

    func testDraftRevisionPreservesOpaqueFactsAndExactCents() throws {
        let original = try Self.json(["amountCents": 2800, "note": "午餐", "expectedRevision": 4, "operationId": "immutable"])
        let schema = try Self.json(["properties": ["amountCents": ["type": "integer"], "note": ["type": "string"], "expectedRevision": ["type": "integer"]]])
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
        XCTAssertFalse(requests.postPaths.contains(where: { $0.hasSuffix("/confirm") || $0.hasSuffix("/generations") }))
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
        var callbackCount = 0
        let prepared = await store.prepareOrganization(in: "chat", messageID: "result", runID: "run", selected: ["action-b"], onPrepared: {
            XCTAssertEqual(store.thread("chat").messages.last?.content.card?["actionId"].stringValue, "prepared")
            XCTAssertEqual(api.ledgerRevision, 0)
            callbackCount += 1
        })
        XCTAssertTrue(prepared)
        XCTAssertEqual(callbackCount, 1)
        XCTAssertEqual(api.ledgerRevision, 0)
        XCTAssertEqual(requests.methods.filter { $0 == "POST" }.count, 1)
        XCTAssertFalse(requests.postPaths.contains(where: { $0.hasSuffix("/generations") }))
    }

    @MainActor func testOrganizationSheetCallbackWaitsForValidatedOwningDraft() async throws {
        CoreMockURLProtocol.setHandler { request in
            if request.url?.path.hasSuffix("/organization/prepare") == true {
                return try Self.reply(request, ["messages": [], "action": ["id": "missing", "conversationId": "chat", "status": "pending"]])
            }
            return try Self.reply(request, ["items": []])
        }
        let api = try client(); defer { api.invalidate() }
        let store = AssistantStore(api: api); await store.open("chat")
        var dismissed = false
        let prepared = await store.prepareOrganization(in: "chat", messageID: "result", runID: "run", selected: ["action-b"], onPrepared: { dismissed = true })
        XCTAssertFalse(prepared)
        XCTAssertFalse(dismissed)
        XCTAssertEqual(api.ledgerRevision, 0)
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
        let selection = AssistantSelectionStore(api: api, conversationID: "chat", value: try Self.json(value))
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
            let selection = AssistantSelectionStore(api: api, conversationID: "chat", value: try Self.json(value))
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

    @MainActor func testNativeCompletionDuplicatesPostOnceAndDoNotNavigateTheOtherConversation() async throws {
        let requests = WorkspaceRequestCapture()
        CoreMockURLProtocol.setHandler { request in
            requests.record(request)
            if request.url?.path.hasSuffix("/native-completions") == true {
                let body = try Self.body(request)
                XCTAssertEqual(body["sourceMessageId"] as? String, "native-source")
                XCTAssertEqual((body["reference"] as? [String: String])?["previewId"], "verified-preview")
                return try Self.reply(request, ["generation": Self.generation()])
            }
            if request.url?.path.hasSuffix("/chat/messages") == true { return try Self.reply(request, ["items": [Self.nativeSource()]]) }
            return try Self.reply(request, ["items": []])
        }
        let api = try client(); defer { api.invalidate() }
        let store = AssistantStore(api: api); await store.open("other")
        let completion = try Self.completion(apiIdentity: api.identity)
        let first = Task { await store.continueNativeCompletion(completion) }
        let duplicate = Task { await store.continueNativeCompletion(completion) }
        await first.value; await duplicate.value
        await store.continueNativeCompletion(completion)
        XCTAssertEqual(requests.postPaths.filter { $0.hasSuffix("/native-completions") }.count, 1)
        XCTAssertEqual(store.selectedID, "other")
        XCTAssertNil(store.thread("other").generation)
        XCTAssertEqual(store.thread("chat").generation?.conversationId, "chat")
        XCTAssertEqual(api.ledgerRevision, 0)
    }

    @MainActor func testForeignNativeCompletionCannotReadOrPost() async throws {
        let requests = WorkspaceRequestCapture()
        CoreMockURLProtocol.setHandler { request in requests.record(request); return try Self.reply(request, ["items": []]) }
        let api = try client(); defer { api.invalidate() }
        let store = AssistantStore(api: api)
        await store.continueNativeCompletion(try Self.completion(apiIdentity: UUID()))
        XCTAssertEqual(requests.count, 0)
        XCTAssertTrue(store.workspacePendingBodies.isEmpty)
        XCTAssertEqual(api.ledgerRevision, 0)
    }

    @MainActor func testNativeCompletionUncertaintyKeepsReceiptAndStableRequestForExplicitRetry() async throws {
        let bodies = WorkspaceBodyCapture()
        CoreMockURLProtocol.setHandler { request in
            if request.url?.path.hasSuffix("/native-completions") == true {
                let count = bodies.add(try Self.body(request))
                if count == 1 { throw URLError(.networkConnectionLost) }
                return try Self.reply(request, ["generation": Self.generation()])
            }
            return try Self.reply(request, ["items": [Self.nativeSource()]])
        }
        let api = try client(); defer { api.invalidate() }
        let store = AssistantStore(api: api)
        let completion = try Self.completion(apiIdentity: api.identity)
        await store.continueNativeCompletion(completion)
        XCTAssertEqual(bodies.count, 1)
        XCTAssertEqual(store.workspacePendingBodies["native:" + completion.clientRequestID], completion.body)
        XCTAssertTrue(store.hasPendingNativeCompletion(conversationID: "chat", messageID: "native-source"))
        await store.retryNativeCompletion(conversationID: "chat", messageID: "native-source")
        XCTAssertEqual(bodies.count, 2)
        XCTAssertEqual(bodies.encoded.first, bodies.encoded.last)
        XCTAssertFalse(store.hasPendingNativeCompletion(conversationID: "chat", messageID: "native-source"))
        XCTAssertEqual(api.ledgerRevision, 0)
    }

    @MainActor func testNativeCompletionRequiresTheActualWorkspaceSourceBeforeInference() async throws {
        let requests = WorkspaceRequestCapture()
        CoreMockURLProtocol.setHandler { request in
            requests.record(request)
            return try Self.reply(request, ["items": [Self.nativeSource(toolName: "stats.monthly")]])
        }
        let api = try client(); defer { api.invalidate() }
        let store = AssistantStore(api: api)
        await store.continueNativeCompletion(try Self.completion(apiIdentity: api.identity))
        XCTAssertTrue(requests.postPaths.isEmpty)
        XCTAssertNil(store.thread("chat").generation)
        XCTAssertEqual(api.ledgerRevision, 0)
    }

    @MainActor func testQueuedDifferentReviewDaysWaitForFirstCreateAndEachSubmitExactlyOnce() async throws {
        let held = expectation(description: "First daily conversation creation is held")
        let secondEntered = expectation(description: "Second day launch entered")
        let lock = NSLock(); var firstRequest: WorkspaceLaunchURLProtocol?; var creates = 0
        let bodies = WorkspaceBodyCapture()
        WorkspaceLaunchURLProtocol.setHandler { transport in
            let request = transport.request; let path = request.url?.path ?? ""
            if request.httpMethod == "POST", path == "/api/v1/assistant/conversations" {
                let count = lock.withLock { creates += 1; return creates }
                if count == 1 { lock.withLock { firstRequest = transport }; held.fulfill() }
                else {
                    XCTAssertEqual(bodies.count, 1, "Second day cannot create before the first has submitted")
                    try transport.respond(Self.conversation("day-2"))
                }
            } else if path.hasSuffix("/daily-review") {
                _ = bodies.add(try Self.body(request))
                let id = path.contains("/day-1/") ? "day-1" : "day-2"
                var generation = Self.generation(id); generation["id"] = "generation-" + id
                try transport.respond(["generation": generation])
            } else { try transport.respond(["items": []]) }
        }
        let api = try client(protocolClass: WorkspaceLaunchURLProtocol.self); defer { api.invalidate() }
        let store = AssistantStore(api: api)
        let a = AssistantLaunchIntent(id: "owner.2026-11-05", apiIdentity: api.identity, date: "2026-11-05", timeZone: "Asia/Shanghai", clientRequestID: "request-day-A", conversationID: nil, mayStart: true)
        let b = AssistantLaunchIntent(id: "owner.2026-11-06", apiIdentity: api.identity, date: "2026-11-06", timeZone: "Asia/Shanghai", clientRequestID: "request-day-B", conversationID: nil, mayStart: true)
        let first = Task { await store.launchDailyReview(a) { _, _ in true } }
        await fulfillment(of: [held], timeout: 3)
        let second = Task { secondEntered.fulfill(); return await store.launchDailyReview(b) { _, _ in true } }
        let duplicate = Task { await store.launchDailyReview(a) { _, _ in true } }
        await fulfillment(of: [secondEntered], timeout: 3)
        XCTAssertTrue(store.creating)
        XCTAssertEqual(bodies.count, 0)
        let pending = lock.withLock { let value = firstRequest; firstRequest = nil; return value }
        try XCTUnwrap(pending).respond(Self.conversation("day-1"))
        let resultA = await first.value; let resultB = await second.value; let repeatedA = await duplicate.value
        XCTAssertEqual(resultA?.id, "day-1"); XCTAssertEqual(repeatedA?.id, "day-1"); XCTAssertEqual(resultB?.id, "day-2")
        XCTAssertEqual(lock.withLock { creates }, 2)
        XCTAssertEqual(bodies.count, 2)
        let submitted = try bodies.encoded.map { try XCTUnwrap(JSONSerialization.jsonObject(with: $0) as? [String: String]) }
        XCTAssertEqual(submitted.map { $0["date"] }, ["2026-11-05", "2026-11-06"])
        XCTAssertEqual(submitted.map { $0["clientRequestId"] }, ["request-day-A", "request-day-B"])
        XCTAssertTrue(submitted.allSatisfy { $0["timeZone"] == "Asia/Shanghai" })
        XCTAssertNil(store.selectedID, "Preparation cannot steal the user's visible conversation")
        XCTAssertEqual(api.ledgerRevision, 0)
    }

    @MainActor func testDailyReviewWaitsForUnrelatedUserConversationCreation() async throws {
        let held = expectation(description: "Manual conversation creation held")
        let dailyEntered = expectation(description: "Daily launch waiting")
        let lock = NSLock(); var firstRequest: WorkspaceLaunchURLProtocol?; var creates = 0
        let bodies = WorkspaceBodyCapture()
        WorkspaceLaunchURLProtocol.setHandler { transport in
            let request = transport.request; let path = request.url?.path ?? ""
            if request.httpMethod == "POST", path == "/api/v1/assistant/conversations" {
                let count = lock.withLock { creates += 1; return creates }
                if count == 1 { lock.withLock { firstRequest = transport }; held.fulfill() }
                else { try transport.respond(Self.conversation("daily-chat")) }
            } else if path.hasSuffix("/daily-review") {
                _ = bodies.add(try Self.body(request)); try transport.respond(["generation": Self.generation("daily-chat")])
            } else { try transport.respond(["items": []]) }
        }
        let api = try client(protocolClass: WorkspaceLaunchURLProtocol.self); defer { api.invalidate() }
        let store = AssistantStore(api: api)
        let manual = Task { await store.createConversation() }
        await fulfillment(of: [held], timeout: 3)
        let intent = AssistantLaunchIntent(id: "owner.day", apiIdentity: api.identity, date: "2026-11-06", timeZone: "Asia/Shanghai", clientRequestID: "daily-after-manual", conversationID: nil, mayStart: true)
        let daily = Task { dailyEntered.fulfill(); return await store.launchDailyReview(intent) { _, _ in true } }
        await fulfillment(of: [dailyEntered], timeout: 3)
        XCTAssertEqual(bodies.count, 0)
        let pending = lock.withLock { let value = firstRequest; firstRequest = nil; return value }
        try XCTUnwrap(pending).respond(Self.conversation("manual-chat"))
        let manualResult = await manual.value; let dailyResult = await daily.value
        XCTAssertEqual(manualResult?.id, "manual-chat"); XCTAssertEqual(dailyResult?.id, "daily-chat")
        XCTAssertEqual(lock.withLock { creates }, 2); XCTAssertEqual(bodies.count, 1)
        let bytes = try XCTUnwrap(bodies.encoded.first)
        let submitted = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
        XCTAssertEqual(submitted["clientRequestId"] as? String, "daily-after-manual")
        XCTAssertEqual(api.ledgerRevision, 0)
    }

    @MainActor func testCancelledFirstDailyCreateReleasesNextDayWithoutAcceptingFailedReceipt() async throws {
        let held = expectation(description: "First day create held for cancellation")
        let nextEntered = expectation(description: "Next day queued")
        let lock = NSLock(); var firstRequest: WorkspaceLaunchURLProtocol?; var creates = 0
        let bodies = WorkspaceBodyCapture()
        WorkspaceLaunchURLProtocol.setHandler { transport in
            let request = transport.request; let path = request.url?.path ?? ""
            if request.httpMethod == "POST", path == "/api/v1/assistant/conversations" {
                let count = lock.withLock { creates += 1; return creates }
                if count == 1 { lock.withLock { firstRequest = transport }; held.fulfill() }
                else { try transport.respond(Self.conversation("surviving-day")) }
            } else if path.hasSuffix("/daily-review") {
                _ = bodies.add(try Self.body(request)); try transport.respond(["generation": Self.generation("surviving-day")])
            } else { try transport.respond(["items": []]) }
        }
        let api = try client(protocolClass: WorkspaceLaunchURLProtocol.self); defer { api.invalidate() }
        let store = AssistantStore(api: api)
        let a = AssistantLaunchIntent(id: "owner.A", apiIdentity: api.identity, date: "2026-11-05", timeZone: "Asia/Shanghai", clientRequestID: "failed-A", conversationID: nil, mayStart: true)
        let b = AssistantLaunchIntent(id: "owner.B", apiIdentity: api.identity, date: "2026-11-06", timeZone: "Asia/Shanghai", clientRequestID: "surviving-B", conversationID: nil, mayStart: true)
        var failedDayCheckpoints = 0
        let first = Task { await store.launchDailyReview(a) { _, _ in failedDayCheckpoints += 1; return true } }
        await fulfillment(of: [held], timeout: 3)
        let second = Task { nextEntered.fulfill(); return await store.launchDailyReview(b) { _, _ in true } }
        await fulfillment(of: [nextEntered], timeout: 3)
        lock.withLock { firstRequest }?.fail(URLError(.cancelled))
        let failed = await first.value; let survived = await second.value
        XCTAssertNil(failed); XCTAssertEqual(survived?.id, "surviving-day")
        XCTAssertEqual(failedDayCheckpoints, 0)
        XCTAssertEqual(lock.withLock { creates }, 2); XCTAssertEqual(bodies.count, 1)
        let bytes = try XCTUnwrap(bodies.encoded.first)
        let submitted = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: String])
        XCTAssertEqual(submitted["date"], "2026-11-06"); XCTAssertEqual(submitted["clientRequestId"], "surviving-B")
        XCTAssertFalse(store.creating); XCTAssertEqual(api.ledgerRevision, 0)
    }
}

private final class WorkspaceRequestCapture: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [URLRequest] = []
    func record(_ request: URLRequest) { lock.withLock { values.append(request) } }
    var count: Int { lock.withLock { values.count } }
    var paths: [String] { lock.withLock { values.map { $0.url?.path ?? "" } } }
    var postPaths: [String] { lock.withLock { values.filter { $0.httpMethod == "POST" }.map { $0.url?.path ?? "" } } }
    var methods: [String] { lock.withLock { values.map { $0.httpMethod ?? "" } } }
}
private final class WorkspaceBodyCapture: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [Data] = []
    func add(_ value: [String: Any]) -> Int { lock.withLock { values.append((try? JSONSerialization.data(withJSONObject: value, options: .sortedKeys)) ?? Data()); return values.count } }
    var count: Int { lock.withLock { values.count } }
    var encoded: [Data] { lock.withLock { values } }
}

private final class WorkspaceLaunchURLProtocol: URLProtocol, @unchecked Sendable {
    typealias Handler = (WorkspaceLaunchURLProtocol) throws -> Void
    private static let lock = NSLock()
    private static var handler: Handler?
    static func setHandler(_ value: Handler?) { lock.withLock { handler = value } }
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "example.com" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            guard let handler = Self.lock.withLock({ Self.handler }) else { throw URLError(.badServerResponse) }
            try handler(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
    func fail(_ error: Error) { client?.urlProtocol(self, didFailWithError: error) }
    func respond(_ value: Any) throws {
        guard let url = request.url, let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]) else { throw URLError(.badServerResponse) }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: try JSONSerialization.data(withJSONObject: value))
        client?.urlProtocolDidFinishLoading(self)
    }
}
