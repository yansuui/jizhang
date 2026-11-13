import XCTest
@testable import Jizhang

final class PlanEditingTests: XCTestCase {
    override func tearDown() { CoreMockURLProtocol.setHandler(nil); super.tearDown() }

    func testExactDecimalInputRejectsRoundingAndUnsafeValues() {
        XCTAssertEqual(PlanInput.hundredths(" 12.30 "), 1230)
        XCTAssertEqual(PlanInput.hundredths("0.01"), 1)
        XCTAssertEqual(PlanInput.hundredths("90071992547409.91"), 9_007_199_254_740_991)
        for invalid in ["0.001", "-1", "+1", "1e3", "1,000", "１２", "1.", ".5", "NaN", "90071992547409.92"] {
            XCTAssertNil(PlanInput.hundredths(invalid), invalid)
        }
    }

    func testRatiosMustSumExactlyToTenThousandWithoutRounding() throws {
        let ratios = try XCTUnwrap(PlanInput.ratios([.growth: "25.01", .reserve: "14.99", .essentials: "50", .joy: "10"]))
        XCTAssertEqual(ratios.growth, 2501)
        XCTAssertEqual(ratios.reserve, 1499)
        XCTAssertNil(PlanInput.ratios([.growth: "25.001", .reserve: "15", .essentials: "50", .joy: "10"]))
        XCTAssertNil(PlanInput.ratios([.growth: "25", .reserve: "15", .essentials: "50", .joy: "10.01"]))
        XCTAssertNil(PlanInput.ratios([.growth: "101", .reserve: "0", .essentials: "0", .joy: "0"]))
    }

    func testConfigurationPayloadIsProspectiveCASAndKeepsServerTimezone() throws {
        let config = try Self.configuration()
        let request = PlanWriteRequest.configuration(config.config, ratios: Self.ratios)
        XCTAssertEqual(request.path, "/financial-funds/config")
        XCTAssertEqual(request.method, "PUT")
        XCTAssertNotNil(UUID(uuidString: request.operationId))
        XCTAssertEqual(request.body, .object([
            "operationId": .string(request.operationId), "expectedRevision": .integer(3),
            "timeZone": .string("Asia/Shanghai"), "ratiosBps": Self.ratios.planJSON
        ]))
    }

    func testNewIncomeUsesCanonicalSalaryContractWithoutLegacyTemplatesOrClientAllocationMath() {
        let request = PlanWriteRequest.salary(amount: 12_345, date: 1_793_836_800_000, accountId: "account-1", note: "工资", revision: 3)
        XCTAssertEqual(request.body, .object([
            "operationId": .string(request.operationId), "contractVersion": .integer(1),
            "expectedFundConfigRevision": .integer(3), "amountCents": .integer(12_345),
            "date": .integer(1_793_836_800_000), "accountId": .string("account-1"), "note": .string("工资")
        ]))
        XCTAssertEqual(request.path, "/salaries")
    }

    func testExistingGrantReviewKeepsFrozenRatioRevisionAndCurrentSourceTokens() throws {
        let source = PlanSalarySource(salaryId: "salary-1", amountCents: 10_000, date: 1_793_836_800_000,
                                      accountId: "account-1", sourceToken: "current-source-token")
        let oldRatios = LedgerPurposeAmounts(growth: 2000, reserve: 2000, essentials: 5000, joy: 1000)
        let request = PlanWriteRequest.review(sources: [source], ratios: oldRatios, revision: 7, grantId: "legacy-group:period-1")
        XCTAssertEqual(request.body["grantId"], .string("legacy-group:period-1"))
        XCTAssertEqual(request.body["expectedRevision"], .integer(7))
        XCTAssertEqual(request.body["ratiosBps"], oldRatios.planJSON)
        XCTAssertEqual(request.body["sources"], .array([.object(["salaryId": .string("salary-1"), "expectedSourceToken": .string("current-source-token")])]))
        let unallocated = PlanWriteRequest.review(sources: [source], ratios: Self.ratios, revision: 3)
        XCTAssertEqual(unallocated.body["grantId"], .null)
        XCTAssertEqual(unallocated.body["expectedRevision"], .integer(3))
    }

