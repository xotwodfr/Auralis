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

  public func newestAlbums(size: Int = 60, offset: Int = 0) async throws -> [Album] {
    let r = try await request("getAlbumList2", [("type", "newest"), ("size", "\(size)"), ("offset", "\(offset)")])
    return Self.objects(r["albumList2"], "album").map(Self.album)
  }

  public func album(id: String) async throws -> (album: Album, songs: [Song]) {
    let r = try await request("getAlbum", [("id", id)])
    guard let raw = r["album"] as? [String: Any] else { throw SubsonicError.invalidResponse }
    return (Self.album(raw), Self.objects(raw, "song").map(Self.song))
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

  public func search(_ query: String, count: Int = 20) async throws -> SearchResults {
    let r = try await request("search3", [
      ("query", query), ("artistCount", "\(count)"), ("albumCount", "\(count)"), ("songCount", "\(count)"),
    ])
    let s = r["searchResult3"]
    return SearchResults(artists: Self.objects(s, "artist").map(Self.artist), albums: Self.objects(s, "album").map(Self.album),
                         songs: Self.objects(s, "song").map(Self.song))
  }

  /// Play reporting, as the web client does: `submission: false` = now playing, `true` = counted play.
  public func scrobble(id: String, submission: Bool) async throws {
    _ = try await request("scrobble", [("id", id), ("submission", "\(submission)")])
  }

  /// Server-side lyrics (OpenSubsonic `songLyrics`). Empty when the server has none or lacks the extension.
  public func lyrics(songId: String) async throws -> [LyricLine] {
    let r = try await request("getLyricsBySongId", [("id", songId)])
    let lists = Self.objects(r["lyricsList"], "structuredLyrics")
    guard let best = lists.first(where: { $0["synced"] as? Bool == true }) ?? lists.first else { return [] }
    let offset = (best["offset"] as? Double ?? 0) / 1000
    return Self.objects(best, "line").map { line in
      LyricLine(start: (line["start"] as? Double).map { $0 / 1000 + offset }, text: line["value"] as? String ?? "")
    }
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

  static func artist(_ r: [String: Any]) -> Artist {
    Artist(id: id(r["id"]) ?? "", name: r["name"] as? String ?? "", albumCount: r["albumCount"] as? Int ?? 0, coverArt: id(r["coverArt"]))
  }

  static func album(_ r: [String: Any]) -> Album {
    Album(id: id(r["id"]) ?? "", name: r["name"] as? String ?? r["title"] as? String ?? "", artist: r["artist"] as? String ?? "",
          artistId: id(r["artistId"]), coverArt: id(r["coverArt"]), songCount: r["songCount"] as? Int ?? 0,
          duration: r["duration"] as? Double ?? 0, year: r["year"] as? Int)
  }

  static func song(_ r: [String: Any]) -> Song {
    Song(id: id(r["id"]) ?? "", title: r["title"] as? String ?? "", album: r["album"] as? String ?? "", albumId: id(r["albumId"]),
         artist: r["artist"] as? String ?? "", track: r["track"] as? Int, duration: r["duration"] as? Double ?? 0, coverArt: id(r["coverArt"]))
  }

  static func playlist(_ r: [String: Any]) -> Playlist {
    Playlist(id: id(r["id"]) ?? "", name: r["name"] as? String ?? "", songCount: r["songCount"] as? Int ?? 0, coverArt: id(r["coverArt"]))
  }
}
