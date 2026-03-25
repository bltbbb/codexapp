import PhotosUI
import SwiftUI
import UniformTypeIdentifiers
import UIKit

struct SessionDetailView: View {
  @EnvironmentObject private var settings: AppSettingsStore
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.openURL) private var openURL
  @StateObject private var model: SessionDetailViewModel
  @FocusState private var isComposerFocused: Bool
  @State private var selectedTab = "messages"
  @State private var selectedPhotoItems: [PhotosPickerItem] = []
  @State private var showingFileImporter = false
  @State private var previewTarget: PreviewTarget?

  init(sessionId: String) {
    _model = StateObject(wrappedValue: SessionDetailViewModel(sessionId: sessionId))
  }

  var body: some View {
    VStack(spacing: 0) {
      header

      Divider()
      Picker("详情页签", selection: $selectedTab) {
        Text("消息").tag("messages")
        Text("事件").tag("events")
        Text("产物").tag("artifacts")
      }
      .pickerStyle(.segmented)
      .padding(.horizontal, 16)
      .padding(.top, 12)

      contentView
    }
    .safeAreaInset(edge: .bottom) {
      if selectedTab == "messages" {
        composer
          .background(Color(uiColor: .systemBackground).opacity(0.96))
      }
    }
    .navigationTitle(model.session?.title ?? "会话")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItemGroup(placement: .topBarTrailing) {
        Button {
          Task {
            await model.load(using: settings, keepStream: true)
          }
        } label: {
          Image(systemName: "arrow.clockwise")
        }

        if model.session?.canStop == true {
          Button(role: .destructive) {
            Task {
              await model.stop(using: settings)
            }
          } label: {
            Image(systemName: "stop.circle")
          }
        }
      }
    }
    .task {
      await model.load(using: settings)
    }
    .onDisappear {
      model.disconnectStream()
    }
    .onChange(of: scenePhase) { phase in
      guard phase == .active else {
        return
      }
      Task {
        await model.load(using: settings, keepStream: true)
      }
    }
    .sheet(item: $previewTarget) { target in
      ArtifactPreviewSheet(target: target)
        .environmentObject(settings)
    }
  }

  @ViewBuilder
  private var contentView: some View {
    if selectedTab == "events" {
      eventList
    } else if selectedTab == "artifacts" {
      artifactList
    } else {
      messageList
    }
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(model.session?.preview.isEmpty == false ? model.session?.preview ?? "" : "会话已连接到远端 Codex 服务")
        .font(.subheadline)
        .foregroundColor(.secondary)
        .lineLimit(2)

      HStack(spacing: 10) {
        Label(streamText, systemImage: streamIcon)
          .font(.caption.weight(.semibold))
          .foregroundColor(streamColor)

        Text(statusText)
          .font(.caption)
          .foregroundColor(.secondary)

        if model.streamState == "reconnecting" {
          Text("第 \(max(model.reconnectAttempt, 1)) 次重连")
            .font(.caption2)
            .foregroundColor(.secondary)
        }

        Spacer()
      }
    }
    .padding(.horizontal, 16)
    .padding(.top, 14)
    .padding(.bottom, 12)
    .background(Color(uiColor: .secondarySystemBackground))
  }

  private var composer: some View {
    VStack(spacing: 10) {
      if !model.pendingAttachments.isEmpty {
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 8) {
            ForEach(model.pendingAttachments) { attachment in
              HStack(spacing: 8) {
                Image(systemName: iconName(for: attachment.kind))
                  .foregroundColor(.orange)
                VStack(alignment: .leading, spacing: 2) {
                  Text(attachment.name)
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
                  Text(formatBytes(attachment.size))
                    .font(.caption2)
                    .foregroundColor(.secondary)
                }
                Button {
                  model.removePendingAttachment(attachment)
                } label: {
                  Image(systemName: "xmark.circle.fill")
                    .foregroundColor(.secondary)
                }
                .buttonStyle(.plain)
              }
              .padding(.horizontal, 10)
              .padding(.vertical, 8)
              .background(Color(uiColor: .secondarySystemBackground))
              .clipShape(Capsule())
            }
          }
        }
      }

      HStack(alignment: .bottom, spacing: 10) {
        PhotosPicker(
          selection: $selectedPhotoItems,
          maxSelectionCount: 3,
          matching: .images
        ) {
          Image(systemName: "plus.circle.fill")
            .font(.system(size: 22))
        }
        .buttonStyle(.plain)

        Button {
          showingFileImporter = true
        } label: {
          Image(systemName: "paperclip.circle.fill")
            .font(.system(size: 22))
        }
        .buttonStyle(.plain)

        TextField("输入消息…", text: $model.draftMessage, axis: .vertical)
          .textFieldStyle(.roundedBorder)
          .focused($isComposerFocused)
          .lineLimit(1 ... 6)
          .submitLabel(.send)
          .onSubmit {
            sendMessage()
          }

        Button {
          sendMessage()
        } label: {
          if model.isSending {
            ProgressView()
              .tint(.white)
          } else {
            Image(systemName: "paperplane.fill")
          }
        }
        .buttonStyle(.borderedProminent)
        .disabled(model.isSending || (model.draftMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && model.pendingAttachments.isEmpty))
      }
    }
    .padding(.horizontal, 16)
    .padding(.top, 12)
    .padding(.bottom, 12)
    .onChange(of: selectedPhotoItems) { newItems in
      let captured = newItems
      selectedPhotoItems = []
      Task {
        await loadPhotoAttachments(captured)
      }
    }
    .fileImporter(
      isPresented: $showingFileImporter,
      allowedContentTypes: [.item],
      allowsMultipleSelection: true
    ) { result in
      switch result {
      case let .success(urls):
        Task {
          await model.addFileAttachments(urls: urls)
        }
      case let .failure(error):
        model.errorMessage = error.localizedDescription
      }
    }
  }

  private func loadPhotoAttachments(_ items: [PhotosPickerItem]) async {
    guard !items.isEmpty else {
      return
    }

    var prepared: [PreparedAttachmentInput] = []
    do {
      for (index, item) in items.enumerated() {
        guard let data = try await item.loadTransferable(type: Data.self) else {
          continue
        }

        let mimeType = item.supportedContentTypes.first?.preferredMIMEType ?? "image/jpeg"
        let fileExtension = item.supportedContentTypes.first?.preferredFilenameExtension ?? "jpg"
        let name = "photo-\(Int(Date().timeIntervalSince1970))-\(index + 1).\(fileExtension)"
        prepared.append(
          PreparedAttachmentInput(
            name: name,
            data: data,
            mimeType: mimeType
          )
        )
      }

      model.addPreparedAttachments(prepared)
    } catch {
      model.errorMessage = error.localizedDescription
    }
  }

  private var messageList: some View {
    ScrollViewReader { proxy in
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 12) {
          ForEach(model.session?.messages ?? []) { message in
            MessageBubble(
              message: message,
              iconName: iconName(for:),
              formatBytes: formatBytes(_:),
              openAttachment: openMessageAttachment(_:),
              formatTime: formatDisplayTime(_:)
            )
              .id("message-\(message.id)")
          }

          if let pendingStatusEvent {
            StatusEventBubble(
              event: pendingStatusEvent,
              detail: statusEventDetail(pendingStatusEvent),
              formatTime: formatDisplayTime(_:)
            )
              .id("pending-status-\(pendingStatusEvent.id)")
          }

          if !model.errorMessage.isEmpty {
            Text(model.errorMessage)
              .font(.footnote)
              .foregroundColor(.red)
              .padding(12)
              .frame(maxWidth: .infinity, alignment: .leading)
          }
        }
        .padding(16)
        .textSelection(.enabled)
      }
      .background(Color(uiColor: .systemGroupedBackground))
      .onChange(of: scrollTargetId) { targetId in
        if let targetId {
          withAnimation(.easeOut(duration: 0.2)) {
            proxy.scrollTo(targetId, anchor: .bottom)
          }
        }
      }
    }
  }

  private var eventList: some View {
    List {
      if (model.session?.events ?? []).isEmpty {
        Text("还没有事件记录")
          .foregroundColor(.secondary)
      } else {
        ForEach((model.session?.events ?? []).reversed(), id: \.id) { event in
          VStack(alignment: .leading, spacing: 6) {
            HStack {
              Text(model.eventTitle(event))
                .font(.headline)
              Spacer()
              Text(formatDisplayTime(event.timestamp))
                .font(.caption)
                .foregroundColor(.secondary)
            }

            Text(model.eventBody(event))
              .font(.subheadline)
              .foregroundColor(.secondary)
          }
          .padding(.vertical, 4)
        }
      }
    }
    .listStyle(.insetGrouped)
  }

  private var artifactList: some View {
    List {
      if (model.session?.artifacts ?? []).isEmpty {
        Text("还没有产物")
          .foregroundColor(.secondary)
      } else {
        ForEach(model.session?.artifacts ?? []) { artifact in
          Button {
            openArtifact(artifact)
          } label: {
            HStack(spacing: 12) {
              Image(systemName: iconName(for: artifact.kind))
                .foregroundColor(.orange)
              VStack(alignment: .leading, spacing: 5) {
                Text(artifact.name)
                  .font(.headline)
                  .foregroundColor(.primary)
                  .lineLimit(1)
                Text(artifactMetaText(artifact))
                  .font(.caption)
                  .foregroundColor(.secondary)
              }
              Spacer()
              Image(systemName: "arrow.up.right.square")
                .foregroundColor(.secondary)
            }
            .padding(.vertical, 4)
          }
          .buttonStyle(.plain)
        }
      }
    }
    .listStyle(.insetGrouped)
  }

  private var streamText: String {
    switch model.streamState {
    case "online": return "实时在线"
    case "connecting": return "连接中"
    case "reconnecting": return "重连中"
    default: return "未连接"
    }
  }

  private var streamIcon: String {
    switch model.streamState {
    case "online": return "dot.radiowaves.left.and.right"
    case "connecting": return "arrow.triangle.2.circlepath"
    case "reconnecting": return "antenna.radiowaves.left.and.right.slash"
    default: return "pause.circle"
    }
  }

  private var streamColor: Color {
    switch model.streamState {
    case "online": return .green
    case "connecting": return .orange
    case "reconnecting": return .red
    default: return .secondary
    }
  }

  private var statusText: String {
    switch model.session?.status {
    case "running": return "任务执行中"
    case "error": return "任务失败"
    case "stopped": return "任务已停止"
    default: return "空闲"
    }
  }

  private func iconName(for kind: String?) -> String {
    switch kind {
    case "image":
      return "photo"
    case "text":
      return "doc.plaintext"
    case "archive":
      return "archivebox"
    case "document":
      return "doc.richtext"
    default:
      return "doc"
    }
  }

  private func artifactMetaText(_ artifact: CodexArtifact) -> String {
    [
      artifact.kind ?? "file",
      artifact.mimeType ?? "",
      formatDisplayTime(artifact.createdAt),
    ]
    .filter { !$0.isEmpty }
    .joined(separator: " | ")
  }

  private func openArtifact(_ artifact: CodexArtifact) {
    openPreview(
      PreviewTarget(
        id: artifact.id,
        name: artifact.name,
        kind: artifact.kind,
        mimeType: artifact.mimeType
      )
    )
  }

  private func openMessageAttachment(_ attachment: CodexMessageAttachment) {
    openPreview(
      PreviewTarget(
        id: attachment.id,
        name: attachment.name,
        kind: attachment.kind,
        mimeType: attachment.mimeType
      )
    )
  }

  private func openPreview(_ target: PreviewTarget) {
    if target.kind == "image" || target.kind == "text" {
      previewTarget = target
      return
    }

    do {
      let api = try settings.makeAPI()
      let url = try api.makeArtifactURL(artifactId: target.id)
      openURL(url)
    } catch {
      model.errorMessage = error.localizedDescription
    }
  }

  private func formatBytes(_ value: Int) -> String {
    let formatter = ByteCountFormatter()
    formatter.countStyle = .file
    return formatter.string(fromByteCount: Int64(value))
  }

  private var pendingStatusEvent: CodexEvent? {
    guard let session = model.session else {
      return nil
    }

    if session.messages.last?.role == "assistant" {
      return nil
    }

    let latestAssistantDate = session.messages
      .filter { $0.role == "assistant" }
      .map { DisplayTime.sortableDate($0.createdAt) }
      .max() ?? .distantPast

    let candidate = session.events
      .filter { shouldDisplayPendingStatus($0) }
      .max { lhs, rhs in
        DisplayTime.sortableDate(lhs.timestamp) < DisplayTime.sortableDate(rhs.timestamp)
      }

    guard let candidate else {
      return nil
    }

    let candidateDate = DisplayTime.sortableDate(candidate.timestamp)
    guard candidateDate > latestAssistantDate else {
      return nil
    }

    return candidate
  }

  private var scrollTargetId: String? {
    if let pendingStatusEvent {
      return "pending-status-\(pendingStatusEvent.id)"
    }
    return model.session?.messages.last.map { "message-\($0.id)" }
  }

  private func shouldDisplayPendingStatus(_ event: CodexEvent) -> Bool {
    switch event.type {
    case "status", "error":
      return !statusEventDetail(event).isEmpty
    default:
      return false
    }
  }

  private func statusEventDetail(_ event: CodexEvent) -> String {
    switch event.type {
    case "status":
      return (event.payload.text ?? event.payload.status ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    case "error":
      return (event.payload.message ?? event.payload.text ?? "任务执行失败").trimmingCharacters(in: .whitespacesAndNewlines)
    case "done":
      return (event.payload.status ?? "任务已结束").trimmingCharacters(in: .whitespacesAndNewlines)
    default:
      return ""
    }
  }

  private func formatDisplayTime(_ rawValue: String?) -> String {
    DisplayTime.text(rawValue)
  }

  private func sendMessage() {
    let canSend = !model.isSending
      && (
        !model.draftMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
          || !model.pendingAttachments.isEmpty
      )
    guard canSend else {
      return
    }

    isComposerFocused = false
    Task {
      await model.send(using: settings)
    }
  }
}

