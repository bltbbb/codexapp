import Foundation
import UserNotifications

@MainActor
final class NotificationRelay: ObservableObject {
  static let shared = NotificationRelay()

  @Published var deviceToken: String = ""
  @Published var pendingSessionId: String?
  @Published var authorizationStatus: UNAuthorizationStatus = .notDetermined

  private init() {}

  func clearPendingSessionId() {
    pendingSessionId = nil
  }
}
