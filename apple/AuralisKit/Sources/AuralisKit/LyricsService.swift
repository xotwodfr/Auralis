import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// Port of the web lyrics pipeline (registry.ts, providers/*, resolve.ts, useLyricsBackend.ts): server lyrics, LRCLIB
// and Spicy Lyrics through the Auralis backend, which also matches tracks to Spotify. No secrets ever reach the client.

public struct HTTPResult: Sendable {
  public var data: Data
  public var status: Int
  public var contentType: String
  /// Seconds, from `Retry-After`.
  public var retryAfter: Double?

  public init(data: Data, status: Int, contentType: String = "application/json", retryAfter: Double? = nil) {
    self.data = data; self.status = status; self.contentType = contentType; self.retryAfter = retryAfter
  }

  var json: Any? { try? JSONSerialization.jsonObject(with: data) }
  var isJSON: Bool { contentType.lowercased().contains("json") }
}

public typealias HTTPFetch = @Sendable (_ url: URL, _ timeout: TimeInterval) async throws -> HTTPResult

public let urlSessionHTTP: HTTPFetch = { url, timeout in
  var req = URLRequest(url: url, timeoutInterval: timeout)
  req.setValue("application/json", forHTTPHeaderField: "Accept")
  // LRCLIB asks clients to identify themselves; browsers can't, native apps can.
  req.setValue("Auralis (https://github.com/xotwodfr/Auralis)", forHTTPHeaderField: "User-Agent")
  // Callback form: corelibs-foundation on Linux has no async URLSession.data.
  return try await withCheckedThrowingContinuation { continuation in
    URLSession.shared.dataTask(with: req) { data, response, error in
      if let error { return continuation.resume(throwing: error) }
      let http = response as? HTTPURLResponse
      continuation.resume(returning: HTTPResult(
        data: data ?? Data(), status: http?.statusCode ?? 0,
        contentType: http?.value(forHTTPHeaderField: "Content-Type") ?? "",
        retryAfter: http?.value(forHTTPHeaderField: "Retry-After").flatMap(Double.init)
      ))
    }.resume()
  }
}

/// What the lyrics server can do (its keys never leave it).
public struct LyricsBackend: Equatable, Sendable {
  /// The Spicy Lyrics key is configured.
  public var enabled: Bool
  /// Spotify credentials are configured too: tracks can be matched automatically.
  public var matching: Bool
}

/// A failed server check, with a message fit to show the user.
public struct ServerCheckError: Error, LocalizedError, Equatable {
  public var message: String
  public var errorDescription: String? { message }
}

public enum SpotifyOutcome: Hashable, Sendable {
  case resolved(SpotifyResolution)
  /// The lookup itself failed (backend missing, timeout, rate limit). Never cached.
  case unavailable
}

/// Everything one lookup needs; the app builds it from Settings and the session.
public struct LyricsRequest: Sendable {
  public var track: LyricsTrack
  public var client: SubsonicClient
  /// The server advertises OpenSubsonic `songLyrics`.
  public var songLyrics: Bool
  /// Allow LRCLIB (and Spotify/Spicy) lookups.
  public var external: Bool
  /// Spotify id to ask Spicy Lyrics for, when known.
  public var spotifyID: String?
  public var backendBase: String

  public init(track: LyricsTrack, client: SubsonicClient, songLyrics: Bool, external: Bool, spotifyID: String?, backendBase: String) {
    self.track = track; self.client = client; self.songLyrics = songLyrics; self.external = external; self.spotifyID = spotifyID
    self.backendBase = backendBase
  }

  /// Identity of the result: a response for one track, account or setting is never reused for another.
  var cacheKey: String {
    let c = client.credentials
    return [c.baseURL.absoluteString, c.username, track.id, track.title, track.artist, track.album, "\(Int(track.duration.rounded()))",
            external ? "ext" : "local", spotifyID ?? ""].joined(separator: "\u{1F}")
  }
}

