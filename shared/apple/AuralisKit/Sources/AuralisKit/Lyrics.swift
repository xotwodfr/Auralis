import Foundation

// Port of src/api/lyrics (types, lrc, match, spicy parsing). Pure Foundation so it is tested on Linux too.

/// One word or syllable with its own timing (seconds from track start).
public struct LyricWord: Hashable, Sendable {
  public var text: String
  public var start: Double
  public var end: Double
  /// Syllable of a longer word: no space before the next piece.
  public var joinNext: Bool = false
}

public struct LyricLine: Hashable, Sendable {
  /// Seconds from track start; nil for unsynchronized lines.
  public var time: Double?
  public var text: String
  /// Word/syllable timings, when the source has them. `text` is always the plain joined form.
  public var words: [LyricWord]?
  /// Background/backing vocals sung alongside this line.
  public var background: [Background] = []
  /// Sung by the second voice (duets).
  public var opposite: Bool = false

  public struct Background: Hashable, Sendable {
    public var text: String
    public var words: [LyricWord]?
  }

  public init(time: Double?, text: String, words: [LyricWord]? = nil, background: [Background] = [], opposite: Bool = false) {
    self.time = time; self.text = text; self.words = words; self.background = background; self.opposite = opposite
  }
}

public struct Credit: Hashable, Sendable {
  public enum Role: String, Sendable { case uploader = "Uploader", maker = "Maker" }
  public var role: Role
  public var name: String
  /// http(s) only.
  public var url: URL?
}

public struct Attribution: Hashable, Sendable {
  /// Who answered, as the API reports it ("Apple Music", "Spicy Lyrics", …).
  public var provider: String
  public var credits: [Credit]
}

public struct Lyrics: Hashable, Sendable {
  public enum Source: String, Sendable { case server, lrclib, spicy }
  public var synced: Bool
  public var source: Source
  public var lines: [LyricLine]
  /// LRCLIB flags instrumental tracks; there are no lines to show.
  public var instrumental = false
  /// Required by the Spicy Lyrics terms wherever its lyrics are shown.
  public var attribution: Attribution?

  public init(synced: Bool, source: Source, lines: [LyricLine], instrumental: Bool = false, attribution: Attribution? = nil) {
    self.synced = synced; self.source = source; self.lines = lines; self.instrumental = instrumental; self.attribution = attribution
  }
}

/// What a provider needs to know about the playing track.
public struct LyricsTrack: Hashable, Sendable {
  public var id: String
  public var title: String
  public var artist: String
  public var album: String
  /// Seconds.
  public var duration: Double
  public var isrc: [String]?
  public var explicit: Bool?

  public init(id: String, title: String, artist: String, album: String, duration: Double, isrc: [String]? = nil, explicit: Bool? = nil) {
    self.id = id; self.title = title; self.artist = artist; self.album = album; self.duration = duration; self.isrc = isrc
    self.explicit = explicit
  }

  public init(_ song: Song) {
    self.init(id: song.id, title: song.title, artist: song.artist, album: song.album, duration: song.duration, isrc: song.isrc,
              explicit: song.explicit)
  }
}

public enum LyricsError: Error, Equatable, LocalizedError {
  case timeout, network, rateLimited, auth, unavailable

  public var errorDescription: String? {
    switch self {
    case .timeout: "The lyrics service took too long to respond."
    case .network: "Couldn't reach the lyrics service."
    case .rateLimited: "The lyrics service is busy. Try again in a minute."
    case .auth: "Your session was rejected by the server. Reconnect in Settings."
    case .unavailable: "Couldn't load lyrics."
    }
  }
}

// MARK: LRC

public enum LRC {
  // [mm:ss], [mm:ss.x], [mm:ss.xx], [mm:ss.xxx] (':' also appears as the fraction separator).
  private static let timestamp = #"\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]"#
  private static let meta = #"^\[([a-z]+):(.*)\]$"#
  private static let wordTag = #"<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>"#

