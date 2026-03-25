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
    textView.font = UIFont.systemFont(ofSize: 16)
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
    let baseFontSize: CGFloat = 16.0
    
    if let attributed = try? AttributedString(
      markdown: rawText,
      options: AttributedString.MarkdownParsingOptions(
        interpretedSyntax: .inlineOnlyPreservingWhitespace, // 使用适合聊天的 markdown 模式
        failurePolicy: .returnPartiallyParsedIfPossible
      )
    ) {
      // 若原内容包含代码块换行或特殊 markdown，转为更兼容的方案
      let mutable = NSMutableAttributedString(attributedString: NSAttributedString(attributed))
      let fullRange = NSRange(location: 0, length: mutable.length)
      
      // 1. 放大字体并给代码加上高亮底色
      mutable.enumerateAttribute(.font, in: fullRange, options: []) { value, range, _ in
        if let oldFont = value as? UIFont {
          // Xcode 默认 Markdown 产出的正文一般极小(譬如12pt)，做合适的缩放
          let scaleFactor = baseFontSize / 12.0
          let newSize = max(oldFont.pointSize * scaleFactor, baseFontSize)
          mutable.addAttribute(.font, value: oldFont.withSize(newSize), range: range)
          
          if oldFont.fontDescriptor.symbolicTraits.contains(.traitMonoSpace) || oldFont.familyName.contains("Courier") {
            mutable.addAttribute(.backgroundColor, value: textColor.withAlphaComponent(0.12), range: range)
          }
        } else {
          mutable.addAttribute(.font, value: UIFont.systemFont(ofSize: baseFontSize), range: range)
        }
      }
      
      // 2. 注入颜色，但不覆盖超链接颜色
      mutable.enumerateAttribute(.link, in: fullRange, options: []) { value, range, _ in
        if value == nil {
          mutable.addAttribute(.foregroundColor, value: textColor, range: range)
        }
      }
      
      // 3. 行距提升
      let paragraphStyle = NSMutableParagraphStyle()
      paragraphStyle.lineSpacing = 6
      mutable.addAttribute(.paragraphStyle, value: paragraphStyle, range: fullRange)
      
      return mutable
    }

    let paragraphStyle = NSMutableParagraphStyle()
    paragraphStyle.lineSpacing = 6
    return NSAttributedString(
      string: rawText,
      attributes: [
        .font: UIFont.systemFont(ofSize: baseFontSize),
        .foregroundColor: textColor,
        .paragraphStyle: paragraphStyle
      ]
    )
  }
}
