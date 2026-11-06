import UIKit
import UserNotifications

@MainActor final class JizhangNotificationDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier,
              let delivery = DailyReminderDelivery(identifier: response.notification.request.identifier,
                  userInfo: response.notification.request.content.userInfo, date: response.notification.date) else {
            completionHandler(); return
        }
        Task { @MainActor in DailyReminderStore.shared.receive(delivery) }
        completionHandler()
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        // Foreground delivery only presents a reminder; inference requires the user's tap.
        completionHandler([.banner, .list, .sound])
    }
}
