import AuralisKit
import SwiftUI

// Ports of src/features/library (views.tsx, components.tsx, TrackActions.tsx).

private let albumPage = 60

// MARK: Top-level sections

struct ArtistsView: View {
  @Environment(AppModel.self) private var app
  @State private var state: Load<[Artist]> = .idle

  var body: some View {
    Page(title: "Artists") {
      LoadView(state: state, retry: load) { artists in
        if artists.isEmpty { EmptyState(title: "No artists yet", hint: "Add music to your server and run a scan.") } else { ArtistList(artists: artists) }
      }
    }
    .task { if state.value == nil { await load() } }
  }

  private func load() async {
    guard let client = app.client else { return }
    state = .loading
    do { state = .loaded(try await client.artists()) } catch { state = .failed(error) }
  }
}

/// Albums, Recently Added (`newest`) and Recent (`recent` = recently played): one paged grid.
struct AlbumListView: View {
  @Environment(AppModel.self) private var app
  let title: String
  let type: AlbumListType
  let hint: String
  var showAdded = false
  @State private var state: Load<[Album]> = .idle
  @State private var hasMore = false
  @State private var loadingMore = false
  @State private var moreFailed = false

  var body: some View {
    Page(title: title) {
      LoadView(state: state, retry: { await load(reset: true) }) { albums in
        if albums.isEmpty {
          EmptyState(title: "No \(title.lowercased()) yet", hint: hint)
        } else {
          AlbumGrid(albums: albums, showAdded: showAdded)
          if hasMore {
            VStack(spacing: 10) {
              if moreFailed { Text("Couldn’t load more.") }
              Button(loadingMore ? "Loading…" : moreFailed ? "Try again" : "Load more") { Task { await load(reset: false) } }
                .buttonStyle(.pill).disabled(loadingMore)
            }
            .frame(maxWidth: .infinity).padding(.vertical, 32)
          }
        }
      }
    }
    .task { if state.value == nil { await load(reset: true) } }
  }

  private func load(reset: Bool) async {
    guard let client = app.client else { return }
    let existing = reset ? [] : (state.value ?? [])
    if reset { state = .loading } else { loadingMore = true; moreFailed = false }
    defer { loadingMore = false }
    do {
      let page = try await client.albumList(type, size: albumPage, offset: existing.count)
      state = .loaded(existing + page)
      hasMore = page.count == albumPage
    } catch {
      if reset { state = .failed(error) } else { moreFailed = true }
    }
  }
}

struct PlaylistsView: View {
  @Environment(AppModel.self) private var app
  @State private var state: Load<[Playlist]> = .idle

  var body: some View {
    Page(title: "Playlists") {
      LoadView(state: state, retry: load) { playlists in
        if playlists.isEmpty { EmptyState(title: "No playlists yet", hint: "Create a playlist in Navidrome.") } else {
          ListPanel {
            ForEach(playlists) { p in
              NavigationLink(value: Route.playlist(id: p.id, name: p.name)) {
                RowContent(lead: { CoverArtView(id: p.coverArt, size: 96, radius: 8) }, title: p.name, sub: p.owner, end: "\(p.songCount) tracks")
              }
              .buttonStyle(RowButtonStyle())
            }
          }
        }
      }
    }
    .task(id: app.playlistsVersion) { await load() }
  }

  private func load() async {
    guard let client = app.client else { return }
    if state.value == nil { state = .loading }
    do { state = .loaded(try await client.playlists()) } catch { if state.value == nil { state = .failed(error) } }
  }
}

struct FavoritesView: View {
  @Environment(AppModel.self) private var app

  var body: some View {
    Page(title: "Favorites") {
      LoadView(state: app.starred, retry: { await app.reloadStarred() }) { s in
        if s.isEmpty {
          EmptyState(title: "No favorites yet", hint: "Star artists, albums or tracks to see them here.")
        } else {
          VStack(alignment: .leading, spacing: 0) {
            if !s.artists.isEmpty { PageSection(title: "Artists") { ArtistList(artists: s.artists) } }
            if !s.albums.isEmpty { PageSection(title: "Albums") { AlbumGrid(albums: s.albums) } }
            if !s.songs.isEmpty { PageSection(title: "Tracks") { TrackList(songs: s.songs) } }
          }
        }
      }
    }
    .task { await app.reloadStarred() }
  }
}