    @MainActor func testLostResponseRecoversCommittedOperationWithoutSecondIncomeWrite() async throws {
        let api = try makeClient()
        defer { api.invalidate() }
        let mutation = PlanMutation()
        let request = PlanWriteRequest.salary(amount: 10_000, date: 1_793_836_800_000, accountId: "account-1", note: "", revision: 3)
        var writes = 0
        CoreMockURLProtocol.setHandler { incoming in
            if incoming.httpMethod == "POST" { writes += 1; throw URLError(.timedOut) }
            XCTAssertEqual(incoming.url?.path, "/api/v1/financial-planning/operations/" + request.operationId)
            return try Self.response(incoming, json: """
            {"operationId":"\(request.operationId)","method":"POST","resource":"/api/v1/salaries","statusCode":201,"response":\(Self.salaryJSON),"committedAt":1793836800000}
            """)
        }
        let first = await mutation.submit(request, api: api)
        XCTAssertFalse(first)
        XCTAssertEqual(mutation.pending, request)
        XCTAssertEqual(api.ledgerRevision, 0)
        let recovered = await mutation.submit(request, api: api)
        XCTAssertTrue(recovered)
        XCTAssertEqual(writes, 1)
        XCTAssertNil(mutation.pending)
        XCTAssertEqual(api.ledgerRevision, 1)
    }

