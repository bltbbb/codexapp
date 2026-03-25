import Foundation
import UniformTypeIdentifiers

@MainActor
final class SessionDetailViewModel: ObservableObject {
  @Published var session: CodexSession?
  @Published var draftMessage: String = ""
  @Published var isLoading = false
  @Published var isSending = false
  @Published var streamState: String = "idle"
  @Published var errorMessage: String = ""
  @Published var reconnectAttempt: Int = 0
  @Published var pendingAttachments: [DraftAttachment] = []

  let sessionId: String
  private var streamTask: Task<Void, Never>?
  private let maxAttachmentCount = 6
  private let maxAttachmentBytes = 10 * 1024 * 1024

  init(sessionId: String) {
    self.sessionId = sessionId
  }

  func load(using settings: AppSettingsStore, keepStream: Bool = false) async {
    isLoading = true
    defer { isLoading = false }

    do {
      let api = try settings.makeAPI()
      session = try await api.loadSession(id: sessionId)
      errorMessage = ""
      reconnectAttempt = 0
      if !keepStream {
        connectStream(using: settings, resetAttempt: true)
      }
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func send(using settings: AppSettingsStore) async {
    let message = draftMessage.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !message.isEmpty || !pendingAttachments.isEmpty else {
      return
    }

    debugPrint("[ios-send][vm] chars=\(message.count) lines=\(debugLineCount(message)) preview=\(debugPreview(message))")
    let currentAttachments = pendingAttachments
    isSending = true
    defer { isSending = false }

    do {
      let api = try settings.makeAPI()
      _ = try await api.sendMessage(
        sessionId: sessionId,
        text: message,
        attachments: currentAttachments.map {
          AttachmentUploadPayload(
            name: $0.name,
            size: $0.size,
            mimeType: $0.mimeType,
            kind: $0.kind,
            dataBase64: $0.dataBase64
          )
        }
      )
      draftMessage = ""
      pendingAttachments = []
      await load(using: settings, keepStream: true)
    } catch {
      errorMessage = error.localizedDescription
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

  func stop(using settings: AppSettingsStore) async {
    do {
      let api = try settings.makeAPI()
      _ = try await api.stopSession(sessionId: sessionId)
      await load(using: settings, keepStream: true)
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func disconnectStream() {
    disconnectStream(resetAttempt: true)
  }

  private func disconnectStream(resetAttempt: Bool) {
    streamTask?.cancel()
    streamTask = nil
    streamState = "idle"
    if resetAttempt {
      reconnectAttempt = 0
    }
  }

  func connectStream(using settings: AppSettingsStore, resetAttempt: Bool = true) {
    disconnectStream(resetAttempt: resetAttempt)

    let request: URLRequest
    do {
      let api = try settings.makeAPI()
      request = try api.makeStreamRequest(sessionId: sessionId)
    } catch {
      errorMessage = error.localizedDescription
      return
    }

    streamState = "connecting"
    if resetAttempt {
      reconnectAttempt = 0
    }
    streamTask = Task { [weak self] in
      guard let self else { return }

      do {
        let (bytes, response) = try await URLSession.shared.bytes(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
          throw CodexAPIError.invalidResponse
        }
        guard httpResponse.statusCode == 200 else {
          throw CodexAPIError.server("SSE 连接失败：\(httpResponse.statusCode)")
        }

        self.streamState = "online"

        for try await line in bytes.lines {
          if Task.isCancelled {
            return
          }

          guard line.hasPrefix("data: ") else {
            continue
          }

          let payload = String(line.dropFirst(6))
          guard let data = payload.data(using: .utf8) else {
            continue
          }

          if let event = try? JSONDecoder().decode(CodexEvent.self, from: data) {
            self.applyStreamEvent(event)
          }
        }
      } catch {
        if Task.isCancelled {
          return
        }
        self.streamState = "reconnecting"
        self.errorMessage = error.localizedDescription
        self.reconnectAttempt += 1
        let retryDelay = min(UInt64(max(2, self.reconnectAttempt * 2)), 12)
        try? await Task.sleep(nanoseconds: retryDelay * 1_000_000_000)
        if Task.isCancelled {
          return
        }
        self.connectStream(using: settings, resetAttempt: false)
      }
    }
  }

  private func applyStreamEvent(_ event: CodexEvent) {
    guard var session else {
      return
    }

    var events = session.events
    if !events.contains(where: { $0.id == event.id }) {
      events.append(event)
      session.events = Array(events.suffix(240))
    }

    if event.type == "status" {
      session.status = inferStatus(text: event.payload.text, fallback: session.status)
      session.canStop = session.status == "running"
    }

    if event.type == "message", let text = event.payload.text, !text.isEmpty {
      var messages = session.messages
      let exists = messages.contains(where: { $0.role == "assistant" && $0.text == text && $0.createdAt == event.timestamp })
      if !exists {
        messages.append(
          CodexMessage(
            id: UUID().uuidString,
            role: "assistant",
            text: text,
            createdAt: event.timestamp,
            attachments: []
          )
        )
      }
      session.messages = messages
      session.lastReply = text
    }

    if event.type == "artifact", let artifact = event.payload.artifact {
      var artifacts = session.artifacts
      if !artifacts.contains(where: { $0.id == artifact.id }) {
        artifacts.append(artifact)
      }
      session.artifacts = artifacts
    }

    if event.type == "error" {
      session.status = "error"
      session.lastError = event.payload.message ?? "任务执行失败"
      session.canStop = false
    }

    if event.type == "done" {
      let status = event.payload.status ?? "idle"
      session.status = status == "error" ? "error" : (status == "stopped" ? "stopped" : "idle")
      session.canStop = false
    }

    self.session = session
  }

  func removePendingAttachment(_ attachment: DraftAttachment) {
    pendingAttachments.removeAll { $0.id == attachment.id }
  }

  func addFileAttachments(urls: [URL]) async {
    guard !urls.isEmpty else {
      return
    }

    do {
      var drafts: [DraftAttachment] = []
      for url in urls {
        let scoped = url.startAccessingSecurityScopedResource()
        defer {
          if scoped {
            url.stopAccessingSecurityScopedResource()
          }
        }

        let data = try Data(contentsOf: url)
        let mimeType = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        drafts.append(try buildDraftAttachment(name: url.lastPathComponent, data: data, mimeType: mimeType))
      }
      try appendAttachments(drafts)
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func addPreparedAttachments(_ attachments: [PreparedAttachmentInput]) {
    do {
      let drafts = try attachments.map { input in
        try buildDraftAttachment(
          name: input.name,
          data: input.data,
          mimeType: input.mimeType
        )
      }
      try appendAttachments(drafts)
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func eventTitle(_ event: CodexEvent) -> String {
    switch event.type {
    case "message":
      return "回复"
    case "artifact":
      return "产物"
    case "error":
      return "异常"
    case "done":
      return "结束"
    default:
      return "状态"
    }
  }

  func eventBody(_ event: CodexEvent) -> String {
    if let message = event.payload.message, !message.isEmpty {
      return message
    }
    if let text = event.payload.text, !text.isEmpty {
      return text
    }
    if let artifact = event.payload.artifact {
      return "已生成产物：\(artifact.name)"
    }
    if let status = event.payload.status, !status.isEmpty {
      return "状态：\(status)"
    }
    return "事件已记录"
  }

  private func inferStatus(text: String?, fallback: String) -> String {
    let normalized = (text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if normalized.contains("停止") {
      return "stopped"
    }
    if normalized.contains("失败") || normalized.contains("异常") || normalized.contains("超时") {
      return "error"
    }
    if !normalized.isEmpty {
      return "running"
    }
    return fallback
  }

  private func appendAttachments(_ attachments: [DraftAttachment]) throws {
    var next = pendingAttachments

    for attachment in attachments {
      if next.contains(where: { $0.name == attachment.name && $0.size == attachment.size }) {
        continue
      }

      if next.count >= maxAttachmentCount {
        throw CodexAPIError.server("最多只能添加 6 个附件")
      }

      let totalBytes = next.reduce(0) { $0 + $1.size } + attachment.size
      if totalBytes > maxAttachmentBytes {
        throw CodexAPIError.server("附件总体积不能超过 10MB")
      }

      next.append(attachment)
    }

    pendingAttachments = next
    errorMessage = ""
  }

  private func buildDraftAttachment(name: String, data: Data, mimeType: String) throws -> DraftAttachment {
    let normalizedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalizedName.isEmpty else {
      throw CodexAPIError.server("附件名称不能为空")
    }

    return DraftAttachment(
      id: UUID().uuidString,
      name: normalizedName,
      size: data.count,
      mimeType: mimeType,
      kind: inferAttachmentKind(name: normalizedName, mimeType: mimeType),
      dataBase64: "data:\(mimeType);base64,\(data.base64EncodedString())"
    )
  }

  private func inferAttachmentKind(name: String, mimeType: String) -> String {
    let normalizedName = name.lowercased()
    let normalizedMime = mimeType.lowercased()

    if normalizedMime.hasPrefix("image/") || [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".svg"].contains(where: { normalizedName.hasSuffix($0) }) {
      return "image"
    }
    if normalizedMime.hasPrefix("text/") || [".txt", ".md", ".json", ".log", ".csv", ".html"].contains(where: { normalizedName.hasSuffix($0) }) {
      return "text"
    }
    if normalizedName.hasSuffix(".zip") {
      return "archive"
    }
    if [".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx"].contains(where: { normalizedName.hasSuffix($0) }) {
      return "document"
    }
    return "file"
  }
}

struct PreparedAttachmentInput {
  let name: String
  let data: Data
  let mimeType: String
}
