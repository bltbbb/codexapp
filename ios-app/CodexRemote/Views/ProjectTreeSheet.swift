import SwiftUI

struct ProjectTreeSheet: View {
  @EnvironmentObject private var settings: AppSettingsStore
  let sessionId: String

  @StateObject private var model = ProjectTreeViewModel()

  var body: some View {
    Group {
      if model.isLoading && model.visibleNodes.isEmpty {
        ProgressView("正在加载项目树…")
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else if !model.errorMessage.isEmpty && model.visibleNodes.isEmpty {
        UnavailableStateView(
          "项目树加载失败",
          systemImage: "folder",
          description: Text(model.errorMessage)
        )
      } else {
        List {
          if !model.workdir.isEmpty {
            Section {
              VStack(alignment: .leading, spacing: 6) {
                if !model.rootName.isEmpty {
                  Text(model.rootName)
                    .font(.headline)
                }
                Text(model.workdir)
                  .font(.caption)
                  .foregroundColor(.secondary)
                  .textSelection(.enabled)
              }
              .padding(.vertical, 4)
            }
          }

          if model.rootTruncated {
            Section {
              Text("根目录内容较多，当前仅展示前 400 项。")
                .font(.caption)
                .foregroundColor(.secondary)
            }
          }

          if !model.errorMessage.isEmpty {
            Section {
              Text(model.errorMessage)
                .font(.caption)
                .foregroundColor(.red)
            }
          }

          Section {
            ForEach(model.visibleNodes) { node in
              Button {
                Task {
                  await model.handleTap(node.entry, using: settings, sessionId: sessionId)
                }
              } label: {
                ProjectTreeRow(
                  entry: node.entry,
                  depth: node.depth,
                  isExpanded: model.expandedPaths.contains(node.entry.relativePath),
                  isLoading: model.loadingPaths.contains(node.entry.relativePath),
                  metaText: model.metaText(for: node.entry)
                )
              }
              .buttonStyle(.plain)
            }
          }
        }
        .listStyle(.insetGrouped)
      }
    }
    .task {
      await model.loadRoot(using: settings, sessionId: sessionId)
    }
    .sheet(item: $model.filePreview) { preview in
      ProjectFilePreviewSheet(preview: preview)
    }
  }
}

private struct ProjectTreeRow: View {
  let entry: ProjectTreeEntry
  let depth: Int
  let isExpanded: Bool
  let isLoading: Bool
  let metaText: String

  var body: some View {
    HStack(spacing: 10) {
      Color.clear
        .frame(width: CGFloat(depth) * 14, height: 1)

      if entry.isDirectory {
        Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
          .font(.caption.weight(.semibold))
          .foregroundColor(.secondary)
          .frame(width: 12)
      } else {
        Image(systemName: "doc.text")
          .foregroundColor(.secondary)
          .frame(width: 12)
      }

      Image(systemName: entry.isDirectory ? "folder" : fileIcon)
        .foregroundColor(entry.isDirectory ? .orange : .accentColor)
        .frame(width: 18)

      VStack(alignment: .leading, spacing: 3) {
        Text(entry.name)
          .foregroundColor(.primary)
          .lineLimit(1)

        if !metaText.isEmpty {
          Text(metaText)
            .font(.caption2)
            .foregroundColor(.secondary)
            .lineLimit(1)
        }
      }

      Spacer()

      if isLoading {
        ProgressView()
          .controlSize(.small)
      }
    }
    .padding(.vertical, 4)
    .contentShape(Rectangle())
  }

