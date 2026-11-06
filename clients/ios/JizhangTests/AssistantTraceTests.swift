import XCTest
@testable import Jizhang

/// The trace is diagnostic metadata. These tests pin the parts a user reads: duration,
/// status wording, failure emphasis and the "no reasoning, no ledger content" contract.
final class AssistantTraceTests: XCTestCase {

    private func entry(kind: String = "tool", status: String = "ok", toolName: String? = "spending.preview",
                       argumentSummary: String? = "startDate=2026-11-01", startedAt: Int64 = 1_000,
                       finishedAt: Int64? = 2_500) -> AssistantTraceEntry {
        AssistantTraceEntry(id: UUID().uuidString, step: 0, kind: kind, toolName: toolName,
                            argumentSummary: argumentSummary, status: status,
                            startedAt: startedAt, finishedAt: finishedAt)
    }

    func testToolStepTitleUsesToolName() {
        XCTAssertEqual(entry(toolName: "transactions.query").title, "transactions.query")
        XCTAssertEqual(entry(toolName: nil).title, "工具调用")
        XCTAssertEqual(entry(kind: "result", toolName: nil).title, "生成回复")
        XCTAssertEqual(entry(kind: "error", toolName: nil).title, "生成失败")
    }

    func testDurationIsSecondsFromMilliseconds() {
        XCTAssertEqual(entry(startedAt: 1_000, finishedAt: 2_500).duration ?? -1, 1.5, accuracy: 0.0001)
    }

    func testRunningStepHasNoDurationAndSaysSo() {
        let running = entry(status: "running", finishedAt: nil)
        XCTAssertNil(running.duration)
        XCTAssertTrue(running.isRunning)
        XCTAssertEqual(running.statusLabel, "进行中")
    }

    func testFailedStepIsMarkedForExpansion() {
        let failed = entry(status: "failed")
        XCTAssertTrue(failed.isFailed)
        XCTAssertFalse(failed.isRunning)
        XCTAssertEqual(failed.statusLabel, "失败")
    }

    func testCompletedStepShowsItsDuration() {
        XCTAssertEqual(entry(status: "ok", startedAt: 0, finishedAt: 840).statusLabel, "0.8s")
    }

    func testNegativeDurationIsRejected() {
        XCTAssertNil(entry(startedAt: 5_000, finishedAt: 1_000).duration)
    }

    func testDetailCarriesOnlyTheArgumentSummary() {
        XCTAssertEqual(entry(argumentSummary: "runId=r1").detail, "runId=r1")
        XCTAssertNil(entry(argumentSummary: nil).detail)
        XCTAssertNil(entry(argumentSummary: "").detail)
    }

    func testDecodesTheServerTracePayload() throws {
        let json = """
        {"items":[{"id":"a","step":0,"kind":"tool","toolName":"spending.preview",
        "argumentSummary":"runId=r1","status":"ok","startedAt":10,"finishedAt":20},
        {"id":"b","step":8,"kind":"error","toolName":null,"argumentSummary":"ASSISTANT_STREAM_BOUNDS",
        "status":"failed","startedAt":30,"finishedAt":31}]}
        """
        let decoded = try JSONDecoder().decode(AssistantTraceItems.self, from: Data(json.utf8))
        XCTAssertEqual(decoded.items.count, 2)
        XCTAssertEqual(decoded.items[0].toolName, "spending.preview")
        XCTAssertEqual(decoded.items[1].kind, "error")
        XCTAssertNil(decoded.items[1].toolName)
        XCTAssertTrue(decoded.items[1].isFailed)
    }

    func testDecodesWithoutOptionalFields() throws {
        let json = """
        {"items":[{"id":"a","step":0,"kind":"result","status":"ok","startedAt":10}]}
        """
        let decoded = try JSONDecoder().decode(AssistantTraceItems.self, from: Data(json.utf8))
        let only = try XCTUnwrap(decoded.items.first)
        XCTAssertNil(only.toolName)
        XCTAssertNil(only.argumentSummary)
        XCTAssertNil(only.finishedAt)
    }
}
