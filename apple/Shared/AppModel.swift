import AuralisKit
import Foundation
import Observation

enum Load<Value> {
  case idle, loading, loaded(Value), failed(String)
}

/// Session + library state. Real data only: everything here comes from the user's own Subsonic/Navidrome server.
@MainActor @Observable
final class AppModel {
  private(set) var client: SubsonicClient?
  private(set) var isConnecting = false
  var connectError: String?
  private(set) var albums: Load<[Album]> = .idle
  private(set) var playlists: Load<[Playlist]> = .idle

  @ObservationIgnored private var coverURLs: [String: URL] = [:]
  @ObservationIgnored private let defaults = UserDefaults.standard
  private static let serverKey = "auralis.server", userKey = "auralis.username"

  /// Silent sign-in from the saved server + Keychain password.
  func restore() async {
    guard client == nil, let server = defaults.string(forKey: Self.serverKey), let user = defaults.string(forKey: Self.userKey),
          let password = Keychain.load(account: "\(user)@\(server)") else { return }
    await connect(server: server, username: user, password: password, remember: false)
  }

  func connect(server: String, username: String, password: String, remember: Bool = true) async {
    isConnecting = true
    connectError = nil
    defer { isConnecting = false }
    do {
      let base = try SubsonicClient.normalizeBaseURL(server)
      let candidate = SubsonicClient(credentials: Credentials(baseURL: base, username: username, password: password))
      try await candidate.ping()
      if remember {
        defaults.set(base.absoluteString, forKey: Self.serverKey)
        defaults.set(username, forKey: Self.userKey)
        Keychain.save(password, account: "\(username)@\(base.absoluteString)")
      }
      client = candidate
      await reload()
    } catch {
      connectError = error.localizedDescription
    }
  }

  func signOut() {
    if let server = defaults.string(forKey: Self.serverKey), let user = defaults.string(forKey: Self.userKey) {
      Keychain.delete(account: "\(user)@\(server)")
    }
    defaults.removeObject(forKey: Self.serverKey)
    defaults.removeObject(forKey: Self.userKey)
    client = nil
    coverURLs.removeAll()
    albums = .idle
    playlists = .idle
  }

  func reload() async {
    guard let client else { return }
    albums = .loading
    playlists = .loading
    async let a = Self.load { try await client.newestAlbums() }
    async let p = Self.load { try await client.playlists() }
    (albums, playlists) = await (a, p)
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

  private static func load<T>(_ work: () async throws -> T) async -> Load<T> {
    do { return .loaded(try await work()) } catch { return .failed(error.localizedDescription) }
  }
}