  /// Parses LRC (synchronized) or plain text. Text is only synchronized if at least one line carries a valid leading
  /// timestamp; malformed lines are skipped, never thrown on.
  public static func parse(_ input: String) -> (synced: Bool, lines: [LyricLine]) {
    let body = input.hasPrefix("\u{FEFF}") ? String(input.dropFirst()) : input
    let rows = body.replacing(regex: #"\r\n|\r"#, with: "\n").components(separatedBy: "\n")
    var timed: [LyricLine] = []
    var offsetMs = 0.0

    for row in rows {
      let line = row.trimmed
      var times: [Double] = []
      var pos = 0
      while let m = line.anchoredMatch(regex: timestamp, at: pos) {
        pos = m.end
        let minutes = Double(m.groups[1] ?? "") ?? 0, seconds = Double(m.groups[2] ?? "") ?? 0
        let fraction = m.groups[3].flatMap { Double("0.\($0)") } ?? 0
        if seconds < 60 { times.append(minutes * 60 + seconds + fraction) }
      }
      if pos > 0 {
        guard !times.isEmpty else { continue }
        let text = ((line as NSString).substring(from: pos)).replacing(regex: wordTag, with: "").trimmed
        timed += times.map { LyricLine(time: $0, text: text) }
        continue
      }
      if let m = line.firstMatch(regex: meta, caseInsensitive: true), m[1]?.lowercased() == "offset" {
        offsetMs = Double((m[2] ?? "").trimmed) ?? 0
      }
    }

    if !timed.isEmpty {
      // Positive LRC offset makes lyrics appear sooner, so subtract it.
      let lines = timed.map { LyricLine(time: max(0, ($0.time ?? 0) - offsetMs / 1000), text: $0.text) }
      return (true, lines.enumerated().sorted { ($0.element.time ?? 0, $0.offset) < ($1.element.time ?? 0, $1.offset) }.map(\.element))
    }
    return (false, plain(rows))
  }

  private static func plain(_ rows: [String]) -> [LyricLine] {
    var lines: [LyricLine] = []
    for row in rows {
      let text = row.replacing(regex: wordTag, with: "").trimmed
      if text.matches(regex: meta, caseInsensitive: true) { continue } // [ar:..], [ti:..] etc.
      if text.isEmpty && (lines.last?.text.isEmpty ?? true) { continue } // collapse blank runs, trim the start
      lines.append(LyricLine(time: nil, text: text))
    }
    while lines.last?.text.isEmpty == true { lines.removeLast() }
    return lines
  }

  /// Index of the last line whose time is <= position, or -1 before the first line.
  public static func activeLine(_ lines: [LyricLine], at position: Double) -> Int {
    var lo = 0, hi = lines.count - 1, found = -1
    while lo <= hi {
      let mid = (lo + hi) / 2
      if (lines[mid].time ?? 0) <= position { found = mid; lo = mid + 1 } else { hi = mid - 1 }
    }
    return found
  }
}

// MARK: Match guards (LRCLIB)

public enum LyricsMatch {
  private static let versionTokenList = ["remix", "live", "acoustic", "instrumental", "cover", "demo", "edit"]

