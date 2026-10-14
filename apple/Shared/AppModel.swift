import AuralisKit
import CoreGraphics
import Foundation
import ImageIO
import Observation

enum Load<Value> {
  case idle, loading, loaded(Value), failed(Error)

  var value: Value? { if case .loaded(let v) = self { v } else { nil } }
}

/// Session, favourites and app-wide feedback. Real data only: everything here comes from the user's own server.
@MainActor @Observable
final class AppModel {
  private(set) var client: SubsonicClient?
  private(set) var isConnecting = false
  var connectError: String?
  private(set) var server: ServerInfo?
  /// The server advertises OpenSubsonic `songLyrics` (`getLyricsBySongId`).
  private(set) var songLyrics = false
  /// Credentials are stored on this device (Keychain).
  private(set) var remember = false
  /// The one `getStarred2` list every heart and the Favorites page read, so they can never disagree.
  private(set) var starred: Load<SearchResults> = .idle
  /// Bumped after playlist edits so open playlist views reload.
  private(set) var playlistsVersion = 0
  private(set) var toast: Toast?
  private(set) var artworkPalette: ArtworkPalette?
  /// What the configured lyrics server can do; nil until probed (or when the lyrics server is off).
  var lyricsBackend: Load<LyricsBackend> = .idle

  let lyrics = LyricsService()

  struct Toast: Equatable, Identifiable {
    let id = UUID()
    var message: String
    var isError: Bool
  }

  @ObservationIgnored private var coverURLs: [String: URL] = [:]
  @ObservationIgnored private var palettes: [String: ArtworkPalette] = [:]
  @ObservationIgnored private let defaults = UserDefaults.standard
  private static let serverKey = "auralis.server", userKey = "auralis.username", paletteKey = "auralis.palette"

  init() {
    artworkPalette = defaults.data(forKey: Self.paletteKey).flatMap { try? JSONDecoder().decode(ArtworkPalette.self, from: $0) }
  }

  /// Silent sign-in from the saved server + Keychain password.
  func restore() async {
    guard client == nil, let server = defaults.string(forKey: Self.serverKey), let user = defaults.string(forKey: Self.userKey),
          let password = Keychain.load(account: "\(user)@\(server)") else { return }
    await connect(server: server, username: user, password: password, remember: true, saveCredentials: false)
  }

  func connect(server: String, username: String, password: String, remember: Bool, saveCredentials: Bool = true) async {
    isConnecting = true
    connectError = nil
    defer { isConnecting = false }
    do {
      let base = try SubsonicClient.normalizeBaseURL(server)
      let candidate = SubsonicClient(credentials: Credentials(baseURL: base, username: username, password: password))
      let info = try await candidate.serverInfo()
      // Plain Subsonic servers answer this with an error; that only means "no extensions".
      let extensions = info.openSubsonic ? ((try? await candidate.openSubsonicExtensions()) ?? []) : []
      var stored = remember
      if remember && saveCredentials {
        defaults.set(base.absoluteString, forKey: Self.serverKey)
        defaults.set(username, forKey: Self.userKey)
        stored = Keychain.save(password, account: "\(username)@\(base.absoluteString)")
      }
      self.server = info
      songLyrics = extensions.contains("songLyrics")
      self.remember = stored
      client = candidate
      await reloadStarred()
    } catch {
      connectError = Self.message(for: error)
    }
  }

  /// Signs out and removes the stored credentials.
  func signOut() {
    forgetDevice()
    client = nil
    server = nil
    coverURLs.removeAll()
    starred = .idle
  }

  /// Stay connected now, but sign in again next time.
  func forgetDevice() {
    if let server = defaults.string(forKey: Self.serverKey), let user = defaults.string(forKey: Self.userKey) {
      Keychain.delete(account: "\(user)@\(server)")
    }
    defaults.removeObject(forKey: Self.serverKey)
    defaults.removeObject(forKey: Self.userKey)
    remember = false
  }

  /// Subsonic URLs carry a fresh salt, so cache one per (id, size) or every redraw would refetch the image.
  func coverURL(_ id: String, size: Int) -> URL? {
    guard let client else { return nil }
    let key = "\(id)@\(size)"
    if let url = coverURLs[key] { return url }
    let url = client.coverArtURL(id, size: size)
    coverURLs[key] = url
    return url
  }

  // MARK: Favourites

  func reloadStarred() async {
    guard let client else { return }
    if starred.value == nil { starred = .loading }
    do { starred = .loaded(try await client.starred()) } catch { if starred.value == nil { starred = .failed(error) } }
  }

  func isStarred(_ kind: StarKind, _ id: String) -> Bool {
    guard let s = starred.value else { return false }
    switch kind {
    case .song: return s.songs.contains { $0.id == id }
    case .album: return s.albums.contains { $0.id == id }
    case .artist: return s.artists.contains { $0.id == id }
    }
  }

