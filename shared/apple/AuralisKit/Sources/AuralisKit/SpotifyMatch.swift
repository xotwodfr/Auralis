import Foundation

// Port of src/api/lyrics/spotifyMatch.ts: decides which Spotify recording (if any) a library track is, so Spicy Lyrics
// can be asked by Spotify id. Same weights, thresholds and rejection rules as the web client.

/// A Spotify search result as the Auralis backend returns it.
public struct SpotifyCandidate: Hashable, Sendable {
  public var id: String
  public var name: String
  public var artists: [String]
  public var album: String
  public var durationMs: Double
  public var explicit: Bool
  /// Uppercase, or "" when Spotify has none.
  public var isrc: String

  public init(id: String, name: String, artists: [String], album: String, durationMs: Double, explicit: Bool, isrc: String) {
    self.id = id; self.name = name; self.artists = artists; self.album = album; self.durationMs = durationMs; self.explicit = explicit
    self.isrc = isrc
  }

  /// Validates one untrusted backend entry.
  public init?(json: Any) {
    guard let x = json as? [String: Any], let id = x["id"] as? String, SpotifyLink.isValidID(id), let name = x["name"] as? String,
          let artists = x["artists"] as? [Any], let names = artists as? [String], names.count == artists.count,
          let album = x["album"] as? String, let ms = SubsonicClient.number(x["durationMs"]),
          let explicit = x["explicit"] as? Bool, let isrc = x["isrc"] as? String else { return nil }
    self.init(id: id, name: name, artists: names, album: album, durationMs: ms, explicit: explicit, isrc: isrc)
  }
}

public enum SpotifyResolution: Hashable, Sendable {
  case matched(SpotifyCandidate, confidence: Double)
  /// Several different recordings fit about equally well: the user picks (or the fallback providers are used).
  case ambiguous([SpotifyCandidate])
  case none
}

public enum SpotifyMatch {
  public static let accept = 0.8
  static let margin = 0.12
  static let suggest = 0.5
  static let maxSuggestions = 5
  static let wTitle = 0.35, wArtist = 0.25, wDuration = 0.25, wAlbum = 0.15

