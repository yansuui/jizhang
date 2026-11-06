import XCTest
@testable import Jizhang

final class AssistantSpendingRunTests: XCTestCase {
    override func tearDown() { CoreMockURLProtocol.setHandler(nil); super.tearDown() }

    func testStreamFailureExplainsKnownCauseWithoutLeakingUnknownProviderText() {
        let timeout = AssistantFault(code: "ASSISTANT_STREAM_BOUNDS", message: "AI 响应超时，本次生成已中断。")
        let format = AssistantFault(code: "ASSISTANT_STREAM_BOUNDS", message: "AI 返回内容无法识别，本次生成未产生结果。")
        XCTAssertNotEqual(timeout.displayMessage, format.displayMessage)
        XCTAssertTrue(timeout.displayMessage.contains("超时"))
        XCTAssertTrue(format.displayMessage.contains("格式"))
        let unsafe = AssistantFault(code: "ASSISTANT_STREAM_BOUNDS", message: "provider_debug_secret=must-not-render")
        XCTAssertFalse(unsafe.displayMessage.contains("must-not-render"))
    }

    @MainActor func testFailedJobExplainsSafeCauseWithoutDisplayingProviderDetails() throws {
        let api = try client(); defer { api.invalidate() }
        var value = Self.run(status: "failed", completed: 3)
        value["errorCode"] = "AI_RESPONSE_INVALID"
        value["errorDetail"] = "private-provider-text"
        let store = AssistantSpendingRunStore(api: api, runID: "run-a", initial: try JSONValue.decodeData(value))
        XCTAssertTrue(store.failureText.contains("格式"))
        XCTAssertFalse(store.failureText.contains("private-provider-text"))
    }

    @MainActor func testBackgroundObservationCompletesWithOnlyReadRequests() async throws {
        let reads = SpendingReadCounter()
        CoreMockURLProtocol.setHandler { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/api/v1/ai/organization-runs/run-a")
            let count = reads.next()
            return try Self.response(request, Self.run(status: count == 3 ? "ready" : "running", completed: count == 3 ? 20 : count))
        }
        let api = try client(); defer { api.invalidate() }
        let store = AssistantSpendingRunStore(api: api, runID: "run-a", initial: .null, pollInterval: .zero, maximumReads: 5)
        await store.observe()
        XCTAssertEqual(reads.count, 3)
        XCTAssertEqual(store.status, "ready")
        XCTAssertNil(store.error)
        XCTAssertFalse(store.observing)
        XCTAssertEqual(api.ledgerRevision, 0)
    }

    @MainActor func testTransientProgressFailureRecoversWithoutNewGeneration() async throws {
        let reads = SpendingReadCounter()
        CoreMockURLProtocol.setHandler { request in
            XCTAssertEqual(request.httpMethod, "GET")
            if reads.next() == 1 { throw URLError(.networkConnectionLost) }
            return try Self.response(request, Self.run(status: "ready", completed: 20))
        }
        let api = try client(); defer { api.invalidate() }
        let store = AssistantSpendingRunStore(api: api, runID: "run-a", initial: .null, pollInterval: .zero, maximumReads: 5)
        await store.observe()
        XCTAssertEqual(reads.count, 2)
        XCTAssertEqual(store.status, "ready")
        XCTAssertNil(store.error)
    }

    @MainActor func testManualRefreshRestartsStoppedReadObservation() async throws {
        let reads = SpendingReadCounter()
        CoreMockURLProtocol.setHandler { request in
            XCTAssertEqual(request.httpMethod, "GET")
            if reads.next() <= 3 { throw URLError(.networkConnectionLost) }
            return try Self.response(request, Self.run(status: "ready", completed: 20))
        }
        let api = try client(); defer { api.invalidate() }
        let store = AssistantSpendingRunStore(api: api, runID: "run-a", initial: .null, pollInterval: .zero, maximumReads: 5)
        await store.observe()
        XCTAssertEqual(reads.count, 3)
        XCTAssertNotNil(store.error)
        await store.observe()
        XCTAssertEqual(reads.count, 4)
        XCTAssertEqual(store.status, "ready")
        XCTAssertNil(store.error)
    }