private struct PreviewTarget: Identifiable {
  let id: String
  let name: String
  let kind: String?
  let mimeType: String?
}

private struct ArtifactPreviewSheet: View {
  @Environment(\.dismiss) private var dismiss
  @EnvironmentObject private var settings: AppSettingsStore

  let target: PreviewTarget

  @State private var textPreview: ArtifactTextPreview?
  @State private var previewError = ""
  @State private var imageURL: URL?
  @State private var isLoading = false

  var body: some View {
    NavigationStack {
      Group {
        if target.kind == "image" {
          imagePreview
        } else if target.kind == "text" {
          textPreviewView
        } else {
          UnavailableStateView(
            "暂不支持预览",
            systemImage: "doc",
            description: Text("当前文件类型会继续使用系统外部打开。")
          )
        }
      }
      .navigationTitle(target.name)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button("关闭") {
            dismiss()
          }
        }
      }
      .task {
        await loadPreview()
      }
    }
  }

  @ViewBuilder
  private var imagePreview: some View {
    if let imageURL {
      ZStack {
        Color.black.opacity(0.96).ignoresSafeArea()
        AsyncImage(url: imageURL) { phase in
          switch phase {
          case let .success(image):
            image
              .resizable()
              .scaledToFit()
              .padding()
          case let .failure(error):
            VStack(spacing: 10) {
              Image(systemName: "exclamationmark.triangle")
                .font(.largeTitle)
              Text(error.localizedDescription)
                .multilineTextAlignment(.center)
            }
            .foregroundColor(.white)
            .padding(24)
          default:
            ProgressView("正在加载图片…")
              .tint(.white)
          }
        }
      }
    } else if !previewError.isEmpty {
      UnavailableStateView(
        "图片预览失败",
        systemImage: "photo",
        description: Text(previewError)
      )
    } else {
      ProgressView("正在准备图片…")
    }
  }

  @ViewBuilder
  private var textPreviewView: some View {
    if isLoading && textPreview == nil && previewError.isEmpty {
      ProgressView("正在加载文本预览…")
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    } else if let textPreview {
      ScrollView {
        VStack(alignment: .leading, spacing: 12) {
          if textPreview.truncated {
            Text("当前仅展示前 200 行或前 16000 个字符。")
              .font(.caption)
              .foregroundColor(.secondary)
          }

          Text(textPreview.text)
            .font(.system(.body, design: .monospaced))
            .frame(maxWidth: .infinity, alignment: .leading)
            .textSelection(.enabled)
        }
        .padding(16)
      }
      .background(Color(uiColor: .systemGroupedBackground))
    } else {
      UnavailableStateView(
        "文本预览失败",
        systemImage: "doc.plaintext",
        description: Text(previewError.isEmpty ? "没有拿到预览内容。" : previewError)
      )
    }
  }

  private func loadPreview() async {
    isLoading = true
    defer { isLoading = false }

    do {
      let api = try settings.makeAPI()
      if target.kind == "image" {
        imageURL = try api.makeArtifactURL(artifactId: target.id)
        previewError = ""
        return
      }

      if target.kind == "text" {
        textPreview = try await api.fetchArtifactTextPreview(artifactId: target.id)
        previewError = ""
      }
    } catch {
      previewError = error.localizedDescription
    }
  }
}

