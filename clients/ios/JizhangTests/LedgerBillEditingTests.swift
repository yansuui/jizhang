import XCTest
import SwiftUI
import UIKit
@testable import Jizhang

final class LedgerBillEditingTests: XCTestCase {
    override func tearDown() { BillTestProtocol.configure(nil); super.tearDown() }

    func testCentsAreExactAndRejectFractionalCentsScientificNotationAndOverflow() throws {
        XCTAssertEqual(try LedgerTransactionDraft.cents("0.01"), 1)
        XCTAssertEqual(try LedgerTransactionDraft.cents(" 123.4 "), 12_340)
        XCTAssertEqual(try LedgerTransactionDraft.cents("90071992547409.91"), 9_007_199_254_740_991)
        for invalid in ["0", "-1", "1e2", "1.001", "1.", ".5", "1,000", "90071992547409.92", "9223372036854775807"] {
            XCTAssertThrowsError(try LedgerTransactionDraft.cents(invalid), invalid)
        }
    }

    func testCalendarMonthAndInclusiveRangeRetainEveryOtherFilter() throws {
        let leapDay = try XCTUnwrap(LedgerBillDates.calendar.date(from: DateComponents(year: 2024, month: 2, day: 29, hour: 23)))
        let bounds = LedgerBillDates.month(containing: leapDay)
        XCTAssertEqual(LedgerFormat.dayKey(bounds.from), "2024-02-01")
        XCTAssertEqual(LedgerFormat.dayKey(bounds.to), "2024-03-01")
        XCTAssertEqual(bounds.to - bounds.from, 29 * 86_400_000)
        let day = try XCTUnwrap(LedgerBillDates.range(start: leapDay, end: leapDay))
        XCTAssertEqual(day.to - day.from, 86_400_000)
        XCTAssertEqual(LedgerFormat.dayKey(day.to - 1), "2024-02-29")
        XCTAssertNil(LedgerBillDates.range(start: leapDay.addingTimeInterval(86_400), end: leapDay))
        var query = LedgerBillQuery(text: "午饭 + 饮料", type: 0, accountId: "a+1", categoryId: "food", tag: "朋友")
        query.from = bounds.from; query.to = bounds.to
        query.accountId = "bank"
        let items = try XCTUnwrap(URLComponents(string: query.path(offset: 50))?.queryItems)
        let values = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(values["from"], String(bounds.from))
        XCTAssertEqual(values["to"], String(bounds.to))
        XCTAssertEqual(values["accountId"], "bank")
        XCTAssertEqual(values["search"], "午饭 + 饮料")
        XCTAssertEqual(values["type"], "0")
        XCTAssertEqual(values["categoryId"], "food")
        XCTAssertEqual(values["tag"], "朋友")
        XCTAssertEqual(values["offset"], "50")
        XCTAssertTrue(LedgerBillDates.isWholeMonth(query))
        query.from = bounds.from + 14 * 86_400_000
        XCTAssertFalse(LedgerBillDates.isWholeMonth(query), "A range ending on month end must retain its mid-month start when reopened")
    }

    @MainActor func testLinkedRefundCreatesIncomeOnceAndLeavesOriginalExpenseUntouched() async throws {
        let api = try client(); defer { api.invalidate() }
        let original = try transaction()
        let store = LedgerTransactionEditorStore(refundOf: original)
        let lock = NSLock()
        var writes = [[String: Any]]()
        BillTestProtocol.configure { transport in
            if transport.request.httpMethod == "POST" {
                let body = transport.body()
                lock.withLock { writes.append(body) }
                XCTAssertEqual(transport.request.url?.path, "/api/v1/transactions")
                XCTAssertEqual(transport.request.value(forHTTPHeaderField: "X-Requested-With"), "fetch")
                transport.respond(Self.row(id: "refund", refund: true))
            } else { Self.metadata(transport) }
        }
        await store.load(api: api)
        XCTAssertTrue(store.ready)
        store.draft.amount = "30.01"
        let saved = await store.save(api: api)
        let secondTap = await store.save(api: api)
        XCTAssertTrue(saved)
        XCTAssertFalse(secondTap)
        XCTAssertEqual(api.ledgerRevision, 1)
        let body = try XCTUnwrap(lock.withLock { writes.first })
        XCTAssertEqual(lock.withLock { writes.count }, 1)
        XCTAssertEqual(body["amountCents"] as? Int, 3001)
        XCTAssertEqual(body["type"] as? Int, 1)
        XCTAssertEqual(body["isRefund"] as? Bool, true)
        XCTAssertEqual(body["refundLinkedTxIds"] as? [String], [original.id])
        XCTAssertEqual(body["categoryId"] as? String, "refund-category")
        XCTAssertTrue(body["fundPurpose"] is NSNull)
        XCTAssertNotNil(UUID(uuidString: body["operationId"] as? String ?? ""))
        XCTAssertEqual(body["operationId"] as? String, (body["operationId"] as? String)?.lowercased())
        XCTAssertEqual(original.amountCents, 10_000)
        XCTAssertEqual(original.refundDetails?.first?.id, "refund")
    }

