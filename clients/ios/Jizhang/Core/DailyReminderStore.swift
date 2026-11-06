import Combine
import Foundation

@MainActor final class DailyReminderStore: ObservableObject {
    static let shared = DailyReminderStore()
    @Published private(set) var preferences = DailyReminderPreferences()
    @Published private(set) var authorization = DailyReminderAuthorization.notDetermined
    @Published private(set) var scheduling = false
    @Published private(set) var requestingPermission = false
    @Published private(set) var scheduledKinds = Set<DailyReminderKind>()
    @Published private(set) var notice: String?
    @Published private(set) var reviewLaunch: AssistantLaunchIntent?
    // In-memory tap receipts permit queued days independently; startup never restores them.
    @Published private(set) var authorizedReviewLaunches: [String: AssistantLaunchIntent] = [:]
    @Published private(set) var recordingLaunch: DailyRecordingIntent?
    @Published private(set) var owner: DailyReminderOwner?

    private let center: DailyNotificationScheduling
    private let storage: UserDefaults
    private let outbox: DailyReviewOutboxStorage
    private var revision = 0
    private var reconciliation: Task<Void, Never>?
    private var pendingDelivery: DailyReminderDelivery?
    private var lastRecordingDelivery: DailyReminderDelivery?
    private static let scheduleFailureNotice = "部分提醒未能安排，请刷新重试；系统设置可能影响通知展示。"
    private let preferencesPrefix = "jizhang.daily.preferences.v1."

    init(center: DailyNotificationScheduling? = nil, preferences: UserDefaults = .standard, outbox: DailyReviewOutboxStorage? = nil) {
        self.center = center ?? SystemDailyNotificationCenter()
        storage = preferences
        self.outbox = outbox ?? FileDailyReviewOutbox()
        // Persisted outboxes are read only in response to an actual notification tap.
    }

    var canReview: Bool { owner?.supportsReview == true }
    func clearNotice() { notice = nil }
    var statusText: String {
        guard owner != nil else { return "登录后可设置此账本的提醒。" }
        switch authorization {
        case .notDetermined: return "尚未允许系统通知；允许后才会安排提醒。"
        case .denied: return "系统通知已关闭，请在系统设置中允许通知。"
        case .unknown: return "暂时无法确认通知权限，请刷新重试。"
        default:
            if scheduling { return "正在更新提醒…" }
            if scheduledKinds.isEmpty { return "当前没有已安排的每日提醒。" }
            return "已安排 \(scheduledKinds.count) 项每日提醒，按设备本地时间通知。"
        }
    }

    func updateSession(api: APIClient?, user: AuthenticatedUser?) {
        guard let api, let user else {
            if owner != nil { deactivate() } else { requestReconciliation() }
            return
        }
        let next = DailyReminderOwner(api: api, user: user)
        if owner != next {
            owner = next
            preferences = loadPreferences(next.key)
            scheduledKinds = []
            reviewLaunch = nil; recordingLaunch = nil; lastRecordingDelivery = nil
            authorizedReviewLaunches = [:]
            notice = nil
        }
        requestReconciliation()
        if let delivery = pendingDelivery {
            pendingDelivery = nil
            receive(delivery)
        }
    }

    func deactivate() {
        owner = nil; scheduledKinds = []
        reviewLaunch = nil; recordingLaunch = nil
        authorizedReviewLaunches = [:]
        pendingDelivery = nil; lastRecordingDelivery = nil
        notice = nil
        requestReconciliation()
    }

    func setRecordingEnabled(_ value: Bool) {
        var next = preferences; next.recordingEnabled = value
        savePreferences(next)
        if value, let identity = owner?.apiIdentity {
            Task { guard self.owner?.apiIdentity == identity else { return }; await self.allowNotifications() }
        }
    }

    func setReviewEnabled(_ value: Bool) {
        var next = preferences; next.reviewEnabled = value
        savePreferences(next)
        if value, let identity = owner?.apiIdentity {
            Task { guard self.owner?.apiIdentity == identity else { return }; await self.allowNotifications() }
        }
    }

    func setRecordingTime(_ value: Date) {
        var next = preferences; next.recordingTime = DailyReminderClock(date: value)
        savePreferences(next)
    }

    func setReviewTime(_ value: Date) {
        var next = preferences; next.reviewTime = DailyReminderClock(date: value)
        savePreferences(next)
    }

    func allowNotifications() async {
        guard let identity = owner?.apiIdentity, !requestingPermission else { return }
        requestingPermission = true
        notice = nil
        defer { requestingPermission = false }
        let current = await center.authorization()
        guard owner?.apiIdentity == identity else { return }
        if current == .notDetermined {
            do { _ = try await center.requestAuthorization() }
            catch { if owner?.apiIdentity == identity { notice = "通知授权未能完成，请稍后重试。" } }
        }
        requestReconciliation()
        await waitForScheduling()
    }

    func refresh() async {
        requestReconciliation()
        await waitForScheduling()
    }

    func waitForScheduling() async {
        while let current = reconciliation { await current.value }
    }

