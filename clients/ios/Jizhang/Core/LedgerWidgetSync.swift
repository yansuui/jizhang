import Foundation
import SwiftUI
import WidgetKit

/// Publishes the aggregates the home-screen widgets show.
///
/// The widgets never own a session, read the database or see bill rows. After a successful read the
/// app copies the authoritative server totals into the shared App Group container and asks WidgetKit
/// to reload; a failed read keeps the previous snapshot instead of writing zeros.
@MainActor
final class LedgerWidgetSync {
    static let shared = LedgerWidgetSync()

    private let store: LedgerWidgetSnapshotStore
    private let reload: () -> Void
    private let now: () -> Date
    /// Bumped whenever this account's snapshot is removed. An in-flight read captured an older
    /// value and must not write the signed-out account back onto the Home Screen afterwards.
    private var generation = 0

    init(store: LedgerWidgetSnapshotStore = .shared,
         reload: @escaping () -> Void = { WidgetCenter.shared.reloadAllTimelines() },
         now: @escaping () -> Date = { Date() }) {
        self.store = store
        self.reload = reload
        self.now = now
    }

    var isAvailable: Bool { store.isAvailable }

    var snapshot: LedgerWidgetSnapshot? { store.load() }

    /// The snapshot may be reused across launches for one account, but never across accounts. A
    /// legacy server without an immutable user id falls back to the session identity, which is
    /// stricter (a fresh key each launch) rather than mixing two accounts.
    static func ownerKey(api: APIClient, userID: String) -> String {
        let server = api.baseURL.absoluteString.lowercased()
        let user = userID.trimmingCharacters(in: .whitespacesAndNewlines)
        return user.isEmpty ? server + "|session:" + api.identity.uuidString : server + "|" + user
    }

    /// Reads the three aggregate endpoints and writes the merged snapshot. Returns true only when a
    /// new snapshot replaced the stored one (the status view and the tests rely on that distinction).
    /// Nothing is read when this signature has no App Group container: the widget could never see
    /// the result, so the widget refresh must not add three pointless requests.
    @discardableResult
    func refresh(api: APIClient, userID: String) async -> Bool {
        guard store.isAvailable else { return false }
        let key = Self.ownerKey(api: api, userID: userID)
        let stored = store.load()
        if let stored, stored.ownerKey != key {
            // Another account's file must also disappear from the Home Screen immediately, not only
            // after a later successful write.
            clear()
        }
        let ticket = generation
        var snapshot = (stored?.ownerKey == key ? stored : nil)
            ?? LedgerWidgetSnapshot(ownerKey: key, updatedAt: milliseconds())
        var applied = 0

        if let balances: LedgerBalances = await fetch("/accounts/balances", api: api) {
            snapshot.apply(balances)
            applied += 1
        }
        if Task.isCancelled { return false }
        if let trend: LedgerTrend = await fetch("/stats/monthly-trend?months=1", api: api) {
            snapshot.apply(trend)
            applied += 1
        }
        if Task.isCancelled { return false }
        if let summary = await fetchSummary(api: api) {
            snapshot.apply(summary)
            applied += 1
        }
        guard applied > 0 else { return false }
        // A logout, 401 or account switch that happened while these reads were in flight owns the
        // newer state: never republish the older account's money.
        guard ticket == generation, !Task.isCancelled else { return false }
        snapshot.updatedAt = milliseconds()
        guard store.save(snapshot) else { return false }
        reload()
        return true
    }

    /// Signing out or losing the session ends that account's snapshot; leaving it behind would show
    /// a previous account's money on the Home Screen.
    func clear() {
        generation &+= 1
        store.clear()
        // Without a container there is no file the extension could read, so there is nothing to
        // reload. Asking WidgetKit anyway would wake an extension that has no data (and does so in
        // the unsigned simulator test host, where no App Group is available).
        guard store.isAvailable else { return }
        reload()
    }

    private func fetch<Value: Decodable>(_ path: String, api: APIClient) async -> Value? {
        do {
            return try await api.request(path)
        } catch {
            return nil
        }
    }

    private func fetchSummary(api: APIClient) async -> LedgerFundSummary? {
        do {
            let summary: LedgerFundSummary = try await api.request("/financial-funds/summary")
            try summary.validate()
            return summary
        } catch {
            return nil
        }
    }

    private func milliseconds() -> Int64 {
        Int64(now().timeIntervalSince1970 * 1_000)
    }
}

extension LedgerWidgetSnapshot {
    /// Server balances copied verbatim. Never recomputed from accounts or bills.
    mutating func apply(_ balances: LedgerBalances) {
        totalBalanceCents = balances.totalBalanceCents
        totalAssetsCents = balances.totalAssetsCents
        totalLiabilitiesCents = balances.totalLiabilitiesCents
    }

    /// The current month is the last point of the one-month trend the server reports.
    mutating func apply(_ trend: LedgerTrend) {
        guard let point = trend.items.last else { return }
        month = point.month
        monthIncomeCents = point.incomeCents
        monthExpenseCents = point.netExpenseCents
    }

    /// The four-purpose balances plus the coverage facts the plan page also shows. `funded` and
    /// `grossSpent` stay separate from the balance; nothing is re-derived here.
    mutating func apply(_ summary: LedgerFundSummary) {
        var values: [String: Purpose] = [:]
        for purpose in LedgerPurpose.allCases {
            values[purpose.rawValue] = Purpose(balanceCents: summary.balances[purpose],
                                               fundedCents: summary.totals.funded[purpose],
                                               spentCents: summary.totals.grossSpent[purpose])
        }
        purposes = values
        purposesAsOf = summary.asOf
        coverageComplete = summary.coverage.complete
        // The contract validates these counts only as non-negative, so each one is capped before the
        // sum: an absurd DTO must not overflow this addition and trap the app.
        coveragePendingCount = [summary.coverage.unallocatedSalaryCount,
                                summary.coverage.unassignedTransactionCount,
                                summary.coverage.invalidRefundCount]
            .reduce(0) { total, count in total + min(max(count, 0), 10_000) }
    }
}

/// One coalesced snapshot read after startup and after every successful ledger write. The short
/// delay collapses bursts of `ledgerRevision` changes (for example a confirmed import) into one read.
@MainActor
private struct LedgerWidgetSnapshotModifier: ViewModifier {
    @ObservedObject var api: APIClient
    let userID: String

    func body(content: Content) -> some View {
        content.task(id: api.ledgerRevision) {
            try? await Task.sleep(for: .milliseconds(600))
            guard !Task.isCancelled else { return }
            await LedgerWidgetSync.shared.refresh(api: api, userID: userID)
        }
    }
}

extension View {
    @MainActor
    func ledgerWidgetSnapshot(api: APIClient, userID: String) -> some View {
        modifier(LedgerWidgetSnapshotModifier(api: api, userID: userID))
    }
}