    @MainActor func testDoubleTapDuringRequestDoesNotSendASecondWrite() async throws {
        let api = try client(); defer { api.invalidate() }
        let store = LedgerTransactionEditorStore()
        let started = expectation(description: "Write pending")
        let lock = NSLock()
        var pending: BillTestProtocol?
        var writes = 0
        BillTestProtocol.configure { transport in
            if transport.request.httpMethod == "POST" {
                lock.withLock { pending = transport; writes += 1 }
                started.fulfill()
            } else { Self.metadata(transport) }
        }
        await store.load(api: api)
        store.draft.amount = "12.34"
        let first = Task { await store.save(api: api) }
        await fulfillment(of: [started], timeout: 3)
        let duplicate = await store.save(api: api)
        XCTAssertFalse(duplicate)
        XCTAssertEqual(api.ledgerRevision, 0)
        lock.withLock { pending }?.respond(Self.row())
        let committed = await first.value
        XCTAssertTrue(committed)
        XCTAssertEqual(lock.withLock { writes }, 1)
    }

    @MainActor func testEditUsesPurposeRevisionAndTransactionTokenAndKeepsRefundLinks() async throws {
        let api = try client(); defer { api.invalidate() }
        let refund = try transaction(refund: true)
        let store = LedgerTransactionEditorStore(transaction: refund)
        let lock = NSLock()
        var patch: [String: Any]?
        BillTestProtocol.configure { transport in
            let path = transport.request.url?.path ?? ""
            if transport.request.httpMethod == "PATCH" {
                lock.withLock { patch = transport.body() }
                transport.respond(Self.row(refund: true))
            } else if path.contains("/bill-purposes/") {
                transport.respond(["billPurpose": ["transactionId": "expense", "transactionToken": String(repeating: "a", count: 64),
                                                     "fundPurposeRevision": 7, "fundPurpose": NSNull()]])
            } else if path == "/api/v1/transactions/expense" { transport.respond(Self.row(refund: true)) }
            else { Self.metadata(transport) }
        }
        await store.load(api: api)
        store.draft.amount = "41.23"
        let saved = await store.save(api: api)
        XCTAssertTrue(saved)
        let body = try XCTUnwrap(lock.withLock { patch })
        XCTAssertEqual(body["expectedFundPurposeRevision"] as? Int, 7)
        XCTAssertEqual(body["expectedTransactionToken"] as? String, String(repeating: "a", count: 64))
        XCTAssertEqual(body["refundLinkedTxIds"] as? [String], ["original-expense"])
        XCTAssertEqual(body["amountCents"] as? Int, 4123)
    }