public actor LyricsService {
  public static let providerTimeout: TimeInterval = 6
  static let probeTimeout: TimeInterval = 8
  /// Rapid skipping: a track has to stay current this long before the network is asked. Cache hits skip it.
  static let settleNanos: UInt64 = 300_000_000
  private static let lrclib = "https://lrclib.net/api"

  private let http: HTTPFetch
  // shortcut: in-memory caches (the web keeps them in IndexedDB); persist them if relaunch lookups become a problem.
  private var lyricsCache: [String: Lyrics?] = [:]
  private var matchCache: [String: SpotifyResolution] = [:]
  private var lrclibBlockedUntil = Date.distantPast
  private var matchBlockedUntil = Date.distantPast

  public init(http: @escaping HTTPFetch = urlSessionHTTP) { self.http = http }

  public func clearCaches() { lyricsCache.removeAll(); matchCache.removeAll() }

  /// Forget one track's stored result (including a remembered "not found") so the next lookup asks again.
  public func forget(_ request: LyricsRequest) {
    lyricsCache[request.cacheKey] = nil
    matchCache[Self.matchKey(request.client.credentials, request.track)] = nil
  }

  // MARK: Lyrics

  /// Tries Spicy (when a Spotify id is known), the server, then LRCLIB, and returns the first hit. Nil only if every
  /// provider answered "none"; if any failed and nothing was found, the last failure is thrown so the UI can retry.
  public func lyrics(for request: LyricsRequest) async throws -> Lyrics? {
    if let cached = lyricsCache[request.cacheKey] { return cached }
    var providers: [@Sendable () async throws -> Lyrics?] = []
    if let id = request.spotifyID { providers.append { try await self.spicy(id: id, request: request) } }
    providers.append { try await Self.server(request) }
    if request.external { providers.append { try await self.lrclib(request.track) } }

    var failure: Error?
    for provider in providers {
      try Task.checkCancellation()
      do {
        if let found = try await Self.withTimeout(Self.providerTimeout, provider) {
          lyricsCache[request.cacheKey] = .some(found)
          return found
        }
      } catch is CancellationError {
        throw CancellationError()
      } catch {
        failure = error
      }
    }
    if let failure { throw failure }
    lyricsCache[request.cacheKey] = .some(nil)
    return nil
  }

  static func withTimeout<T: Sendable>(_ seconds: TimeInterval, _ work: @escaping @Sendable () async throws -> T) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
      group.addTask { try await work() }
      group.addTask {
        try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
        throw LyricsError.timeout
      }
      defer { group.cancelAll() }
      guard let first = try await group.next() else { throw LyricsError.unavailable }
      return first
    }
  }

  /// Server lyrics: `getLyricsBySongId` when the server advertises `songLyrics`, else legacy `getLyrics`.
  static func server(_ r: LyricsRequest) async throws -> Lyrics? {
    do {
      if r.songLyrics { return try await r.client.lyrics(songId: r.track.id) }
      return try await r.client.legacyLyrics(artist: r.track.artist, title: r.track.title)
    } catch SubsonicError.notFound {
      return nil
    } catch SubsonicError.network {
      throw LyricsError.network
    } catch SubsonicError.auth {
      throw LyricsError.auth
    } catch is CancellationError {
      throw CancellationError()
    } catch {
      throw LyricsError.unavailable
    }
  }

  private func get(_ url: URL, timeout: TimeInterval = LyricsService.providerTimeout) async throws -> HTTPResult {
    do { return try await http(url, timeout) } catch {
      if Task.isCancelled { throw CancellationError() }
      throw LyricsError.network
    }
  }

  // MARK: LRCLIB

  func lrclib(_ track: LyricsTrack) async throws -> Lyrics? {
    let query = [URLQueryItem(name: "track_name", value: track.title), URLQueryItem(name: "artist_name", value: track.artist)]
    let exact = try await lrclibGet("get", query + (track.album.isEmpty ? [] : [URLQueryItem(name: "album_name", value: track.album)])
                                   + [URLQueryItem(name: "duration", value: "\(Int(track.duration.rounded()))")])
    if let exact = exact as? [String: Any], let hit = Self.best(track, [exact]) { return Self.toLyrics(hit) }
    let found = try await lrclibGet("search", query) as? [Any] ?? []
    return Self.best(track, found.compactMap { $0 as? [String: Any] }).flatMap(Self.toLyrics)
  }

  private func lrclibGet(_ path: String, _ items: [URLQueryItem]) async throws -> Any? {
    if Date() < lrclibBlockedUntil { throw LyricsError.rateLimited }
    var parts = URLComponents(string: "\(Self.lrclib)/\(path)")
    parts?.queryItems = items
    guard let url = parts?.url else { return nil }
    let res = try await get(url)
    if res.status == 404 { return nil }
    if res.status == 429 {
      lrclibBlockedUntil = Date().addingTimeInterval(res.retryAfter.flatMap { $0 > 0 ? $0 : nil } ?? 60)
      throw LyricsError.rateLimited
    }
    guard (200..<300).contains(res.status) else { throw LyricsError.unavailable }
    guard let json = res.json else { throw LyricsError.unavailable }
    return json
  }

  /// Best accepted candidate: synced first, then closest duration.
  static func best(_ track: LyricsTrack, _ records: [[String: Any]]) -> [String: Any]? {
    func text(_ r: [String: Any], _ k: String) -> Bool { !((r[k] as? String) ?? "").trimmed.isEmpty }
    return records
      .filter { r in
        LyricsMatch.isMatch(track, trackName: r["trackName"] as? String ?? "", artistName: r["artistName"] as? String ?? "",
                            albumName: r["albumName"] as? String, duration: SubsonicClient.number(r["duration"]))
          && (r["instrumental"] as? Bool == true || text(r, "syncedLyrics") || text(r, "plainLyrics"))
      }
      .min { a, b in
        let sa = text(a, "syncedLyrics"), sb = text(b, "syncedLyrics")
        if sa != sb { return sa }
        let da = abs((SubsonicClient.number(a["duration"]) ?? 0) - track.duration), db = abs((SubsonicClient.number(b["duration"]) ?? 0) - track.duration)
        return da < db
      }
  }

  static func toLyrics(_ r: [String: Any]) -> Lyrics? {
    if r["instrumental"] as? Bool == true { return Lyrics(synced: false, source: .lrclib, lines: [], instrumental: true) }
    let synced = ((r["syncedLyrics"] as? String) ?? "").trimmed, plain = ((r["plainLyrics"] as? String) ?? "").trimmed
    let text = synced.isEmpty ? plain : synced
    guard !text.isEmpty else { return nil }
    let parsed = LRC.parse(text)
    return parsed.lines.isEmpty ? nil : Lyrics(synced: parsed.synced, source: .lrclib, lines: parsed.lines)
  }

  // MARK: Spicy Lyrics (Auralis backend)

  private func backendURL(_ base: String, _ path: String) throws -> URL {
    guard !base.isEmpty, let url = URL(string: base + path) else { throw LyricsError.unavailable }
    return url
  }

  func spicy(id: String, request: LyricsRequest) async throws -> Lyrics? {
    let res = try await get(try backendURL(request.backendBase, "/api/spicy/lyrics/\(id)"))
    if [400, 404, 503].contains(res.status) { return nil } // none for this id / not configured there
    if res.status == 429 { throw LyricsError.rateLimited }
    guard (200..<300).contains(res.status) else { throw LyricsError.unavailable }
    guard res.isJSON else { return nil }
    guard let json = res.json else { throw LyricsError.unavailable }
    return SpicyLyrics.parse((json as? [String: Any])?["Body"], trackDuration: request.track.duration)
  }

  /// Asks a lyrics server what it can do. A 503 is a healthy answer from a server whose key is missing.
  public func probe(_ base: String) async throws -> LyricsBackend {
    guard !base.isEmpty, let url = URL(string: base + "/api/spicy/health") else {
      throw ServerCheckError(message: "No lyrics server is configured. Enter one above.")
    }
    let res: HTTPResult
    do { res = try await http(url, Self.probeTimeout) } catch {
      if Task.isCancelled { throw CancellationError() }
      let timedOut = (error as? URLError)?.code == .timedOut
      throw ServerCheckError(message: timedOut ? "The server did not answer in time." : "Couldn't reach the server. Check the address and your connection.")
    }
    let notOurs = ServerCheckError(message: (200..<300).contains(res.status) || res.status == 503
      ? "That address answered, but it is not an Auralis lyrics server." : "The server answered with HTTP \(res.status).")
    guard res.isJSON, let j = res.json as? [String: Any], let enabled = j["enabled"] as? Bool else { throw notOurs }
    return LyricsBackend(enabled: enabled, matching: j["matching"] as? Bool == true)
  }

  // MARK: Spotify matching

  static func matchKey(_ c: Credentials, _ t: LyricsTrack) -> String {
    [c.baseURL.absoluteString, c.username, t.id, t.title, t.artist, t.album, "\(Int(t.duration.rounded()))",
     (t.isrc ?? []).joined(separator: ","), t.explicit.map { "\($0)" } ?? ""].joined(separator: "\u{1F}")
  }

  /// The Spotify recording for a library track, from cache or the backend. Throws only CancellationError.
  public func spotifyMatch(_ track: LyricsTrack, credentials: Credentials, backendBase: String) async throws -> SpotifyOutcome {
    let key = Self.matchKey(credentials, track)
    if let cached = matchCache[key] { return .resolved(cached) }
    if Date() < matchBlockedUntil { return .unavailable }
    try await Task.sleep(nanoseconds: Self.settleNanos)

    var parts = URLComponents(string: backendBase + "/api/spicy/match")
    let title = String(track.title.replacing(regex: #"\s*[(\[](?:feat|ft)\.?\s[^)\]]*[)\]]"#, with: "", caseInsensitive: true).prefix(200))
    var items = [URLQueryItem(name: "title", value: title)]
    let primary = track.artist.replacing(regex: #"\s*(?:,|;|/|\bfeat\.?\s|\bft\.?\s|\bfeaturing\b)\s*"#, with: "\u{1F}", caseInsensitive: true)
      .components(separatedBy: "\u{1F}").first?.trimmed ?? ""
    if !primary.isEmpty { items.append(URLQueryItem(name: "artist", value: String(primary.prefix(200)))) }
    if let isrc = track.isrc?.first { items.append(URLQueryItem(name: "isrc", value: isrc)) }
    parts?.queryItems = items
    guard !backendBase.isEmpty, let url = parts?.url else { return .unavailable }

    let res: HTTPResult
    do { res = try await http(url, Self.providerTimeout) } catch {
      try Task.checkCancellation()
      return .unavailable // network failure or timeout
    }
    if res.status == 429 {
      matchBlockedUntil = Date().addingTimeInterval(res.retryAfter.flatMap { $0 > 0 ? min($0, 600) : nil } ?? 30)
      return .unavailable
    }
    guard (200..<300).contains(res.status), res.isJSON, let list = (res.json as? [String: Any])?["candidates"] as? [Any] else {
      return .unavailable
    }
    let resolution = SpotifyMatch.resolve(track, list.compactMap(SpotifyCandidate.init(json:)))
    matchCache[key] = resolution
    return .resolved(resolution)
  }
}
