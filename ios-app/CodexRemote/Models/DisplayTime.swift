import Foundation

enum DisplayTime {
  static func text(_ rawValue: String?) -> String {
    guard let rawValue else {
      return ""
    }

    let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else {
      return ""
    }

    guard let date = parse(trimmed) else {
      return trimmed
    }

    if calendar.isDateInToday(date) {
      return todayFormatter.string(from: date)
    }

    if calendar.isDateInYesterday(date) {
      return "昨天 \(timeFormatter.string(from: date))"
    }

    return dateTimeFormatter.string(from: date)
  }

  static func sortableDate(_ rawValue: String) -> Date {
    parse(rawValue) ?? .distantPast
  }

  private static func parse(_ rawValue: String) -> Date? {
    if let date = iso8601Fractional.date(from: rawValue) {
      return date
    }

    if let date = iso8601Basic.date(from: rawValue) {
      return date
    }

    for formatter in fallbackFormatters {
      if let date = formatter.date(from: rawValue) {
        return date
      }
    }

    return nil
  }

  private static let calendar: Calendar = {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = .current
    return calendar
  }()

  private static let locale = Locale(identifier: "zh_CN")

  private static let iso8601Fractional: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    formatter.timeZone = .current
    return formatter
  }()

  private static let iso8601Basic: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    formatter.timeZone = .current
    return formatter
  }()

  private static let todayFormatter: DateFormatter = {
    let formatter = DateFormatter()
    formatter.locale = locale
    formatter.timeZone = .current
    formatter.dateFormat = "今天 HH:mm"
    return formatter
  }()

  private static let timeFormatter: DateFormatter = {
    let formatter = DateFormatter()
    formatter.locale = locale
    formatter.timeZone = .current
    formatter.dateFormat = "HH:mm"
    return formatter
  }()

  private static let dateTimeFormatter: DateFormatter = {
    let formatter = DateFormatter()
    formatter.locale = locale
    formatter.timeZone = .current
    formatter.dateFormat = "MM-dd HH:mm"
    return formatter
  }()

  private static let fallbackFormatters: [DateFormatter] = {
    let patterns = [
      "yyyy-MM-dd HH:mm:ss",
      "yyyy-MM-dd'T'HH:mm:ss.SSSZ",
      "yyyy-MM-dd'T'HH:mm:ssZ",
      "yyyy-MM-dd'T'HH:mm:ss.SSSXXXXX",
      "yyyy-MM-dd'T'HH:mm:ssXXXXX",
    ]

    return patterns.map { pattern in
      let formatter = DateFormatter()
      formatter.locale = Locale(identifier: "en_US_POSIX")
      formatter.timeZone = .current
      formatter.dateFormat = pattern
      return formatter
    }
  }()
}