  private var fileIcon: String {
    switch entry.kind {
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
}

@MainActor
private final class ProjectTreeViewModel: ObservableObject {
  @Published var rootName = ""
  @Published var workdir = ""
  @Published var errorMessage = ""
  @Published var filePreview: ProjectFilePreview?
  @Published var isLoading = false
  @Published var rootTruncated = false
  @Published var expandedPaths: Set<String> = []
  @Published var loadingPaths: Set<String> = []

  private var entriesByParent: [String: [ProjectTreeEntry]] = [:]

  var visibleNodes: [VisibleProjectTreeNode] {
    buildVisibleNodes(parentPath: "", depth: 0)
  }

  func loadRoot(using settings: AppSettingsStore, sessionId: String) async {
    guard !isLoading else {
      return
    }

    isLoading = true
    defer { isLoading = false }

    do {
      let api = try settings.makeAPI()
      let response = try await api.fetchProjectTree(sessionId: sessionId)
      rootName = response.rootName
      workdir = response.workdir
      rootTruncated = response.truncated
      entriesByParent[""] = response.entries
      expandedPaths = []
      errorMessage = ""
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func handleTap(_ entry: ProjectTreeEntry, using settings: AppSettingsStore, sessionId: String) async {
    if entry.isDirectory {
      await toggleDirectory(entry, using: settings, sessionId: sessionId)
      return
    }

    await openFile(entry, using: settings, sessionId: sessionId)
  }

  func metaText(for entry: ProjectTreeEntry) -> String {
    if entry.isDirectory {
      return ""
    }

    let parts = [
      entry.kind ?? "file",
      formatBytes(entry.size),
    ]
    .filter { !$0.isEmpty }
    return parts.joined(separator: " | ")
  }

  private func toggleDirectory(_ entry: ProjectTreeEntry, using settings: AppSettingsStore, sessionId: String) async {
    if expandedPaths.contains(entry.relativePath) {
      expandedPaths.remove(entry.relativePath)
      return
    }

    if entriesByParent[entry.relativePath] == nil {
      loadingPaths.insert(entry.relativePath)
      defer { loadingPaths.remove(entry.relativePath) }

      do {
        let api = try settings.makeAPI()
        let response = try await api.fetchProjectTree(sessionId: sessionId, relativePath: entry.relativePath)
        entriesByParent[entry.relativePath] = response.entries
        errorMessage = ""
      } catch {
        errorMessage = error.localizedDescription
        return
      }
    }

    expandedPaths.insert(entry.relativePath)
  }

  private func openFile(_ entry: ProjectTreeEntry, using settings: AppSettingsStore, sessionId: String) async {
    do {
      let api = try settings.makeAPI()
      filePreview = try await api.fetchProjectFilePreview(sessionId: sessionId, relativePath: entry.relativePath)
      errorMessage = ""
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func buildVisibleNodes(parentPath: String, depth: Int) -> [VisibleProjectTreeNode] {
    let entries = entriesByParent[parentPath] ?? []
    var result: [VisibleProjectTreeNode] = []
    for entry in entries {
      result.append(VisibleProjectTreeNode(entry: entry, depth: depth))
      if entry.isDirectory && expandedPaths.contains(entry.relativePath) {
        result.append(contentsOf: buildVisibleNodes(parentPath: entry.relativePath, depth: depth + 1))
      }
    }
    return result
  }

  private func formatBytes(_ value: Int?) -> String {
    guard let value else {
      return ""
    }
    let formatter = ByteCountFormatter()
    formatter.countStyle = .file
    return formatter.string(fromByteCount: Int64(value))
  }
}

private struct VisibleProjectTreeNode: Identifiable {
  let entry: ProjectTreeEntry
  let depth: Int

  var id: String { entry.id }
}

private struct ProjectFilePreviewSheet: View {
  @Environment(\.dismiss) private var dismiss
  let preview: ProjectFilePreview

  var body: some View {
    NavigationStack {
      VStack(alignment: .leading, spacing: 0) {
        VStack(alignment: .leading, spacing: 8) {
          Text(preview.relativePath)
            .font(.caption.monospaced())
            .foregroundColor(.secondary)
            .textSelection(.enabled)

          if preview.truncated {
            Text("当前仅展示前 240 行或前 20000 个字符。")
              .font(.caption)
              .foregroundColor(.secondary)
          }
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)

        ScrollView([.horizontal, .vertical]) {
          HStack(alignment: .top, spacing: 0) {
            VStack(alignment: .trailing, spacing: 0) {
              ForEach(Array(previewLines.enumerated()), id: \.offset) { index, _ in
                Text("\(index + 1)")
                  .font(.system(size: 12, design: .monospaced))
                  .foregroundColor(.secondary)
                  .frame(minWidth: 34, alignment: .trailing)
                  .padding(.trailing, 12)
                  .padding(.vertical, 1)
              }
            }
            .padding(.vertical, 14)
            .background(Color(uiColor: .secondarySystemGroupedBackground))

            Rectangle()
              .fill(Color(uiColor: .separator))
              .frame(width: 1)

            VStack(alignment: .leading, spacing: 0) {
              ForEach(Array(previewLines.enumerated()), id: \.offset) { _, line in
                Text(line.isEmpty ? " " : line)
                  .font(.system(size: 13, design: .monospaced))
                  .foregroundColor(.primary)
                  .frame(maxWidth: .infinity, alignment: .leading)
                  .padding(.vertical, 1)
              }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 14)
          }
          .textSelection(.enabled)
        }
        .background(Color(uiColor: .systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
          RoundedRectangle(cornerRadius: 16, style: .continuous)
            .stroke(Color(uiColor: .separator), lineWidth: 1)
        )
        .padding(16)
      }
      .background(Color(uiColor: .systemGroupedBackground))
      .navigationTitle(preview.name)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button("关闭") {
            dismiss()
          }
        }
      }
    }
  }

  private var previewLines: [String] {
    let lines = preview.text.replacingOccurrences(of: "\r\n", with: "\n").split(
      separator: "\n",
      omittingEmptySubsequences: false
    )
    let normalized = lines.map(String.init)
    return normalized.isEmpty ? [""] : normalized
  }
}
