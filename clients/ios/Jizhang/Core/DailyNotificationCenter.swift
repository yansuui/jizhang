import Foundation
import UserNotifications

@MainActor protocol DailyNotificationScheduling: AnyObject {
    func authorization() async -> DailyReminderAuthorization
    func requestAuthorization() async throws -> Bool
    func add(_ request: DailyReminderRequest) async throws
    func pendingIdentifiers() async -> [String]
    func deliveredIdentifiers() async -> [String]
    func removePending(_ identifiers: [String])
    func removeDelivered(_ identifiers: [String])
}

@MainActor final class SystemDailyNotificationCenter: DailyNotificationScheduling {
    private let center: UNUserNotificationCenter
    init(center: UNUserNotificationCenter = .current()) { self.center = center }

    func authorization() async -> DailyReminderAuthorization {
        await withCheckedContinuation { continuation in
            center.getNotificationSettings { settings in
                let value: DailyReminderAuthorization
                switch settings.authorizationStatus {
                case .notDetermined: value = .notDetermined
                case .denied: value = .denied
                case .authorized: value = .authorized
                case .provisional: value = .provisional
                case .ephemeral: value = .ephemeral
                @unknown default: value = .unknown
                }
                continuation.resume(returning: value)
            }
        }
    }

    func requestAuthorization() async throws -> Bool {
        try await center.requestAuthorization(options: [.alert, .sound])
    }

    func add(_ request: DailyReminderRequest) async throws {
        let content = UNMutableNotificationContent()
        content.title = request.kind == .recording ? "今天记账了吗？" : "来看看今天的账单"
        content.body = request.kind == .recording ? "记录今天的收入与支出，让每一笔都有迹可循。" : "点击生成当天复盘，了解收支和需要留意的记录。"
        content.sound = .default
        content.userInfo = ["version": 1, "owner": request.ownerKey, "kind": request.kind.rawValue]
        // Leaving the zone unspecified follows the device's local reminder clock.
        let components = DateComponents(hour: request.clock.hour, minute: request.clock.minute)
        let trigger = UNCalendarNotificationTrigger(dateMatching: components, repeats: true)
        try await center.add(UNNotificationRequest(identifier: request.identifier, content: content, trigger: trigger))
    }

    func pendingIdentifiers() async -> [String] {
        await withCheckedContinuation { continuation in
            center.getPendingNotificationRequests { continuation.resume(returning: $0.map(\.identifier)) }
        }
    }

    func deliveredIdentifiers() async -> [String] {
        await withCheckedContinuation { continuation in
            center.getDeliveredNotifications { continuation.resume(returning: $0.map { $0.request.identifier }) }
        }
    }

    func removePending(_ identifiers: [String]) { center.removePendingNotificationRequests(withIdentifiers: identifiers) }
    func removeDelivered(_ identifiers: [String]) { center.removeDeliveredNotifications(withIdentifiers: identifiers) }
}
