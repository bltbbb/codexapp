import SwiftUI

struct UnavailableStateView<Description: View>: View {
  private let title: LocalizedStringKey
  private let systemImage: String
  private let description: Description

  init(
    _ title: LocalizedStringKey,
    systemImage: String,
    @ViewBuilder description: () -> Description
  ) {
    self.title = title
    self.systemImage = systemImage
    self.description = description()
  }

  var body: some View {
    VStack(spacing: 14) {
      Image(systemName: systemImage)
        .font(.system(size: 42))
        .foregroundColor(.secondary)

      Text(title)
        .font(.headline)

      description
        .font(.subheadline)
        .foregroundColor(.secondary)
        .multilineTextAlignment(.center)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .padding(24)
  }
}