private struct MessageBubble: View {
  let message: CodexMessage
  let iconName: (String?) -> String
  let formatBytes: (Int) -> String
  let openAttachment: (CodexMessageAttachment) -> Void
  let formatTime: (String) -> String

  var body: some View {
    HStack {
      if message.role == "assistant" {
        bubble
        Spacer(minLength: 36)
      } else {
        Spacer(minLength: 36)
        bubble
      }
    }
  }

  private var bubble: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(message.role == "assistant" ? "Codex" : "你")
        .font(.caption.weight(.semibold))
        .foregroundColor(titleColor)
      MarkdownMessageText(message.text)
        .font(.body)
        .foregroundColor(bodyColor)
        .frame(maxWidth: .infinity, alignment: .leading)

      if !message.attachments.isEmpty {
        VStack(alignment: .leading, spacing: 6) {
          ForEach(message.attachments) { attachment in
            Button {
              openAttachment(attachment)
            } label: {
              HStack(spacing: 8) {
                Image(systemName: iconName(attachment.kind))
                VStack(alignment: .leading, spacing: 2) {
                  Text(attachment.name)
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
                  Text(formatBytes(attachment.size ?? 0))
                    .font(.caption2)
                    .foregroundColor(metaColor)
                }
                Spacer(minLength: 0)
              }
              .padding(.horizontal, 10)
              .padding(.vertical, 8)
              .background(attachmentBackgroundColor)
              .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            .buttonStyle(.plain)
          }
        }
      }

      Text(formatTime(message.createdAt))
        .font(.caption2)
        .foregroundColor(metaColor)
    }
    .padding(12)
    .background(bubbleBackgroundColor)
    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    .textSelection(.enabled)
  }

  private var titleColor: Color {
    message.role == "assistant" ? .secondary : .white.opacity(0.86)
  }

  private var bodyColor: Color {
    message.role == "assistant" ? .primary : .white
  }

  private var metaColor: Color {
    message.role == "assistant" ? .secondary : .white.opacity(0.72)
  }

  private var attachmentBackgroundColor: Color {
    message.role == "assistant" ? Color(.tertiarySystemBackground) : Color.white.opacity(0.14)
  }

  private var bubbleBackgroundColor: Color {
    message.role == "assistant" ? Color(.secondarySystemBackground) : .orange
  }
}

