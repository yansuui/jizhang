import XCTest
@testable import Jizhang

/// Result cards must read like the rest of the ledger: names instead of UUIDs,
/// yuan instead of cents, dates instead of epoch counters, and no revision or
/// token fields. The transport object is still decoded, just not dumped.
final class AssistantResultPresentationTests: XCTestCase {
    private let dateMilliseconds: Int64 = 1_793_980_800_000 // 2026-11-07 00:00 Asia/Shanghai

    private func json(_ object: [String: Any]) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: JSONSerialization.data(withJSONObject: object))
    }

    private func metadata() throws -> LedgerMetadata {
        func decode<Value: Decodable>(_ object: [String: Any], as: Value.Type) throws -> Value {
            try JSONDecoder().decode(Value.self, from: JSONSerialization.data(withJSONObject: object))
        }
        let category: LedgerCategory = try decode(["id": "builtin-expense-food", "name": "餐饮", "type": 0,
            "parentId": NSNull(), "icon": "fork.knife", "color": 0, "isBuiltin": true], as: LedgerCategory.self)
        let account: LedgerAccount = try decode(["id": "account-wechat", "name": "微信", "type": 4,
            "initialBalanceCents": 0, "isBuiltin": false], as: LedgerAccount.self)
        return LedgerMetadata(categories: [category], accounts: [account])
    }

    private func transactionObject() -> [String: Any] {
        ["id": "tx-1", "type": 0, "amountCents": 1800, "categoryId": "builtin-expense-food",
         "accountId": "account-wechat", "date": dateMilliseconds, "note": "猪肘饭", "tags": ["午饭"],
         "isRefund": false, "financialPurpose": NSNull(), "financialPurposeRevision": 0,
         "fundPurpose": "essentials", "fundPurposeRevision": 0, "fundPurposeStatus": "unresolved",
         "fundPurposeSource": "unresolved", "updatedAt": dateMilliseconds]
    }

    private func transactionValue() throws -> JSONValue {
        try json(transactionObject())
    }

    func testReceiptDecodesTheWriteResult() throws {
        let value = AssistantResultPresentation.transaction(from: .object(["transaction": try transactionValue()]))
        let receipt = try XCTUnwrap(value)
        XCTAssertEqual(receipt.id, "tx-1")
        XCTAssertEqual(receipt.note, "猪肘饭")
        XCTAssertEqual(receipt.fundPurpose, LedgerPurpose.essentials)
        XCTAssertEqual(receipt.amountCents, 1800)
    }

    func testReadPageKeepsOnlyCompleteTransactionDecodes() throws {
        let page = JSONValue.object(["total": .integer(1), "items": .array([try transactionValue()])])
        XCTAssertEqual(AssistantResultPresentation.transactions(from: page)?.first?.id, "tx-1")
        let mixed = JSONValue.object(["items": .array([try transactionValue(), .object(["id": .string("not-a-bill")])])])
        XCTAssertNil(AssistantResultPresentation.transactions(from: mixed))
    }

    func testMachineFieldsNeverBecomeVisibleRows() {
        for key in ["fundPurposeRevision", "fundPurposeStatus", "fundPurposeSource", "financialPurposeRevision",
                    "updatedAt", "operationId", "expectedTransactionToken", "fingerprint"] {
            XCTAssertTrue(AssistantPreviewFormat.isInternal(key), key)
        }
        XCTAssertFalse(AssistantPreviewFormat.isInternal("fundPurpose"))
        XCTAssertFalse(AssistantPreviewFormat.isInternal("amountCents"))
        XCTAssertEqual(AssistantPreviewFormat.ordered(["fundPurposeRevision", "amountCents", "note", "type", "date"]),
                       ["type", "amountCents", "date", "note"])
    }

    func testScalarsReadAsPeopleReadThem() throws {
        let names = try metadata()
        XCTAssertEqual(AssistantPreviewFormat.scalar(.integer(dateMilliseconds), key: "date"), "2026年11月7日")
        XCTAssertEqual(AssistantPreviewFormat.scalar(.integer(1800), key: "amountCents"), "¥18.00")
        XCTAssertEqual(AssistantPreviewFormat.scalar(.string("essentials"), key: "fundPurpose"), "日常必要")
        XCTAssertEqual(AssistantPreviewFormat.scalar(.string("builtin-expense-food"), key: "categoryId", metadata: names), "餐饮")
        XCTAssertEqual(AssistantPreviewFormat.scalar(.string("account-wechat"), key: "accountId", metadata: names), "微信")
        XCTAssertEqual(AssistantPreviewFormat.scalar(.string("confirmed"), key: "status"), "已确认")
        XCTAssertEqual(AssistantPreviewFormat.scalar(.null, key: "fundPurpose"), "未设置")
    }

    func testOnlyAnIdentifierResultHasNoCard() throws {
        XCTAssertTrue(AssistantResultPresentation.isTrivial(try json(["id": "tx-1", "deleted": true])))
        XCTAssertFalse(AssistantResultPresentation.isTrivial(try json(["id": "tx-1", "note": "猪肘饭"])))
        let wrapper = JSONValue.object(["category": .object(["id": .string("c-1"), "name": .string("餐饮"), "type": .integer(0)])])
        XCTAssertEqual(AssistantResultPresentation.primaryObject(from: wrapper)?.objectValue?["name"]?.stringValue, "餐饮")
    }

    func testWrappedFactsDropThePageEnvelope() throws {
        let page = JSONValue.object(["total": .integer(8), "offset": .integer(0), "limit": .integer(30),
                                     "hasMore": .bool(true),
                                     "items": .array([try transactionValue()]),
                                     "notice": .string("本页展示 1 项")])
        let facts = AssistantResultPresentation.facts(page)
        XCTAssertNil(facts["total"].intValue)
        XCTAssertNil(facts["items"].arrayValue)
        XCTAssertEqual(facts["notice"].stringValue, "本页展示 1 项")
    }
}
