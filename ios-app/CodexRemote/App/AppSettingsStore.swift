import Foundation
import SwiftUI
import UIKit
import UserNotifications

@MainActor
final class AppSettingsStore: ObservableObject {
  private enum Keys {
    static let baseURL = "codex_remote_base_url"
    static let accessToken = "codex_remote_access_token"
    static let deviceName = "codex_remote_device_name"
    static let deviceId = "codex_remote_device_id"
  }

  @Published var baseURLText: String
  @Published var accessToken: String
  @Published var deviceName: String
  @Published var pushSummary: PushServiceStatus?
  @Published var pushDevices: [PushDevice] = []
  @Published var isRefreshingPush = false
  @Published var isRegisteringPush = false
  @Published var lastStatusMessage: String = ""
  @Published var lastErrorMessage: String = ""

  let deviceId: String
  let relay = NotificationRelay.shared

  init(defaults: UserDefaults = .standard) {
    let storedDeviceId = defaults.string(forKey: Keys.deviceId)?.trimmingCharacters(in: .whitespacesAndNewlines)
    if let storedDeviceId, !storedDeviceId.isEmpty {
      self.deviceId = storedDeviceId
    } else {
      let newId = UUID().uuidString.lowercased()
      defaults.set(newId, forKey: Keys.deviceId)
      self.deviceId = newId
    }

    self.baseURLText = defaults.string(forKey: Keys.baseURL) ?? "http://100.x.x.x:4632"
    self.accessToken = defaults.string(forKey: Keys.accessToken) ?? ""
    self.deviceName = defaults.string(forKey: Keys.deviceName) ?? UIDevice.current.name
  }

  func save() {
    let defaults = UserDefaults.standard
    defaults.set(baseURLText.trimmingCharacters(in: .whitespacesAndNewlines), forKey: Keys.baseURL)
    defaults.set(accessToken.trimmingCharacters(in: .whitespacesAndNewlines), forKey: Keys.accessToken)
    defaults.set(deviceName.trimmingCharacters(in: .whitespacesAndNewlines), forKey: Keys.deviceName)
    lastStatusMessage = "配置已保存"
    lastErrorMessage = ""
  }

  func makeAPI() throws -> CodexAPI {
    try CodexAPI(configuration: makeConfiguration())
  }

  func makeConfiguration() throws -> ServerConfiguration {
    let normalizedBaseURL = baseURLText.trimmingCharacters(in: .whitespacesAndNewlines)
    let normalizedToken = accessToken.trimmingCharacters(in: .whitespacesAndNewlines)

    guard !normalizedBaseURL.isEmpty else {
      throw CodexAPIError.invalidConfiguration("请先填写服务地址")
    }

    let finalBaseURL: String
    if normalizedBaseURL.hasPrefix("http://") || normalizedBaseURL.hasPrefix("https://") {
      finalBaseURL = normalizedBaseURL
    } else {
      finalBaseURL = "http://\(normalizedBaseURL)"
    }

    guard let url = URL(string: finalBaseURL) else {
      throw CodexAPIError.invalidConfiguration("服务地址格式不正确")
    }

    guard !normalizedToken.isEmpty else {
      throw CodexAPIError.invalidConfiguration("请先填写访问令牌")
    }

    return ServerConfiguration(baseURL: url, accessToken: normalizedToken)
  }

  func refreshAuthorizationStatus() async {
    let settings = await UNUserNotificationCenter.current().notificationSettings()
    relay.authorizationStatus = settings.authorizationStatus
  }

  func requestNotificationPermission() async {
    do {
      let granted = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
      await refreshAuthorizationStatus()
      if granted {
        UIApplication.shared.registerForRemoteNotifications()
        lastStatusMessage = "已申请通知权限，等待系统返回 deviceToken"
        lastErrorMessage = ""
      } else {
        lastErrorMessage = "用户未允许通知权限"
      }
    } catch {
      lastErrorMessage = error.localizedDescription
    }
  }

  func refreshPushStatus() async {
    guard canRequestServer else {
      pushSummary = nil
      pushDevices = []
      return
    }

    isRefreshingPush = true
    defer { isRefreshingPush = false }

    do {
      let api = try makeAPI()
      let response = try await api.fetchPushDevices()
      pushSummary = response.push
      pushDevices = response.devices
      lastErrorMessage = ""
    } catch {
      lastErrorMessage = error.localizedDescription
    }
  }

  func registerCurrentDevice(bundleId: String) async {
    guard !relay.deviceToken.isEmpty else {
      lastErrorMessage = "还没有拿到 APNs deviceToken，请先允许通知"
      return
    }

    isRegisteringPush = true
    defer { isRegisteringPush = false }

    do {
      let api = try makeAPI()
      let request = PushRegisterRequest(
        deviceId: deviceId,
        deviceToken: relay.deviceToken,
        deviceName: deviceName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? UIDevice.current.name : deviceName,
        bundleId: bundleId,
        appVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.1.0",
        tailscaleIdentity: UIDevice.current.name,
        pushEnabled: true,
        notifyOnCompleted: true,
        notifyOnError: true,
        environment: currentPushEnvironment
      )
      let response = try await api.registerPushDevice(request)
      pushSummary = response.push
      if let device = response.device {
        mergeRegisteredDevice(device)
      }
      lastStatusMessage = "设备已注册到后端"
      lastErrorMessage = ""
    } catch {
      lastErrorMessage = error.localizedDescription
    }
  }

  var canRequestServer: Bool {
    !baseURLText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && !accessToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  private var currentPushEnvironment: String {
#if DEBUG
    return "sandbox"
#else
    return "production"
#endif
  }

  private func mergeRegisteredDevice(_ device: PushDevice) {
    if let index = pushDevices.firstIndex(where: { $0.id == device.id }) {
      pushDevices[index] = device
    } else {
      pushDevices.insert(device, at: 0)
    }
  }
}
