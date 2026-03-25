import SwiftUI
import UIKit

struct RootView: View {
  @EnvironmentObject private var settings: AppSettingsStore
  @ObservedObject private var relay = NotificationRelay.shared

  @State private var sessions: [CodexSessionSummary] = []
  @State private var isLoading = false
  @State private var path = NavigationPath()
  @State private var showSettings = false
  @State private var errorMessage = ""

  var body: some View {
    NavigationStack(path: $path) {
      Group {
        if !settings.canRequestServer {
          UnavailableStateView(
            "先配置服务器",
            systemImage: "server.rack",
            description: Text("先在右上角设置里填写 Tailscale 地址和访问令牌。")
          )
        } else if isLoading && sessions.isEmpty {
          ProgressView("正在加载会话…")
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
          ScrollView {
            LazyVStack(spacing: 16) {
              ForEach(sessions) { session in
                NavigationLink(value: session.id) {
                  SessionRow(session: session)
                }
                .buttonStyle(.plain)
              }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
          }
          .refreshable {
            await refreshSessions()
          }
        }
      }
      .background(
        LinearGradient(
          colors: [
            Color(uiColor: .systemGroupedBackground),
            Color(uiColor: .secondarySystemGroupedBackground)
          ],
          startPoint: .topLeading,
          endPoint: .bottomTrailing
        )
        .ignoresSafeArea()
      )
      .navigationTitle("Codex 会话台")
      .navigationDestination(for: String.self) { sessionId in
        SessionDetailView(sessionId: sessionId)
      }
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button {
            showSettings = true
          } label: {
            Image(systemName: "slider.horizontal.3")
          }
        }

        ToolbarItemGroup(placement: .topBarTrailing) {
          Button {
            Task {
              await refreshSessions()
            }
          } label: {
            Image(systemName: "arrow.clockwise")
          }

          Button {
            Task {
              await createSession()
            }
          } label: {
            Image(systemName: "plus")
          }
        }
      }
      .sheet(isPresented: $showSettings) {
        NavigationStack {
          SettingsView()
        }
        .environmentObject(settings)
      }
      .overlay(alignment: .bottom) {
        if !errorMessage.isEmpty {
          Text(errorMessage)
            .font(.footnote)
            .foregroundColor(.red)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(Color(uiColor: .secondarySystemBackground).opacity(0.96), in: Capsule())
            .padding(.bottom, 12)
        }
      }
      .task {
        await settings.refreshAuthorizationStatus()
        await settings.refreshPushStatus()
        await refreshSessions()
        if let pendingSessionId = relay.pendingSessionId, !pendingSessionId.isEmpty {
          path.append(pendingSessionId)
          relay.clearPendingSessionId()
        }
      }
      .onChange(of: relay.pendingSessionId) { pendingSessionId in
        guard let pendingSessionId, !pendingSessionId.isEmpty else {
          return
        }
        path = NavigationPath()
        path.append(pendingSessionId)
        relay.clearPendingSessionId()
      }
    }
  }

  private func refreshSessions() async {
    guard settings.canRequestServer else {
      return
    }

    isLoading = true
    defer { isLoading = false }

    do {
      let api = try settings.makeAPI()
      sessions = try await api.listSessions()
      errorMessage = ""
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func createSession() async {
    do {
      let api = try settings.makeAPI()
      let session = try await api.createSession()
      await refreshSessions()
      path.append(session.id)
    } catch {
      errorMessage = error.localizedDescription
    }
  }
}

private struct SessionRow: View {
  let session: CodexSessionSummary

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(spacing: 12) {
        Image(systemName: "terminal.fill")
          .font(.system(size: 18, weight: .bold))
          .foregroundColor(.orange)
          .frame(width: 44, height: 44)
          .background(Color.orange.opacity(0.12))
          .clipShape(Circle())
        
        VStack(alignment: .leading, spacing: 4) {
          Text(session.title.isEmpty ? "未命名会话" : session.title)
            .font(.headline.weight(.semibold))
            .foregroundColor(.primary)
            .lineLimit(1)
            
          Text(DisplayTime.text(session.updatedAt))
            .font(.caption)
            .foregroundColor(.secondary)
            .lineLimit(1)
        }
        Spacer()
        
        Text(statusText)
          .font(.caption2.weight(.bold))
          .foregroundColor(statusColor)
          .padding(.horizontal, 10)
          .padding(.vertical, 5)
          .background(statusColor.opacity(0.15), in: Capsule())
      }

      Text(session.preview.isEmpty ? "暂无摘要" : session.preview)
        .font(.subheadline)
        .foregroundColor(.secondary)
        .lineLimit(2)
        .multilineTextAlignment(.leading)
    }
    .padding(16)
    .background(Color(uiColor: .secondarySystemGroupedBackground))
    .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
    .shadow(color: Color.black.opacity(0.06), radius: 10, x: 0, y: 4)
  }

  private var statusText: String {
    switch session.status {
    case "running": return "执行中"
    case "error": return "失败"
    case "stopped": return "已停止"
    default: return "空闲"
    }
  }

  private var statusColor: Color {
    switch session.status {
    case "running": return .orange
    case "error": return .red
    case "stopped": return .gray
    default: return .green
    }
  }
}