// MARK: Detail pages

struct ArtistDetailView: View {
  @Environment(AppModel.self) private var app
  let id: String
  let name: String
  @State private var state: Load<(artist: Artist, albums: [Album])> = .idle

  var body: some View {
    Page {
      LoadView(state: state, retry: load) { data in
        Hero(cover: data.artist.coverArt, title: data.artist.name, meta: "\(data.albums.count) albums", star: .artist(data.artist)) {
          EmptyView()
        } actions: {
          ArtistActions(albums: data.albums)
        }
        if data.albums.isEmpty { EmptyState(title: "No albums for this artist") } else { AlbumGrid(albums: data.albums) }
      }
    }
    .navigationTitle(name)
    .task(id: id) { await load() }
  }

  private func load() async {
    guard let client = app.client else { return }
    state = .loading
    do { state = .loaded(try await client.artist(id: id)) } catch { state = .failed(error) }
  }
}

struct AlbumDetailView: View {
  @Environment(AppModel.self) private var app
  @Environment(\.navigate) private var navigate
  @Environment(\.tokens) private var t
  let id: String
  let name: String
  @State private var state: Load<(album: Album, songs: [Song])> = .idle

  var body: some View {
    Page {
      LoadView(state: state, retry: load) { data in
        let a = data.album
        Hero(cover: a.coverArt, title: a.name,
             meta: [a.year.map(String.init), "\(a.songCount) tracks", formatTime(a.duration)].compactMap { $0 }.joined(separator: " · "),
             star: .album(a)) {
          if let artistId = a.artistId {
            Button(a.artist) { navigate(.artist(id: artistId, name: a.artist)) }.buttonStyle(.plain).foregroundStyle(t.accentLink)
          } else {
            Text(a.artist)
          }
        } actions: {
          PlayButtons(songs: data.songs)
        }
        if data.songs.isEmpty { EmptyState(title: "No tracks on this album") } else { TrackList(songs: data.songs, numbered: true) }
      }
    }
    .navigationTitle(name)
    .task(id: id) { await load() }
  }

  private func load() async {
    guard let client = app.client else { return }
    state = .loading
    do { state = .loaded(try await client.album(id: id)) } catch { state = .failed(error) }
  }
}

struct PlaylistDetailView: View {
  @Environment(AppModel.self) private var app
  let id: String
  let name: String
  @State private var state: Load<(playlist: Playlist, songs: [Song])> = .idle

  var body: some View {
    Page {
      LoadView(state: state, retry: load) { data in
        Hero(cover: data.playlist.coverArt, title: data.playlist.name,
             meta: "\(data.playlist.songCount) tracks · \(formatTime(data.playlist.duration))", star: nil) {
          EmptyView()
        } actions: {
          PlayButtons(songs: data.songs)
        }
        if data.songs.isEmpty { EmptyState(title: "This playlist is empty") } else { TrackList(songs: data.songs, inPlaylist: data.playlist.id) }
      }
    }
    .navigationTitle(name)
    .task(id: "\(id)#\(app.playlistsVersion)") { await load() }
  }

  private func load() async {
    guard let client = app.client else { return }
    if state.value == nil { state = .loading }
    do { state = .loaded(try await client.playlist(id: id)) } catch { if state.value == nil { state = .failed(error) } }
  }
}

/// `.hero`: 160pt cover, big title with its heart, a line of context, the actions.
struct Hero<Sub: View, Actions: View>: View {
  @Environment(\.tokens) private var t
  let cover: String?
  let title: String
  let meta: String
  let star: AppModel.StarItem?
  @ViewBuilder let sub: Sub
  @ViewBuilder let actions: Actions

  var body: some View {
    HStack(alignment: .bottom, spacing: 22) {
      CoverArtView(id: cover, size: 400).frame(width: 160)
      VStack(alignment: .leading, spacing: 6) {
        HStack(alignment: .center, spacing: 4) {
          Text(title).font(.pageTitle).kerning(-1.08).lineLimit(3).accessibilityAddTraits(.isHeader)
          if let star { StarButton(item: star, name: title) }
        }
        sub.font(.body16)
        Text(meta).foregroundStyle(t.text2)
        actions.padding(.top, 12)
      }
    }
    .padding(.bottom, 8)
  }
}

