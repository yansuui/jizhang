import SwiftUI
import Combine

enum LedgerTransferEditError: LocalizedError, Equatable {
    case missingFromAccount, missingToAccount, sameAccount, notEnoughAccounts, reusedAccount
    var errorDescription: String? {
        switch self {
        case .missingFromAccount: return "请选择转出账户。"
        case .missingToAccount: return "请选择转入账户。"
        case .sameAccount: return "转出和转入账户不能相同。"
        case .notEnoughAccounts: return "至少需要两个可用账户才能转账。"
        case .reusedAccount: return "转账账户已停用，请重新选择。"
        }
    }
}

struct LedgerTransferDraft: Equatable {
    var fromAccountId = ""
    var toAccountId = ""
    var amount = ""
    var date = Date()
    var note = ""

    init(transfer: LedgerTransfer? = nil) {
        guard let transfer else { return }
        fromAccountId = transfer.fromAccountId
        toAccountId = transfer.toAccountId
        amount = LedgerTransactionDraft.amountText(transfer.amountCents)
        date = Date(timeIntervalSince1970: Double(transfer.date) / 1_000)
        note = transfer.note
    }

    /// A transfer is neither income nor expense, so it only carries two accounts, an amount,
    /// a date and a note. The server remains authoritative for both accounts being usable.
    func body(usableAccounts: [LedgerAccount]) throws -> JSONValue {
        guard !fromAccountId.isEmpty else { throw LedgerTransferEditError.missingFromAccount }
        guard !toAccountId.isEmpty else { throw LedgerTransferEditError.missingToAccount }
        guard fromAccountId != toAccountId else { throw LedgerTransferEditError.sameAccount }
        guard usableAccounts.contains(where: { $0.id == fromAccountId }),
              usableAccounts.contains(where: { $0.id == toAccountId }) else { throw LedgerTransferEditError.reusedAccount }
        return .object([
            "fromAccountId": .string(fromAccountId),
            "toAccountId": .string(toAccountId),
            "amountCents": .integer(try LedgerTransactionDraft.cents(amount)),
            "date": .integer(LedgerBillDates.milliseconds(date)),
            "note": .string(note)
        ])
    }
}

/// `/transfers` has no idempotency key, so a save is attempted exactly once per explicit tap and
/// an unconfirmed result is never retried blindly: a second POST would move the money again.
@MainActor final class LedgerTransferEditorStore: ObservableObject {
    @Published var draft: LedgerTransferDraft
    @Published private(set) var accounts: [LedgerAccount] = []
    @Published private(set) var loading = false
    @Published private(set) var ready = false
    @Published private(set) var saving = false
    @Published private(set) var error: String?
    /// Set when the outcome is unknown. `/transfers` has no operation ID, so the only safe
    /// recovery is to read the list: re-submitting the frozen body could move the money twice.
    @Published private(set) var needsVerification = false
    private let transfer: LedgerTransfer?
    private var owner: UUID?
    private var generation = 0
    private var committed = false

    init(transfer: LedgerTransfer? = nil) {
        self.transfer = transfer
        draft = LedgerTransferDraft(transfer: transfer)
    }

    func load(api: APIClient) async {
        guard !saving, owner == nil || owner == api.identity else { return }
        owner = api.identity
        generation += 1
        let ticket = generation
        loading = true
        ready = false
        error = nil
        defer { if ticket == generation { loading = false } }
        do {
            let page: LedgerPage<LedgerAccount> = try await api.request("/accounts")
            guard owner == api.identity, generation == ticket, !Task.isCancelled else { return }
            accounts = page.items
            try prepareSelection()
            ready = true
        } catch {
            guard owner == api.identity, generation == ticket, !Task.isCancelled else { return }
            self.error = error.localizedDescription
        }
    }

    func save(api: APIClient) async -> Bool {
        guard owner == api.identity, !saving, ready, !committed, !needsVerification else { return false }
        error = nil
        // Local validation happens before any request, so a rejected draft can never be an
        // unconfirmed submission — the form must stay editable.
        let body: JSONValue
        do {
            body = try draft.body(usableAccounts: accounts)
        } catch {
            self.error = error.localizedDescription
            return false
        }
        saving = true
        defer { saving = false }
        do {
            let result: LedgerTransfer
            if let transfer {
                result = try await api.request("/transfers/" + LedgerURL.segment(transfer.id),
                                               method: "PATCH", body: body)
            } else {
                result = try await api.request("/transfers", method: "POST", body: body)
            }
            try Task.checkCancellation()
            guard owner == api.identity else { return false }
            guard !result.id.isEmpty else { throw LedgerDataError.invalidResponse }
            committed = true
            api.notifyLedgerChanged()
            return true
        } catch {
            // A rejection cannot have committed; an unknown outcome must be confirmed by the user.
            if let failure = error as? APIError, (400..<500).contains(failure.status), failure.status != 408 {
                self.error = error.localizedDescription
            } else {
                needsVerification = true
                // Refresh the list behind the sheet: the only honest way to find out whether the
                // write landed is to re-read it, and a stale list invites a duplicate transfer.
                api.notifyLedgerChanged()
                self.error = "提交结果尚未确认。请关闭后到「账户转账」列表（可下拉刷新）核对；确认没有这笔转账后，重新打开编辑再提交，避免重复转账。"
            }
            return false
        }
    }

