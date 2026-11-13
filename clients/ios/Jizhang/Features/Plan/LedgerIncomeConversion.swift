import SwiftUI

/// Converting a recorded income bill into a 收入分配: the server creates the frozen ratio grant,
/// then the bill is deleted so the same money is not counted twice. The request identity is
/// retained across attempts, so a retry replays the original operation instead of granting again.
@MainActor enum LedgerIncomeConversions {
    struct Pending {
        let operationId: String
        let body: JSONValue
        var salaryCreated: Bool
    }

    private static var records: [UUID: [String: Pending]] = [:]

    static func pending(api: APIClient, billId: String) -> Pending? { records[api.identity]?[billId] }
    static func store(_ value: Pending, api: APIClient, billId: String) {
        records[api.identity, default: [:]][billId] = value
    }
    static func clear(api: APIClient, billId: String) { records[api.identity]?[billId] = nil }
}

/// Owns the two-step conversion for whichever surface starts it (the unclassified list or a bill
/// detail card). One shared state machine keeps a half-finished conversion resumable from either.
@MainActor final class LedgerIncomeConverter: ObservableObject {
    @Published private(set) var busyId: String?
    @Published private(set) var errors: [String: String] = [:]
    @Published private(set) var needsRetry: Set<String> = []

    func convert(_ bill: LedgerTransaction, api: APIClient) async -> Bool {
        guard busyId == nil, bill.type == .income, !bill.isRefund else { return false }
        busyId = bill.id
        errors[bill.id] = nil
        defer { busyId = nil }
        if let retained = LedgerIncomeConversions.pending(api: api, billId: bill.id) {
            return await finish(retained, bill: bill, api: api)
        }
        do {
            let config: LedgerFundConfiguration = try await api.request("/financial-funds/config")
            try config.validate()
            let request = PlanWriteRequest.salary(amount: bill.amountCents, date: bill.date,
                                                  accountId: bill.accountId, note: bill.note,
                                                  revision: config.config.revision)
            let pending = LedgerIncomeConversions.Pending(operationId: request.operationId,
                                                          body: request.body, salaryCreated: false)
            LedgerIncomeConversions.store(pending, api: api, billId: bill.id)
            return await finish(pending, bill: bill, api: api)
        } catch is CancellationError {
            return false
        } catch {
            errors[bill.id] = error.localizedDescription
            return false
        }
    }

    private func finish(_ pending: LedgerIncomeConversions.Pending, bill: LedgerTransaction,
                        api: APIClient) async -> Bool {
        var state = pending
        if !state.salaryCreated {
            do {
                let salary: PlanSalary = try await api.request("/salaries", method: "POST", body: state.body)
                try salary.validate()
                guard salary.amountCents == bill.amountCents, salary.date == bill.date,
                      salary.accountId == bill.accountId, salary.fundGrant != nil else {
                    throw LedgerDataError.invalidResponse
                }
                state.salaryCreated = true
                LedgerIncomeConversions.store(state, api: api, billId: bill.id)
            } catch is CancellationError {
                return false
            } catch {
                if LedgerPurposeAssignment.isAmbiguous(error) {
                    needsRetry.insert(bill.id)
                    errors[bill.id] = "收入分配结果尚未确认。请点「重试」用同一请求核实，不会重复记入。"
                } else {
                    LedgerIncomeConversions.clear(api: api, billId: bill.id)
                    errors[bill.id] = error.localizedDescription
                }
                return false
            }
        }
        do {
            let _: EmptyResponse = try await api.request("/transactions/" + LedgerURL.segment(bill.id),
                                                         method: "DELETE")
        } catch let failure as APIError where failure.status == 404 {
            // Already removed by the previous attempt; the conversion is complete.
        } catch is CancellationError {
            return false
        } catch {
            needsRetry.insert(bill.id)
            errors[bill.id] = "收入分配已生成，但原账单还没删除。请重试删除，否则同一笔钱会被算两次。"
            return false
        }
        LedgerIncomeConversions.clear(api: api, billId: bill.id)
        needsRetry.remove(bill.id)
        api.notifyLedgerChanged()
        return true
    }
}
