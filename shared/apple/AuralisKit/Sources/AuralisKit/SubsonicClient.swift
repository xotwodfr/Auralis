import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public enum SubsonicError: Error, Equatable, LocalizedError {
  case invalidURL, network, http(Int), invalidResponse, auth, notFound, server(code: Int, message: String)

  /// Messages never include the URL: it carries the auth token.
  public var errorDescription: String? {
    switch self {
    case .invalidURL: "That server address isn't valid."
    case .network: "Could not reach the server."
    case .http(let status): "The server responded with HTTP \(status)."
    case .invalidResponse: "The server's response wasn't a Subsonic response."
    case .auth: "Wrong username or password."
    case .notFound: "That item no longer exists on the server."
    case .server(_, let message): message
    }
  }
}

/// Mirrors src/api/subsonic (web). Token auth only: the password is never sent.
public struct SubsonicClient: Sendable {
  public static let apiVersion = "1.16.1"
  public static let clientName = "Auralis"

  public typealias Fetch = @Sendable (URL) async throws -> (Data, Int)

  public let credentials: Credentials
  private let fetch: Fetch
  private let makeSalt: @Sendable () -> String

  public init(
    credentials: Credentials,
    fetch: @escaping Fetch = SubsonicClient.urlSessionFetch,
    makeSalt: @escaping @Sendable () -> String = { String((0..<16).map { _ in "0123456789abcdef".randomElement()! }) }
  ) {
    self.credentials = credentials
    self.fetch = fetch
    self.makeSalt = makeSalt
  }

  public static let urlSessionFetch: Fetch = { url in
    // Callback form: corelibs-foundation on Linux has no async URLSession.data.
    try await withCheckedThrowingContinuation { continuation in
      URLSession.shared.dataTask(with: url) { data, response, error in
        if let error { continuation.resume(throwing: error) } else {
          continuation.resume(returning: (data ?? Data(), (response as? HTTPURLResponse)?.statusCode ?? 0))
        }
      }.resume()
    }
  }

  /// Accepts `host:port` (assumes https), trims trailing slashes.
  public static func normalizeBaseURL(_ input: String) throws -> URL {
    let raw = input.trimmingCharacters(in: .whitespacesAndNewlines)
    let withScheme = raw.range(of: "^[A-Za-z][A-Za-z0-9+.-]*://", options: .regularExpression) != nil ? raw : "https://\(raw)"
    guard !raw.isEmpty, var parts = URLComponents(string: withScheme),
          let scheme = parts.scheme?.lowercased(), scheme == "http" || scheme == "https",
          parts.host?.isEmpty == false, parts.user == nil, parts.password == nil else { throw SubsonicError.invalidURL }
    parts.query = nil; parts.fragment = nil
    while parts.path.hasSuffix("/") { parts.path.removeLast() }
    guard let url = parts.url else { throw SubsonicError.invalidURL }
    return url
  }

  public func url(_ endpoint: String, _ params: [(String, String)] = []) -> URL {
    let salt = makeSalt()
    var parts = URLComponents(url: credentials.baseURL.appendingPathComponent("rest/\(endpoint)"), resolvingAgainstBaseURL: false)!
    parts.queryItems = (params + [
      ("u", credentials.username), ("t", MD5.hex(credentials.password + salt)), ("s", salt),
      ("v", Self.apiVersion), ("c", Self.clientName), ("f", "json"),
    ]).map { URLQueryItem(name: $0.0, value: $0.1) }
    return parts.url!
  }

  func request(_ endpoint: String, _ params: [(String, String)] = []) async throws -> [String: Any] {
    let data: Data, status: Int
    do { (data, status) = try await fetch(url(endpoint, params)) } catch { throw SubsonicError.network }
    guard (200..<300).contains(status) else { throw SubsonicError.http(status) }
    guard let root = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          let inner = root["subsonic-response"] as? [String: Any],
          let state = inner["status"] as? String, state == "ok" || state == "failed" else { throw SubsonicError.invalidResponse }
    if state == "failed" {
      let error = inner["error"] as? [String: Any]
      let code = error?["code"] as? Int ?? 0
      switch code {
      case 40, 41: throw SubsonicError.auth
      case 70: throw SubsonicError.notFound
      default: throw SubsonicError.server(code: code, message: error?["message"] as? String ?? "Subsonic error \(code)")
      }
    }
    return inner
  }

  // MARK: Endpoints

  public func ping() async throws { _ = try await request("ping") }

  /// `ping`, keeping what the response says about the server.
  public func serverInfo() async throws -> ServerInfo {
    let r = try await request("ping")
    return ServerInfo(apiVersion: r["version"] as? String ?? "", type: r["type"] as? String, serverVersion: r["serverVersion"] as? String,
                      openSubsonic: r["openSubsonic"] as? Bool ?? false)
  }

  /// OpenSubsonic extension names (e.g. `songLyrics`). Empty for plain Subsonic servers.
  public func openSubsonicExtensions() async throws -> [String] {
    let r = try await request("getOpenSubsonicExtensions")
    return ((r["openSubsonicExtensions"] as? [Any]) ?? []).compactMap { ($0 as? [String: Any])?["name"] as? String }
  }

