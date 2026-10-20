import AuralisKit
import SwiftUI

/// Tab bar + Now Playing accessory are standard SwiftUI; iOS 26 renders them as Liquid Glass with no extra styling.
struct MainView: View {
  @Environment(PlayerModel.self) private var player
  @State private var showNowPlaying = false

  var body: some View {
    TabView {
      Tab("Albums", image: "icon-album") {
        RoutedStack { AlbumListView(title: "Albums", type: .alphabeticalByName, hint: "Add music to your server and run a scan.") }
      }
      Tab("Artists", image: "icon-artist") { RoutedStack { ArtistsView() } }
      Tab("Playlists", image: "icon-playlist") { RoutedStack { PlaylistsView() } }
      Tab("Favorites", image: "icon-heart") { RoutedStack { FavoritesView() } }
      Tab("Settings", image: "icon-settings") { NavigationStack { SettingsView() } }
      Tab(role: .search) { SearchTab() }
    }
    .tabBarMinimizeBehavior(.onScrollDown)
    .tabViewBottomAccessory { MiniPlayer(onTap: { showNowPlaying = true }) }
    .sheet(isPresented: $showNowPlaying) { NowPlayingSheet() }
  }
}

private struct SearchTab: View {
  @State private var text = ""
  @State private var query = ""
  var body: some View {
    RoutedStack { SearchResultsView(query: query) }
      .searchable(text: $text)
      // Restarts on every keystroke; the sleep is the debounce.
      .task(id: text) {
        try? await Task.sleep(for: .milliseconds(300))
        if !Task.isCancelled { query = text.trimmingCharacters(in: .whitespaces) }
      }
  }
}

private struct MiniPlayer: View {
  @Environment(PlayerModel.self) private var player
  let onTap: () -> Void

  var body: some View {
    HStack {
      Button(action: onTap) {
        HStack {
          CoverArtView(id: player.current?.coverArt, size: 80, radius: 6).frame(width: 32, height: 32)
          Text(player.current?.title ?? "Not playing").lineLimit(1)
          Spacer()
        }
        .contentShape(.rect)
      }
      .buttonStyle(.plain)
      .disabled(player.current == nil)
      Button { player.togglePlay() } label: { Image(systemName: player.isPlaying ? "pause.fill" : "play.fill") }
        .accessibilityLabel(player.isPlaying ? "Pause" : "Play")
        .disabled(player.current == nil)
      Button { player.next() } label: { Image(systemName: "forward.fill") }
        .accessibilityLabel("Next")
        .disabled(!player.canNext)
    }
    .padding(.horizontal)
  }
}

/// iOS has no persistent player bar, so the sheet carries the controls under the shared Now Playing view.
private struct NowPlayingSheet: View {
  @Environment(PlayerModel.self) private var player
  @Environment(\.tokens) private var t
  @State private var showQueue = false

  var body: some View {
    NavigationStack {
      VStack(spacing: 12) {
        NowPlayingView()
        if player.current != nil {
          Scrubber().padding(.horizontal)
          Transport()
          if let error = player.errorMessage { Text(error).font(.callout).foregroundStyle(t.danger) }
        }
      }
      .padding(.bottom)
      .background(t.bg)
      .toolbar {
        Button { showQueue = true } label: { Image("icon-queue") }.accessibilityLabel("Queue")
      }
      .sheet(isPresented: $showQueue) { QueueView().presentationDetents([.medium, .large]) }
    }
  }
}

private struct Scrubber: View {
  @Environment(PlayerModel.self) private var player
  @State private var dragging: Double?

  var body: some View {
    VStack(spacing: 2) {
      Slider(value: Binding(get: { dragging ?? player.position }, set: { dragging = $0 }), in: 0...max(player.duration, 1)) { editing in
        if !editing, let target = dragging { player.seek(to: target); dragging = nil }
      }
      HStack {
        Text(formatTime(dragging ?? player.position))
        Spacer()
        Text(formatTime(player.duration))
      }
      .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
    }
  }
}

private struct Transport: View {
  @Environment(PlayerModel.self) private var player

  var body: some View {
    // One container so adjacent glass buttons render and blend as a single layer.
    GlassEffectContainer(spacing: 16) {
      HStack(spacing: 16) {
        Button { player.toggleShuffle() } label: { Image("icon-shuffle") }
          .buttonStyle(.glass).tint(player.isShuffled ? .accentColor : nil).accessibilityLabel("Shuffle")
        Button { player.previous() } label: { Image("icon-prev") }
          .buttonStyle(.glass).accessibilityLabel("Previous")
        Button { player.togglePlay() } label: { Image(player.isPlaying ? "icon-pause" : "icon-play").frame(width: 32) }
          .buttonStyle(.glassProminent).controlSize(.large).accessibilityLabel(player.isPlaying ? "Pause" : "Play")
        Button { player.next() } label: { Image("icon-next") }
          .buttonStyle(.glass).accessibilityLabel("Next")
        Button { player.cycleRepeat() } label: { Image(player.repeatMode == .one ? "icon-repeat-one" : "icon-repeat") }
          .buttonStyle(.glass).tint(player.repeatMode == .off ? nil : .accentColor).accessibilityLabel("Repeat")
      }
    }
  }
}
