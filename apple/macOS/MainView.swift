import SwiftUI

private enum SidebarItem: Hashable, CaseIterable {
  case albums, playlists, search, nowPlaying

  var title: String {
    switch self { case .albums: "Albums"; case .playlists: "Playlists"; case .search: "Search"; case .nowPlaying: "Now Playing" }
  }
  var icon: String {
    switch self {
    case .albums: "square.stack"; case .playlists: "music.note.list"; case .search: "magnifyingglass"; case .nowPlaying: "play.circle"
    }
  }
}

/// NavigationSplitView gives the floating Liquid Glass sidebar on macOS 26 for free.
struct MainView: View {
  @Environment(AppModel.self) private var app
  @State private var selection: SidebarItem? = .albums

  var body: some View {
    NavigationSplitView {
      List(SidebarItem.allCases, id: \.self, selection: $selection) { section in
        Label(section.title, systemImage: section.icon)
      }
      .navigationSplitViewColumnWidth(min: 180, ideal: 200)
      .toolbar { Button("Sign Out", systemImage: "rectangle.portrait.and.arrow.right") { app.signOut() } }
    } detail: {
      NavigationStack {
        switch selection ?? .albums {
        case .albums: AlbumsView()
        case .playlists: PlaylistsView()
        case .search: SearchView()
        case .nowPlaying: NowPlayingView()
        }
      }
      .safeAreaInset(edge: .bottom) { PlayerBar(openNowPlaying: { selection = .nowPlaying }) }
    }
    .frame(minWidth: 820, minHeight: 520)
  }
}

private struct PlayerBar: View {
  @Environment(PlayerModel.self) private var player
  let openNowPlaying: () -> Void

  var body: some View {
    if let song = player.current {
      HStack(spacing: 12) {
        Button(action: openNowPlaying) {
          HStack {
            CoverArtView(id: song.coverArt, size: 80).frame(width: 36, height: 36)
            VStack(alignment: .leading) {
              Text(song.title).lineLimit(1)
              Text(song.artist).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
          }
          .contentShape(.rect)
        }
        .buttonStyle(.plain)
        Spacer()
        Transport()
      }
      .padding(.horizontal, 16).padding(.vertical, 8)
      .glassEffect(.regular, in: .capsule)
      .padding()
    }
  }
}