  public func artists() async throws -> [Artist] {
    let r = try await request("getArtists")
    return Self.objects(r["artists"], "index").flatMap { Self.objects($0, "artist") }.map(Self.artist)
  }

  public func artist(id: String) async throws -> (artist: Artist, albums: [Album]) {
    let r = try await request("getArtist", [("id", id)])
    guard let raw = r["artist"] as? [String: Any] else { throw SubsonicError.invalidResponse }
    return (Self.artist(raw), Self.objects(raw, "album").map(Self.album))
  }

  public func albumList(_ type: AlbumListType, size: Int = 60, offset: Int = 0) async throws -> [Album] {
    let r = try await request("getAlbumList2", [("type", type.rawValue), ("size", "\(size)"), ("offset", "\(offset)")])
    return Self.objects(r["albumList2"], "album").map(Self.album)
  }

  public func newestAlbums(size: Int = 60, offset: Int = 0) async throws -> [Album] {
    try await albumList(.newest, size: size, offset: offset)
  }

  public func album(id: String) async throws -> (album: Album, songs: [Song]) {
    let r = try await request("getAlbum", [("id", id)])
    guard let raw = r["album"] as? [String: Any] else { throw SubsonicError.invalidResponse }
    return (Self.album(raw), Self.objects(raw, "song").map(Self.song))
  }

  public func starred() async throws -> SearchResults {
    let r = try await request("getStarred2")
    return Self.results(r["starred2"])
  }

  public func setStarred(_ kind: StarKind, id: String, on: Bool) async throws {
    let key = switch kind { case .song: "id"; case .album: "albumId"; case .artist: "artistId" }
    _ = try await request(on ? "star" : "unstar", [(key, id)])
  }

  public func playlists() async throws -> [Playlist] {
    let r = try await request("getPlaylists")
    return Self.objects(r["playlists"], "playlist").map(Self.playlist)
  }

  public func playlist(id: String) async throws -> (playlist: Playlist, songs: [Song]) {
    let r = try await request("getPlaylist", [("id", id)])
    guard let raw = r["playlist"] as? [String: Any] else { throw SubsonicError.invalidResponse }
    return (Self.playlist(raw), Self.objects(raw, "entry").map(Self.song))
  }

  public func createPlaylist(name: String, songIds: [String]) async throws {
    _ = try await request("createPlaylist", [("name", name)] + songIds.map { ("songId", $0) })
  }

  public func addToPlaylist(id: String, songIds: [String]) async throws {
    _ = try await request("updatePlaylist", [("playlistId", id)] + songIds.map { ("songIdToAdd", $0) })
  }

  /// `indexes` are positions in the playlist, as the server numbers its entries.
  public func removeFromPlaylist(id: String, indexes: [Int]) async throws {
    _ = try await request("updatePlaylist", [("playlistId", id)] + indexes.map { ("songIndexToRemove", "\($0)") })
  }

  public func search(_ query: String, artistCount: Int = 20, albumCount: Int = 20, songCount: Int = 20) async throws -> SearchResults {
    let r = try await request("search3", [
      ("query", query), ("artistCount", "\(artistCount)"), ("albumCount", "\(albumCount)"), ("songCount", "\(songCount)"),
    ])
    return Self.results(r["searchResult3"])
  }

  /// Play reporting, as the web client does: `submission: false` = now playing, `true` = counted play.
  public func scrobble(id: String, submission: Bool) async throws {
    _ = try await request("scrobble", [("id", id), ("submission", "\(submission)")])
  }

  /// Server-side lyrics (OpenSubsonic `songLyrics`), mirroring src/api/lyrics/providers/server.ts: a synced version
  /// wins, entries without text are skipped, and the offset (positive = sooner) is subtracted.
  public func lyrics(songId: String) async throws -> Lyrics? {
    let r = try await request("getLyricsBySongId", [("id", songId)])
    let usable = Self.objects(r["lyricsList"], "structuredLyrics").filter { list in
      Self.objects(list, "line").contains { !(($0["value"] as? String) ?? "").trimmingCharacters(in: .whitespaces).isEmpty }
    }
    let allTimed = { (list: [String: Any]) in Self.objects(list, "line").allSatisfy { Self.number($0["start"]) != nil } }
    guard let pick = usable.first(where: { $0["synced"] as? Bool == true && allTimed($0) }) ?? usable.first else { return nil }
    let synced = pick["synced"] as? Bool == true && allTimed(pick)
    let offset = (Self.number(pick["offset"]) ?? 0) / 1000
    let lines = Self.objects(pick, "line").map { line in
      LyricLine(time: synced ? max(0, (Self.number(line["start"]) ?? 0) / 1000 - offset) : nil,
                text: ((line["value"] as? String) ?? "").trimmingCharacters(in: .whitespaces))
    }
    return Lyrics(synced: synced, source: .server, lines: lines)
  }