    @MainActor func testAmbiguousWriteSurvivesReopeningAndReconcilesWithoutNewPost() async throws {
        let api = try client(); defer { api.invalidate() }
        let lock = NSLock()
        var writes = 0
        var operationID = ""
        BillTestProtocol.configure { transport in
            if transport.request.httpMethod == "POST" {
                lock.withLock { writes += 1; operationID = transport.body()["operationId"] as? String ?? "" }
                transport.fail(URLError(.timedOut))
            } else if transport.request.url?.path.contains("/operations/") == true {
                transport.respond(["operationId": lock.withLock { operationID.lowercased() }, "method": "POST", "resource": "/api/v1/transactions",
                                   "statusCode": 201, "response": Self.row(), "committedAt": 1000])
            } else { Self.metadata(transport) }
        }
        let first = LedgerTransactionEditorStore()
        await first.load(api: api)
        first.draft.amount = "18.88"
        let failed = await first.save(api: api)
        XCTAssertFalse(failed)
        XCTAssertTrue(first.awaitingReconciliation)
        XCTAssertEqual(api.ledgerRevision, 0)
        let reopened = LedgerTransactionEditorStore()
        await reopened.load(api: api)
        XCTAssertTrue(reopened.awaitingReconciliation)
        XCTAssertEqual(reopened.draft.amount, "18.88")
        let blindRetry = await reopened.save(api: api)
        XCTAssertFalse(blindRetry)
        // Another API session cannot adopt the old account's unresolved write.
        let otherAPI = try client(); defer { otherAPI.invalidate() }
        await first.load(api: otherAPI)
        let wrongOwnerReplay = await first.save(api: otherAPI, retryPending: true)
        XCTAssertFalse(wrongOwnerReplay, "Reusing a store must never replay the first account's pending request in a new session")
        let other = LedgerTransactionEditorStore()
        await other.load(api: otherAPI)
        XCTAssertFalse(other.awaitingReconciliation)
        XCTAssertEqual(other.draft.amount, "")
        let recovered = await reopened.reconcile(api: api)
        XCTAssertTrue(recovered)
        XCTAssertEqual(lock.withLock { writes }, 1)
        XCTAssertEqual(api.ledgerRevision, 1)
    }

    @MainActor func testRefundFromInactiveAccountRequiresExplicitDestination() async throws {
        let api = try client(); defer { api.invalidate() }
        let store = LedgerTransactionEditorStore(refundOf: try transaction())
        let lock = NSLock()
        var writes = 0
        BillTestProtocol.configure { transport in
            if transport.request.httpMethod == "POST" {
                lock.withLock { writes += 1 }
                XCTAssertEqual(transport.body()["accountId"] as? String, "cash")
                var row = Self.row(refund: true); row["accountId"] = "cash"
                transport.respond(row)
            } else if transport.request.url?.path.hasSuffix("/accounts") == true {
                transport.respond(["items": [["id": "cash", "name": "现金", "type": 0, "initialBalanceCents": 0, "isBuiltin": true]]])
            } else { Self.metadata(transport) }
        }
        await store.load(api: api)
        XCTAssertEqual(store.draft.accountId, "bank")
        XCTAssertNotNil(store.error)
        store.draft.amount = "10.01"
        let rejected = await store.save(api: api)
        XCTAssertFalse(rejected)
        XCTAssertEqual(lock.withLock { writes }, 0)
        store.draft.accountId = "cash"
        let saved = await store.save(api: api)
        XCTAssertTrue(saved)
        XCTAssertEqual(lock.withLock { writes }, 1)
    }

    @MainActor func testConflictRefreshRetainsEditedFieldsAndUpdatesUntouchedFields() async throws {
        let api = try client(); defer { api.invalidate() }
        let store = LedgerTransactionEditorStore(transaction: try transaction())
        let lock = NSLock()
        var revision = 1
        var sent = [[String: Any]]()
        BillTestProtocol.configure { transport in
            let path = transport.request.url?.path ?? ""
            if transport.request.httpMethod == "PATCH" {
                let count = lock.withLock { sent.append(transport.body()); return sent.count }
                if count == 1 {
                    lock.withLock { revision = 2 }
                    transport.respond(["error": ["code": "FINANCIAL_SOURCE_CHANGED"]], status: 409)
                } else { transport.respond(Self.row()) }
            } else if path.contains("/bill-purposes/") {
                transport.respond(["billPurpose": ["transactionId": "expense", "transactionToken": String(repeating: "a", count: 64),
                                                     "fundPurposeRevision": lock.withLock { revision }, "fundPurpose": NSNull()]])
            } else if path == "/api/v1/transactions/expense" {
                var row = Self.row()
                if lock.withLock({ revision }) == 2 { row["amountCents"] = 20_000; row["note"] = "他端的新备注" }
                transport.respond(row)
            } else { Self.metadata(transport) }
        }
        await store.load(api: api)
        store.draft.note = "我的修改"
        let first = await store.save(api: api)
        XCTAssertFalse(first)
        XCTAssertFalse(store.ready)
        await store.load(api: api)
        XCTAssertTrue(store.ready)
        XCTAssertEqual(store.draft.note, "我的修改")
        XCTAssertEqual(store.draft.amount, "200.00")
        XCTAssertEqual(store.conflictSource?.note, "他端的新备注")
        let second = await store.save(api: api)
        XCTAssertTrue(second)
        let last = try XCTUnwrap(lock.withLock { sent.last })
        XCTAssertEqual(last["expectedFundPurposeRevision"] as? Int, 2)
        XCTAssertEqual(last["note"] as? String, "我的修改")
        XCTAssertEqual(last["amountCents"] as? Int, 20_000)
        XCTAssertEqual(api.ledgerRevision, 1)
    }

