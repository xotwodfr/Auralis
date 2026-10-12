import Foundation

public struct Credentials: Equatable, Sendable {
  public var baseURL: URL
  public var username: String
  public var password: String

  public init(baseURL: URL, username: String, password: String) {
    self.baseURL = baseURL
    self.username = username
    self.password = password
  }
}

public struct Artist: Identifiable, Hashable, Sendable {
  public let id: String
  public var name: String
  public var albumCount: Int
  public var coverArt: String?
}

public struct Album: Identifiable, Hashable, Sendable {
  public let id: String
  public var name: String
  public var artist: String
  public var artistId: String?
  public var coverArt: String?
  public var songCount: Int
  /// Seconds.
  public var duration: Double
  public var year: Int?
}

public struct Song: Identifiable, Hashable, Codable, Sendable {
  public let id: String
  public var title: String
  public var album: String
  public var albumId: String?
  public var artist: String
  public var track: Int?
  /// Seconds.
  public var duration: Double
  public var coverArt: String?

  public init(id: String, title: String, album: String = "", albumId: String? = nil, artist: String = "",
              track: Int? = nil, duration: Double = 0, coverArt: String? = nil) {
    self.id = id; self.title = title; self.album = album; self.albumId = albumId; self.artist = artist
    self.track = track; self.duration = duration; self.coverArt = coverArt
  }
}

public struct Playlist: Identifiable, Hashable, Sendable {
  public let id: String
  public var name: String
  public var songCount: Int
  public var coverArt: String?
}

public struct SearchResults: Sendable {
  public var artists: [Artist] = []
  public var albums: [Album] = []
  public var songs: [Song] = []
}

public struct LyricLine: Hashable, Sendable {
  /// Seconds; nil for unsynced lyrics.
  public var start: Double?
  public var text: String
}