  /// Casefold, drop bracketed qualifiers and `feat.` suffixes, strip punctuation, collapse spaces.
  public static func normalize(_ text: String) -> String {
    text.lowercased()
      .replacing(regex: #"[(\[{][^)\]}]*[)\]}]"#, with: " ")
      .replacing(regex: #"\s(?:feat|ft)\.?\s.*$"#, with: " ")
      .replacing(regex: #"[^\p{L}\p{N}\s]"#, with: " ")
      .replacing(regex: #"\s+"#, with: " ")
      .trimmed
  }

  private static func versionTokens(_ texts: String...) -> [String] {
    let words = Set(texts.joined(separator: " ").lowercased().replacing(regex: #"[^\p{L}\p{N}]+"#, with: " ").split(separator: " ").map(String.init))
    return versionTokenList.filter(words.contains)
  }

  /// Whether a candidate is the same recording: normalized title + artist match, duration within tolerance, and no
  /// version token (live/remix/…) on one side only.
  /// shortcut: artists compare by exact normalized equality, so "A & B" vs "A" is rejected; loosen if reports appear.
  public static func isMatch(_ track: LyricsTrack, trackName: String, artistName: String, albumName: String?, duration: Double?) -> Bool {
    let title = normalize(track.title)
    guard !title.isEmpty, title == normalize(trackName), normalize(track.artist) == normalize(artistName) else { return false }
    let exact = track.title.trimmed.lowercased() == trackName.trimmed.lowercased()
    guard let duration, abs(duration - track.duration) <= (exact ? 5 : 3) else { return false }
    let theirsAll = versionTokens(trackName, albumName ?? ""), mineAll = versionTokens(track.title, track.album)
    return versionTokens(track.title).allSatisfy(theirsAll.contains) && versionTokens(trackName).allSatisfy(mineAll.contains)
  }
}

// MARK: Spicy Lyrics (via the Auralis backend)

public enum SpicyLyrics {
  /// Lyrics that end well after the track does belong to a different recording (live/extended/wrong id).
  static let overrunTolerance = 5.0
  private static let providers = ["spicy_lyrics": "Spicy Lyrics", "apple_music": "Apple Music", "spotify": "Spotify"]

  private static func num(_ v: Any?) -> Double? { SubsonicClient.number(v) }

  private static func words(_ raw: Any?) -> [LyricWord] {
    ((raw as? [Any]) ?? []).compactMap { item in
      guard let s = item as? [String: Any], let text = (s["Text"] as? String)?.trimmed, !text.isEmpty,
            let start = num(s["StartTime"]), let end = num(s["EndTime"]) else { return nil }
      return LyricWord(text: text, start: start, end: end, joinNext: s["IsPartOfWord"] as? Bool == true)
    }
  }

  public static func join(_ w: [LyricWord]) -> String {
    w.enumerated().map { i, x in x.text + (x.joinNext || i == w.count - 1 ? "" : " ") }.joined()
  }

  private static func credit(_ role: Credit.Role, _ v: Any?) -> [Credit] {
    guard let v = v as? [String: Any],
          let name = ["username", "Username", "name", "Name"].lazy.compactMap({ v[$0] as? String }).first else { return [] }
    let url = ["url", "Url", "profileUrl"].lazy.compactMap { v[$0] as? String }.first
      .flatMap { $0.matches(regex: "^https?://", caseInsensitive: true) ? URL(string: $0) : nil }
    return [Credit(role: role, name: name, url: url)]
  }

  /// Normalizes a Spicy Lyrics `Body` (Syllable / Line / Static). Null for unusable data or an implausible match.
  public static func parse(_ body: Any?, trackDuration: Double) -> Lyrics? {
    guard let body = body as? [String: Any], let content = body["Content"] as? [Any] else { return nil }
    let type = body["Type"] as? String
    var lines: [LyricLine] = []
    var synced = true

    for case let item as [String: Any] in content {
      if type == "Syllable" {
        guard item["Type"] as? String == "Vocal", let lead = item["Lead"] as? [String: Any] else { continue }
        let w = words(lead["Syllables"])
        guard let first = w.first else { continue }
        let background = ((item["Background"] as? [Any]) ?? []).compactMap { b -> LyricLine.Background? in
          let bw = words((b as? [String: Any])?["Syllables"])
          return bw.isEmpty ? nil : .init(text: join(bw), words: bw)
        }
        lines.append(LyricLine(time: first.start, text: join(w), words: w, background: background, opposite: item["OppositeAligned"] as? Bool == true))
      } else if type == "Line", let text = (item["Text"] as? String)?.trimmed, !text.isEmpty, let start = num(item["StartTime"]) {
        lines.append(LyricLine(time: start, text: text))
      } else if type == "Static", let text = (item["Text"] as? String)?.trimmed, !text.isEmpty {
        synced = false
        lines.append(LyricLine(time: nil, text: text))
      }
    }
    guard !lines.isEmpty else { return nil }

    if synced {
      lines.sort { ($0.time ?? 0) < ($1.time ?? 0) }
      let end = lines.map { line in ([line.time ?? 0] + (line.words ?? []).map(\.end)).max() ?? 0 }.max() ?? 0
      if (lines[0].time ?? 0) < 0 || (trackDuration > 0 && end > trackDuration + overrunTolerance) { return nil }
    }
    let source = body["source"] as? String ?? ""
    let upload = body["UploadAttribution"] as? [String: Any] ?? [:]
    let attribution = Attribution(
      provider: providers[source] ?? "an unknown source",
      credits: source == "spicy_lyrics" ? credit(.uploader, upload["Uploader"]) + credit(.maker, upload["Maker"]) : []
    )
    return Lyrics(synced: synced, source: .spicy, lines: lines, attribution: attribution)
  }
}

// MARK: Spotify links

public enum SpotifyLink {
  /// Stored instead of an id when the user turned Spicy Lyrics off for a track (e.g. a wrong automatic match).
  public static let none = "none"
  private static let idPattern = "^[A-Za-z0-9]{22}$"

  public static func isValidID(_ s: String) -> Bool { s.matches(regex: idPattern) }

  /// Accepts a bare id, `spotify:track:<id>`, or an open.spotify.com track URL (with optional /intl-xx/ and query).
  public static func parseTrackID(_ input: String) -> String? {
    let text = input.trimmed
    if isValidID(text) { return text }
    if let m = text.firstMatch(regex: "^spotify:track:([A-Za-z0-9]{22})$") { return m[1] }
    guard let url = URLComponents(string: text), url.scheme == "https", url.host == "open.spotify.com",
          let m = url.path.firstMatch(regex: "^/(?:intl-[a-z-]+/)?track/([A-Za-z0-9]{22})/?$") else { return nil }
    return m[1]
  }
}

// MARK: Lyrics server address

public enum LyricsServer {
  /// The hosted Auralis lyrics backend the web production build uses.
  public static let defaultURL = "https://lyrics.folk3s.com"
  private static let loopback: Set<String> = ["localhost", "127.0.0.1", "[::1]", "::1"]

  public enum Check: Equatable { case ok(String), invalid(String) }

  /// A normalized origin + optional path prefix, or a message fit to show the user. https only, except http on this machine.
  public static func check(_ input: String) -> Check {
    guard let u = URLComponents(string: input.trimmed), let scheme = u.scheme?.lowercased(), let host = u.host, !host.isEmpty else {
      return .invalid("Enter a full address such as https://lyrics.example.com.")
    }
    guard scheme == "http" || scheme == "https" else {
      return .invalid("The address must start with https:// (or http://localhost for development).")
    }
    if scheme == "http" && !loopback.contains(host.lowercased()) {
      return .invalid("Plain http:// is only allowed for localhost. Use https:// for any other server.")
    }
    if u.user != nil || u.password != nil || u.query != nil || u.fragment != nil {
      return .invalid("Remove the username, password, query and fragment from the address.")
    }
    var origin = "\(scheme)://\(host.lowercased())"
    if let port = u.port { origin += ":\(port)" }
    return .ok((origin + u.path).replacing(regex: "/+$", with: ""))
  }
}
