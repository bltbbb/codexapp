import Foundation

struct ServerConfiguration {
  let baseURL: URL
  let accessToken: String
}

enum CodexAPIError: LocalizedError {
  case invalidConfiguration(String)
  case invalidResponse
  case server(String)

  var errorDescription: String? {
    switch self {
    case let .invalidConfiguration(message):
      return message
    case .invalidResponse:
      return "服务端返回了无法识别的数据"
    case let .server(message):
      return message
    }
  }
}

struct SessionsResponse: Decodable {
  let sessions: [CodexSessionSummary]
}

struct SessionEnvelope: Decodable {
  let session: CodexSession
}

struct CreateSessionEnvelope: Decodable {
  let session: CodexSession
}

struct SendMessageEnvelope: Decodable {
  let session: CodexSession?
}

struct StopSessionEnvelope: Decodable {
  let ok: Bool
}

struct PushDevicesEnvelope: Decodable {
  let push: PushServiceStatus
  let devices: [PushDevice]
}

struct PushRegisterEnvelope: Decodable {
  let ok: Bool
  let device: PushDevice?
  let push: PushServiceStatus?
}

struct ArtifactTextPreview: Decodable {
  let name: String
  let path: String
  let truncated: Bool
  let text: String
}

struct ProjectTreeDirectoryResponse: Decodable {
  let rootName: String
  let workdir: String
  let currentPath: String
  let truncated: Bool
  let entries: [ProjectTreeEntry]
}

struct ProjectTreeEntry: Decodable, Identifiable, Hashable {
  let name: String
  let relativePath: String
  let type: String
  let size: Int?
  let mimeType: String?
  let kind: String?

  var id: String { relativePath }
  var isDirectory: Bool { type == "directory" }
}

struct ProjectFilePreview: Decodable, Identifiable, Hashable {
  let name: String
  let relativePath: String
  let truncated: Bool
  let text: String

  var id: String { relativePath }
}

struct PushRegisterRequest: Encodable {
  let deviceId: String
  let deviceToken: String
  let deviceName: String
  let bundleId: String
  let appVersion: String
  let tailscaleIdentity: String
  let pushEnabled: Bool
  let notifyOnCompleted: Bool
  let notifyOnError: Bool
  let environment: String
}

struct SendMessageRequest: Encodable {
  let message: String
  let attachments: [AttachmentUploadPayload]
}

struct CodexTokenUsageBreakdown: Decodable, Hashable {
  let inputTokens: Int
  let cachedInputTokens: Int
  let outputTokens: Int
  let reasoningOutputTokens: Int
  let totalTokens: Int
}

struct CodexTokenUsage: Decodable, Hashable {
  let updatedAt: String?
  let modelContextWindow: Int?
  let contextTokens: Int?
  let remainingTokens: Int?
  let contextUsagePercent: Double?
  let total: CodexTokenUsageBreakdown?
  let last: CodexTokenUsageBreakdown?
}

struct CodexSessionSummary: Decodable, Identifiable, Hashable {
  let id: String
  let title: String
  let source: String
  let status: String
  let preview: String
  let updatedAt: String
  let createdAt: String
  let lastActivityAt: String?
  let workdir: String?
  let codexThreadId: String?
  let lastError: String?
  let model: String?
  let reasoningEffort: String?
  let tokenUsage: CodexTokenUsage?
}

struct CodexSession: Decodable, Identifiable, Hashable {
  let id: String
  let title: String
  let source: String
  var status: String
  var preview: String
  let updatedAt: String
  let createdAt: String
  let lastActivityAt: String?
  let workdir: String?
  let codexThreadId: String?
  var model: String?
  var reasoningEffort: String?
  var tokenUsage: CodexTokenUsage?
  var lastError: String?
  var lastReply: String?
  var messages: [CodexMessage]
  var events: [CodexEvent]
  var artifacts: [CodexArtifact]
  var canStop: Bool
}

struct CodexMessage: Decodable, Identifiable, Hashable {
  let id: String
  let role: String
  let text: String
  let createdAt: String
  let attachments: [CodexMessageAttachment]
}

struct CodexMessageAttachment: Decodable, Identifiable, Hashable {
  let id: String
  let name: String
  let size: Int?
  let mimeType: String?
  let kind: String?
  let createdAt: String?
}

struct CodexArtifact: Decodable, Identifiable, Hashable {
  let id: String
  let name: String
  let kind: String?
  let mimeType: String?
  let createdAt: String?
  let size: Int?
  let source: String?
}

struct CodexEvent: Decodable, Identifiable, Hashable {
  let id: String
  let type: String
  let sessionId: String
  let timestamp: String
  let payload: CodexEventPayload
}

struct CodexEventPayload: Decodable, Hashable {
  let text: String?
  let message: String?
  let status: String?
  let model: String?
  let sessionId: String?
  let runId: String?
  let artifact: CodexArtifact?
}

struct PushServiceStatus: Decodable, Hashable {
  let serviceEnabled: Bool
  let configured: Bool
  let environment: String
  let bundleId: String?
  let deviceCount: Int
  let enabledDeviceCount: Int
}

struct PushDevice: Decodable, Identifiable, Hashable {
  let id: String
  let deviceId: String
  let deviceName: String
  let bundleId: String
  let appVersion: String?
  let tailscaleIdentity: String?
  let pushEnabled: Bool
  let notifyOnCompleted: Bool
  let notifyOnError: Bool
  let environment: String
  let tokenMasked: String?
  let invalidatedAt: String?
}

struct AttachmentUploadPayload: Encodable, Hashable {
  let name: String
  let size: Int
  let mimeType: String
  let kind: String
  let dataBase64: String
}

struct DraftAttachment: Identifiable, Hashable {
  let id: String
  let name: String
  let size: Int
  let mimeType: String
  let kind: String
  let dataBase64: String
}
