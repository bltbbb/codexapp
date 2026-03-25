import Foundation

struct AnyEncodable: Encodable {
  private let encodeBlock: (Encoder) throws -> Void

  init<T: Encodable>(_ wrapped: T) {
    self.encodeBlock = wrapped.encode
  }

  func encode(to encoder: Encoder) throws {
    try encodeBlock(encoder)
  }
}

struct APIErrorEnvelope: Decodable {
  let error: String?
}

final class CodexAPI {
  private let configuration: ServerConfiguration
  private let encoder = JSONEncoder()
  private let decoder = JSONDecoder()

  init(configuration: ServerConfiguration) {
    self.configuration = configuration
  }

  func listSessions() async throws -> [CodexSessionSummary] {
    let response: SessionsResponse = try await request(path: "/api/sessions")
    return response.sessions
  }

  func createSession() async throws -> CodexSession {
    let response: CreateSessionEnvelope = try await request(
      path: "/api/sessions",
      method: "POST",
      body: AnyEncodable([String: String]())
    )
    return response.session
  }

  func loadSession(id: String) async throws -> CodexSession {
    let response: SessionEnvelope = try await request(path: "/api/sessions/\(id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id)?messageLimit=60")
    return response.session
  }

  func sendMessage(sessionId: String, text: String, attachments: [AttachmentUploadPayload] = []) async throws -> CodexSession? {
    debugPrint("[ios-send][api] chars=\(text.count) lines=\(debugLineCount(text)) preview=\(debugPreview(text))")
    let response: SendMessageEnvelope = try await request(
      path: "/api/sessions/\(sessionId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? sessionId)/messages",
      method: "POST",
      body: AnyEncodable(SendMessageRequest(message: text, attachments: attachments))
    )
    return response.session
  }

  func stopSession(sessionId: String) async throws -> Bool {
    let response: StopSessionEnvelope = try await request(
      path: "/api/sessions/\(sessionId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? sessionId)/stop",
      method: "POST",
      body: AnyEncodable([String: String]())
    )
    return response.ok
  }

  func fetchPushDevices() async throws -> PushDevicesEnvelope {
    try await request(path: "/api/push/devices")
  }

  func registerPushDevice(_ payload: PushRegisterRequest) async throws -> PushRegisterEnvelope {
    try await request(
      path: "/api/push/register",
      method: "POST",
      body: AnyEncodable(payload)
    )
  }

  func makeStreamRequest(sessionId: String) throws -> URLRequest {
    var request = URLRequest(url: try makeURL(path: "/api/sessions/\(sessionId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? sessionId)/stream"))
    request.httpMethod = "GET"
    request.setValue(configuration.accessToken, forHTTPHeaderField: "x-access-token")
    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
    request.timeoutInterval = 300
    return request
  }

  func makeArtifactURL(artifactId: String) throws -> URL {
    let encodedId = artifactId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? artifactId
    let encodedToken = configuration.accessToken.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? configuration.accessToken
    return try makeURL(path: "/api/files/\(encodedId)?token=\(encodedToken)")
  }

  func fetchArtifactTextPreview(artifactId: String) async throws -> ArtifactTextPreview {
    let encodedId = artifactId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? artifactId
    return try await request(path: "/api/files/\(encodedId)?preview=1")
  }

  func fetchProjectTree(sessionId: String, relativePath: String = "") async throws -> ProjectTreeDirectoryResponse {
    let encodedSessionId = sessionId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? sessionId
    let encodedPath = relativePath.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? relativePath
    return try await request(path: "/api/sessions/\(encodedSessionId)/project-tree?path=\(encodedPath)")
  }

  func fetchProjectFilePreview(sessionId: String, relativePath: String) async throws -> ProjectFilePreview {
    let encodedSessionId = sessionId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? sessionId
    let encodedPath = relativePath.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? relativePath
    return try await request(path: "/api/sessions/\(encodedSessionId)/project-file?path=\(encodedPath)")
  }

  private func request<T: Decodable>(
    path: String,
    method: String = "GET",
    body: AnyEncodable? = nil
  ) async throws -> T {
    var request = URLRequest(url: try makeURL(path: path))
    request.httpMethod = method
    request.setValue(configuration.accessToken, forHTTPHeaderField: "x-access-token")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")

    if let body {
      request.httpBody = try encoder.encode(body)
      if path.contains("/messages"), let bodyText = String(data: request.httpBody ?? Data(), encoding: .utf8) {
        debugPrint("[ios-send][http-body] chars=\(bodyText.count) preview=\(debugPreview(bodyText))")
      }
    }

    let (data, response) = try await URLSession.shared.data(for: request)
    guard let httpResponse = response as? HTTPURLResponse else {
      throw CodexAPIError.invalidResponse
    }

    guard (200 ..< 300).contains(httpResponse.statusCode) else {
      let envelope = try? decoder.decode(APIErrorEnvelope.self, from: data)
      throw CodexAPIError.server(envelope?.error ?? "请求失败：\(httpResponse.statusCode)")
    }

    do {
      return try decoder.decode(T.self, from: data)
    } catch {
      throw CodexAPIError.invalidResponse
    }
  }

  private func makeURL(path: String) throws -> URL {
    let normalizedPath = path.hasPrefix("/") ? path : "/\(path)"
    guard var components = URLComponents(url: configuration.baseURL, resolvingAgainstBaseURL: false) else {
      throw CodexAPIError.invalidConfiguration("服务地址无法解析")
    }

    let pathPart: String
    let queryPart: String?

    if let queryIndex = normalizedPath.firstIndex(of: "?") {
      pathPart = String(normalizedPath[..<queryIndex])
      queryPart = String(normalizedPath[normalizedPath.index(after: queryIndex)...])
    } else {
      pathPart = normalizedPath
      queryPart = nil
    }

    let basePath = components.path.hasSuffix("/") ? String(components.path.dropLast()) : components.path
    components.path = "\(basePath)\(pathPart)"
    components.percentEncodedQuery = queryPart

    guard let url = components.url else {
      throw CodexAPIError.invalidConfiguration("服务地址无法拼接")
    }

    return url
  }

  private func debugLineCount(_ text: String) -> Int {
    max(1, text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n").count)
  }

  private func debugPreview(_ text: String, limit: Int = 160) -> String {
    let normalized = text
      .replacingOccurrences(of: "\r", with: "\\r")
      .replacingOccurrences(of: "\n", with: "\\n")
      .replacingOccurrences(of: "\t", with: "\\t")
    return normalized.count > limit ? String(normalized.prefix(limit)) + "…" : normalized
  }
}