  /// Legacy `getLyrics` (plain or LRC text) for servers without `songLyrics`.
  public func legacyLyrics(artist: String, title: String) async throws -> Lyrics? {
    let r = try await request("getLyrics", [("artist", artist), ("title", title)])
    let text = (r["lyrics"] as? [String: Any])?["value"] as? String ?? ""
    guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
    let parsed = LRC.parse(text)
    return parsed.lines.isEmpty ? nil : Lyrics(synced: parsed.synced, source: .server, lines: parsed.lines)
  }

  public func streamURL(for song: Song) -> URL { url("stream", [("id", song.id)]) }

  public func coverArtURL(_ id: String, size: Int = 600) -> URL { url("getCoverArt", [("id", id), ("size", "\(size)")]) }

  // MARK: Lenient mapping (servers and proxies send odd shapes: a malformed list degrades to empty)

  static func objects(_ container: Any?, _ key: String) -> [[String: Any]] {
    ((container as? [String: Any])?[key] as? [Any])?.compactMap { $0 as? [String: Any] } ?? []
  }

  private static func id(_ v: Any?) -> String? {
    if let s = v as? String { return s }
    if let n = v as? NSNumber { return n.stringValue }
    return nil
  }

  static func number(_ v: Any?) -> Double? {
    if let n = v as? NSNumber, !(v is Bool) { return n.doubleValue }
    return v as? Double
  }

  // Subsonic sends `starred` as the time the user starred it; its presence is the flag.
  private static func starred(_ v: Any?) -> Bool { !((v as? String) ?? "").isEmpty }

  /// ISO 8601 (`Z` or `±hh:mm`), any number of fractional digits (Navidrome sends nanoseconds). Parsed by hand:
  /// ISO8601DateFormatter rejects >3 fraction digits and crashes in some Linux Foundation builds.
  static func date(_ v: Any?) -> Date? {
    guard let m = (v as? String)?.firstMatch(regex: #"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):?(\d{2}))$"#) else { return nil }
    let n = m.map { $0.flatMap { Int($0) } }
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = TimeZone(secondsFromGMT: 0) ?? cal.timeZone
    guard let base = cal.date(from: DateComponents(year: n[1], month: n[2], day: n[3], hour: n[4], minute: n[5], second: n[6])) else { return nil }
    let offset = ((n[9] ?? 0) * 3600 + (n[10] ?? 0) * 60) * (m[8] == "-" ? -1 : 1)
    return base.addingTimeInterval(TimeInterval(-offset))
  }

  // OpenSubsonic `isrc` is a list; keep only well-formed codes.
  private static func isrcs(_ v: Any?) -> [String]? {
    let list = ((v as? [Any]) ?? []).compactMap { $0 as? String }
      .filter { $0.range(of: "^[A-Za-z]{2}[A-Za-z0-9]{3}\\d{7}$", options: .regularExpression) != nil }.map { $0.uppercased() }
    return list.isEmpty ? nil : list
  }

  static func results(_ container: Any?) -> SearchResults {
    SearchResults(artists: objects(container, "artist").map(artist), albums: objects(container, "album").map(album),
                  songs: objects(container, "song").map(song))
  }

  static func artist(_ r: [String: Any]) -> Artist {
    Artist(id: id(r["id"]) ?? "", name: r["name"] as? String ?? "", albumCount: r["albumCount"] as? Int ?? 0, coverArt: id(r["coverArt"]),
           starred: starred(r["starred"]))
  }

  static func album(_ r: [String: Any]) -> Album {
    Album(id: id(r["id"]) ?? "", name: r["name"] as? String ?? r["title"] as? String ?? "", artist: r["artist"] as? String ?? "",
          artistId: id(r["artistId"]), coverArt: id(r["coverArt"]), songCount: r["songCount"] as? Int ?? 0,
          duration: number(r["duration"]) ?? 0, year: r["year"] as? Int, created: date(r["created"]), starred: starred(r["starred"]))
  }

  static func song(_ r: [String: Any]) -> Song {
    let explicit: Bool? = switch r["explicitStatus"] as? String { case "explicit": true; case "clean": false; default: nil }
    return Song(id: id(r["id"]) ?? "", title: r["title"] as? String ?? "", album: r["album"] as? String ?? "", albumId: id(r["albumId"]),
                artist: r["artist"] as? String ?? "", artistId: id(r["artistId"]), track: r["track"] as? Int,
                duration: number(r["duration"]) ?? 0, coverArt: id(r["coverArt"]), isrc: isrcs(r["isrc"]), explicit: explicit,
                starred: starred(r["starred"]) ? true : nil)
  }

  static func playlist(_ r: [String: Any]) -> Playlist {
    Playlist(id: id(r["id"]) ?? "", name: r["name"] as? String ?? "", songCount: r["songCount"] as? Int ?? 0,
             duration: number(r["duration"]) ?? 0, coverArt: id(r["coverArt"]), owner: r["owner"] as? String)
  }
}
