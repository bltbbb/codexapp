import SwiftUI

@main
struct CodexRemoteApp: App {
  @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
  @StateObject private var settingsStore = AppSettingsStore()

  var body: some Scene {
    WindowGroup {
      RootView()
        .environmentObject(settingsStore)
    }
  }
}