    @MainActor func testExplicitRetryFreezesOriginalPayloadAndOperationID() async throws {
        let api = try client(); defer { api.invalidate() }
        let store = LedgerTransactionEditorStore()
        let lock = NSLock()
        var payloads = [[String: Any]]()
        BillTestProtocol.configure { transport in
            if transport.request.httpMethod == "POST" {
                let count = lock.withLock { payloads.append(transport.body()); return payloads.count }
                if count == 1 { transport.fail(URLError(.networkConnectionLost)) }
                else { transport.respond(Self.row()) }
            } else { Self.metadata(transport) }
        }
        await store.load(api: api)
        store.draft.amount = "16.01"
        _ = await store.save(api: api)
        store.draft.amount = "99.99" // Even an accidental external binding edit cannot alter the replay.
        let replayed = await store.save(api: api, retryPending: true)
        XCTAssertTrue(replayed)
        let sent = lock.withLock { payloads }
        XCTAssertEqual(sent.count, 2)
        XCTAssertEqual(sent[0]["operationId"] as? String, sent[1]["operationId"] as? String)
        XCTAssertEqual(sent[1]["amountCents"] as? Int, 1601)
        XCTAssertEqual(api.ledgerRevision, 1)
    }

    @MainActor func testDefiniteValidationFailureKeepsDraftEditableWithoutPublishingSuccess() async throws {
        let api = try client(); defer { api.invalidate() }
        let store = LedgerTransactionEditorStore()
        BillTestProtocol.configure { transport in
            if transport.request.httpMethod == "POST" {
                transport.respond(["error": ["code": "VALIDATION"]], status: 400)
            } else { Self.metadata(transport) }
        }
        await store.load(api: api)
        store.draft.amount = "88.88"
        store.draft.note = "保留这份草稿"
        let saved = await store.save(api: api)
        XCTAssertFalse(saved)
        XCTAssertFalse(store.awaitingReconciliation)
        XCTAssertTrue(store.ready)
        XCTAssertEqual(store.draft.amount, "88.88")
        XCTAssertEqual(store.draft.note, "保留这份草稿")
        XCTAssertEqual(api.ledgerRevision, 0)
    }

    @MainActor func testCompactRefundEditorPreview() async throws {
        let ready = expectation(description: "Editor metadata loaded")
        ready.expectedFulfillmentCount = 2
        BillTestProtocol.configure { transport in Self.metadata(transport); ready.fulfill() }
        let api = try client(); defer { api.invalidate() }
        let expense = try transaction()
        try await capture("bill-refund-editor-compact", ready: ready) {
            LedgerTransactionEditor(api: api, refundOf: expense, onSaved: {})
        }
    }

    @MainActor func testCompactBillSheetPreview() async throws {
        let ready = expectation(description: "Bill detail loaded")
        BillTestProtocol.configure { transport in transport.respond(Self.row()); ready.fulfill() }
        let api = try client(); defer { api.invalidate() }
        try await capture("bill-detail-medium-sheet", ready: ready) {
            BillSheetPreview(api: api)
        }
    }

    /// The bill card is a centred modal overlay now (Android-parity), not a system sheet.
    /// This renders it for visual review against `TransactionDetailScreen.kt`.
    @MainActor func testCentredBillDetailOverlayPreview() async throws {
        let ready = expectation(description: "Bill detail loaded")
        BillTestProtocol.configure { transport in transport.respond(Self.row()); ready.fulfill() }
        let api = try client(); defer { api.invalidate() }
        try await capture("bill-detail-centred-overlay", ready: ready) {
            ZStack {
                Color(uiColor: .systemGroupedBackground)
                LedgerBillDetailOverlay(api: api, transactionID: "expense", metadata: .empty, onDismiss: {})
                    .ignoresSafeArea()
            }
        }
    }

