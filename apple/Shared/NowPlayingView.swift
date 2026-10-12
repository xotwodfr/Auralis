import AuralisKit
import SwiftUI

struct NowPlayingView: View {
  @Environment(PlayerModel.self) private var player
  @State private var showLyrics = false

  var body: some View {
    VStack(spacing: 20) {
      if let song = player.current {
        Picker("View", selection: $showLyrics) {
          Text("Artwork").tag(false)
          Text("Lyrics").tag(true)
        }
        .pickerStyle(.segmented)
        .frame(maxWidth: 260)

        if showLyrics { LyricsView(song: song) } else { CoverArtView(id: song.coverArt, size: 900).frame(maxWidth: 420) }

        VStack(spacing: 4) {
          Text(song.title).font(.title2.bold()).lineLimit(2)
          Text(song.artist).foregroundStyle(.secondary)
        }
        if let error = player.errorMessage { Text(error).font(.callout).foregroundStyle(.red) }
        Scrubber()
        Transport()
      } else {
        ContentUnavailableView("Nothing playing", systemImage: "play.slash", description: Text("Pick an album or playlist to start."))
      }
    }
    .padding()
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .navigationTitle("Now Playing")
  }
}

private struct Scrubber: View {
  @Environment(PlayerModel.self) private var player
  @State private var dragging: Double?

  var body: some View {
    VStack(spacing: 2) {
      Slider(
        value: Binding(get: { dragging ?? player.position }, set: { dragging = $0 }),
        in: 0...max(player.duration, 1)
      ) { editing in
        if !editing, let target = dragging { player.seek(to: target); dragging = nil }
      }
      HStack {
        Text(formatTime(dragging ?? player.position))
        Spacer()
        Text(formatTime(player.duration))
      }
      .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
    }
    .frame(maxWidth: 520)
  }
}

struct Transport: View {
  @Environment(PlayerModel.self) private var player

  var body: some View {
    // One container so adjacent glass buttons render and blend as a single layer.
    GlassEffectContainer(spacing: 16) {
      HStack(spacing: 16) {
        Button { player.toggleShuffle() } label: { Image(systemName: "shuffle") }
          .buttonStyle(.glass).tint(player.isShuffled ? .accentColor : nil).accessibilityLabel("Shuffle")
        Button { player.previous() } label: { Image(systemName: "backward.fill") }
          .buttonStyle(.glass).accessibilityLabel("Previous")
        Button { player.togglePlay() } label: { Image(systemName: player.isPlaying ? "pause.fill" : "play.fill").frame(width: 32) }
          .buttonStyle(.glassProminent).controlSize(.large).accessibilityLabel(player.isPlaying ? "Pause" : "Play")
        Button { player.next() } label: { Image(systemName: "forward.fill") }
          .buttonStyle(.glass).accessibilityLabel("Next")
        Button { player.cycleRepeat() } label: {
          Image(systemName: player.repeatMode == .one ? "repeat.1" : "repeat")
        }
        .buttonStyle(.glass).tint(player.repeatMode == .off ? nil : .accentColor).accessibilityLabel("Repeat")
      }
    }
  }
}

/// Server lyrics only (OpenSubsonic `songLyrics`). LRCLIB and Spicy Lyrics are not ported yet.
struct LyricsView: View {
  @Environment(AppModel.self) private var app
  @Environment(PlayerModel.self) private var player
  let song: Song
  @State private var lines: Load<[LyricLine]> = .idle

  var body: some View {
    Group {
      switch lines {
      case .idle, .loading: ProgressView()
      case .failed(let message): ContentUnavailableView("No lyrics", systemImage: "text.quote", description: Text(message))
      case .loaded(let lines):
        if lines.isEmpty {
          ContentUnavailableView("No lyrics on your server", systemImage: "text.quote")
        } else {
          LyricLines(lines: lines)
        }
      }
    }
    .task(id: song.id) {
      guard let client = app.client else { return }
      lines = .loading
      do { lines = .loaded(try await client.lyrics(songId: song.id)) } catch { lines = .failed(error.localizedDescription) }
    }
  }
}

private struct LyricLines: View {
  @Environment(PlayerModel.self) private var player
  let lines: [LyricLine]

  private var activeIndex: Int? { lines.lastIndex { ($0.start ?? .infinity) <= player.position } }

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
            Text(line.text.isEmpty ? "♪" : line.text)
              .font(.title3.weight(.semibold))
              .opacity(line.start == nil || index == activeIndex ? 1 : 0.4)
              .id(index)
              .onTapGesture { if let t = line.start { player.seek(to: t) } }
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
      }
      .onChange(of: activeIndex) { _, new in
        if let new { withAnimation { proxy.scrollTo(new, anchor: .center) } }
      }
    }
    .frame(maxWidth: 520)
  }
}
