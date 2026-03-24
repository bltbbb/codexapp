import SwiftUI
import UIKit

struct SettingsView: View {
  @Environment(\.dismiss) private var dismiss
  @EnvironmentObject private var settings: AppSettingsStore
  @ObservedObject private var relay = NotificationRelay.shared

  var body: some View {
    Form {
      Section("服务配置") {
        TextField("服务地址", text: $settings.baseURLText)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()
          .keyboardType(.URL)

        SecureField("访问令牌", text: $settings.accessToken)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled()

        TextField("设备名称", text: $settings.deviceName)

        Button("保存配置") {
          settings.save()
        }
      }

      Section("推送注册") {
        LabeledContent("权限状态", value: authorizationText)
        LabeledContent("设备 Token", value: relay.deviceToken.isEmpty ? "未获取" : relay.deviceToken)

        Button("申请通知权限") {
          Task {
            await settings.requestNotificationPermission()
          }
        }

        Button {
          Task {
            await settings.registerCurrentDevice(bundleId: Bundle.main.bundleIdentifier ?? "com.example.codexremote")
          }
        } label: {
          if settings.isRegisteringPush {
            ProgressView()
          } else {
            Text("注册当前设备到后端")
          }
        }
        .disabled(settings.isRegisteringPush || relay.deviceToken.isEmpty)

        Button {
          Task {
            await settings.refreshPushStatus()
          }
        } label: {
          if settings.isRefreshingPush {
            ProgressView()
          } else {
            Text("刷新推送状态")
          }
        }
      }

      Section("后端设备列表") {
        if settings.pushDevices.isEmpty {
          Text("还没有已注册设备")
            .foregroundColor(.secondary)
        } else {
          ForEach(settings.pushDevices) { device in
            VStack(alignment: .leading, spacing: 6) {
              HStack {
                Text(device.deviceName)
                  .font(.headline)
                Spacer()
                Text(device.pushEnabled ? "已启用" : "已关闭")
                  .font(.caption.weight(.semibold))
                  .foregroundColor(deviceStatusColor(device))
              }

              if let tokenMasked = device.tokenMasked, !tokenMasked.isEmpty {
                Text(tokenMasked)
                  .font(.caption)
                  .foregroundColor(.secondary)
              }

              Text(device.bundleId)
                .font(.caption)
                .foregroundColor(.secondary)
            }
            .padding(.vertical, 4)
          }
        }
      }

      if !settings.lastStatusMessage.isEmpty {
        Section("状态") {
          Text(settings.lastStatusMessage)
            .foregroundColor(.green)
        }
      }

      if !settings.lastErrorMessage.isEmpty {
        Section("错误") {
          Text(settings.lastErrorMessage)
            .foregroundColor(.red)
        }
      }
    }
    .navigationTitle("设置")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Button("完成") {
          dismiss()
        }
      }
    }
    .task {
      await settings.refreshAuthorizationStatus()
      await settings.refreshPushStatus()
    }
  }

  private var authorizationText: String {
    switch relay.authorizationStatus {
    case .authorized, .provisional, .ephemeral:
      return "已允许"
    case .denied:
      return "已拒绝"
    case .notDetermined:
      return "未决定"
    @unknown default:
      return "未知"
    }
  }

  private func deviceStatusColor(_ device: PushDevice) -> Color {
    device.pushEnabled ? .green : .secondary
  }
}
