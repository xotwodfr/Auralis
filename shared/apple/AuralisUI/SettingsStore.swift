import AuralisKit
import Foundation
import Observation

/// Device preferences, mirroring src/state/settings.ts, theme.ts and spotifyLinks.ts. Stored in UserDefaults.
@MainActor @Observable
final class SettingsStore {
  @ObservationIgnored private let defaults: UserDefaults
  private static let prefix = "auralis.settings."
  private static let maxLinks = 5000

  /// Allow lookups on third-party services (LRCLIB). Server lyrics are always used.
  var externalLookups: Bool { didSet { save(externalLookups, "externalLookups") } }
  /// Tell your own server what you play, so its play counts and "recently played" lists stay accurate.
  var reportPlays: Bool { didSet { save(reportPlays, "reportPlays") } }
  /// Ask the Auralis lyrics server for word-synced (Spicy) lyrics and automatic Spotify matching.
  var lyricsServerEnabled: Bool { didSet { save(lyricsServerEnabled, "lyricsServerEnabled") } }
  /// The user's own lyrics server (validated, no trailing slash). Empty = the built-in default.
  var lyricsServerURL: String { didSet { save(lyricsServerURL, "lyricsServerUrl") } }
  var theme: ThemePref { didSet { save(theme.rawValue, "theme") } }
  /// `server|user|trackId` → Spotify id, or `SpotifyLink.none`. A link the user makes always wins over a match.
  private(set) var spotifyLinks: [String: String] { didSet { save(spotifyLinks, "spotifyLinks") } }
  /// Insertion order, so the oldest links are evicted first.
  @ObservationIgnored private var linkOrder: [String]

  init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    func bool(_ key: String) -> Bool { defaults.object(forKey: Self.prefix + key) as? Bool ?? true }
    externalLookups = bool("externalLookups")
    reportPlays = bool("reportPlays")
    lyricsServerEnabled = bool("lyricsServerEnabled")
    lyricsServerURL = defaults.string(forKey: Self.prefix + "lyricsServerUrl") ?? ""
    theme = defaults.string(forKey: Self.prefix + "theme").flatMap(ThemePref.init(rawValue:)) ?? .system
    let links = (defaults.dictionary(forKey: Self.prefix + "spotifyLinks") as? [String: String] ?? [:])
      .filter { SpotifyLink.isValidID($0.value) || $0.value == SpotifyLink.none }
    spotifyLinks = links
    linkOrder = defaults.stringArray(forKey: Self.prefix + "spotifyLinkOrder")?.filter { links[$0] != nil } ?? Array(links.keys)
  }

  private func save(_ value: Any, _ key: String) { defaults.set(value, forKey: Self.prefix + key) }

  /// Where the lyrics backend lives: the saved address, else the hosted default.
  var backendBase: String { lyricsServerURL.isEmpty ? LyricsServer.defaultURL : lyricsServerURL }

  static func linkKey(_ c: Credentials, trackID: String) -> String { "\(c.baseURL.absoluteString)|\(c.username)|\(trackID)" }

  func link(_ key: String, to spotifyID: String) {
    linkOrder.removeAll { $0 == key }
    linkOrder.append(key)
    var links = spotifyLinks
    links[key] = spotifyID
    for old in linkOrder.prefix(max(0, linkOrder.count - Self.maxLinks)) { links[old] = nil }
    linkOrder = Array(linkOrder.suffix(Self.maxLinks))
    spotifyLinks = links
    save(linkOrder, "spotifyLinkOrder")
  }

  func unlink(_ key: String) {
    linkOrder.removeAll { $0 == key }
    spotifyLinks[key] = nil
    save(linkOrder, "spotifyLinkOrder")
  }

  func clearLinks() {
    linkOrder = []
    spotifyLinks = [:]
    save(linkOrder, "spotifyLinkOrder")
  }
}