private struct StatusEventBubble: View {
  let event: CodexEvent
  let detail: String
  let formatTime: (String) -> String

  var body: some View {
    HStack {
      VStack(alignment: .leading, spacing: 8) {
        HStack(spacing: 8) {
          if event.type == "status" {
            ProgressView()
              .controlSize(.small)
          } else {
            Image(systemName: iconName)
              .foregroundColor(tintColor)
          }

          Text(title)
            .font(.caption.weight(.semibold))
            .foregroundColor(tintColor)
        }

        Text(detail)
          .font(.footnote)
          .foregroundColor(.primary)
          .frame(maxWidth: .infinity, alignment: .leading)

        Text(formatTime(event.timestamp))
          .font(.caption2)
          .foregroundColor(.secondary)
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 10)
      .background(Color(uiColor: .secondarySystemBackground))
      .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))

      Spacer(minLength: 48)
    }
    .textSelection(.enabled)
  }

  private var title: String {
    switch event.type {
    case "status":
      return "执行中"
    case "error":
      return "执行失败"
    case "done":
      return "执行完成"
    default:
      return "状态更新"
    }
  }

  private var iconName: String {
    switch event.type {
    case "error":
      return "exclamationmark.circle.fill"
    case "done":
      return "checkmark.circle.fill"
    default:
      return "clock.fill"
    }
  }

  private var tintColor: Color {
    switch event.type {
    case "status":
      return .orange
    case "error":
      return .red
    case "done":
      return .green
    default:
      return .secondary
    }
  }
}

private struct MarkdownMessageText: View {
  let rawText: String

  init(_ rawText: String) {
    self.rawText = rawText
  }

  var body: some View {
    renderedText
      .textSelection(.enabled)
  }

  private var renderedText: Text {
    guard let attributed = try? AttributedString(
      markdown: rawText,
      options: AttributedString.MarkdownParsingOptions(
        interpretedSyntax: .full,
        failurePolicy: .returnPartiallyParsedIfPossible
      )
    ) else {
      return Text(rawText)
    }

    return Text(attributed)
  }
}
