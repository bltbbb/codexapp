import SwiftUI
import UIKit

struct SelectableMarkdownTextView: UIViewRepresentable {
  let rawText: String
  let textColor: UIColor

  func makeUIView(context: Context) -> UITextView {
    let textView = UITextView()
    textView.backgroundColor = .clear
    textView.isEditable = false
    textView.isSelectable = true
    textView.isScrollEnabled = false
    textView.font = UIFont.preferredFont(forTextStyle: .body)
    textView.textColor = textColor
    textView.adjustsFontForContentSizeCategory = true
    textView.textContainerInset = .zero
    textView.textContainer.lineFragmentPadding = 0
    textView.showsVerticalScrollIndicator = false
    textView.showsHorizontalScrollIndicator = false
    textView.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    textView.setContentHuggingPriority(.defaultLow, for: .horizontal)
    textView.linkTextAttributes = [
      .foregroundColor: UIColor.systemBlue,
      .underlineStyle: NSUnderlineStyle.single.rawValue,
    ]
    return textView
  }

  func updateUIView(_ uiView: UITextView, context: Context) {
    uiView.textColor = textColor
    uiView.attributedText = makeAttributedText()
  }

  func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
    let targetSize = CGSize(
      width: proposal.width ?? UIScreen.main.bounds.width,
      height: .greatestFiniteMagnitude
    )
    let fitted = uiView.sizeThatFits(targetSize)
    return CGSize(width: targetSize.width, height: fitted.height)
  }

  private func makeAttributedText() -> NSAttributedString {
    if let attributed = try? AttributedString(
      markdown: rawText,
      options: AttributedString.MarkdownParsingOptions(
        interpretedSyntax: .full,
        failurePolicy: .returnPartiallyParsedIfPossible
      )
    ) {
      let mutable = NSMutableAttributedString(attributedString: NSAttributedString(attributed))
      let fullRange = NSRange(location: 0, length: mutable.length)
      mutable.addAttribute(.foregroundColor, value: textColor, range: fullRange)
      return mutable
    }

    return NSAttributedString(
      string: rawText,
      attributes: [
        .font: UIFont.preferredFont(forTextStyle: .body),
        .foregroundColor: textColor,
      ]
    )
  }
}