    private func prepareSelection() throws {
        if transfer == nil {
            if !accounts.contains(where: { $0.id == draft.fromAccountId }) {
                draft.fromAccountId = accounts.first?.id ?? ""
            }
            if !accounts.contains(where: { $0.id == draft.toAccountId }) || draft.toAccountId == draft.fromAccountId {
                draft.toAccountId = accounts.first { $0.id != draft.fromAccountId }?.id ?? ""
            }
        }
        guard accounts.count >= 2 else { throw LedgerTransferEditError.notEnoughAccounts }
    }
}

@MainActor struct LedgerTransferEditor: View {
    let api: APIClient
    let onSaved: () -> Void
    private let editing: Bool
    @Environment(\.dismiss) private var dismiss
    @StateObject private var store: LedgerTransferEditorStore

    init(api: APIClient, transfer: LedgerTransfer? = nil, onSaved: @escaping () -> Void) {
        self.api = api
        self.onSaved = onSaved
        editing = transfer != nil
        _store = StateObject(wrappedValue: LedgerTransferEditorStore(transfer: transfer))
    }

    private var blocked: Bool { store.loading || store.saving || !store.ready || store.needsVerification }

    var body: some View {
        NavigationStack {
            Form {
                if store.loading { ProgressView("正在读取账户…") }
                if let error = store.error {
                    Section {
                        Text(error).font(.subheadline).foregroundStyle(.red)
                        if !store.ready && !store.loading {
                            Button("重新读取") { Task { await store.load(api: api) } }
                        }
                    }
                }
                Group {
                    Section {
                        HStack(alignment: .firstTextBaseline) {
                            Text("¥").font(.title2)
                            TextField("0.00", text: $store.draft.amount)
                                .font(.system(.largeTitle, design: .rounded).weight(.semibold))
                                .keyboardType(.decimalPad).monospacedDigit()
                                .accessibilityLabel("转账金额，单位元")
                        }.padding(.vertical, 8)
                    }
                    Section("转账账户") {
                        Picker("转出账户", selection: $store.draft.fromAccountId) {
                            accountOption(store.draft.fromAccountId, placeholder: "请选择转出账户")
                            ForEach(store.accounts) { Text($0.name).tag($0.id) }
                        }
                        Picker("转入账户", selection: $store.draft.toAccountId) {
                            accountOption(store.draft.toAccountId, placeholder: "请选择转入账户")
                            ForEach(store.accounts) { Text($0.name).tag($0.id) }
                        }
                    }
                    Section("转账信息") {
                        DatePicker("日期", selection: $store.draft.date, displayedComponents: [.date, .hourAndMinute])
                            .environment(\.timeZone, LedgerBillDates.calendar.timeZone)
                        TextField("备注（选填）", text: $store.draft.note, axis: .vertical).lineLimit(2...5)
                    }
                    Section {
                        Text("转账只改变两个账户的余额，不计为收入或支出。")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    if store.needsVerification {
                        Section("待核对的提交") {
                            Text("这份转账已冻结。请关闭后到「账户转账」列表核对是否已经生效。")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                    if !store.needsVerification {
                        Section {
                            Button { save() } label: {
                                HStack {
                                    Spacer()
                                    if store.saving { ProgressView() } else { Text(editing ? "保存修改" : "保存转账").bold() }
                                    Spacer()
                                }.padding(.vertical, 6)
                            }.disabled(blocked)
                        }
                    }
                }.disabled(blocked)
            }
            .navigationTitle(editing ? "编辑转账" : "账户转账")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }.disabled(store.saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") { save() }.disabled(blocked)
                }
            }
            .interactiveDismissDisabled(store.saving)
            .task { await store.load(api: api) }
        }
    }

    /// The picker must still show a label for a disabled account rather than an empty selection.
    @ViewBuilder private func accountOption(_ id: String, placeholder: String) -> some View {
        if !store.accounts.contains(where: { $0.id == id }) {
            Text(id.isEmpty ? placeholder : "保留原账户（已停用）").tag(id)
        }
    }

    private func save() { Task { if await store.save(api: api) { onSaved(); dismiss() } } }
}
