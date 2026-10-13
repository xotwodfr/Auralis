import Foundation

/// ICU regular expressions (the same flavour the web's `u`-flag patterns rely on: `\p{L}`, `\b`), on Apple and Linux.
extension String {
  private func regex(_ pattern: String, _ caseInsensitive: Bool) -> NSRegularExpression? {
    try? NSRegularExpression(pattern: pattern, options: caseInsensitive ? [.caseInsensitive] : [])
  }

  func replacing(regex pattern: String, with template: String, caseInsensitive: Bool = false) -> String {
    guard let re = regex(pattern, caseInsensitive) else { return self }
    return re.stringByReplacingMatches(in: self, range: NSRange(startIndex..., in: self), withTemplate: template)
  }

  func matches(regex pattern: String, caseInsensitive: Bool = false) -> Bool {
    regex(pattern, caseInsensitive)?.firstMatch(in: self, range: NSRange(startIndex..., in: self)) != nil
  }

  /// Capture groups of the first match (index 0 = whole match); nil groups did not participate.
  func firstMatch(regex pattern: String, caseInsensitive: Bool = false) -> [String?]? {
    let ns = self as NSString
    guard let re = regex(pattern, caseInsensitive), let m = re.firstMatch(in: self, range: NSRange(location: 0, length: ns.length))
    else { return nil }
    return (0..<m.numberOfRanges).map { i in
      let r = m.range(at: i)
      return r.location == NSNotFound ? nil : ns.substring(with: r)
    }
  }

  /// End offset (UTF-16) of an anchored match at `offset`, with its groups.
  func anchoredMatch(regex pattern: String, at offset: Int) -> (end: Int, groups: [String?])? {
    let ns = self as NSString
    guard offset <= ns.length, let re = regex(pattern, false),
          let m = re.firstMatch(in: self, options: [.anchored], range: NSRange(location: offset, length: ns.length - offset))
    else { return nil }
    let groups = (0..<m.numberOfRanges).map { i -> String? in
      let r = m.range(at: i)
      return r.location == NSNotFound ? nil : ns.substring(with: r)
    }
    return (m.range.location + m.range.length, groups)
  }

  var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}