// MARK: Albums

struct AlbumGrid: View {
  let albums: [Album]
  var showAdded = false

  var body: some View {
    LazyVGrid(columns: [GridItem(.adaptive(minimum: 170, maximum: 230), spacing: 18, alignment: .top)], alignment: .leading, spacing: 22) {
      ForEach(albums) { AlbumCard(album: $0, showAdded: showAdded) }
    }
    .accessibilityElement(children: .contain)
  }
}

private struct AlbumCard: View {
  @Environment(AppModel.self) private var app
  @Environment(PlayerModel.self) private var player
  @Environment(\.tokens) private var t
  let album: Album
  let showAdded: Bool
  @State private var hover = false
  @State private var busy = false
  @State private var failed = false

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      NavigationLink(value: Route.album(id: album.id, name: album.name)) {
        VStack(alignment: .leading, spacing: 2) {
          CoverArtView(id: album.coverArt, size: 300).padding(.bottom, 8)
          Text(album.name).font(.body16.weight(.semibold)).lineLimit(1)
          Text([album.artist, album.year.map(String.init)].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
            .font(.meta).foregroundStyle(t.text2).lineLimit(1)
          if showAdded, album.created != nil {
            Text("Added \(formatDate(album.created))").font(.meta).foregroundStyle(t.text2).lineLimit(1)
          }
        }
        .contentShape(.rect)
      }
      .buttonStyle(.plain)
      if failed { Text("Couldn’t load this album.").font(.meta).foregroundStyle(t.danger) }
    }
    .overlay(alignment: .topTrailing) {
      HStack(spacing: 4) {
        StarButton(item: .album(album), name: album.name, onArtwork: true).background(Circle().fill(.black.opacity(0.55)))
        Button { Task { await play() } } label: { Icon("play", size: 20).foregroundStyle(.white) }
          .buttonStyle(IconButtonStyle()).background(Circle().fill(.black.opacity(0.55)))
          .disabled(busy).accessibilityLabel("Play \(album.name)")
      }
      .padding(8)
      .opacity(hover ? 1 : 0)
      .animation(.easeOut(duration: 0.2), value: hover)
    }
    .onHover { hover = $0 }
    .contextMenu {
      Button("Play") { Task { await play() } }
      Button("Shuffle") { Task { await play(shuffle: true) } }
      Button("Add to Queue") { Task { if let s = await songs() { player.addToQueue(s) } } }
    }
  }

  private func songs() async -> [Song]? {
    guard let client = app.client else { return nil }
    busy = true; failed = false
    defer { busy = false }
    do { return try await client.album(id: album.id).songs } catch { failed = true; return nil }
  }

  private func play(shuffle: Bool = false) async {
    guard let s = await songs() else { return }
    if shuffle { player.shufflePlay(s) } else { player.play(s) }
  }
}

/// Play / Shuffle / Add to queue for a loaded list of tracks.
struct PlayButtons: View {
  @Environment(PlayerModel.self) private var player
  let songs: [Song]
  var body: some View {
    HStack(spacing: 10) {
      Button("Play") { player.play(songs) }.buttonStyle(.pillPrimary)
      Button("Shuffle") { player.shufflePlay(songs) }.buttonStyle(.pill)
      Button("Add to queue") { player.addToQueue(songs) }.buttonStyle(.pill)
    }
    .disabled(songs.isEmpty)
  }
}

/// Same actions for an artist: gathers every album's tracks first (one request per album).
private struct ArtistActions: View {
  @Environment(AppModel.self) private var app
  @Environment(PlayerModel.self) private var player
  @Environment(\.tokens) private var t
  let albums: [Album]
  @State private var failed = false

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 10) {
        Button("Play") { run { player.play($0) } }.buttonStyle(.pillPrimary)
        Button("Shuffle") { run { player.shufflePlay($0) } }.buttonStyle(.pill)
        Button("Add to queue") { run { player.addToQueue($0) } }.buttonStyle(.pill)
      }
      .disabled(albums.isEmpty)
      if failed { Text("Couldn’t load this artist’s tracks.").foregroundStyle(t.danger) }
    }
  }

  private func run(_ act: @escaping ([Song]) -> Void) {
    guard let client = app.client else { return }
    failed = false
    Task {
      do {
        let all = try await withThrowingTaskGroup(of: (Int, [Song]).self) { group in
          for (i, a) in albums.enumerated() { group.addTask { (i, try await client.album(id: a.id).songs) } }
          var parts: [(Int, [Song])] = []
          for try await p in group { parts.append(p) }
          return parts.sorted { $0.0 < $1.0 }.flatMap(\.1)
        }
        act(all)
      } catch {
        failed = true
      }
    }
  }
}