    func receive(_ delivery: DailyReminderDelivery) {
        guard let owner else { pendingDelivery = delivery; return }
        guard owner.key == delivery.ownerKey else {
            notice = "此提醒来自其他账本，请登录对应账号后再打开。"
            return
        }
        switch delivery.kind {
        case .recording:
            guard lastRecordingDelivery != delivery else { return }
            lastRecordingDelivery = delivery
            recordingLaunch = DailyRecordingIntent(apiIdentity: owner.apiIdentity)
        case .review:
            guard owner.supportsReview else {
                notice = "当前记账服务暂不支持通知复盘，请更新服务后再试；记账提醒仍可使用。"
                return
            }
            let day = DailyReviewOutboxEntry.day(containing: delivery.deliveredAt)
            let id = owner.key + "." + day
            let entry: DailyReviewOutboxEntry
            do {
                entry = try loadOutbox(id) ?? DailyReviewOutboxEntry(id: id, ownerKey: owner.key, date: day,
                    timeZone: DailyReviewOutboxEntry.ledgerTimeZone, clientRequestID: UUID().uuidString,
                    conversationID: nil, generationID: nil, state: .requested)
            } catch { notice = "复盘请求暂时无法恢复，请在助手选择日期继续。"; return }
            guard saveOutbox(entry) else { notice = "无法保存复盘请求，请稍后重试。"; return }
            let launch = entry.launch(for: owner)
            authorizedReviewLaunches[entry.id] = launch
            reviewLaunch = launch
        }
    }

    /// Synchronous durable checkpoints fence the next network step before it starts.
    @discardableResult
    func checkpoint(_ intent: AssistantLaunchIntent, _ checkpoint: DailyReviewCheckpoint) -> Bool {
        guard let owner, owner.key + "." + intent.date == intent.id, owner.apiIdentity == intent.apiIdentity,
              let authorized = authorizedReviewLaunches[intent.id],
              authorized.apiIdentity == intent.apiIdentity, authorized.clientRequestID == intent.clientRequestID,
              authorized.date == intent.date, authorized.timeZone == intent.timeZone,
              var entry = try? loadOutbox(intent.id), entry.clientRequestID == intent.clientRequestID,
              entry.timeZone == intent.timeZone else { return false }
        switch checkpoint {
        case .conversation(let id):
            guard !id.isEmpty,
                  entry.conversationID == nil || entry.conversationID == id else { return false }
            entry.conversationID = id
            if entry.state == .requested { entry.state = .bound }
        case .submitting(let id):
            guard entry.conversationID == id,
                  entry.state != .accepted else { return false }
            entry.state = .submitting
        case .accepted(let id):
            guard entry.conversationID != nil, !id.isEmpty,
                  entry.generationID == nil || entry.generationID == id else { return false }
            entry.generationID = id; entry.state = .accepted
        case .uncertain(let id):
            guard entry.conversationID == id, entry.state != .accepted else { return false }
            entry.state = .uncertain
        }
        guard saveOutbox(entry) else { return false }
        let updated = entry.launch(for: owner, presentationID: authorized.presentationID)
        authorizedReviewLaunches[intent.id] = updated
        if reviewLaunch?.id == intent.id { reviewLaunch = updated }
        return true
    }

    private func loadPreferences(_ ownerKey: String) -> DailyReminderPreferences {
        guard let data = storage.data(forKey: preferencesPrefix + ownerKey),
              let value = try? JSONDecoder().decode(DailyReminderPreferences.self, from: data), value.isValid else {
            return DailyReminderPreferences()
        }
        return value
    }

    private func savePreferences(_ next: DailyReminderPreferences) {
        guard let owner, next.isValid, let data = try? JSONEncoder().encode(next) else { return }
        storage.set(data, forKey: preferencesPrefix + owner.key)
        preferences = next; notice = nil; scheduledKinds = []
        requestReconciliation()
    }

    private func loadOutbox(_ id: String) throws -> DailyReviewOutboxEntry? {
        guard let data = try outbox.read(id) else { return nil }
        let entry = try JSONDecoder().decode(DailyReviewOutboxEntry.self, from: data)
        guard entry.isValid, entry.id == id else { throw DailyReviewOutboxError.invalid }
        return entry
    }

    private func saveOutbox(_ entry: DailyReviewOutboxEntry) -> Bool {
        guard entry.isValid, let data = try? JSONEncoder().encode(entry) else { return false }
        do { try outbox.write(data, id: entry.id); return true }
        catch { notice = "无法保存复盘请求，请稍后重试。"; return false }
    }

    private func requestReconciliation() {
        revision += 1
        guard reconciliation == nil else { return }
        scheduling = true
        reconciliation = Task { [weak self] in
            guard let self else { return }
            while true {
                let ticket = self.revision
                await self.reconcile(ticket: ticket, owner: self.owner, preferences: self.preferences)
                if self.revision == ticket { break }
            }
            self.scheduling = false
            self.reconciliation = nil
        }
    }

    private func reconcile(ticket: Int, owner: DailyReminderOwner?, preferences: DailyReminderPreferences) async {
        let permission = await center.authorization()
        guard revision == ticket else { return }
        authorization = permission
        var requests: [DailyReminderRequest] = []
        if let owner, permission.allowsDelivery {
            if preferences.recordingEnabled { requests.append(DailyReminderRequest(ownerKey: owner.key, kind: .recording, clock: preferences.recordingTime)) }
            if preferences.reviewEnabled && owner.supportsReview { requests.append(DailyReminderRequest(ownerKey: owner.key, kind: .review, clock: preferences.reviewTime)) }
        }
        let wanted = Set(requests.map(\.identifier))
        let pending = await center.pendingIdentifiers()
        guard revision == ticket else { return }
        center.removePending(pending.filter { $0.hasPrefix(DailyReminderRequest.prefix) && !wanted.contains($0) })
        let delivered = await center.deliveredIdentifiers()
        guard revision == ticket else { return }
        center.removeDelivered(delivered.filter { $0.hasPrefix(DailyReminderRequest.prefix) && !wanted.contains($0) })
        var armed = Set<DailyReminderKind>()
        var failed = false
        for request in requests {
            guard revision == ticket else { return }
            do { try await center.add(request); armed.insert(request.kind) }
            catch { failed = true }
        }
        guard revision == ticket else { return }
        scheduledKinds = armed
        if failed { notice = Self.scheduleFailureNotice }
        else if notice == Self.scheduleFailureNotice { notice = nil }
    }
}
