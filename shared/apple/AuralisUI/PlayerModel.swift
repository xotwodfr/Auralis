import AVFoundation
import AuralisKit
import Combine
import MediaPlayer
import Observation
import OSLog

/// AVPlayer-based playback, keeping the web engine's contract (src/state/playback.ts): the player is the source of truth
/// for time, natural track ends advance the queue, a play is reported at half the track or 4 minutes, and the queue is
/// restored (paused) after a relaunch.
@MainActor @Observable
final class PlayerModel {
  enum Status { case idle, loading, buffering, playing, paused }

  private(set) var queue = PlayQueue()
  private(set) var status = Status.idle
  private(set) var position: Double = 0
  private(set) var duration: Double = 0
  private(set) var volume: Double = 1
  private(set) var errorMessage: String?

  var current: Song? { queue.current }
  var isPlaying: Bool { status == .playing || status == .buffering || (status == .loading && autoplay) }
  var isBusy: Bool { status == .loading || status == .buffering }
  var isShuffled: Bool { queue.isShuffled }
  var repeatMode: RepeatMode { queue.repeatMode }
  var canPrevious: Bool { !queue.entries.isEmpty }
  var canNext: Bool { queue.nextIndex(manual: true) != nil }
  /// The audio clock itself, finer than `position` (which ticks 4× a second): lyrics read it every frame.
  var playbackTime: Double {
    let t = player.currentTime().seconds
    return loaded && t.isFinite ? t : position
  }

  /// Mirrors Settings → Playback → "Report plays to your server".
  @ObservationIgnored var reportPlays = true
  @ObservationIgnored private(set) var client: SubsonicClient?
  @ObservationIgnored private let player = AVPlayer()
  @ObservationIgnored private var autoplay = false
  /// The player holds the current entry's stream (false after a restore, until the first play).
  @ObservationIgnored private var loaded = false
  @ObservationIgnored private var timeObserver: Any?
  @ObservationIgnored private var statusObserver: AnyCancellable?
  @ObservationIgnored private var itemObservers: [AnyCancellable] = []
  @ObservationIgnored private var scrobbled = false
  @ObservationIgnored private var lastSaved = Date.distantPast
  @ObservationIgnored private let log = Logger(subsystem: "app.auralis", category: "playback")
  @ObservationIgnored private let defaults = UserDefaults.standard
  private static let scrobbleCapSeconds = 240.0
  private static let restartThreshold = 3.0
  static let seekStep = 5.0
  static let volumeStep = 0.05
  private static let storeKey = "auralis.playback"

