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
  @State private var selectedPhotoItems: [PhotosPickerItem] = []
  @State private var showingFileImporter = false
  @State private var previewTarget: PreviewTarget?
  @State private var activePanel: SessionPanel?

  init(sessionId: String) {
    _model = StateObject(wrappedValue: SessionDetailViewModel(sessionId: sessionId))
  }

  var body: some View {
    VStack(spacing: 0) {
      header

      Divider()
      messageList
    }
    .safeAreaInset(edge: .bottom) {
      composer
        .background(.ultraThinMaterial)
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
    .sheet(item: $activePanel) { panel in
      NavigationStack {
        Group {
          if panel == .events {
            eventList
          } else if panel == .artifacts {
            artifactList
          } else {
            ProjectTreeSheet(sessionId: model.sessionId)
              .environmentObject(settings)
          }
        }
        .navigationTitle(panel.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .topBarLeading) {
            Button("关闭") {
              activePanel = nil
            }
          }
        }
      }
    }
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 10) {
        Label(streamText, systemImage: streamIcon)
          .font(.caption.weight(.semibold))
          .foregroundColor(streamColor)
          .padding(.horizontal, 10)
          .padding(.vertical, 5)
          .background(streamColor.opacity(0.15), in: Capsule())

        Text(statusText)
          .font(.caption.weight(.medium))
          .foregroundColor(.secondary)

        if model.streamState == "reconnecting" {
          Text("第 \(max(model.reconnectAttempt, 1)) 次重连")
            .font(.caption2.weight(.medium))
            .foregroundColor(.secondary)
        }

        Spacer()

        Button {
          activePanel = .events
        } label: {
          Image(systemName: "list.bullet.rectangle")
            .font(.system(size: 18, weight: .semibold))
        }
        .buttonStyle(.plain)
        .foregroundColor(.secondary)
        .accessibilityLabel("查看事件")

        Button {
          activePanel = .artifacts
        } label: {
          Image(systemName: "shippingbox")
            .font(.system(size: 18, weight: .semibold))
        }
        .buttonStyle(.plain)
        .foregroundColor(.secondary)
        .accessibilityLabel("查看产物")

        Button {
          activePanel = .projectTree
        } label: {
          Image(systemName: "folder")
            .font(.system(size: 18, weight: .semibold))
        }
        .buttonStyle(.plain)
        .foregroundColor(.secondary)
        .accessibilityLabel("查看项目树")
      }
    }
    .padding(.horizontal, 16)
    .padding(.top, 14)
    .padding(.bottom, 14)
    .background(.regularMaterial)
  }

  private var composer: some View {
    VStack(spacing: 12) {
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
              .background(Color.white.opacity(0.92))
              .clipShape(Capsule())
              .overlay(
                Capsule()
                  .stroke(Color.black.opacity(0.04), lineWidth: 1)
              )
            }
          }
        }
      }

      VStack(spacing: 12) {
        ZStack(alignment: .leading) {
          if model.draftMessage.isEmpty {
            Text("Type a message for AI")
              .font(.system(size: 20, weight: .medium))
              .foregroundColor(.secondary.opacity(0.8))
              .padding(.horizontal, 28)
              .padding(.vertical, 20)
          }

          TextEditor(text: $model.draftMessage)
            .focused($isComposerFocused)
            .font(.system(size: 20, weight: .medium))
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .scrollContentBackground(.hidden)
            .frame(minHeight: 66, maxHeight: 148)
            .padding(.horizontal, 18)
            .padding(.vertical, 10)
            .background(Color.clear)
        }
        .background(Color.white.opacity(0.95))
        .clipShape(RoundedRectangle(cornerRadius: 30, style: .continuous))
        .shadow(color: Color.black.opacity(0.06), radius: 20, x: 0, y: 10)

        HStack(spacing: 14) {
          PhotosPicker(
            selection: $selectedPhotoItems,
            maxSelectionCount: 3,
            matching: .images
          ) {
            composerToolIcon("photo")
          }
          .buttonStyle(.plain)

          Button {
            showingFileImporter = true
          } label: {
            composerToolIcon("plus")
          }
          .buttonStyle(.plain)

          Spacer(minLength: 0)

          Button {
            sendMessage()
          } label: {
            ZStack {
              Circle()
                .fill(sendButtonBackground)
                .frame(width: 58, height: 58)

              if model.isSending {
                ProgressView()
                  .tint(sendButtonForeground)
              } else {
                Image(systemName: "arrow.up")
                  .font(.system(size: 24, weight: .medium))
                  .foregroundColor(sendButtonForeground)
              }
            }
          }
          .buttonStyle(.plain)
          .disabled(sendButtonDisabled)
        }
      }
      .padding(.horizontal, 16)
      .padding(.top, 16)
      .padding(.bottom, 12)
      .background(Color.white.opacity(0.78))
      .clipShape(RoundedRectangle(cornerRadius: 34, style: .continuous))
      .shadow(color: Color.black.opacity(0.08), radius: 24, x: 0, y: 10)
    }
    .padding(.horizontal, 16)
    .padding(.top, 10)
    .padding(.bottom, 12)
    .background(
      LinearGradient(
        colors: [
          Color.white.opacity(0.94),
          Color(uiColor: .systemGray6),
        ],
        startPoint: .top,
        endPoint: .bottom
      )
    )
    .onChange(of: selectedPhotoItems) { newItems in
      let captured = newItems
      selectedPhotoItems = []
      Task {
        await loadPhotoAttachments(captured)
      }
    }
    .fileImporter(
      isPresented: $showingFileImporter,
      allowedContentTypes: supportedImportContentTypes,
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

  private func composerToolIcon(_ systemName: String) -> some View {
    ZStack {
      Circle()
        .fill(Color.black.opacity(0.04))
        .frame(width: 46, height: 46)

      Image(systemName: systemName)
        .font(.system(size: 21, weight: .medium))
        .foregroundColor(.primary)
    }
  }

  private var sendButtonDisabled: Bool {
    model.isSending || (model.draftMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && model.pendingAttachments.isEmpty)
  }

  private var sendButtonBackground: Color {
    sendButtonDisabled ? Color.black.opacity(0.10) : Color.black.opacity(0.88)
  }

  private var sendButtonForeground: Color {
    sendButtonDisabled ? .secondary : .white
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

  private var supportedImportContentTypes: [UTType] {
    [
      .content,
      .data,
      .plainText,
      .text,
      .utf8PlainText,
      .json,
      .xml,
      .commaSeparatedText,
      .pdf,
      .archive,
      .zip,
      .image,
      .movie,
      .audio
    ]
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
              imageURL: messageAttachmentImageURL(_:),
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
      .simultaneousGesture(
        TapGesture().onEnded {
          isComposerFocused = false
        }
      )
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
    .simultaneousGesture(
      TapGesture().onEnded {
        isComposerFocused = false
      }
    )
  }

  private var artifactList: some View {
    List {
      if (model.session?.artifacts ?? []).isEmpty {
        Text("还没有产物")
          .foregroundColor(.secondary)
      } else {
        ForEach(model.session?.artifacts ?? []) { artifact in
          Button {
            openArtifactFromPanel(artifact)
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
    .simultaneousGesture(
      TapGesture().onEnded {
        isComposerFocused = false
      }
    )
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

  private func openArtifactFromPanel(_ artifact: CodexArtifact) {
    activePanel = nil
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
      openArtifact(artifact)
    }
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
    if target.isImage || target.isText {
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

  private func messageAttachmentImageURL(_ attachment: CodexMessageAttachment) -> URL? {
    guard isImageAttachment(attachment.kind, mimeType: attachment.mimeType, name: attachment.name) else {
      return nil
    }

    do {
      let api = try settings.makeAPI()
      return try api.makeArtifactURL(artifactId: attachment.id)
    } catch {
      return nil
    }
  }

  private func isImageAttachment(_ kind: String?, mimeType: String?, name: String) -> Bool {
    if kind == "image" {
      return true
    }

    if mimeType?.hasPrefix("image/") == true {
      return true
    }

    let normalizedName = name.lowercased()
    return [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".svg", ".heic", ".heif"]
      .contains { normalizedName.hasSuffix($0) }
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

    let candidate = session.events
      .filter { shouldDisplayPendingStatus($0) }
      .max { lhs, rhs in
        DisplayTime.sortableDate(lhs.timestamp) < DisplayTime.sortableDate(rhs.timestamp)
      }

    guard let candidate else {
      return nil
    }

    let candidateDate = DisplayTime.sortableDate(candidate.timestamp)
    let latestDoneDate = session.events
      .filter { $0.type == "done" }
      .map { DisplayTime.sortableDate($0.timestamp) }
      .max() ?? .distantPast

    guard candidateDate > latestDoneDate else {
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

    debugPrint("[ios-send][view] chars=\(model.draftMessage.count) lines=\(debugLineCount(model.draftMessage)) preview=\(debugPreview(model.draftMessage))")
    isComposerFocused = false
    Task {
      await model.send(using: settings)
    }
  }

  private func debugLineCount(_ text: String) -> Int {
    max(1, text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n").count)
  }

  private func debugPreview(_ text: String, limit: Int = 120) -> String {
    let normalized = text
      .replacingOccurrences(of: "\r", with: "\\r")
      .replacingOccurrences(of: "\n", with: "\\n")
      .replacingOccurrences(of: "\t", with: "\\t")
    return normalized.count > limit ? String(normalized.prefix(limit)) + "…" : normalized
  }
}

private enum SessionPanel: String, Identifiable {
  case events
  case artifacts
  case projectTree

  var id: String { rawValue }

  var title: String {
    switch self {
    case .events:
      return "事件"
    case .artifacts:
      return "产物"
    case .projectTree:
      return "项目树"
    }
  }
}

private struct PreviewTarget: Identifiable {
  let id: String
  let name: String
  let kind: String?
  let mimeType: String?

  var isImage: Bool {
    if kind == "image" {
      return true
    }

    if mimeType?.hasPrefix("image/") == true {
      return true
    }

    let normalizedName = name.lowercased()
    return [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".svg", ".heic", ".heif"]
      .contains { normalizedName.hasSuffix($0) }
  }

  var isText: Bool {
    if kind == "text" {
      return true
    }

    if mimeType?.hasPrefix("text/") == true {
      return true
    }

    let normalizedName = name.lowercased()
    return [".md", ".txt", ".log", ".json", ".yml", ".yaml", ".xml", ".csv", ".js", ".ts", ".swift", ".py"]
      .contains { normalizedName.hasSuffix($0) }
  }
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
        if target.isImage {
          imagePreview
        } else if target.isText {
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
      if target.isImage {
        imageURL = try api.makeArtifactURL(artifactId: target.id)
        previewError = ""
        return
      }

      if target.isText {
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
  let imageURL: (CodexMessageAttachment) -> URL?
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
      SelectableMarkdownTextView(
        rawText: message.text,
        textColor: UIColor(bodyColor)
      )
        .frame(maxWidth: .infinity, alignment: .leading)

      if !imageAttachments.isEmpty {
        VStack(alignment: .leading, spacing: 8) {
          ForEach(imageAttachments) { attachment in
            Button {
              openAttachment(attachment)
            } label: {
              MessageImageThumbnail(
                attachment: attachment,
                imageURL: imageURL(attachment),
                metaText: formatBytes(attachment.size ?? 0),
                isAssistant: message.role == "assistant"
              )
            }
            .buttonStyle(.plain)
          }
        }
      }

      if !nonImageAttachments.isEmpty {
        VStack(alignment: .leading, spacing: 6) {
          ForEach(nonImageAttachments) { attachment in
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
    .padding(14)
    .background(
      Group {
        if message.role == "assistant" {
          RoundedRectangle(cornerRadius: 20, style: .continuous)
            .fill(Color(uiColor: .secondarySystemGroupedBackground))
            .shadow(color: Color.black.opacity(0.04), radius: 6, x: 0, y: 2)
        } else {
          RoundedRectangle(cornerRadius: 20, style: .continuous)
            .fill(
              LinearGradient(
                colors: [Color.orange, Color.orange.opacity(0.8)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
              )
            )
            .shadow(color: Color.orange.opacity(0.3), radius: 8, x: 0, y: 4)
        }
      }
    )
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

  private var imageAttachments: [CodexMessageAttachment] {
    message.attachments.filter { attachment in
      if attachment.kind == "image" {
        return true
      }
      if attachment.mimeType?.hasPrefix("image/") == true {
        return true
      }

      let normalizedName = attachment.name.lowercased()
      return [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".svg", ".heic", ".heif"]
        .contains { normalizedName.hasSuffix($0) }
    }
  }

  private var nonImageAttachments: [CodexMessageAttachment] {
    message.attachments.filter { attachment in
      !imageAttachments.contains(attachment)
    }
  }
}

private struct MessageImageThumbnail: View {
  let attachment: CodexMessageAttachment
  let imageURL: URL?
  let metaText: String
  let isAssistant: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      ZStack {
        RoundedRectangle(cornerRadius: 16, style: .continuous)
          .fill(thumbnailBackground)

        if let imageURL {
          AsyncImage(url: imageURL) { phase in
            switch phase {
            case let .success(image):
              image
                .resizable()
                .scaledToFill()
            case .failure:
              fallbackContent(systemImage: "photo", text: "图片加载失败")
            default:
              ProgressView()
                .tint(progressTint)
            }
          }
        } else {
          fallbackContent(systemImage: "photo", text: "图片不可用")
        }
      }
      .frame(width: 220, height: 156)
      .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: 16, style: .continuous)
          .stroke(borderColor, lineWidth: 1)
      )

      VStack(alignment: .leading, spacing: 2) {
        Text(attachment.name)
          .font(.caption.weight(.semibold))
          .foregroundColor(textColor)
          .lineLimit(1)
        Text(metaText)
          .font(.caption2)
          .foregroundColor(metaColor)
      }
    }
  }

  @ViewBuilder
  private func fallbackContent(systemImage: String, text: String) -> some View {
    VStack(spacing: 8) {
      Image(systemName: systemImage)
        .font(.title2)
      Text(text)
        .font(.caption)
    }
    .foregroundColor(metaColor)
  }

  private var thumbnailBackground: Color {
    isAssistant ? Color(.tertiarySystemBackground) : Color.white.opacity(0.14)
  }

  private var borderColor: Color {
    isAssistant ? Color.black.opacity(0.06) : Color.white.opacity(0.18)
  }

  private var textColor: Color {
    isAssistant ? .primary : .white
  }

  private var metaColor: Color {
    isAssistant ? .secondary : .white.opacity(0.72)
  }

  private var progressTint: Color {
    isAssistant ? .secondary : .white
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