    @MainActor func testUnknownOperationReplaysIdenticalPayloadAndUUID() async throws {
        let api = try makeClient()
        defer { api.invalidate() }
        let mutation = PlanMutation()
        let request = PlanWriteRequest.configuration(try Self.configuration().config, ratios: Self.ratios)
        var sent: [JSONValue] = []
        CoreMockURLProtocol.setHandler { incoming in
            if incoming.httpMethod == "GET" { return try Self.response(incoming, status: 404, json: #"{"error":{"code":"FINANCIAL_NOT_FOUND"}}"#) }
            sent.append(try Self.body(incoming))
            if sent.count == 1 { throw URLError(.networkConnectionLost) }
            return try Self.response(incoming, json: Self.configJSON.replacingOccurrences(of: "\"revision\":3", with: "\"revision\":4"))
        }
        let first = await mutation.submit(request, api: api)
        XCTAssertFalse(first)
        let retried = await mutation.submit(request, api: api)
        XCTAssertTrue(retried)
        XCTAssertEqual(sent, [request.body, request.body])
        XCTAssertEqual(api.ledgerRevision, 1)
    }

    @MainActor func testRevisionConflictPreservesDraftAndRequiresExplicitRefresh() async throws {
        let api = try makeClient()
        defer { api.invalidate() }
        let state = PlanEditorState()
        state.ratios = [.growth: "30", .reserve: "10", .essentials: "50", .joy: "10"]
        state.amount = "999.12"
        CoreMockURLProtocol.setHandler { incoming in
            if incoming.httpMethod == "PUT" {
                return try Self.response(incoming, status: 409, json: #"{"error":{"code":"FINANCIAL_REVISION_CONFLICT"}}"#)
            }
            return try Self.response(incoming, json: Self.configJSON)
        }
        let saved = await state.mutation.submit(.configuration(try Self.configuration().config, ratios: Self.ratios), api: api)
        XCTAssertFalse(saved)
        XCTAssertTrue(state.mutation.conflict)
        XCTAssertNil(state.mutation.pending)
        XCTAssertEqual(api.ledgerRevision, 0)
        await state.load(api: api, needsAccounts: false)
        XCTAssertFalse(state.mutation.conflict)
        XCTAssertEqual(state.ratios[.growth], "30")
        XCTAssertEqual(state.amount, "999.12")
        XCTAssertEqual(state.config?.revision, 3)
    }

    @MainActor func testUnresolvedMutationRejectsChangedPayloadAndAnotherSession() async throws {
        let api = try makeClient()
        let another = try makeClient()
        defer { api.invalidate(); another.invalidate() }
        let mutation = PlanMutation()
        let request = PlanWriteRequest.configuration(try Self.configuration().config, ratios: Self.ratios)
        var requests = 0
        CoreMockURLProtocol.setHandler { _ in requests += 1; throw URLError(.timedOut) }
        _ = await mutation.submit(request, api: api)
        let changed = PlanWriteRequest.configuration(try Self.configuration().config, ratios: Self.ratios)
        let replaced = await mutation.submit(changed, api: api)
        let crossed = await mutation.submit(request, api: another)
        XCTAssertFalse(replaced)
        XCTAssertFalse(crossed)
        XCTAssertEqual(requests, 1)
        XCTAssertEqual(mutation.pending, request)
    }

    @MainActor func testInvalidatedSessionCannotPublishMutationSuccess() async throws {
        let api = try makeClient()
        api.invalidate()
        let mutation = PlanMutation()
        CoreMockURLProtocol.setHandler { _ in XCTFail("No request after invalidation"); throw URLError(.cancelled) }
        let saved = await mutation.submit(.configuration(try Self.configuration().config, ratios: Self.ratios), api: api)
        XCTAssertFalse(saved)
        XCTAssertEqual(api.ledgerRevision, 0)
        XCTAssertNil(mutation.result)
        XCTAssertNotNil(mutation.pending)
    }

    @MainActor func testRecoveryRecordForDifferentResourceDoesNotReleaseOrPublishSuccess() async throws {
        let api = try makeClient()
        defer { api.invalidate() }
        let mutation = PlanMutation()
        let request = PlanWriteRequest.configuration(try Self.configuration().config, ratios: Self.ratios)
        CoreMockURLProtocol.setHandler { incoming in
            if incoming.httpMethod == "PUT" { throw URLError(.timedOut) }
            return try Self.response(incoming, json: """
            {"operationId":"\(request.operationId)","method":"PUT","resource":"/api/v1/other","statusCode":200,"response":\(Self.configJSON)}
            """)
        }
        _ = await mutation.submit(request, api: api)
        let recovered = await mutation.submit(request, api: api)
        XCTAssertFalse(recovered)
        XCTAssertEqual(mutation.pending, request)
        XCTAssertEqual(api.ledgerRevision, 0)
    }

    func testHistoryReadsFrozenAllocationAndRejectsMalformedAmounts() throws {
        let salary = try JSONDecoder().decode(PlanSalary.self, from: Data(Self.salaryJSON.utf8))
        try salary.validate()
        XCTAssertEqual(salary.fundGrant?.statusTitle, "已确认")
        XCTAssertEqual(salary.fundGrant?.targets.reserve, 1500)
        XCTAssertEqual(salary.fundGrant?.canReconfirm, false)
        let bad = Self.salaryJSON.replacingOccurrences(of: #""targets":{"growth":2500"#, with: #""targets":{"growth":2499"#)
        let malformed = try JSONDecoder().decode(PlanSalary.self, from: Data(bad.utf8))
        XCTAssertThrowsError(try malformed.validate())
    }

    func testMigrationIssueQueueSeparatesActionableArchivedAndServerOnlyRows() throws {
        let page = try JSONDecoder().decode(PlanIssuePage.self, from: Data(Self.issuePageJSON.utf8))
        XCTAssertEqual(page.total, 6)
        XCTAssertEqual(Set(page.items.map(\.id)).count, page.items.count)
        XCTAssertEqual(page.items.map(\.canAllocate), [false, false, false, true, false, false])
        // Live bill/salary facts drive the balances, so open archival rows are not tasks.
        XCTAssertEqual(page.items.map(\.isArchived), [true, true, true, false, false, false])
        XCTAssertEqual(page.items.map(\.needsServerAttention), [false, false, false, false, false, true])
        XCTAssertEqual(page.items[3].source?.sourceToken, "token-1")
        XCTAssertNil(page.items[2].source)
        try page.items.compactMap(\.source).forEach { try $0.validate() }
    }

    func testPurposeAssignmentSendsTheGuardedCanonicalBody() {
        let facts = LedgerBillPurposeSnapshot.Facts(transactionId: "tx-1", transactionToken: "tok-1",
                                                    fundPurposeRevision: 4, fundPurpose: nil)
        let assignment = LedgerPurposeAssignment(transactionId: "tx-1", purpose: .reserve, facts: facts,
                                                 operationId: "op-1")
        XCTAssertEqual(assignment.body, .object([
            "operationId": .string("op-1"), "fundPurpose": .string("reserve"),
            "expectedFundPurposeRevision": .integer(4), "expectedTransactionToken": .string("tok-1")
        ]))
    }

    func testPurposeWriteAmbiguityFollowsTheHTTPStatus() {
        XCTAssertFalse(LedgerPurposeAssignment.isAmbiguous(APIError(status: 400, code: "X", message: "x")))
        XCTAssertFalse(LedgerPurposeAssignment.isAmbiguous(APIError(status: 409, code: "X", message: "x")))
        XCTAssertTrue(LedgerPurposeAssignment.isAmbiguous(APIError(status: 408, code: "X", message: "x")))
        XCTAssertTrue(LedgerPurposeAssignment.isAmbiguous(APIError(status: 503, code: "X", message: "x")))
        XCTAssertTrue(LedgerPurposeAssignment.isAmbiguous(APIError(status: 0, code: "TIMEOUT", message: "x")))
        XCTAssertTrue(LedgerPurposeAssignment.isAmbiguous(URLError(.timedOut)))
    }

    @MainActor func testUnclassifiedFilterMatchesTheSummaryRule() throws {
        let json = "[" + Self.billJSON(id: "a", purpose: nil) + ","
            + Self.billJSON(id: "b", purpose: "joy") + ","
            + Self.billJSON(id: "c", purpose: nil, refund: true) + "]"
        let rows = try JSONDecoder().decode([LedgerTransaction].self, from: Data(json.utf8))
        XCTAssertEqual(rows.filter(\.isUnclassifiedForFunds).map(\.id), ["a"])
    }

    @MainActor func testAssigningAPurposeForgetsTheBillAndRefreshesTheLedger() async throws {
        let api = try makeClient()
        defer { api.invalidate() }
        CoreMockURLProtocol.setHandler { incoming in
            let path = incoming.url?.path ?? ""
            if path.hasSuffix("/categories") || path.hasSuffix("/accounts") {
                return try Self.response(incoming, json: #"{"items":[]}"#)
            }
            if path.contains("/bill-purposes/tx-1") {
                return try Self.response(incoming, json: #"{"billPurpose":{"transactionId":"tx-1","transactionToken":"tok-1","fundPurposeRevision":0,"fundPurpose":null}}"#)
            }
            if path.hasSuffix("/transactions/tx-1") && incoming.httpMethod == "PATCH" {
                return try Self.response(incoming, json: Self.billJSON(id: "tx-1", purpose: "joy"))
            }
            if path.hasSuffix("/transactions") {
                let page = #"{"items":["# + Self.billJSON(id: "tx-1", purpose: nil) + ","
                    + Self.billJSON(id: "tx-2", purpose: "essentials") + #"],"total":2,"limit":100,"offset":0}"#
                return try Self.response(incoming, json: page)
            }
            XCTFail("Unexpected request " + path)
            throw URLError(.badServerResponse)
        }
        let store = LedgerUnclassifiedBillsStore()
        await store.reload(api: api)
        XCTAssertEqual(store.items.map(\.id), ["tx-1"])
        XCTAssertEqual(store.scanned, 2)
        XCTAssertFalse(store.hasMore)
        let bill = try XCTUnwrap(store.items.first)
        await store.assign(.joy, to: bill, api: api)
        XCTAssertTrue(store.items.isEmpty)
        XCTAssertTrue(store.rowErrors.isEmpty)
        XCTAssertTrue(store.needsRetry.isEmpty)
        XCTAssertEqual(api.ledgerRevision, 1)
    }

    @MainActor func testFundRecordsKeepOnlyThatPurposeAndReadItsFrozenShare() async throws {
        let api = try makeClient()
        defer { api.invalidate() }
        CoreMockURLProtocol.setHandler { incoming in
            let path = incoming.url?.path ?? ""
            if path.hasSuffix("/categories") || path.hasSuffix("/accounts") {
                return try Self.response(incoming, json: #"{"items":[]}"#)
            }
            if path == "/api/v1/salaries" {
                return try Self.response(incoming, json: #"{"items":[{"id":"salary-1","amountCents":10000,"date":1793836800000,"note":"工资","accountId":"account-1","updatedAt":1793836800000},{"id":"salary-2","amountCents":20000,"date":1793836700000,"note":"","accountId":"account-1","updatedAt":1793836700000}]}"#)
            }
            if path.hasPrefix("/api/v1/salaries/") {
                return try Self.response(incoming, json: Self.salaryJSON)
            }
            if path == "/api/v1/transactions" {
                let page = #"{"items":["# + Self.billJSON(id: "bill-1", purpose: "joy") + ","
                    + Self.billJSON(id: "bill-2", purpose: "growth") + #"],"total":2,"limit":100,"offset":0}"#
                return try Self.response(incoming, json: page)
            }
            XCTFail("Unexpected request " + path)
            throw URLError(.badServerResponse)
        }
        let store = LedgerFundRecordsStore(purpose: .joy)
        await store.load(api: api)
        XCTAssertEqual(store.bills.map(\.id), ["bill-1"])
        XCTAssertEqual(store.allocations.map(\.id), ["salary-1", "salary-2"])
        XCTAssertEqual(store.scanned, 2)
        XCTAssertFalse(store.hasMore)
        let allocation = try XCTUnwrap(store.allocations.first)
        await store.loadShare(for: allocation, api: api)
        // The list endpoint omits the grant; the frozen share comes from /salaries/:id.
        XCTAssertEqual(store.shares["salary-1"], 1000)
        XCTAssertEqual(store.sharesBps["salary-1"], 1000)
    }

    @MainActor func testAllocatingAnIncomeSplitsItWithoutCreatingASalaryRecord() async throws {
        let api = try makeClient()
        defer { api.invalidate() }
        var posted: JSONValue?
        CoreMockURLProtocol.setHandler { incoming in
            let path = incoming.url?.path ?? ""
            if path.hasSuffix("/financial-funds/config") {
                return try Self.response(incoming, json: Self.configJSON)
            }
            if path.contains("/financial-planning/bill-purposes/tx-income") {
                return try Self.response(incoming, json: #"{"billPurpose":{"transactionId":"tx-income","transactionToken":"tok-1","fundPurposeRevision":0,"fundPurpose":null}}"#)
            }
            if path == "/api/v1/financial-funds/income-allocations" && incoming.httpMethod == "POST" {
                posted = try Self.body(incoming)
                return try Self.response(incoming, json: #"{"contractVersion":1,"allocation":{"transactionId":"tx-income","revision":1,"amountCents":10000,"ratiosBps":{"growth":2500,"reserve":1500,"essentials":5000,"joy":1000},"targets":{"growth":2500,"reserve":1500,"essentials":5000,"joy":1000},"createdAt":1793836800000}}"#)
            }
            // A salary write here would mean the income was recorded as 工资.
            XCTFail("Unexpected request " + path)
            throw URLError(.badServerResponse)
        }
        let bill = try JSONDecoder().decode(LedgerTransaction.self, from: Data(Self.billJSON(
            id: "tx-income", purpose: nil, type: 1, amountCents: 10000).utf8))
        let store = LedgerIncomeAllocationStore()
        let done = await store.allocate(bill, api: api)
        XCTAssertTrue(done)
        XCTAssertEqual(api.ledgerRevision, 1)
        let body = try XCTUnwrap(posted)
        XCTAssertEqual(body["transactionId"], .string("tx-income"))
        XCTAssertEqual(body["expectedTransactionToken"], .string("tok-1"))
        XCTAssertEqual(body["expectedFundConfigRevision"], .integer(3))
        XCTAssertNotNil(body["operationId"].stringValue)
    }

    func testAllocationRequestFreezesGuardsForReplay() {
        let facts = LedgerBillPurposeSnapshot.Facts(transactionId: "tx-1", transactionToken: "tok-1",
                                                    fundPurposeRevision: 2, fundPurpose: nil)
        let request = LedgerIncomeAllocationRequest(transactionId: "tx-1", facts: facts,
                                                    configRevision: 4, operationId: "op-1")
        XCTAssertEqual(request.body, .object([
            "operationId": .string("op-1"), "transactionId": .string("tx-1"),
            "expectedTransactionToken": .string("tok-1"), "expectedFundConfigRevision": .integer(4)
        ]))
        XCTAssertFalse(LedgerIncomeAllocationRequest.isAmbiguous(APIError(status: 409, code: "X", message: "x")))
        XCTAssertTrue(LedgerIncomeAllocationRequest.isAmbiguous(APIError(status: 0, code: "TIMEOUT", message: "x")))
    }

    @MainActor func testOnlyUnconfirmedRefundsNeedAnAllocation() throws {
        let json = "[" + Self.billJSON(id: "r1", purpose: nil, refund: true, type: 1) + ","
            + Self.billJSON(id: "r2", purpose: nil, refund: true, type: 1, allocated: true) + ","
            + Self.billJSON(id: "i1", purpose: nil, type: 1) + "]"
        let rows = try JSONDecoder().decode([LedgerTransaction].self, from: Data(json.utf8))
        XCTAssertEqual(rows.filter(LedgerUnallocatedRefundStore.needsAllocation).map(\.id), ["r1"])
        XCTAssertTrue(rows[1].fundIncomeAllocated == true)
        XCTAssertNil(rows[2].fundIncomeAllocated)
    }

    @MainActor private func makeClient() throws -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [CoreMockURLProtocol.self]
        return try APIClient(baseURL: ServerAddress.parse("https://example.com"), credentialStore: CoreMemoryCredentialStore(), configuration: configuration)
    }

    private static func body(_ request: URLRequest) throws -> JSONValue {
        if let data = request.httpBody { return try JSONDecoder().decode(JSONValue.self, from: data) }
        let stream = try XCTUnwrap(request.httpBodyStream)
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 1024)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count > 0 else { break }
            data.append(contentsOf: buffer.prefix(count))
        }
        return try JSONDecoder().decode(JSONValue.self, from: data)
    }

    private static func response(_ request: URLRequest, status: Int = 200, json: String) throws -> (HTTPURLResponse, Data) {
        let response = try XCTUnwrap(HTTPURLResponse(url: XCTUnwrap(request.url), statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"]))
        return (response, Data(json.utf8))
    }

    private static func configuration() throws -> LedgerFundConfiguration {
        try JSONDecoder().decode(LedgerFundConfiguration.self, from: Data(configJSON.utf8))
    }
    private static let ratios = LedgerPurposeAmounts(growth: 2500, reserve: 1500, essentials: 5000, joy: 1000)
    private static let configJSON = #"{"contractVersion":1,"config":{"revision":3,"ratiosBps":{"growth":2500,"reserve":1500,"essentials":5000,"joy":1000},"timeZone":"Asia/Shanghai","updatedAt":1793836800000}}"#
    private static func billJSON(id: String, purpose: String?, refund: Bool = false, type: Int = 0,
                                 amountCents: Int = 1200, allocated: Bool = false) -> String {
        let purposeValue = purpose.map { "\"" + $0 + "\"" } ?? "null"
        let allocatedField = allocated ? "\"fundIncomeAllocated\":true," : ""
        return "{\"id\":\"\(id)\",\"type\":\(type),\"amountCents\":\(amountCents),"
            + "\"categoryId\":\"cat-1\",\"accountId\":\"account-1\",\"date\":1793836800000,"
            + "\"note\":\"账单\",\"tags\":[],\"isRefund\":\(refund ? "true" : "false"),"
            + "\"fundPurpose\":\(purposeValue),\(allocatedField)\"updatedAt\":1793836800000}"
    }
    private static let issuePageJSON = #"{"contractVersion":1,"total":6,"limit":50,"offset":0,"items":[{"sourceKind":"transaction","sourceId":"tx-1","reason":"unassigned","status":"open"},{"sourceKind":"period","sourceId":"period-1","reason":"unverified-group","status":"open"},{"sourceKind":"salary","sourceId":"salary-gone","reason":"unallocated","status":"open"},{"sourceKind":"salary","sourceId":"salary-2","reason":"unallocated","status":"open","source":{"salaryId":"salary-2","amountCents":10000,"date":1793836800000,"accountId":"account-1","sourceToken":"token-1"}},{"sourceKind":"salary","sourceId":"salary-done","reason":"unallocated","status":"resolved"},{"sourceKind":"config","sourceId":"3","reason":"invalid-current-config","status":"open"}]}"#
    private static let salaryJSON = #"{"id":"salary-1","amountCents":10000,"date":1793836800000,"note":"","accountId":"account-1","updatedAt":1793836800000,"fundGrant":{"grantId":"salary:salary-1","revision":1,"status":"active","sourceAmountCents":10000,"ratiosBps":{"growth":2500,"reserve":1500,"essentials":5000,"joy":1000},"targets":{"growth":2500,"reserve":1500,"essentials":5000,"joy":1000}}}"#
}