  init() {
    #if os(iOS)
    // `.playback` + UIBackgroundModes=audio keeps music going with the screen locked.
    try? AVAudioSession.sharedInstance().setCategory(.playback)
    #endif
    timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.25, preferredTimescale: 600), queue: .main) { [weak self] t in
      MainActor.assumeIsolated { self?.tick(t.seconds) }
    }
    statusObserver = player.publisher(for: \.timeControlStatus).receive(on: DispatchQueue.main).sink { [weak self] s in
      MainActor.assumeIsolated { self?.playerStatusChanged(s) }
    }
    configureRemoteCommands()
  }

  /// Called when the session changes: restores this account's saved queue, or stops everything on sign-out.
  func attach(_ client: SubsonicClient?) {
    guard client?.credentials != self.client?.credentials else { return }
    let signedOut = client == nil
    self.client = client
    stopAndReset(forget: signedOut)
    if let client { restore(for: client) }
  }

  // MARK: Controls

  func play(_ songs: [Song], startAt: Int = 0) {
    guard !songs.isEmpty else { return }
    queue.play(songs, startAt: startAt)
    loadCurrent(autoplay: true)
  }

  func shufflePlay(_ songs: [Song]) {
    guard !songs.isEmpty else { return }
    queue.setShuffle(true)
    queue.play(songs, startAt: Int.random(in: 0..<songs.count))
    loadCurrent(autoplay: true)
  }

  func addNext(_ songs: [Song]) { queue.addNext(songs); save() }
  func addToQueue(_ songs: [Song]) { queue.append(songs); save() }

  func jump(to index: Int) {
    if queue.jump(to: index) { loadCurrent(autoplay: true) }
  }

  func remove(at index: Int) {
    let before = queue.currentEntry?.key
    queue.remove(at: index)
    if queue.currentEntry?.key != before { loadCurrent(autoplay: autoplay) } else { save() }
  }

  func move(from: Int, to: Int) { queue.move(from: from, to: to); save() }

  func clearQueue() {
    queue.clear()
    loadCurrent(autoplay: false)
  }

  func togglePlay() {
    guard current != nil else {
      if !queue.entries.isEmpty { jump(to: 0) }
      return
    }
    if errorMessage != nil { return retry() }
    if !loaded { return loadCurrent(autoplay: true, at: position) }
    if isPlaying {
      autoplay = false
      player.pause()
      save()
    } else {
      autoplay = true
      // From the end of a track, play() would do nothing: restart it.
      if duration > 0 && position >= duration - 0.25 { seek(to: 0) }
      player.play()
    }
  }

  func next() { if let i = queue.nextIndex(manual: true) { jump(to: i) } }

  func previous() {
    // Like the web client: past 3 seconds (or at the start of the queue), restart the track instead of going back.
    var q = queue
    if position > Self.restartThreshold || !q.previous() { seek(to: 0) } else { queue = q; loadCurrent(autoplay: true) }
  }

  func seek(to seconds: Double) {
    let target = max(0, duration > 0 ? min(seconds, duration) : seconds)
    position = target
    guard loaded else { return }
    player.seek(to: CMTime(seconds: target, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
    publishNowPlaying()
  }

  func seek(by delta: Double) { seek(to: position + delta) }

  func setVolume(_ value: Double) {
    volume = min(1, max(0, value))
    player.volume = Float(volume)
    save()
  }

  func toggleShuffle() { queue.setShuffle(!queue.isShuffled); save() }

  func cycleRepeat() {
    queue.repeatMode = switch queue.repeatMode { case .off: .all; case .all: .one; case .one: .off }
    save()
  }

  func retry() { loadCurrent(autoplay: true, at: position) }

  // MARK: Internals

  private func loadCurrent(autoplay: Bool, at start: Double = 0) {
    itemObservers = []
    errorMessage = nil
    guard let client, let song = queue.current else {
      player.replaceCurrentItem(with: nil)
      loaded = false
      self.autoplay = false
      status = .idle
      position = 0
      duration = 0
      save()
      publishNowPlaying()
      return
    }
    loaded = true
    self.autoplay = autoplay
    scrobbled = false
    position = start
    duration = song.duration
    status = .loading
    let item = AVPlayerItem(url: client.streamURL(for: song))
    let ended = NotificationCenter.default.publisher(for: .AVPlayerItemDidPlayToEndTime, object: item)
      .sink { [weak self] _ in MainActor.assumeIsolated { self?.trackEnded() } }
    let failed = item.publisher(for: \.status).sink { [weak self] status in
      guard status == .failed else { return }
      MainActor.assumeIsolated {
        self?.errorMessage = "This track couldn't be played."
        self?.status = .paused
      }
    }
    itemObservers = [ended, failed]
    player.replaceCurrentItem(with: item)
    if start > 0 { player.seek(to: CMTime(seconds: start, preferredTimescale: 600)) }
    if autoplay { player.play() } else { player.pause() }
    save()
    publishNowPlaying()
    if autoplay { Task { await report(song, submission: false) } }
  }

  private func trackEnded() {
    if let i = queue.nextIndex(manual: false) {
      queue.jump(to: i)
      loadCurrent(autoplay: true)
    } else {
      autoplay = false
      status = .paused
      publishNowPlaying()
    }
  }

  private func playerStatusChanged(_ s: AVPlayer.TimeControlStatus) {
    guard loaded, errorMessage == nil else { return }
    switch s {
    case .playing: status = .playing
    case .waitingToPlayAtSpecifiedRate: status = player.currentItem?.status == .readyToPlay ? .buffering : .loading
    case .paused: if status != .loading || !autoplay { status = .paused }
    @unknown default: break
    }
    publishNowPlaying()
  }

  private func tick(_ seconds: Double) {
    guard loaded, seconds.isFinite else { return }
    position = seconds
    if let d = player.currentItem?.duration.seconds, d.isFinite, d > 0 { duration = d }
    if !scrobbled, duration > 0, position >= min(duration / 2, Self.scrobbleCapSeconds), let song = current {
      scrobbled = true
      Task { await report(song, submission: true) }
    }
    if Date().timeIntervalSince(lastSaved) > 5 { save() }
  }

  private func report(_ song: Song, submission: Bool) async {
    guard reportPlays else { return }
    do { try await client?.scrobble(id: song.id, submission: submission) } catch {
      log.warning("scrobble failed: \(error.localizedDescription, privacy: .public)")
    }
  }

  // MARK: Persistence (per server + user)

  private struct Saved: Codable {
    var scope: String
    var queue: PlayQueue
    var position: Double
    var volume: Double
  }

  private func scope(_ c: Credentials) -> String { "\(c.baseURL.absoluteString)|\(c.username)" }

  private func save() {
    lastSaved = Date()
    guard let client else { return }
    let saved = Saved(scope: scope(client.credentials), queue: queue, position: position, volume: volume)
    defaults.set(try? JSONEncoder().encode(saved), forKey: Self.storeKey)
  }

  /// Stored state is untrusted (older builds, partial writes): anything malformed is ignored, never partly applied.
  private func restore(for client: SubsonicClient) {
    guard let data = defaults.data(forKey: Self.storeKey), let saved = try? JSONDecoder().decode(Saved.self, from: data),
          saved.scope == scope(client.credentials), saved.queue.isConsistent, saved.position.isFinite, saved.volume.isFinite else { return }
    queue = saved.queue
    setVolume(saved.volume)
    position = max(0, saved.position)
    duration = current?.duration ?? 0
    status = current == nil ? .idle : .paused
    publishNowPlaying()
  }

  private func stopAndReset(forget: Bool) {
    player.replaceCurrentItem(with: nil)
    itemObservers = []
    loaded = false
    autoplay = false
    queue = PlayQueue()
    status = .idle
    position = 0
    duration = 0
    errorMessage = nil
    if forget { defaults.removeObject(forKey: Self.storeKey) }
    publishNowPlaying()
  }

  // MARK: System media integration (lock screen, Control Center, media keys, AirPods)

  private func configureRemoteCommands() {
    let c = MPRemoteCommandCenter.shared()
    c.playCommand.addTarget { [weak self] _ in MainActor.assumeIsolated { if self?.isPlaying == false { self?.togglePlay() } }; return .success }
    c.pauseCommand.addTarget { [weak self] _ in MainActor.assumeIsolated { if self?.isPlaying == true { self?.togglePlay() } }; return .success }
    c.togglePlayPauseCommand.addTarget { [weak self] _ in MainActor.assumeIsolated { self?.togglePlay() }; return .success }
    c.nextTrackCommand.addTarget { [weak self] _ in MainActor.assumeIsolated { self?.next() }; return .success }
    c.previousTrackCommand.addTarget { [weak self] _ in MainActor.assumeIsolated { self?.previous() }; return .success }
    c.changePlaybackPositionCommand.addTarget { [weak self] event in
      guard let event = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
      MainActor.assumeIsolated { self?.seek(to: event.positionTime) }
      return .success
    }
  }

  private func publishNowPlaying() {
    guard let song = current else { MPNowPlayingInfoCenter.default().nowPlayingInfo = nil; return }
    var info: [String: Any] = [
      MPMediaItemPropertyTitle: song.title, MPMediaItemPropertyArtist: song.artist, MPMediaItemPropertyAlbumTitle: song.album,
      MPMediaItemPropertyPlaybackDuration: duration, MPNowPlayingInfoPropertyElapsedPlaybackTime: position,
      MPNowPlayingInfoPropertyPlaybackRate: isPlaying ? 1.0 : 0.0,
    ]
    if let art = artworkCache[song.id] { info[MPMediaItemPropertyArtwork] = art } else { fetchArtwork(for: song) }
    MPNowPlayingInfoCenter.default().nowPlayingInfo = info
  }

  @ObservationIgnored private var artworkCache: [String: MPMediaItemArtwork] = [:]

  private func fetchArtwork(for song: Song) {
    guard let client, let cover = song.coverArt, artworkCache[song.id] == nil else { return }
    let url = client.coverArtURL(cover, size: 600)
    Task {
      guard let (data, _) = try? await URLSession.shared.data(from: url), let image = PlatformImage(data: data) else { return }
      artworkCache[song.id] = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
      if current?.id == song.id { publishNowPlaying() }
    }
  }
}

#if os(iOS)
import UIKit
typealias PlatformImage = UIImage
#else
import AppKit
typealias PlatformImage = NSImage
#endif
