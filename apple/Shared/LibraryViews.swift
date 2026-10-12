import AuralisKit
import SwiftUI

struct AlbumsView: View {
  @Environment(AppModel.self) private var app

  var body: some View {
    LoadView(state: app.albums, emptyTitle: "No albums yet", emptySystemImage: "square.stack", retry: { await app.reload() }) { albums in
      ScrollView {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 16)], spacing: 20) {
          ForEach(albums) { album in
            NavigationLink(value: album) {
              VStack(alignment: .leading, spacing: 6) {
                CoverArtView(id: album.coverArt, size: 400)
                Text(album.name).font(.subheadline.weight(.semibold)).lineLimit(1)
                Text(album.artist).font(.caption).foregroundStyle(.secondary).lineLimit(1)
              }
            }
            .buttonStyle(.plain)
          }
        }
        .padding()
      }
    }
    .navigationTitle("Albums")
    .navigationDestination(for: Album.self) { AlbumDetailView(album: $0) }
    .refreshable { await app.reload() }
  }
}

struct AlbumDetailView: View {
  @Environment(AppModel.self) private var app
  let album: Album
  @State private var songs: Load<[Song]> = .idle

  var body: some View {
    LoadView(state: songs, emptyTitle: "This album has no tracks", emptySystemImage: "music.note", retry: load) { songs in
      SongList(songs: songs, header: AnyView(AlbumHeader(album: album, songs: songs)))
    }
    .navigationTitle(album.name)
    .task { await load() }
  }

  private func load() async {
    guard let client = app.client else { return }
    songs = .loading
    do { songs = .loaded(try await client.album(id: album.id).songs) } catch { songs = .failed(error.localizedDescription) }
  }
}

private struct AlbumHeader: View {
  @Environment(PlayerModel.self) private var player
  let album: Album
  let songs: [Song]

  var body: some View {
    VStack(spacing: 12) {
      CoverArtView(id: album.coverArt, size: 600).frame(maxWidth: 260)
      Text(album.artist).font(.headline)
      HStack {
        Button("Play", systemImage: "play.fill") { player.play(songs) }.buttonStyle(.glassProminent)
        Button("Shuffle", systemImage: "shuffle") {
          player.play(songs.shuffled())
        }.buttonStyle(.glass)
      }
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical)
  }
}

struct SongList: View {
  @Environment(PlayerModel.self) private var player
  let songs: [Song]
  var header: AnyView?

  var body: some View {
    List {
      if let header { header.listRowSeparator(.hidden) }
      ForEach(Array(songs.enumerated()), id: \.element.id) { index, song in
        Button { player.play(songs, startAt: index) } label: {
          HStack {
            VStack(alignment: .leading) {
              Text(song.title).lineLimit(1)
              Text(song.artist).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
            Text(formatTime(song.duration)).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
          }
          .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .contextMenu {
          Button("Play Next", systemImage: "text.insert") { player.addNext(song) }
          Button("Add to Queue", systemImage: "text.append") { player.addToQueue(song) }
        }
      }
    }
  }
}

struct PlaylistsView: View {
  @Environment(AppModel.self) private var app

  var body: some View {
    LoadView(state: app.playlists, emptyTitle: "No playlists", emptySystemImage: "music.note.list", retry: { await app.reload() }) { playlists in
      List(playlists) { playlist in
        NavigationLink(value: playlist) {
          Label {
            VStack(alignment: .leading) {
              Text(playlist.name)
              Text("\(playlist.songCount) songs").font(.caption).foregroundStyle(.secondary)
            }
          } icon: { Image(systemName: "music.note.list") }
        }
      }
    }
    .navigationTitle("Playlists")
    .navigationDestination(for: Playlist.self) { PlaylistDetailView(playlist: $0) }
    .refreshable { await app.reload() }
  }
}

struct PlaylistDetailView: View {
  @Environment(AppModel.self) private var app
  let playlist: Playlist
  @State private var songs: Load<[Song]> = .idle

  var body: some View {
    LoadView(state: songs, emptyTitle: "This playlist is empty", emptySystemImage: "music.note", retry: load) { SongList(songs: $0) }
      .navigationTitle(playlist.name)
      .task { await load() }
  }

  private func load() async {
    guard let client = app.client else { return }
    songs = .loading
    do { songs = .loaded(try await client.playlist(id: playlist.id).songs) } catch { songs = .failed(error.localizedDescription) }
  }
}

struct SearchView: View {
  @Environment(AppModel.self) private var app
  @State private var query = ""
  @State private var results: Load<SearchResults> = .idle

  var body: some View {
    Group {
      switch results {
      case .idle: ContentUnavailableView("Search your library", systemImage: "magnifyingglass")
      case .loading: ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
      case .failed(let message): ContentUnavailableView("Search failed", systemImage: "exclamationmark.triangle", description: Text(message))
      case .loaded(let r):
        if r.songs.isEmpty && r.albums.isEmpty {
          ContentUnavailableView.search(text: query)
        } else {
          List {
            if !r.albums.isEmpty {
              Section("Albums") {
                ForEach(r.albums) { album in NavigationLink(album.name, value: album) }
              }
            }
            if !r.songs.isEmpty { Section("Songs") { SongRows(songs: r.songs) } }
          }
        }
      }
    }
    .navigationTitle("Search")
    .navigationDestination(for: Album.self) { AlbumDetailView(album: $0) }
    .searchable(text: $query)
    // Restarts (and cancels the previous run) on every keystroke; the sleep is the debounce.
    .task(id: query) {
      let q = query.trimmingCharacters(in: .whitespaces)
      guard !q.isEmpty, let client = app.client else { results = .idle; return }
      try? await Task.sleep(for: .milliseconds(300))
      if Task.isCancelled { return }
      results = .loading
      do { results = .loaded(try await client.search(q)) } catch {
        if !Task.isCancelled { results = .failed(error.localizedDescription) }
      }
    }
  }
}

private struct SongRows: View {
  @Environment(PlayerModel.self) private var player
  let songs: [Song]

  var body: some View {
    ForEach(Array(songs.enumerated()), id: \.element.id) { index, song in
      Button { player.play(songs, startAt: index) } label: {
        VStack(alignment: .leading) {
          Text(song.title).lineLimit(1)
          Text("\(song.artist) · \(song.album)").font(.caption).foregroundStyle(.secondary).lineLimit(1)
        }
      }
      .buttonStyle(.plain)
    }
  }
}
