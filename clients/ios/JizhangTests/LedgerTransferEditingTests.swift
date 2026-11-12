import Foundation
import XCTest
@testable import Jizhang

final class LedgerTransferEditingTests: XCTestCase {
    private func account(_ id: String, _ name: String) throws -> LedgerAccount {
        try JSONDecoder().decode(LedgerAccount.self, from: Data(
            "{\"id\":\"\(id)\",\"name\":\"\(name)\",\"type\":1,\"initialBalanceCents\":0,\"isBuiltin\":false}".utf8))
    }

    func testBodyCarriesBothAccountsIntegerCentsAndEpochDate() throws {
        let accounts = [try account("cash", "现金"), try account("bank", "储蓄卡")]
        var draft = LedgerTransferDraft()
        draft.fromAccountId = "bank"
        draft.toAccountId = "cash"
        draft.amount = "12.34"
        draft.note = "搬钱"
        draft.date = Date(timeIntervalSince1970: 1_700_000_000)

        let body = try draft.body(usableAccounts: accounts)
        XCTAssertEqual(body["fromAccountId"].stringValue, "bank")
        XCTAssertEqual(body["toAccountId"].stringValue, "cash")
        XCTAssertEqual(body["amountCents"].intValue, 1_234)
        XCTAssertEqual(body["date"].intValue, 1_700_000_000_000)
        XCTAssertEqual(body["note"].stringValue, "搬钱")
        // A transfer is neither income nor expense: the body carries no type, category or refund.
        let keys = Set(body.objectValue?.keys.map { $0 } ?? [])
        XCTAssertEqual(keys, ["fromAccountId", "toAccountId", "amountCents", "date", "note"])
        XCTAssertEqual(body["type"], .null)
        XCTAssertEqual(body["categoryId"], .null)
    }

    func testBodyRefusesTheSameAccountAndDisabledAccounts() throws {
        let accounts = [try account("cash", "现金"), try account("bank", "储蓄卡")]
        var draft = LedgerTransferDraft()
        draft.amount = "1"
        draft.fromAccountId = "bank"
        draft.toAccountId = "bank"
        XCTAssertThrowsError(try draft.body(usableAccounts: accounts))
        draft.toAccountId = "removed"
        XCTAssertThrowsError(try draft.body(usableAccounts: accounts)) { error in
            XCTAssertEqual(error as? LedgerTransferEditError, .reusedAccount)
        }
        draft.toAccountId = "cash"
        draft.fromAccountId = ""
        XCTAssertThrowsError(try draft.body(usableAccounts: accounts))
        // The new-transfer form starts with an empty amount: it must be rejected locally, never
        // reported as an unconfirmed submission.
        draft.fromAccountId = "bank"
        draft.amount = ""
        XCTAssertThrowsError(try draft.body(usableAccounts: accounts))
        draft.amount = "0"
        XCTAssertThrowsError(try draft.body(usableAccounts: accounts))
    }

    func testExistingTransferRoundTripsBackIntoTheDraft() throws {
        let transfer = try JSONDecoder().decode(LedgerTransfer.self, from: Data("""
            {"id":"t1","fromAccountId":"bank","toAccountId":"cash","amountCents":123456,
             "date":1700000000000,"note":"搬钱","updatedAt":0}
            """.utf8))
        let draft = LedgerTransferDraft(transfer: transfer)
        XCTAssertEqual(draft.amount, "1234.56")
        XCTAssertEqual(draft.fromAccountId, "bank")
        XCTAssertEqual(draft.toAccountId, "cash")
        XCTAssertEqual(draft.note, "搬钱")
        XCTAssertEqual(LedgerBillDates.milliseconds(draft.date), 1_700_000_000_000)
    }
}
