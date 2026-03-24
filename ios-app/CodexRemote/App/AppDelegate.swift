import UIKit
import UserNotifications

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    UNUserNotificationCenter.current().delegate = self
    if let remoteNotification = launchOptions?[.remoteNotification] as? [AnyHashable: Any] {
      Task { @MainActor in
        NotificationRelay.shared.pendingSessionId = Self.extractSessionId(from: remoteNotification)
      }
    }
    return true
  }

  func application(
    _ application: UIApplication,
    didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
  ) {
    let token = deviceToken.map { String(format: "%02x", $0) }.joined()
    Task { @MainActor in
      NotificationRelay.shared.deviceToken = token
    }
  }

  func application(
    _ application: UIApplication,
    didFailToRegisterForRemoteNotificationsWithError error: Error
  ) {
    print("APNs 注册失败: \(error.localizedDescription)")
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification
  ) async -> UNNotificationPresentationOptions {
    [.banner, .badge, .sound]
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse
  ) async {
    await MainActor.run {
      NotificationRelay.shared.pendingSessionId = Self.extractSessionId(from: response.notification.request.content.userInfo)
    }
  }

  private static func extractSessionId(from userInfo: [AnyHashable: Any]) -> String? {
    if let value = userInfo["sessionId"] as? String, !value.isEmpty {
      return value
    }
    return nil
  }
}