// MARK: Lists

/// `.list-panel`: rows on one surface, separated by hairlines.
struct ListPanel<Content: View>: View {
  @ViewBuilder let content: Content
  var body: some View {
    LazyVStack(spacing: 0) { content }.panel(padding: 0).clipShape(.rect(cornerRadius: Metric.rPanel))
  }
}

/// `.row`: 56pt, lead artwork/number, two lines of text, a trailing figure.
struct RowContent<Lead: View>: View {
  @Environment(\.tokens) private var t
  @ViewBuilder let lead: Lead
  let title: String
  var sub: String?
  var end: String?
  var current = false

  var body: some View {
    HStack(spacing: 14) {
      lead.frame(width: 36, height: 36)
      VStack(alignment: .leading, spacing: 1) {
        Text(title).font(.body16.weight(.semibold)).foregroundStyle(current ? t.accent : t.text).lineLimit(1)
        if let sub, !sub.isEmpty { Text(sub).font(.meta).foregroundStyle(t.text2).lineLimit(1) }
      }
      Spacer(minLength: 8)
      if let end { Text(end).font(.meta.monospacedDigit()).foregroundStyle(t.text2) }
    }
    .padding(.horizontal, 16)
    .frame(height: Metric.rowHeight)
    .contentShape(.rect)
  }
}

/// Hover highlight for link rows (`a.row:hover { background: var(--hover) }`).
struct RowButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View { RowBody(configuration: configuration) }

  private struct RowBody: View {
    @Environment(\.tokens) private var t
    let configuration: ButtonStyleConfiguration
    @State private var hover = false
    var body: some View {
      configuration.label
        .background(hover || configuration.isPressed ? t.hover : .clear)
        .onHover { hover = $0 }
    }
  }
}

struct ArtistList: View {
  let artists: [Artist]
  var body: some View {
    ListPanel {
      ForEach(artists) { a in
        HStack(spacing: 0) {
          NavigationLink(value: Route.artist(id: a.id, name: a.name)) {
            RowContent(lead: { CoverArtView(id: a.coverArt, size: 96, radius: 18) }, title: a.name,
                       end: "\(a.albumCount) \(a.albumCount == 1 ? "album" : "albums")")
          }
          .buttonStyle(RowButtonStyle())
          StarButton(item: .artist(a), name: a.name).padding(.trailing, 8)
        }
      }
    }
  }
}

/// `numbered`: album context, so the track number replaces the art and the album name is omitted.
/// `inPlaylist`: adds "Remove from this playlist" to each track's actions.
struct TrackList: View {
  @Environment(PlayerModel.self) private var player
  let songs: [Song]
  var numbered = false
  var inPlaylist: String?

  var body: some View {
    ListPanel {
      ForEach(Array(songs.enumerated()), id: \.offset) { index, song in
        TrackRow(songs: songs, index: index, numbered: numbered, inPlaylist: inPlaylist, current: player.current?.id == song.id)
      }
    }
  }
}

private struct TrackRow: View {
  @Environment(PlayerModel.self) private var player
  @Environment(\.tokens) private var t
  let songs: [Song]
  let index: Int
  let numbered: Bool
  let inPlaylist: String?
  let current: Bool
  @State private var picking = false
  @State private var hover = false

  private var song: Song { songs[index] }

