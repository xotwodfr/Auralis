import AuralisKit
import SwiftUI

/// The persistent player (src/features/player/PlayerBar.tsx): track, transport + progress, volume / lyrics / queue.
/// It floats over the content, so it is the one Liquid Glass surface besides the system chrome.
struct PlayerBar: View {
  @Environment(PlayerModel.self) private var player
  @Environment(Router.self) private var router
  @Environment(\.tokens) private var t

  var body: some View {
    @Bindable var router = router
    let song = player.current
    HStack(spacing: 16) {
      HStack(spacing: 12) {
        CoverArtView(id: song?.coverArt, size: 112, radius: 8).frame(width: 56, height: 56)
        VStack(alignment: .leading, spacing: 1) {
          Text(song?.title ?? "Nothing playing").font(.body16.weight(.semibold)).lineLimit(1)
          Text(song.map { [$0.artist, $0.album].filter { !$0.isEmpty }.joined(separator: " · ") } ?? "Pick something from your library.")
            .font(.hint).foregroundStyle(t.text2).lineLimit(1)
          if player.errorMessage == nil, let status = player.status == .loading ? "Loading…" : player.status == .buffering ? "Buffering…" : nil {
            Text(status).font(.hint).foregroundStyle(t.text2)
          }
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .contentShape(.rect)
      .onTapGesture { if song != nil { router.selection = .nowPlaying } }

      VStack(spacing: 2) {
        Transport()
        ProgressRow()
        if let error = player.errorMessage {
          HStack(spacing: 4) {
            Text(error)
            Button("Retry") { player.retry() }.buttonStyle(.plain).underline().foregroundStyle(t.accentLink)
          }
          .font(.hint).foregroundStyle(t.danger)
        }
      }
      .frame(minWidth: 280, maxWidth: 640)
      .layoutPriority(1)

      HStack(spacing: 8) {
        HStack(spacing: 8) {
          Icon("volume", size: 20)
          ThinSlider(value: player.volume, range: 0...1, label: "Volume", valueText: "\(Int((player.volume * 100).rounded()))%", live: true) {
            player.setVolume($0)
          }
          .frame(width: 100)
        }
        .foregroundStyle(t.text2)
        Button { router.selection = .nowPlaying } label: { Icon("lyrics") }
          .buttonStyle(IconButtonStyle(active: router.selection == .nowPlaying))
          .help("Now Playing and lyrics").accessibilityLabel("Lyrics")
        Button { router.showQueue.toggle() } label: { Icon("queue") }
          .buttonStyle(IconButtonStyle(active: router.showQueue))
          .help("Queue").accessibilityLabel("Queue")
          .popover(isPresented: $router.showQueue, arrowEdge: .top) {
            QueueView().frame(width: 440, height: 520)
          }
      }
      .frame(maxWidth: .infinity, alignment: .trailing)
    }
    .padding(.horizontal, 18)
    .padding(.vertical, 8)
    .frame(minHeight: 88)
    .glassEffect(.regular, in: .rect(cornerRadius: Metric.rPanel))
    .padding(.horizontal, 12)
    .padding(.bottom, 12)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Player")
  }
}

private struct Transport: View {
  @Environment(PlayerModel.self) private var player
  @Environment(\.tokens) private var t

  var body: some View {
    HStack(spacing: 4) {
      Button { player.toggleShuffle() } label: { Icon("shuffle") }
        .buttonStyle(IconButtonStyle(active: player.isShuffled)).help("Shuffle").accessibilityLabel("Shuffle")
        .accessibilityAddTraits(player.isShuffled ? .isSelected : [])
      Button { player.previous() } label: { Icon("prev") }
        .buttonStyle(IconButtonStyle()).disabled(!player.canPrevious).help("Previous").accessibilityLabel("Previous track")
      Button { player.togglePlay() } label: {
        Icon(player.isPlaying ? "pause" : "play", size: 26).foregroundStyle(t.text)
      }
      .buttonStyle(IconButtonStyle())
      .help(player.isPlaying ? "Pause (Space)" : "Play (Space)")
      .accessibilityLabel(player.isPlaying ? "Pause" : "Play")
      Button { player.next() } label: { Icon("next") }
        .buttonStyle(IconButtonStyle()).disabled(!player.canNext).help("Next").accessibilityLabel("Next track")
      Button { player.cycleRepeat() } label: { Icon(player.repeatMode == .one ? "repeat-one" : "repeat") }
        .buttonStyle(IconButtonStyle(active: player.repeatMode != .off)).help("Repeat")
        .accessibilityLabel("Repeat \(player.repeatMode.rawValue)")
    }
  }
}

/// Re-renders on every playhead tick, so it is kept separate from the rest of the bar.
private struct ProgressRow: View {
  @Environment(PlayerModel.self) private var player
  @Environment(\.tokens) private var t

  var body: some View {
    HStack(spacing: 10) {
      Text(formatTime(player.position)).frame(minWidth: 34, alignment: .trailing)
      ThinSlider(value: min(player.position, player.duration), range: 0...max(player.duration, 1), label: "Seek",
                 valueText: "\(formatTime(player.position)) of \(formatTime(player.duration))") { player.seek(to: $0) }
        .disabled(player.current == nil || player.duration <= 0)
      Text(formatTime(player.duration)).frame(minWidth: 34, alignment: .leading)
    }
    .font(.system(size: 12).monospacedDigit())
    .foregroundStyle(t.text2)
  }
}

/// `.slider`: a 4pt pill track with the played part filled; the knob appears on hover/drag. Commits on release
/// (or continuously with `live`), and is adjustable with VoiceOver and the arrow keys.
struct ThinSlider: View {
  @Environment(\.tokens) private var t
  @Environment(\.isEnabled) private var enabled
  let value: Double
  let range: ClosedRange<Double>
  let label: String
  let valueText: String
  var live = false
  let commit: (Double) -> Void
  @State private var drag: Double?
  @State private var hover = false

  var body: some View {
    GeometryReader { g in
      let span = range.upperBound - range.lowerBound
      let shown = drag ?? value
      let fraction = span > 0 ? min(1, max(0, (shown - range.lowerBound) / span)) : 0
      ZStack(alignment: .leading) {
        Capsule().fill(t.track).frame(height: 4)
        Capsule().fill(hover || drag != nil ? t.accent : t.text2).frame(width: g.size.width * fraction, height: 4)
        Circle().fill(t.text).frame(width: 12, height: 12)
          .shadow(color: .black.opacity(0.2), radius: 2, y: 1)
          .offset(x: g.size.width * fraction - 6)
          .opacity(enabled && (hover || drag != nil) ? 1 : 0)
      }
      .frame(maxHeight: .infinity)
      .contentShape(.rect)
      .gesture(DragGesture(minimumDistance: 0).onChanged { d in
        guard enabled else { return }
        let v = range.lowerBound + span * min(1, max(0, d.location.x / max(g.size.width, 1)))
        drag = v
        if live { commit(v) }
      }.onEnded { _ in
        if let drag { commit(drag) }
        drag = nil
      })
    }
    .frame(height: 24)
    .opacity(enabled ? 1 : 0.4)
    .onHover { hover = $0 }
    .accessibilityElement()
    .accessibilityLabel(label)
    .accessibilityValue(valueText)
    .accessibilityAdjustableAction { direction in
      let step = (range.upperBound - range.lowerBound) / 20
      commit(min(range.upperBound, max(range.lowerBound, value + (direction == .increment ? step : -step))))
    }
  }
}