    @MainActor func testMissingRunStopsAndDoesNotInventReadyState() async throws {
        let reads = SpendingReadCounter()
        CoreMockURLProtocol.setHandler { request in
            _ = reads.next()
            return try Self.response(request, ["error": ["code": "NOT_FOUND", "message": "Missing run"]], status: 404)
        }
        let api = try client(); defer { api.invalidate() }
        let store = AssistantSpendingRunStore(api: api, runID: "run-a", initial: .null, pollInterval: .zero)
        await store.observe()
        XCTAssertEqual(reads.count, 1)
        XCTAssertNil(store.status)
        XCTAssertNotNil(store.error)
        XCTAssertFalse(store.observing)
    }

    @MainActor func testWrongRunAndInvalidCountsNeverReplaceProgress() async throws {
        let reads = SpendingReadCounter()
        CoreMockURLProtocol.setHandler { request in
            let count = reads.next()
            var value = Self.run(status: "ready", completed: 20)
            if count == 1 { value["runId"] = "other-run" }
            else { value["completedCount"] = 21 }
            return try Self.response(request, value)
        }
        let api = try client(); defer { api.invalidate() }
        let initial = try JSONValue.decodeData(Self.run(status: "running", completed: 3))
        let store = AssistantSpendingRunStore(api: api, runID: "run-a", initial: initial, pollInterval: .zero)
        await store.observe()
        XCTAssertEqual(reads.count, 3)
        XCTAssertEqual(store.status, "running")
        XCTAssertEqual(store.run["completedCount"].intValue, 3)
        XCTAssertNotNil(store.error)
    }

    @MainActor func testLeavingStopsReadPolling() async throws {
        let read = expectation(description: "Initial progress read")
        let reads = SpendingReadCounter()
        CoreMockURLProtocol.setHandler { request in
            _ = reads.next(); read.fulfill()
            return try Self.response(request, Self.run(status: "running", completed: 0))
        }
        let api = try client(); defer { api.invalidate() }
        let store = AssistantSpendingRunStore(api: api, runID: "run-a", initial: .null, pollInterval: .seconds(30))
        let observation = Task { await store.observe() }
        await fulfillment(of: [read], timeout: 3)
        observation.cancel(); await observation.value
        XCTAssertFalse(store.observing)
        XCTAssertEqual(reads.count, 1)
    }

    @MainActor private func client() throws -> APIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [CoreMockURLProtocol.self]
        return try APIClient(baseURL: URL(string: "https://example.com")!, credentialStore: CoreMemoryCredentialStore(),
                             restoreSession: false, configuration: config)
    }
    private static func run(status: String, completed: Int) -> [String: Any] {
        ["runId": "run-a", "status": status, "eligibleCount": 20, "completedCount": completed,
         "startDate": "2026-11-01", "endDate": "2026-11-06", "canResume": false]
    }
    private static func response(_ request: URLRequest, _ value: [String: Any], status: Int = 200) throws -> (HTTPURLResponse, Data) {
        let response = try XCTUnwrap(HTTPURLResponse(url: XCTUnwrap(request.url), statusCode: status,
                                                  httpVersion: nil, headerFields: ["Content-Type": "application/json"]))
        return (response, try JSONSerialization.data(withJSONObject: value))
    }
}

private final class SpendingReadCounter {
    private let lock = NSLock()
    private var value = 0
    var count: Int { lock.lock(); defer { lock.unlock() }; return value }
    func next() -> Int { lock.lock(); defer { lock.unlock() }; value += 1; return value }
}

private extension JSONValue {
    static func decodeData(_ value: [String: Any]) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: JSONSerialization.data(withJSONObject: value))
    }
}
