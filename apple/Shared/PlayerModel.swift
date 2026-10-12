import AVFoundation
import AuralisKit
import Combine
import MediaPlayer
import Observation
import OSLog

/// AVPlayer-based playback. The web engine's contract is kept: the player is the source of truth for time,
/// natural track ends advance the queue, and a play is scrobbled at half the track or 4 minutes.
@MainActor @Observable
final class PlayerModel {
  private(set) var queue = PlayQueue()
  private(set) var isPlaying = false
  private(set) var position: Double = 0
  private(set) var duration: Double = 0
  private(set) var errorMessage: String?

  var current: Song? { queue.current }
  var isShuffled: Bool { queue.isShuffled }
  var repeatMode: RepeatMode { queue.repeatMode }

  @ObservationIgnored var client: SubsonicClient?
  @ObservationIgnored private let player = AVPlayer()
  @ObservationIgnored private var timeObserver: Any?
  @ObservationIgnored private var statusObserver: AnyCancellable?
  @ObservationIgnored private var itemObservers: [AnyCancellable] = []
  @ObservationIgnored private var scrobbled = false
  @ObservationIgnored private let log = Logger(subsystem: "app.auralis", category: "playback")
  private static let scrobbleCapSeconds = 240.0

  init() {
    #if os(iOS)
    // `.playback` + UIBackgroundModes=audio keeps music going with the screen locked.
    try? AVAudioSession.sharedInstance().setCategory(.playback)
    #endif
    timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.25, preferredTimescale: 600), queue: .main) { [weak self] t in
      MainActor.assumeIsolated { self?.tick(t.seconds) }
    }
    statusObserver = player.publisher(for: \.timeControlStatus).receive(on: DispatchQueue.main).sink { [weak self] status in
      MainActor.assumeIsolated {
        self?.isPlaying = status != .paused
        self?.publishNowPlaying()
      }
    }
    configureRemoteCommands()
  }

  // MARK: Controls

  func play(_ songs: [Song], startAt: Int = 0) {
    queue.play(songs, startAt: startAt)
    loadCurrent()
  }

  func addNext(_ song: Song) { queue.addNext(song); if player.currentItem == nil { loadCurrent() } }
  func addToQueue(_ song: Song) { queue.append(song); if player.currentItem == nil { loadCurrent() } }

  func togglePlay() {
    if player.currentItem == nil { loadCurrent(); return }
    isPlaying ? player.pause() : player.play()
  }

  func next() { if queue.next() { loadCurrent() } }

  func previous() {
    // Like the web client: past 3 seconds, restart the track instead of going back.
    if position > 3 { seek(to: 0) } else if queue.previous() { loadCurrent() }
  }

  func seek(to seconds: Double) {
    player.seek(to: CMTime(seconds: seconds, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
    position = seconds
    publishNowPlaying()
  }

  func toggleShuffle() { queue.setShuffle(!queue.isShuffled) }

  func cycleRepeat() {
    queue.repeatMode = switch queue.repeatMode { case .off: .all; case .all: .one; case .one: .off }
  }

  // MARK: Internals

  private func loadCurrent() {
    guard let client, let song = queue.current else { return }
    errorMessage = nil
    scrobbled = false
    position = 0
    duration = song.duration
    let item = AVPlayerItem(url: client.streamURL(for: song))
    let ended = NotificationCenter.default.publisher(for: .AVPlayerItemDidPlayToEndTime, object: item)
      .sink { [weak self] _ in MainActor.assumeIsolated { self?.trackEnded() } }
    let failed = item.publisher(for: \.status).sink { [weak self] status in
      guard status == .failed else { return }
      MainActor.assumeIsolated { self?.errorMessage = "This track couldn't be played." }
    }
    itemObservers = [ended, failed]
    player.replaceCurrentItem(with: item)
    player.play()
    publishNowPlaying()
    Task { await report(song, submission: false) }
  }

  private func trackEnded() {
    if queue.trackEnded() { loadCurrent() } else { isPlaying = false; publishNowPlaying() }
  }

  private func tick(_ seconds: Double) {
    guard seconds.isFinite else { return }
    position = seconds
    if let d = player.currentItem?.duration.seconds, d.isFinite, d > 0 { duration = d }
    if !scrobbled, duration > 0, position >= min(duration / 2, Self.scrobbleCapSeconds), let song = current {
      scrobbled = true
      Task { await report(song, submission: true) }
    }
  }

  private func report(_ song: Song, submission: Bool) async {
    do { try await client?.scrobble(id: song.id, submission: submission) } catch {
      log.warning("scrobble failed: \(error.localizedDescription, privacy: .public)")
    }
  }

  // MARK: System media integration (lock screen, Control Center, media keys, AirPods)

  private func configureRemoteCommands() {
    let c = MPRemoteCommandCenter.shared()
    c.playCommand.addTarget { [weak self] _ in MainActor.assumeIsolated { self?.player.play() }; return .success }
    c.pauseCommand.addTarget { [weak self] _ in MainActor.assumeIsolated { self?.player.pause() }; return .success }
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
