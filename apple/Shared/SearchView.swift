import AuralisKit
import SwiftUI

/// Results for the toolbar search (src/features/search/Search.tsx). The caller debounces `query`.
struct SearchResultsView: View {
  @Environment(AppModel.self) private var app
  let query: String
  @State private var state: Load<SearchResults> = .idle

  var body: some View {
    Page(title: query.isEmpty ? "Search" : "Results for “\(query)”") {
      if query.isEmpty {
        EmptyState(title: "Search your library", hint: "Type an artist, album or track name in the search box.")
      } else {
        LoadView(state: state, retry: load) { r in
          if r.isEmpty {
            EmptyState(title: "No results for “\(query)”", hint: "Check the spelling or try a shorter search.")
          } else {
            VStack(alignment: .leading, spacing: 0) {
              if !r.artists.isEmpty { PageSection(title: "Artists") { ArtistList(artists: r.artists) } }
              if !r.albums.isEmpty { PageSection(title: "Albums") { AlbumGrid(albums: r.albums) } }
              if !r.songs.isEmpty { PageSection(title: "Tracks") { TrackList(songs: r.songs) } }
            }
          }
        }
      }
    }
    .task(id: query) { await load() }
  }

  private func load() async {
    guard !query.isEmpty, let client = app.client else { return }
    state = .loading
    // shortcut: one capped page per type (no pagination), like the web; add "show more" if users hit the caps.
    do { state = .loaded(try await client.search(query, artistCount: 10, albumCount: 20, songCount: 50)) } catch {
      if !Task.isCancelled { state = .failed(error) }
    }
  }
}
