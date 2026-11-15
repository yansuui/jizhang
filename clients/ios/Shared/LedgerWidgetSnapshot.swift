import Foundation

/// A display-only snapshot of the aggregates the home-screen widgets show.
///
/// The widgets never open the ledger, own a session or decode bill rows. The app copies the
/// authoritative server values into this small document inside the shared App Group container after
/// a successful read, and the widgets render exactly those values. Nothing here is re-derived from
/// loaded pages, so a widget can never invent a total the server did not report.
struct LedgerWidgetSnapshot: Codable, Equatable {
    static let currentSchemaVersion = 1
    static let maximumCents: Int64 = 9_007_199_254_740_991

    struct Purpose: Codable, Equatable {
        let balanceCents: Int64
        let fundedCents: Int64
        let spentCents: Int64
    }

    /// A stable per-account key (server address plus the server's user id). It never becomes a
    /// widget label; it only stops one account's aggregates being merged into another's snapshot.
    let ownerKey: String
    let schemaVersion: Int
    var updatedAt: Int64
    var month: String?
    var totalBalanceCents: Int64?
    var totalAssetsCents: Int64?
    var totalLiabilitiesCents: Int64?
    var monthIncomeCents: Int64?
    var monthExpenseCents: Int64?
    var purposes: [String: Purpose]?
    var purposesAsOf: Int64?
    var coverageComplete: Bool?
    var coveragePendingCount: Int?

    init(ownerKey: String, updatedAt: Int64, schemaVersion: Int = currentSchemaVersion) {
        self.ownerKey = ownerKey
        self.schemaVersion = schemaVersion
        self.updatedAt = updatedAt
    }

    var hasBalance: Bool {
        totalBalanceCents != nil || monthIncomeCents != nil || monthExpenseCents != nil
    }

    var hasPurposes: Bool {
        purposes?.isEmpty == false
    }

    func purpose(_ value: LedgerPurpose) -> Purpose? {
        purposes?[value.rawValue]
    }

    /// Only a plausible, current snapshot is stored or rendered. A malformed shared file must
    /// produce the widgets' explicit "尚未同步" state rather than a fabricated zero balance.
    var sanitized: LedgerWidgetSnapshot? {
        guard schemaVersion == Self.currentSchemaVersion,
              updatedAt >= 0,
              !ownerKey.isEmpty,
              ownerKey.utf8.count <= 256,
              month.map { Self.isMonthLabel($0) } ?? true,
              Self.isPlausible(totalBalanceCents),
              Self.isPlausible(totalAssetsCents),
              Self.isPlausible(totalLiabilitiesCents),
              Self.isPlausible(monthIncomeCents),
              Self.isPlausible(monthExpenseCents),
              Self.isPlausible(purposesAsOf),
              coveragePendingCount.map({ $0 >= 0 && $0 <= 30_000 }) ?? true else { return nil }
        var copy = self
        if let purposes {
            var usable: [String: Purpose] = [:]
            for (key, value) in purposes where LedgerPurpose(rawValue: key) != nil {
                guard Self.isPlausible(value.balanceCents),
                      Self.isPlausible(value.fundedCents), value.fundedCents >= 0,
                      Self.isPlausible(value.spentCents), value.spentCents >= 0 else { continue }
                usable[key] = value
            }
            copy.purposes = usable.isEmpty ? nil : usable
        }
        guard copy.hasBalance || copy.hasPurposes else { return nil }
        return copy
    }

    static func decode(_ data: Data) -> LedgerWidgetSnapshot? {
        guard let decoded = try? JSONDecoder().decode(LedgerWidgetSnapshot.self, from: data) else { return nil }
        return decoded.sanitized
    }

    private static func isPlausible(_ value: Int64?) -> Bool {
        guard let value else { return true }
        return value >= -maximumCents && value <= maximumCents
    }

    private static func isMonthLabel(_ value: String) -> Bool {
        value.range(of: #"^[0-9]{4}-(0[1-9]|1[0-2])$"#, options: .regularExpression) != nil
    }
}

extension LedgerWidgetSnapshot {
    /// Synthetic values for the widget gallery and the simulator preview tests only. The app never
    /// writes this sample, so it cannot be mistaken for the user's ledger.
    static var previewSample: LedgerWidgetSnapshot {
        var sample = LedgerWidgetSnapshot(ownerKey: "preview-owner", updatedAt: 1_793_750_400_000)
        sample.month = "2026-11"
        sample.totalBalanceCents = 12_345_678
        sample.totalAssetsCents = 15_000_000
        sample.totalLiabilitiesCents = 2_654_322
        sample.monthIncomeCents = 3_200_000
        sample.monthExpenseCents = 1_845_600
        sample.purposes = [
            LedgerPurpose.growth.rawValue: Purpose(balanceCents: 5_040_000, fundedCents: 6_000_000, spentCents: 960_000),
            LedgerPurpose.reserve.rawValue: Purpose(balanceCents: 2_400_000, fundedCents: 2_400_000, spentCents: 0),
            LedgerPurpose.essentials.rawValue: Purpose(balanceCents: 2_860_400, fundedCents: 3_200_000, spentCents: 339_600),
            LedgerPurpose.joy.rawValue: Purpose(balanceCents: 1_200_000, fundedCents: 1_200_000, spentCents: 0)
        ]
        sample.purposesAsOf = 1_793_750_400_000
        sample.coverageComplete = true
        sample.coveragePendingCount = 0
        return sample
    }
}

/// Reads and writes the widget snapshot in the shared App Group container.
///
/// Group propagation lives in `clients/ios/Jizhang/Jizhang.entitlements` and
/// `clients/ios/JizhangWidgets/JizhangWidgets.entitlements`. `isAvailable` is false when the running
/// signature carries no App Group entitlement, so the app can explain that state instead of claiming
/// the widget is synchronized.
struct LedgerWidgetSnapshotStore {
    static let appGroupIdentifier = "group.com.yansuu1.jizhang.ios"
    static let fileName = "ledger-widget-snapshot.json"
    static let maximumBytes = 16 * 1_024

    /// Nil when the App Group container is unavailable for this signature.
    let directory: URL?

    init(directory: URL?) {
        self.directory = directory
    }

    static let shared = LedgerWidgetSnapshotStore(
        directory: FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: LedgerWidgetSnapshotStore.appGroupIdentifier))

    var isAvailable: Bool {
        directory != nil
    }

    func load() -> LedgerWidgetSnapshot? {
        guard let url = fileURL,
              let data = try? Data(contentsOf: url),
              data.count <= Self.maximumBytes else { return nil }
        return LedgerWidgetSnapshot.decode(data)
    }

    @discardableResult
    func save(_ snapshot: LedgerWidgetSnapshot) -> Bool {
        guard let url = fileURL,
              let value = snapshot.sanitized,
              let data = try? JSONEncoder().encode(value),
              data.count <= Self.maximumBytes else { return false }
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                    withIntermediateDirectories: true)
            try data.write(to: url, options: [.atomic])
            return true
        } catch {
            return false
        }
    }

    func clear() {
        guard let url = fileURL else { return }
        try? FileManager.default.removeItem(at: url)
    }

    private var fileURL: URL? {
        directory?.appendingPathComponent(Self.fileName, isDirectory: false)
    }
}
