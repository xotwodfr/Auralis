import SwiftUI

/// Tab bar + Now Playing accessory are standard SwiftUI; iOS 26 renders them as Liquid Glass with no extra styling.
struct MainView: View {
  @Environment(AppModel.self) private var app
  @Environment(PlayerModel.self) private var player
  @State private var showNowPlaying = false

  var body: some View {
    TabView {
      Tab("Albums", systemImage: "square.stack") { NavigationStack { AlbumsView() } }
      Tab("Playlists", systemImage: "music.note.list") { NavigationStack { PlaylistsView() } }
      Tab("Account", systemImage: "person.crop.circle") {
        NavigationStack {
          List { Button("Sign Out", role: .destructive) { app.signOut() } }.navigationTitle("Account")
        }
      }
      Tab(role: .search) { NavigationStack { SearchView() } }
    }
    .tabBarMinimizeBehavior(.onScrollDown)
    .tabViewBottomAccessory { MiniPlayer(onTap: { showNowPlaying = true }) }
    .sheet(isPresented: $showNowPlaying) { NavigationStack { NowPlayingView() } }
  }
}

private struct MiniPlayer: View {
  @Environment(PlayerModel.self) private var player
  let onTap: () -> Void

  var body: some View {
    HStack {
      Button(action: onTap) {
        HStack {
          CoverArtView(id: player.current?.coverArt, size: 80).frame(width: 32, height: 32)
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
        .disabled(player.current == nil)
    }
    .padding(.horizontal)
  }
}
