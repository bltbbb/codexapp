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
    let baseFont = UIFont.systemFont(ofSize: baseFontSize)
    let boldFont = UIFont.boldSystemFont(ofSize: baseFontSize)
    let monoFont = UIFont.monospacedSystemFont(ofSize: baseFontSize - 1, weight: .regular)
    
    let mutable = NSMutableAttributedString(string: rawText)
    
    let fullRange = NSRange(location: 0, length: mutable.length)
    mutable.addAttribute(.font, value: baseFont, range: fullRange)
    mutable.addAttribute(.foregroundColor, value: textColor, range: fullRange)
    
    let paragraphStyle = NSMutableParagraphStyle()
    paragraphStyle.lineSpacing = 6
    mutable.addAttribute(.paragraphStyle, value: paragraphStyle, range: fullRange)
    
    // Helper to apply Regex styles
    func applyRegex(pattern: String, styleAttributes: [NSAttributedString.Key: Any]) {
      guard let regex = try? NSRegularExpression(pattern: pattern, options: []) else { return }
      let matches = regex.matches(in: mutable.string, options: [], range: NSRange(location: 0, length: mutable.length))
      for match in matches.reversed() {
        guard match.numberOfRanges > 1 else { continue }
        let contentRange = match.range(at: 1)
        let fullMatchRange = match.range
        
        let contentStr = mutable.attributedSubstring(from: contentRange).string
        let replaceAttrStr = NSMutableAttributedString(string: contentStr)
        
        replaceAttrStr.addAttribute(.font, value: baseFont, range: NSRange(location: 0, length: replaceAttrStr.length))
        replaceAttrStr.addAttribute(.foregroundColor, value: textColor, range: NSRange(location: 0, length: replaceAttrStr.length))
        replaceAttrStr.addAttribute(.paragraphStyle, value: paragraphStyle, range: NSRange(location: 0, length: replaceAttrStr.length))
        
        for (k, v) in styleAttributes {
          replaceAttrStr.addAttribute(k, value: v, range: NSRange(location: 0, length: replaceAttrStr.length))
        }
        
        mutable.replaceCharacters(in: fullMatchRange, with: replaceAttrStr)
      }
    }
    
    // 1. Code blocks (```code```)
    applyRegex(
      pattern: "(?s)```[ \\t]*(?:[a-zA-Z0-9_+-]+)?[ \\t]*\n?(.*?)```",
      styleAttributes: [
        .font: monoFont,
        .backgroundColor: textColor.withAlphaComponent(0.12)
      ]
    )
    
    // 2. Inline code (`code`)
    applyRegex(
      pattern: "(?s)`([^`]+)`",
      styleAttributes: [
        .font: monoFont,
        .backgroundColor: textColor.withAlphaComponent(0.12)
      ]
    )
    
    // 3. Bold (**text**)
    applyRegex(
      pattern: "(?s)\\*\\*(.*?)\\*\\*",
      styleAttributes: [
        .font: boldFont
      ]
    )
    
    // 4. Links ([text](url))
    if let linkRegex = try? NSRegularExpression(pattern: "(?s)\\[(.*?)\\]\\((.*?)\\)", options: []) {
      let matches = linkRegex.matches(in: mutable.string, options: [], range: NSRange(location: 0, length: mutable.length))
      for match in matches.reversed() {
        guard match.numberOfRanges > 2 else { continue }
        let textInfo = mutable.attributedSubstring(from: match.range(at: 1)).string
        let urlInfo = mutable.attributedSubstring(from: match.range(at: 2)).string
        
        let replaceAttrStr = NSMutableAttributedString(string: textInfo)
        replaceAttrStr.addAttribute(.font, value: baseFont, range: NSRange(location: 0, length: replaceAttrStr.length))
        replaceAttrStr.addAttribute(.paragraphStyle, value: paragraphStyle, range: NSRange(location: 0, length: replaceAttrStr.length))
        
        if let url = URL(string: urlInfo) {
          replaceAttrStr.addAttribute(.link, value: url, range: NSRange(location: 0, length: replaceAttrStr.length))
        } else {
          replaceAttrStr.addAttribute(.foregroundColor, value: textColor, range: NSRange(location: 0, length: replaceAttrStr.length))
        }
        mutable.replaceCharacters(in: match.range, with: replaceAttrStr)
      }
    }
    
    return mutable
  }
}