  /// Casefold, strip Latin diacritics and punctuation, unify quotes and `&`, collapse whitespace.
  public static func fold(_ text: String) -> String {
    text.decomposedStringWithCompatibilityMapping
      .replacing(regex: "[\\u0300-\\u036f]", with: "")
      .lowercased()
      .replacing(regex: "[’‘`´']", with: "")
      .replacing(regex: #"\s*[&+]\s*"#, with: " and ")
      .replacing(regex: #"[^\p{L}\p{N}]+"#, with: " ")
      .trimmed
  }

  // Recording variants with different audio (and so different lyric timing).
  private static let material: [(String, String)] = [
    ("live", #"\blive\b|\bin concert\b|\bsessions?\b"#),
    ("remix", #"\bremix(?:ed)?\b|\brmx\b|\b(?:club|dub|vip|extended) mix\b|\brework\b|\bbootleg\b"#),
    ("acoustic", #"\bacoustic\b|\bunplugged\b"#),
    ("instrumental", #"\binstrumental\b|\bkaraoke\b|\boff vocal\b"#),
    ("demo", #"\bdemo\b"#),
    ("cover", #"\bcover\b"#),
    ("extended", #"\bextended\b"#),
    ("edit", #"\bedit\b"#),
    ("tempo", #"\bsped up\b|\bspeed up\b|\bslowed\b|\bnightcore\b"#),
    ("orchestral", #"\borchestral\b|\bsymphonic\b"#),
    ("rerecorded", #"\bre ?recorded\b|\btaylors version\b"#),
  ]
  // Same performance, different master or packaging: a mild preference, never a rejection.
  private static let soft: [(String, String)] = [
    ("remaster", #"\bremaster(?:ed)?\b"#),
    ("mono", #"\bmono\b"#),
    ("version", #"\bversion\b|\bmix\b"#),
  ]

  struct Title { var base: String; var full: String; var material: Set<String>; var soft: Set<String> }

  private static func tokens(_ folded: String, _ table: [(String, String)]) -> [String] {
    table.filter { folded.matches(regex: $0.1) }.map(\.0)
  }

  static func parseTitle(_ raw: String) -> Title {
    var parts: [String] = []
    let ns = raw as NSString
    var base = raw
    if let re = try? NSRegularExpression(pattern: #"[(\[{]([^)\]}]*)[)\]}]"#) {
      for m in re.matches(in: raw, range: NSRange(location: 0, length: ns.length)) { parts.append(ns.substring(with: m.range(at: 1))) }
      base = re.stringByReplacingMatches(in: raw, range: NSRange(location: 0, length: ns.length), withTemplate: " ")
    }
    if let dash = base.firstMatch(regex: #"\s[-–—]\s(.*)$"#), let whole = dash[0], let tail = dash[1],
       let range = base.range(of: whole, options: .backwards) {
      parts.append(tail)
      base = String(base[..<range.lowerBound])
    }
    base = base.replacing(regex: #"\s(?:feat\.?|ft\.?|featuring)\s.*$"#, with: "", caseInsensitive: true)
    var mat = Set<String>(), sft = Set<String>(), kept: [String] = []
    for p in parts {
      let f = fold(p)
      if f.isEmpty || f.matches(regex: #"^(?:feat|ft|featuring|with)\b"#) { continue }
      let m = tokens(f, material), s = tokens(f, soft)
      mat.formUnion(m); sft.formUnion(s)
      if m.isEmpty && s.isEmpty && !f.matches(regex: #"^\d{4}$"#) { kept.append(f) }
    }
    let b = fold(base)
    return Title(base: b, full: ([b] + kept).joined(separator: " "), material: mat, soft: sft)
  }

  /// Live albums mark their tracks as live even when the track title doesn't. Phrases only: "Live Forever" is not.
  private static func albumMaterial(_ album: String) -> Set<String> {
    let f = fold(album)
    var t = Set(tokens(f, material.filter { $0.0 == "acoustic" || $0.0 == "instrumental" }))
    if f.matches(regex: #"^live$|\blive (?:at|in|from|on)\b|\bin concert\b"#) || parseTitle(album).material.contains("live") { t.insert("live") }
    return t
  }

  private static let unknownArtists: Set<String> = ["", "unknown", "unknown artist", "various artists", "various", "va"]
  public static func unknownArtist(_ artist: String) -> Bool { unknownArtists.contains(fold(artist)) }

  private static func split(_ artist: String) -> [String] {
    artist.replacing(regex: #"\s*(?:,|;|/|\bfeat\.?|\bft\.?|\bfeaturing\b|\bwith\b|\bx\b|&|\band\b|\+)\s*"#, with: "\u{1F}", caseInsensitive: true)
      .components(separatedBy: "\u{1F}")
  }

  private static func artistScore(_ trackArtist: String, _ names: [String]) -> Double {
    let whole = fold(trackArtist.replacing(regex: #"\s(?:feat\.?|ft\.?|featuring)\s.*$"#, with: "", caseInsensitive: true))
    let theirs = names.map(fold)
    if theirs.contains(whole) || fold(names.joined(separator: " & ")) == whole || fold(names.joined(separator: ", ")) == whole { return 1 }
    let mine = split(trackArtist).map(fold).filter { !$0.isEmpty }
    if let first = mine.first, first == theirs.first { return 0.9 }
    return mine.contains(where: theirs.contains) ? 0.6 : 0
  }

  private static func durationScore(_ diff: Double) -> Double? {
    if diff <= 2 { return 1 }
    if diff <= 4 { return 0.7 }
    if diff <= 7 { return 0.35 }
    if diff <= 10 { return 0.1 }
    return nil // a different edit/performance
  }

  struct Scored { var candidate: SpotifyCandidate; var score: Double; var viaISRC: Bool; var rejected: String? }

  /// Scores one candidate against the library track.
  static func score(_ track: LyricsTrack, _ c: SpotifyCandidate) -> Scored {
    func reject(_ why: String) -> Scored { Scored(candidate: c, score: 0, viaISRC: false, rejected: why) }
    let mine = parseTitle(track.title), theirs = parseTitle(c.name)
    let seconds = c.durationMs / 1000
    let delta: Double? = track.duration > 0 && seconds > 0 ? abs(track.duration - seconds) : nil
    let isrc = !c.isrc.isEmpty && (track.isrc ?? []).contains(c.isrc)

    let mineMat = mine.material.union(albumMaterial(track.album)), theirMat = theirs.material.union(albumMaterial(c.album))
    let gap = mineMat.symmetricDifference(theirMat)
    if !gap.isEmpty { return reject("different version (\(gap.sorted().joined(separator: ", ")))") }
    if let delta, durationScore(delta) == nil { return reject("duration differs by \(Int(delta.rounded())) s") }

    var total = 0.0, viaISRC = false
    if isrc && (delta ?? 0) <= 3 {
      // The same ISRC is the same recording: trust it over spelling differences (translations, transliterations).
      total += 0.97; viaISRC = true
    } else {
      let title = mine.full == theirs.full ? 1.0 : (mine.base == theirs.base && !mine.base.isEmpty ? 0.8 : 0)
      if title == 0 { return reject("title differs") }
      total += wTitle * title
      if !unknownArtist(track.artist) {
        let artist = artistScore(track.artist, c.artists)
        if artist == 0 { return reject("artist differs") }
        total += wArtist * artist
      }
      if let delta, let d = durationScore(delta) { total += wDuration * d }
      // Album is a tie-breaker (singles and compilations carry the same recording), never a gate.
      let myAlbum = parseTitle(track.album), theirAlbum = parseTitle(c.album)
      let album = !myAlbum.full.isEmpty && myAlbum.full == theirAlbum.full ? 1.0 : (!myAlbum.base.isEmpty && myAlbum.base == theirAlbum.base ? 0.8 : 0)
      total += wAlbum * album
    }
    let softGap = mine.soft.symmetricDifference(theirs.soft)
    if !softGap.isEmpty { total -= 0.08 * Double(min(2, softGap.count)) }
    if let explicit = track.explicit, explicit != c.explicit { total -= 0.15 }
    return Scored(candidate: c, score: max(0, min(1, total)), viaISRC: viaISRC, rejected: nil)
  }

  /// Two candidates that are one recording released twice (single + album, re-release): picking either is fine.
  private static func sameRecording(_ track: LyricsTrack, _ a: SpotifyCandidate, _ b: SpotifyCandidate) -> Bool {
    if !a.isrc.isEmpty && a.isrc == b.isrc { return true }
    let ta = parseTitle(a.name), tb = parseTitle(b.name)
    return ta.base == tb.base && ta.material == tb.material && abs(a.durationMs - b.durationMs) <= 1500
      && (track.explicit == nil || a.explicit == b.explicit)
  }

  /// Accepts automatically only a confident match with no materially different recording close behind it; offers the
  /// plausible ones when unsure; otherwise none.
  public static func resolve(_ track: LyricsTrack, _ candidates: [SpotifyCandidate]) -> SpotifyResolution {
    let viable = candidates.enumerated()
      .map { (i: $0.offset, s: score(track, $0.element)) }
      .filter { $0.s.rejected == nil && $0.s.score > 0 }
      .sorted { a, b in
        if a.s.score != b.s.score { return a.s.score > b.s.score }
        // Ties: when explicitness is unknown prefer the explicit (original) release, then Spotify's relevance order.
        if track.explicit == nil && a.s.candidate.explicit != b.s.candidate.explicit { return a.s.candidate.explicit }
        return a.i < b.i
      }
      .map(\.s)
    guard let best = viable.first else { return .none }

    let rival = viable.dropFirst().first { $0.score >= best.score - margin && !sameRecording(track, best.candidate, $0.candidate) }
    if best.score >= accept && rival == nil && (best.viaISRC || !unknownArtist(track.artist)) {
      return .matched(best.candidate, confidence: (best.score * 100).rounded() / 100)
    }
    if best.score < suggest && !unknownArtist(track.artist) { return .none }

    // One entry per distinct recording, best first.
    var distinct: [SpotifyCandidate] = []
    for s in viable {
      if s.score < suggest * 0.9 && !distinct.isEmpty { break }
      if !distinct.contains(where: { sameRecording(track, $0, s.candidate) }) { distinct.append(s.candidate) }
      if distinct.count == maxSuggestions { break }
    }
    return .ambiguous(distinct)
  }
}
