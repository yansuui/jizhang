import XCTest
@testable import Jizhang

final class AssistantProtocolTests: XCTestCase {
    private func decode<T: Decodable>(_ value: Any, as type: T.Type = T.self) throws -> T {
        try JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: value))
    }

    private func message(id: String = "reply", text: String = "最终回复", cardStatus: String? = nil) -> [String: Any] {
        var content: [String: Any] = ["version": 1, "text": text, "generationId": "g1"]
        if let cardStatus { content["card"] = ["status": cardStatus, "summary": "示例草案"] }
        return ["id": id, "conversationId": "c1", "role": "assistant", "kind": "text", "content": content, "createdAt": 1_000]
    }

    private func snapshot(seq: Int = 0, status: String = "running", messages: [[String: Any]] = []) throws -> AssistantGenerationSnapshot {
        try decode([
            "version": 1, "id": "g1", "conversationId": "c1", "userMessageId": "u1", "userMessage": NSNull(),
            "status": status, "delivery": "stream", "lastSeq": seq, "createdAt": 1_000, "updatedAt": 1_001,
            "partialMessages": [], "messageIds": messages.compactMap { $0["id"] as? String }, "messages": messages,
            "outcome": status == "completed" ? "answer" as Any : NSNull() as Any, "error": NSNull()
        ])
    }

    private func event(_ seq: Int, type: String, fields: [String: Any] = [:]) throws -> AssistantStreamEvent {
        var json: [String: Any] = ["version": 1, "generationId": "g1", "seq": seq, "type": type]
        fields.forEach { json[$0] = $1 }
        return try decode(json)
    }

    func testEmojiDeltaUsesUTF16Offsets() throws {
        var state = try AssistantGenerationState(snapshot(), conversation: "c1")
        try state.apply(event(1, type: "text-delta", fields: ["messageId": "reply", "step": 0, "offset": 0, "text": "🍵"]))
        try state.apply(event(2, type: "text-delta", fields: ["messageId": "reply", "step": 0, "offset": 2, "text": "喝茶"]))
        XCTAssertEqual(state.partials.first?.text, "🍵喝茶")
        XCTAssertEqual(state.lastSeq, 2)
    }

    func testWrongOffsetDoesNotAdvanceOrDuplicateText() throws {
        var state = try AssistantGenerationState(snapshot(), conversation: "c1")
        try state.apply(event(1, type: "text-delta", fields: ["messageId": "reply", "step": 0, "offset": 0, "text": "🍵"]))
        XCTAssertThrowsError(try state.apply(event(2, type: "text-delta", fields: ["messageId": "reply", "step": 0, "offset": 1, "text": "wrong"]))) {
            XCTAssertEqual($0 as? AssistantProtocolError, .textOffset)
        }
        XCTAssertEqual(state.lastSeq, 1)
        XCTAssertEqual(state.partials.first?.text, "🍵")
    }

    func testFinalMessageTakesOverProvisionalID() throws {
        var state = try AssistantGenerationState(snapshot(), conversation: "c1")
        try state.apply(event(1, type: "text-delta", fields: ["messageId": "reply", "step": 0, "offset": 0, "text": "部分"] ))
        try state.apply(event(2, type: "message", fields: ["message": message()]))
        let visible = state.merged(with: [])
        XCTAssertTrue(state.partials.isEmpty)
        XCTAssertEqual(visible.count, 1)
        XCTAssertEqual(visible.first?.id, "reply")
        XCTAssertEqual(visible.first?.content.text, "最终回复")
    }

    func testHistoryConfirmedCardOverridesOldGenerationPendingCard() throws {
        let state = try AssistantGenerationState(snapshot(seq: 4, status: "completed", messages: [message(cardStatus: "pending")]), conversation: "c1")
        let history: AssistantMessage = try decode(message(cardStatus: "confirmed"))
        let visible = state.merged(with: [history])
        XCTAssertEqual(visible.count, 1)
        XCTAssertEqual(visible[0].content.card?["status"].stringValue, "confirmed")
    }

    func testDuplicateReplayIsIgnoredButGapRequiresReconciliation() throws {
        var state = try AssistantGenerationState(snapshot(), conversation: "c1")
        let first = try event(1, type: "state", fields: ["status": "running"])
        XCTAssertTrue(try state.apply(first))
        XCTAssertFalse(try state.apply(first))
        XCTAssertThrowsError(try state.apply(event(3, type: "state", fields: ["status": "running"]))) {
            XCTAssertEqual($0 as? AssistantProtocolError, .sequenceGap)
        }
        XCTAssertEqual(state.lastSeq, 1)
    }

    func testWrongConversationAndGenerationAreRejected() throws {
        XCTAssertThrowsError(try AssistantGenerationState(snapshot(), conversation: "other"))
        var state = try AssistantGenerationState(snapshot(), conversation: "c1")
        let other: AssistantStreamEvent = try decode(["version": 1, "generationId": "other", "seq": 1, "type": "state", "status": "running"])
        XCTAssertThrowsError(try state.apply(other))
        XCTAssertEqual(state.lastSeq, 0)
    }

    func testOldSnapshotCannotReplaceNewText() throws {
        var state = try AssistantGenerationState(snapshot(), conversation: "c1")
        try state.apply(event(1, type: "text-delta", fields: ["messageId": "reply", "step": 0, "offset": 0, "text": "新内容"]))
        XCTAssertFalse(try state.reconcile(snapshot(seq: 0)))
        XCTAssertEqual(state.partials.first?.text, "新内容")
    }

    func testTerminalCannotRegressToRunningAtSameCursor() throws {
        var state = try AssistantGenerationState(snapshot(), conversation: "c1")
        try state.apply(event(1, type: "terminal", fields: ["status": "cancelled", "outcome": NSNull(), "messageIds": [], "error": NSNull()]))
        XCTAssertFalse(try state.reconcile(snapshot(seq: 1)))
        XCTAssertEqual(state.status, .cancelled)
    }

    func testFinalMessageCannotBelongToAnotherConversation() throws {
        var state = try AssistantGenerationState(snapshot(), conversation: "c1")
        var other = message(); other["conversationId"] = "c2"
        XCTAssertThrowsError(try state.apply(event(1, type: "message", fields: ["message": other])))
        XCTAssertTrue(state.messages.isEmpty)
    }

    func testSSEFramesAcceptLFCRLFAndCRIncludingSplitEmojiBytes() throws {
        for newline in ["\n", "\r\n", "\r"] {
            var parser = AssistantSSEParser()
            let content = "id: 1\(newline)event: text-delta\(newline)data: {\"version\":1,\"generationId\":\"g1\",\"seq\":1,\"type\":\"text-delta\",\"messageId\":\"reply\",\"step\":0,\"offset\":0,\"text\":\"🍵茶\"}\(newline)\(newline)"
            var frames: [AssistantSSEFrame] = []
            for byte in content.utf8 { if let frame = try parser.feed(byte) { frames.append(frame) } }
            XCTAssertEqual(frames.count, 1)
            XCTAssertEqual(try frames[0].decode().text, "🍵茶")
        }
    }

    func testSSECommentDoesNotBecomeEventAndIncompleteFrameIsNotAccepted() throws {
        var parser = AssistantSSEParser()
        var count = 0
        for byte in ": keep-alive\n\ndata: {\"type\":\"terminal\"}\n".utf8 {
            if try parser.feed(byte) != nil { count += 1 }
        }
        XCTAssertEqual(count, 0)
    }

    func testSSETransportIDMustMatchEnvelopeSequence() throws {
        let json = "{\"version\":1,\"generationId\":\"g1\",\"seq\":3,\"type\":\"state\",\"status\":\"running\"}"
        let frame = AssistantSSEFrame(id: "2", event: "state", data: Data(json.utf8))
        XCTAssertThrowsError(try frame.decode())
    }

    func testSSERejectsMalformedUTF8AndUnboundedLine() throws {
        var malformed = AssistantSSEParser()
        _ = try malformed.feed(0xFF)
        XCTAssertThrowsError(try malformed.feed(10))
        var oversized = AssistantSSEParser()
        for _ in 0..<(64 * 1_024) { _ = try oversized.feed(65) }
        XCTAssertThrowsError(try oversized.feed(65))
    }

    func testEmptyCompleteProgressIsNotDisplayed() throws {
        let item: AssistantMessage = try decode([
            "id": "p", "conversationId": "c1", "role": "assistant", "kind": "progress", "createdAt": 1_000,
            "content": ["version": 1, "progress": ["state": "complete"]]
        ])
        XCTAssertFalse(item.isVisible)
    }

    func testClarificationRejectsDuplicateOptionIDs() {
        let question = AssistantClarification(id: "q", selection: "single", question: "选哪个？",
            options: [.init(id: "a", label: "甲"), .init(id: "a", label: "乙")], allowFreeText: true)
        XCTAssertFalse(question.isValid)
    }

    func testPendingSubmissionKeepsExactRequestBodyForExplicitRetry() {
        let pending = AssistantSubmission(requestID: "same-id", input: .object(["type": .string("text"), "text": .string("看看预算")]), draftText: "看看预算")
        XCTAssertEqual(pending.body["clientRequestId"].stringValue, "same-id")
        XCTAssertEqual(pending.body["input"]["text"].stringValue, "看看预算")
        XCTAssertEqual(pending.body["clientCapabilities"].arrayValue, [.string("workspace-v1")])
        XCTAssertEqual(pending.body.objectValue?.count, 4)
    }
}