    /// The daily totals row is server data. It must render the three authoritative figures,
    /// and must show placeholders rather than inventing numbers when a summary is missing.
    @MainActor func testDaySummaryHeaderPreview() async throws {
        let ready = expectation(description: "Header rendered")
        ready.fulfill()
        try await capture("bill-day-summary-header", ready: ready) {
            VStack(alignment: .leading, spacing: 12) {
                LedgerDaySummaryHeader(day: "2026-11-05",
                                       summary: LedgerDaySummary(day: "2026-11-05", expenseCents: 12_800,
                                                                incomeCents: 300_000, count: 4))
                LedgerDaySummaryHeader(day: "2026-11-04", summary: nil)
                LedgerDaySummaryHeader(day: "2026-11-03", summary: nil, summaryAvailable: false)
                Spacer()
            }
            .padding()
        }
    }

    @MainActor func testAccountAndDateFiltersWithLargeTextPreview() async throws {
        let ready = expectation(description: "Bill list and metadata loaded")
        ready.expectedFulfillmentCount = 3
        BillTestProtocol.configure { transport in
            if transport.request.url?.path == "/api/v1/transactions" {
                transport.respond(["items": [Self.row()], "total": 1, "limit": 50, "offset": 0])
            } else { Self.metadata(transport) }
            ready.fulfill()
        }
        let api = try client(); defer { api.invalidate() }
        try await capture("bill-account-date-filters-large", ready: ready) {
            NavigationStack { BillsView(api: api, initialQuery: LedgerBillQuery(accountId: "bank")) }
                .environment(\.dynamicTypeSize, .xxxLarge)
        }
    }

    @MainActor func testNewAccountQueryRejectsLateOldReadAndResetsPagination() async throws {
        let api = try client(); defer { api.invalidate() }
        let store = LedgerBillsStore()
        let started = expectation(description: "Old account page held")
        let lock = NSLock()
        var oldRead: BillTestProtocol?
        var queries = [[String: String]]()
        BillTestProtocol.configure { transport in
            if transport.request.url?.path == "/api/v1/transactions" {
                let items = URLComponents(url: transport.request.url!, resolvingAgainstBaseURL: false)?.queryItems ?? []
                let values = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
                lock.withLock { queries.append(values) }
                if values["accountId"] == "old" {
                    lock.withLock { oldRead = transport }
                    started.fulfill()
                } else {
                    let offset = Int(values["offset"] ?? "0") ?? 0
                    let rows = offset == 0 ? (0..<50).map { Self.row(id: "new-\($0)") } : [Self.row(id: "new-50")]
                    transport.respond(["items": rows, "total": 51, "limit": 50, "offset": offset, "searchVersion": 1, "searchRevision": "new"])
                }
            } else { Self.metadata(transport) }
        }
        let old = Task { await store.reload(api: api, query: LedgerBillQuery(accountId: "old")) }
        await fulfillment(of: [started], timeout: 3)
        let query = LedgerBillQuery(text: "咖啡", type: 0, accountId: "new", categoryId: "food", tag: "早餐", from: 1000, to: 2000)
        store.prepare(query: query)
        await store.reload(api: api, query: query)
        await store.next(api: api)
        lock.withLock { oldRead }?.respond(["items": [Self.row(id: "old")], "total": 1, "limit": 50, "offset": 0])
        await old.value
        XCTAssertEqual(store.items.count, 51)
        XCTAssertTrue(store.items.allSatisfy { $0.id.hasPrefix("new-") })
        let last = try XCTUnwrap(lock.withLock { queries.last })
        XCTAssertEqual(last["offset"], "50")
        XCTAssertEqual(last["accountId"], "new")
        XCTAssertEqual(last["from"], "1000")
        XCTAssertEqual(last["to"], "2000")
        XCTAssertEqual(last["search"], "咖啡")
        XCTAssertEqual(last["categoryId"], "food")
        XCTAssertEqual(last["tag"], "早餐")
    }

