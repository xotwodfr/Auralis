import Foundation

public enum RepeatMode: String, Codable, Sendable { case off, all, one }

/// Pure queue state, mirroring src/audio/queue.ts: entries carry a unique key so the same song can be queued twice,
/// shuffle keeps the current track first, and repeat-one only applies to natural track ends, never to an explicit Next.
public struct PlayQueue: Codable, Equatable, Sendable {
  public struct Entry: Codable, Equatable, Hashable, Sendable, Identifiable {
    public let key: Int
    public let song: Song
    public var id: Int { key }
  }

  public private(set) var entries: [Entry] = []
  public private(set) var index: Int?
  public var repeatMode: RepeatMode = .off
  /// Unshuffled order, kept in sync while shuffle is on; nil otherwise.
  private var original: [Entry]?
  private var nextKey = 1

  public init() {}

  public var songs: [Song] { entries.map(\.song) }
  public var current: Song? { currentEntry?.song }
  public var currentEntry: Entry? { index.flatMap { entries.indices.contains($0) ? entries[$0] : nil } }
  public var isShuffled: Bool { original != nil }

  private mutating func make(_ songs: [Song]) -> [Entry] {
    defer { nextKey += songs.count }
    return songs.enumerated().map { Entry(key: nextKey + $0.offset, song: $0.element) }
  }

  /// Replaces the queue. With shuffle on, `startAt` plays first and the rest is shuffled.
  public mutating func play(_ songs: [Song], startAt: Int = 0) {
    guard !songs.isEmpty else { return clear() }
    let all = make(songs)
    let start = min(max(startAt, 0), all.count - 1)
    if original == nil {
      entries = all; index = start
    } else {
      entries = [all[start]] + all.enumerated().filter { $0.offset != start }.map(\.element).shuffled()
      index = 0; original = all
    }
  }

  public mutating func setShuffle(_ on: Bool) {
    guard on != isShuffled else { return }
    let cur = currentEntry
    if !on {
      let restored = original ?? entries
      entries = restored; original = nil
      index = cur.flatMap { c in restored.firstIndex(of: c) }
    } else {
      original = entries
      if let cur { entries = [cur] + entries.filter { $0 != cur }.shuffled(); index = 0 } else { entries.shuffle() }
    }
  }

  public mutating func addNext(_ songs: [Song]) {
    let added = make(songs)
    let at = (index ?? -1) + 1
    entries.insert(contentsOf: added, at: min(at, entries.count))
    if let cur = currentEntry, let o = original, let i = o.firstIndex(of: cur) {
      original?.insert(contentsOf: added, at: i + 1)
    } else {
      original?.insert(contentsOf: added, at: 0)
    }
  }

  public mutating func append(_ songs: [Song]) {
    let added = make(songs)
    entries += added
    original? += added
  }

  /// Removing the current entry makes the following one current; if none follows, nothing is current.
  public mutating func remove(at i: Int) {
    guard entries.indices.contains(i) else { return }
    let removed = entries.remove(at: i)
    original?.removeAll { $0 == removed }
    if let cur = index {
      if i < cur { index = cur - 1 } else if i == cur && cur >= entries.count { index = nil }
    }
  }

  public mutating func clear() {
    entries = []; index = nil
    if original != nil { original = [] }
  }

  public mutating func move(from: Int, to: Int) {
    guard from != to, entries.indices.contains(from), entries.indices.contains(to) else { return }
    let cur = currentEntry
    entries.insert(entries.remove(at: from), at: to)
    index = cur.flatMap { c in entries.firstIndex(of: c) }
  }

  @discardableResult
  public mutating func jump(to i: Int) -> Bool {
    guard entries.indices.contains(i) else { return false }
    index = i
    return true
  }

  /// Where to go when the track ends (`manual: false`) or the user presses Next. nil = stop.
  public func nextIndex(manual: Bool) -> Int? {
    if !manual, repeatMode == .one, let index { return index }
    let i = index ?? -1
    if i + 1 < entries.count { return i + 1 }
    // shortcut: repeat-all wraps to the same shuffled order; reshuffle per lap if users ask.
    return repeatMode == .all && !entries.isEmpty ? 0 : nil
  }

  /// Explicit Next. Returns false at the end of the queue (unless repeating all).
  @discardableResult
  public mutating func next() -> Bool { nextIndex(manual: true).map { jump(to: $0) } ?? false }

  /// Track ended by itself: repeat-one replays the same song.
  @discardableResult
  public mutating func trackEnded() -> Bool { nextIndex(manual: false).map { jump(to: $0) } ?? false }

  @discardableResult
  public mutating func previous() -> Bool {
    guard let i = index else { return false }
    if i > 0 { index = i - 1; return true }
    if repeatMode == .all && entries.count > 1 { index = entries.count - 1; return true }
    return false
  }

  /// Whether a decoded (stored, so untrusted) queue is internally consistent; an inconsistent one is dropped, never half-applied.
  public var isConsistent: Bool {
    let keys = entries.map(\.key)
    return Set(keys).count == keys.count && (keys.max() ?? 0) < nextKey && (index.map { entries.indices.contains($0) } ?? true)
  }
}