  var body: some View {
    HStack(spacing: 0) {
      Button { player.play(songs, startAt: index) } label: {
        RowContent(lead: {
          if numbered {
            Text("\(song.track ?? index + 1)").font(.body16.monospacedDigit()).foregroundStyle(t.text3)
          } else {
            CoverArtView(id: song.coverArt, size: 96, radius: 8)
          }
        }, title: song.title,
        sub: numbered ? song.artist : [song.artist, song.album].filter { !$0.isEmpty }.joined(separator: " · "),
        end: formatTime(song.duration), current: current)
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Play \(song.title)")
      StarButton(item: .song(song), name: song.title)
      Menu {
        TrackActions(song: song, index: index, inPlaylist: inPlaylist, picking: $picking)
      } label: {
        Icon("more", size: 20)
      }
      .menuStyle(.button)
      .buttonStyle(IconButtonStyle())
      .menuIndicator(.hidden)
      .fixedSize()
      .help("More")
      .accessibilityLabel("More actions for \(song.title)")
      .padding(.trailing, 8)
    }
    .background(current || hover ? t.hover : .clear)
    .onHover { hover = $0 }
    .contextMenu { TrackActions(song: song, index: index, inPlaylist: inPlaylist, picking: $picking) }
    .sheet(isPresented: $picking) { PlaylistPicker(song: song) }
  }
}

/// Every action for one track, in one place (menu and right-click).
struct TrackActions: View {
  @Environment(AppModel.self) private var app
  @Environment(PlayerModel.self) private var player
  @Environment(\.navigate) private var navigate
  let song: Song
  var index = 0
  var inPlaylist: String?
  @Binding var picking: Bool

  var body: some View {
    Button("Play Next") { player.addNext([song]) }
    Button("Add to Queue") { player.addToQueue([song]) }
    Button("Add to Playlist…") { picking = true }
    Button(app.isStarred(.song, song.id) ? "Remove from Favorites" : "Add to Favorites") { Task { await app.toggleStar(.song(song)) } }
    if let albumId = song.albumId { Button("Go to Album") { navigate(.album(id: albumId, name: song.album)) } }
    if let artistId = song.artistId { Button("Go to Artist") { navigate(.artist(id: artistId, name: song.artist)) } }
    if let inPlaylist {
      Divider()
      Button("Remove from This Playlist", role: .destructive) { Task { await app.removeFromPlaylist(song, playlistID: inPlaylist, index: index) } }
    }
  }
}

/// Second step of "Add to playlist": the user's playlists, plus creating one from this track.
struct PlaylistPicker: View {
  @Environment(AppModel.self) private var app
  @Environment(\.dismiss) private var dismiss
  @Environment(\.tokens) private var t
  let song: Song
  @State private var playlists: Load<[Playlist]> = .idle
  @State private var name = ""
  @State private var saving = false
  @State private var error: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text("Add “\(song.title)” to…").font(.panelTitle)
      if let error { Text(error).foregroundStyle(t.danger) }
      LoadView(state: playlists, retry: load) { list in
        ScrollView {
          VStack(spacing: 2) {
            if list.isEmpty { Text("You have no playlists yet. Make one below.").foregroundStyle(t.text2) }
            ForEach(list) { p in
              Button { save(p, nil) } label: {
                HStack(spacing: 12) { Icon("playlist", size: 20); Text(p.name); Spacer() }.frame(minHeight: 44).contentShape(.rect)
              }
              .buttonStyle(RowButtonStyle())
            }
          }
        }
        .frame(maxHeight: 320)
      }
      HStack(alignment: .bottom) {
        VStack(alignment: .leading, spacing: 6) {
          Text("New playlist").font(.meta).foregroundStyle(t.text2)
          TextField("Name", text: $name).textFieldStyle(.roundedBorder).onSubmit { create() }
        }
        Button(saving ? "Saving…" : "Create") { create() }.buttonStyle(.pillPrimary)
          .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || saving)
      }
      HStack { Spacer(); Button("Cancel") { dismiss() }.buttonStyle(.pill).keyboardShortcut(.cancelAction) }
    }
    .padding(22)
    .frame(minWidth: 380)
    .background(t.surface)
    .task { await load() }
  }

  private func create() {
    let n = name.trimmingCharacters(in: .whitespaces)
    if !n.isEmpty { save(nil, n) }
  }

  private func save(_ playlist: Playlist?, _ newName: String?) {
    saving = true
    error = nil
    Task {
      do {
        try await app.addToPlaylist(song, playlist: playlist, newName: newName)
        dismiss()
      } catch {
        self.error = AppModel.message(for: error)
      }
      saving = false
    }
  }

  private func load() async {
    guard let client = app.client else { return }
    playlists = .loading
    do { playlists = .loaded(try await client.playlists()) } catch { playlists = .failed(error) }
  }
}
