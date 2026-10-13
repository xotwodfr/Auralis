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

/// What `ping` reports about the server (shown in Settings → Connection).
public struct ServerInfo: Equatable, Sendable {
  public var apiVersion: String
  public var type: String?
  public var serverVersion: String?
  public var openSubsonic: Bool
}

public struct Artist: Identifiable, Hashable, Sendable {
  public let id: String
  public var name: String
  public var albumCount: Int
  public var coverArt: String?
  public var starred: Bool = false
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
  /// When the album was added to the library (ISO 8601 from the server).
  public var created: Date?
  public var starred: Bool = false
}

public struct Song: Identifiable, Hashable, Codable, Sendable {
  public let id: String
  public var title: String
  public var album: String
  public var albumId: String?
  public var artist: String
  public var artistId: String?
  public var track: Int?
  /// Seconds.
  public var duration: Double
  public var coverArt: String?
  /// OpenSubsonic: the recording's ISRC(s), when the files are tagged.
  public var isrc: [String]?
  /// OpenSubsonic `explicitStatus`; nil when unknown.
  public var explicit: Bool?
  public var starred: Bool?

  public init(id: String, title: String, album: String = "", albumId: String? = nil, artist: String = "", artistId: String? = nil,
              track: Int? = nil, duration: Double = 0, coverArt: String? = nil, isrc: [String]? = nil, explicit: Bool? = nil,
              starred: Bool? = nil) {
    self.id = id; self.title = title; self.album = album; self.albumId = albumId; self.artist = artist; self.artistId = artistId
    self.track = track; self.duration = duration; self.coverArt = coverArt; self.isrc = isrc; self.explicit = explicit
    self.starred = starred
  }
}

public struct Playlist: Identifiable, Hashable, Sendable {
  public let id: String
  public var name: String
  public var songCount: Int
  /// Seconds.
  public var duration: Double = 0
  public var coverArt: String?
  public var owner: String?
}

public struct SearchResults: Sendable {
  public var artists: [Artist] = []
  public var albums: [Album] = []
  public var songs: [Song] = []

  public init(artists: [Artist] = [], albums: [Album] = [], songs: [Song] = []) {
    self.artists = artists; self.albums = albums; self.songs = songs
  }

  public var isEmpty: Bool { artists.isEmpty && albums.isEmpty && songs.isEmpty }
}

/// `getAlbumList2` orderings the app uses. `newest` = recently added, `recent` = recently played.
public enum AlbumListType: String, Sendable {
  case newest, recent, frequent, random, alphabeticalByName, alphabeticalByArtist
}

public enum StarKind: String, Sendable { case song, album, artist }