    @MainActor private func client() throws -> APIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [BillTestProtocol.self]
        return try APIClient(baseURL: URL(string: "https://bill-fixture.example")!, credentialStore: CoreMemoryCredentialStore(),
                             restoreSession: false, configuration: config)
    }

    @MainActor private func capture<Content: View>(_ name: String, ready: XCTestExpectation,
                                                  @ViewBuilder content: () -> Content) async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first { $0.isKeyWindow }
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        let controller = UIHostingController(rootView: content().tint(AppTheme.accent))
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer { window.isHidden = true; previous?.makeKeyAndVisible() }
        await fulfillment(of: [ready], timeout: 10)
        try await Task.sleep(nanoseconds: 500_000_000)
        window.layoutIfNeeded()
        let screenshot = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        let attachment = XCTAttachment(image: screenshot)
        attachment.name = name + "-synthetic-fixture"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func transaction(refund: Bool = false) throws -> LedgerTransaction {
        try JSONDecoder().decode(LedgerTransaction.self, from: JSONSerialization.data(withJSONObject: Self.row(refund: refund)))
    }

    fileprivate static func row(id: String = "expense", refund: Bool = false) -> [String: Any] {
        ["id": id, "type": refund ? 1 : 0, "amountCents": refund ? 3001 : 10000,
         "categoryId": refund ? "refund-category" : "food", "accountId": "bank", "date": 1704038400000 as Int64,
         "note": "测试账单", "tags": ["测试"], "isRefund": refund, "fundPurpose": NSNull(), "updatedAt": 1000,
         "refundLinkedTxIds": refund ? ["original-expense"] : [],
         "refundSummary": ["totalRefundCents": 3001, "refundCount": 1],
         "refundDetails": refund ? [] : [["id": "refund", "amountCents": 3001, "date": 1704038400000 as Int64, "note": "退款"]]]
    }

    fileprivate static func metadata(_ transport: BillTestProtocol) {
        if transport.request.url?.path.hasSuffix("/categories") == true {
            transport.respond(["items": [
                ["id": "food", "name": "餐饮", "type": 0, "parentId": NSNull(), "icon": "", "color": 0, "isBuiltin": true],
                ["id": "refund-category", "name": "退款", "type": 1, "parentId": NSNull(), "icon": "", "color": 0, "isBuiltin": true]]])
        } else if transport.request.url?.path.hasSuffix("/accounts") == true {
            transport.respond(["items": [["id": "bank", "name": "银行卡", "type": 1, "initialBalanceCents": 0, "isBuiltin": false]]])
        } else { transport.respond(["error": ["code": "NOT_FOUND"]], status: 404) }
    }
}

@MainActor private struct BillSheetPreview: View {
    let api: APIClient
    var body: some View {
        Color(uiColor: .systemGroupedBackground).sheet(isPresented: .constant(true)) {
            LedgerBillDetailSheet(api: api, transactionID: "expense", metadata: .empty)
        }
    }
}

/// Held responses exercise real APIClient ownership and in-flight gates without timing sleeps.
private final class BillTestProtocol: URLProtocol {
    private static let lock = NSLock()
    private static var handler: ((BillTestProtocol) -> Void)?
    static func configure(_ value: ((BillTestProtocol) -> Void)?) { lock.withLock { handler = value } }
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "bill-fixture.example" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        if let callback = Self.lock.withLock({ Self.handler }) { callback(self) }
        else { fail(URLError(.badServerResponse)) }
    }
    override func stopLoading() {}
    func fail(_ error: Error) { client?.urlProtocol(self, didFailWithError: error) }
    func respond(_ object: Any, status: Int = 200) {
        do {
            let response = try XCTUnwrap(HTTPURLResponse(url: XCTUnwrap(request.url), statusCode: status, httpVersion: nil,
                                                       headerFields: ["Content-Type": "application/json"]))
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: try JSONSerialization.data(withJSONObject: object))
            client?.urlProtocolDidFinishLoading(self)
        } catch { fail(error) }
    }
    func body() -> [String: Any] {
        var data = request.httpBody ?? Data()
        if data.isEmpty, let stream = request.httpBodyStream {
            stream.open(); defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 1024)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }
                data.append(contentsOf: buffer.prefix(count))
            }
        }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }
}