  enum StarItem { case song(Song), album(Album), artist(Artist) }

  /// Flips the list first so the heart responds instantly, then reconciles with the server.
  func toggleStar(_ item: StarItem) async {
    guard let client else { return }
    let previous = starred.value ?? SearchResults()
    var next = previous
    let kind: StarKind, id: String, on: Bool
    switch item {
    case .song(let s):
      kind = .song; id = s.id; on = !previous.songs.contains { $0.id == s.id }
      next.songs.removeAll { $0.id == s.id }; if on { next.songs.append(s) }
    case .album(let a):
      kind = .album; id = a.id; on = !previous.albums.contains { $0.id == a.id }
      next.albums.removeAll { $0.id == a.id }; if on { next.albums.append(a) }
    case .artist(let a):
      kind = .artist; id = a.id; on = !previous.artists.contains { $0.id == a.id }
      next.artists.removeAll { $0.id == a.id }; if on { next.artists.append(a) }
    }
    starred = .loaded(next)
    do { try await client.setStarred(kind, id: id, on: on) } catch {
      starred = .loaded(previous)
      show(on ? "Couldn't add to favorites." : "Couldn't remove from favorites.", error: true)
    }
    await reloadStarred()
  }

  // MARK: Lyrics server

  @ObservationIgnored private var probedBase: String?

  /// What the lyrics server can do; asked once per address (Settings → "Test connection" forces a fresh check).
  func probeLyricsBackend(_ base: String, force: Bool = false) async {
    if !force && probedBase == base {
      if case .idle = lyricsBackend {} else { return }
    }
    probedBase = base
    lyricsBackend = .loading
    do { lyricsBackend = .loaded(try await lyrics.probe(base)) } catch is CancellationError {
      lyricsBackend = .idle // ask again next time rather than remembering a cancelled check as a failure
    } catch {
      lyricsBackend = .failed(error)
    }
  }

  // MARK: Playlists

  func addToPlaylist(_ song: Song, playlist: Playlist?, newName: String? = nil) async throws {
    guard let client else { return }
    if let playlist { try await client.addToPlaylist(id: playlist.id, songIds: [song.id]) } else if let newName {
      try await client.createPlaylist(name: newName, songIds: [song.id])
    }
    playlistsVersion += 1
    show("Added “\(song.title)” to “\(playlist?.name ?? newName ?? "")”.")
  }

  func removeFromPlaylist(_ song: Song, playlistID: String, index: Int) async {
    guard let client else { return }
    do {
      try await client.removeFromPlaylist(id: playlistID, indexes: [index])
      playlistsVersion += 1
      show("Removed “\(song.title)” from the playlist.")
    } catch {
      show(Self.message(for: error), error: true)
    }
  }

  // MARK: Feedback

  func show(_ message: String, error: Bool = false) {
    let t = Toast(message: message, isError: error)
    toast = t
    Task {
      try? await Task.sleep(for: .seconds(4))
      if toast?.id == t.id { toast = nil }
    }
  }

  /// User-facing text for a failure (src/features/connect/errorMessage.ts).
  static func message(for error: Error) -> String {
    switch error as? SubsonicError {
    case .invalidURL?: "Enter a valid server address, like https://music.example.com."
    case .network?: "Couldn't reach the server. Check the address and your connection."
    case .http(let status)?: "The server responded with HTTP \(status). Check the address."
    case .invalidResponse?: "That address didn't respond like a Subsonic server."
    case .auth?: "Wrong username or password."
    case .notFound?: "That item no longer exists on the server."
    case .server(_, let message)?: message
    case nil: (error as? LocalizedError)?.errorDescription ?? "Something went wrong. Try again."
    }
  }

  // MARK: Artwork theme

  /// Samples the cover at 32×32 for the "Album Artwork" theme; the last usable palette is kept and stored.
  func loadPalette(cover: String) async {
    if let hit = palettes[cover] { return setPalette(hit) }
    guard let url = coverURL(cover, size: 64), let (data, _) = try? await URLSession.shared.data(from: url),
          let pixels = Self.pixels(data, side: 32) else { return }
    let palette = ArtworkPalette.derive(pixels)
    palettes[cover] = palette
    setPalette(palette)
  }

  private func setPalette(_ p: ArtworkPalette) {
    artworkPalette = p
    defaults.set(try? JSONEncoder().encode(p), forKey: Self.paletteKey)
  }

  private static func pixels(_ data: Data, side: Int) -> [UInt8]? {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return nil }
    var buffer = [UInt8](repeating: 0, count: side * side * 4)
    let drawn = buffer.withUnsafeMutableBytes { raw -> Bool in
      guard let ctx = CGContext(data: raw.baseAddress, width: side, height: side, bitsPerComponent: 8, bytesPerRow: side * 4,
                                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
      ctx.draw(image, in: CGRect(x: 0, y: 0, width: side, height: side))
      return true
    }
    return drawn ? buffer : nil
  }
}
