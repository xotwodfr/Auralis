import Foundation

public enum RepeatMode: String, Codable, Sendable { case off, all, one }

/// Pure queue state, mirroring src/audio/queue.ts semantics where it matters: shuffle keeps the current track,
/// repeat-one only applies to natural track ends, never to an explicit Next.
public struct PlayQueue: Codable, Equatable, Sendable {
  public private(set) var songs: [Song] = []
  public private(set) var index: Int?
  public var repeatMode: RepeatMode = .off
  private var original: [Song]?

  public init() {}

  public var current: Song? { index.flatMap { songs.indices.contains($0) ? songs[$0] : nil } }
  public var isShuffled: Bool { original != nil }

  public mutating func play(_ songs: [Song], startAt: Int = 0) {
    self.songs = songs
    original = nil
    index = songs.indices.contains(startAt) ? startAt : nil
  }

  public mutating func setShuffle(_ on: Bool) {
    if on, original == nil {
      original = songs
      let rest = songs.enumerated().filter { $0.offset != index }.map(\.element).shuffled()
      songs = current.map { [$0] + rest } ?? rest
      if current != nil { index = 0 }
    } else if !on, let restore = original {
      let now = current
      songs = restore
      original = nil
      index = now.flatMap { c in songs.firstIndex(of: c) }
    }
  }

  public mutating func addNext(_ song: Song) {
    songs.insert(song, at: (index ?? -1) + 1)
    original?.append(song)
    if index == nil { index = 0 }
  }

  public mutating func append(_ song: Song) {
    songs.append(song)
    original?.append(song)
    if index == nil { index = 0 }
  }

  /// Explicit Next. Returns false at the end of the queue (unless repeating all).
  @discardableResult
  public mutating func next() -> Bool { advance(naturalEnd: false) }

  /// Track ended by itself: repeat-one replays the same song.
  @discardableResult
  public mutating func trackEnded() -> Bool { advance(naturalEnd: true) }

  @discardableResult
  public mutating func previous() -> Bool {
    guard let i = index else { return false }
    if i > 0 { index = i - 1 } else if repeatMode == .all { index = songs.count - 1 } else { return false }
    return true
  }

  private mutating func advance(naturalEnd: Bool) -> Bool {
    guard let i = index else { return false }
    if naturalEnd, repeatMode == .one { return true }
    if i + 1 < songs.count { index = i + 1; return true }
    if repeatMode == .all, !songs.isEmpty { index = 0; return true }
    return false
  }
}
