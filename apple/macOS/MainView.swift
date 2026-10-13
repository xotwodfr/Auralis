import AppKit
import AuralisKit
import SwiftUI

/// The web's destinations (src/App.tsx routes, Shell.tsx sidebar), in the same order and groups.
enum SidebarItem: Hashable {
  case nowPlaying, artists, albums, recentlyAdded, playlists, favorites, recent, settings, search

  var title: String {
    switch self {
    case .nowPlaying: "Now Playing"; case .artists: "Artists"; case .albums: "Albums"; case .recentlyAdded: "Recently Added"
    case .playlists: "Playlists"; case .favorites: "Favorites"; case .recent: "Recent"; case .settings: "Settings"; case .search: "Search"
    }
  }

  var icon: String {
    switch self {
    case .nowPlaying: "wave"; case .artists: "artist"; case .albums: "album"; case .recentlyAdded: "added"; case .playlists: "playlist"
    case .favorites: "heart"; case .recent: "clock"; case .settings: "settings"; case .search: "search"
    }
  }

  static let library: [SidebarItem] = [.artists, .albums, .recentlyAdded]
  static let yours: [SidebarItem] = [.playlists, .favorites, .recent]
}

/// Window-wide navigation state, shared with the menu commands.
@MainActor @Observable
final class Router {
  var selection: SidebarItem = .artists
  var search = ""
  /// The debounced query the results page shows.
  var query = ""
  var showQueue = false
  /// Bumped to move focus into the toolbar search field (`/`, ⌘F).
  var searchRequests = 0
}

/// NavigationSplitView gives the floating Liquid Glass sidebar on macOS 26; content stays on solid theme surfaces.
struct MainView: View {
  @Environment(AppModel.self) private var app
  @Environment(PlayerModel.self) private var player
  @Environment(Router.self) private var router
  @Environment(\.tokens) private var t
  @FocusState private var searchFocused: Bool
  @State private var keys = KeyMonitor()

  var body: some View {
    @Bindable var router = router
    NavigationSplitView {
      Sidebar()
        .navigationSplitViewColumnWidth(min: 200, ideal: 236, max: 300)
    } detail: {
      RoutedStack { destination }
        .id(router.selection == .search ? "search" : "\(router.selection)")
        .searchable(text: $router.search, placement: .toolbar, prompt: "Search")
        .searchFocused($searchFocused)
        .safeAreaInset(edge: .bottom, spacing: 0) { PlayerBar() }
        .overlay(alignment: .bottom) { ToastView().padding(.bottom, 116) }
        .background(t.bg)
    }
    .frame(minWidth: 760, minHeight: 540)
    .task(id: router.search) {
      // The sleep is the debounce; a new keystroke cancels it (src/features/search/SearchBox.tsx).
      try? await Task.sleep(for: .milliseconds(300))
      if Task.isCancelled { return }
      let q = router.search.trimmingCharacters(in: .whitespaces)
      if q.isEmpty && router.selection != .search { return }
      router.query = q
      router.selection = .search
    }
    .onChange(of: router.searchRequests) { searchFocused = true }
    .onAppear { keys.install(player: player, router: router) }
    .onDisappear { keys.remove() }
  }

  @ViewBuilder private var destination: some View {
    switch router.selection {
    case .nowPlaying: NowPlayingView()
    case .artists: ArtistsView()
    case .albums: AlbumListView(title: "Albums", type: .alphabeticalByName, hint: "Add music to your server and run a scan.")
    case .recentlyAdded: AlbumListView(title: "Recently Added", type: .newest, hint: "Newly added albums will show up here.", showAdded: true)
    case .recent: AlbumListView(title: "Recent", type: .recent, hint: "Albums you play will show up here.")
    case .playlists: PlaylistsView()
    case .favorites: FavoritesView()
    case .settings: SettingsView()
    case .search: SearchResultsView(query: router.query)
    }
  }
}

private struct Sidebar: View {
  @Environment(AppModel.self) private var app
  @Environment(Router.self) private var router
  @Environment(\.tokens) private var t

  var body: some View {
    // List's single selection binds an optional; the router always has a destination.
    List(selection: Binding<SidebarItem?>(get: { router.selection }, set: { if let item = $0 { router.selection = item } })) {
      HStack(spacing: 10) {
        Icon("wave", size: 22).foregroundStyle(t.accent)
        Text("Auralis").font(.system(size: 17, weight: .semibold)).kerning(-0.34)
      }
      .padding(.vertical, 6)
      .selectionDisabled()

      row(.nowPlaying)
      Section("Library") { ForEach(SidebarItem.library, id: \.self) { row($0) } }
      Section("Yours") { ForEach(SidebarItem.yours, id: \.self) { row($0) } }
    }
    .listStyle(.sidebar)
    .safeAreaInset(edge: .bottom, spacing: 0) { account }
  }

  private func row(_ item: SidebarItem) -> some View {
    Label { Text(item.title).font(.system(size: 15)) } icon: { Icon(item.icon, size: 20) }
      .tag(item)
      .frame(minHeight: 30)
  }

  /// Settings lives in the footer with the account line, as on the web.
  private var account: some View {
    let c = app.client?.credentials
    let host = c?.baseURL.absoluteString.replacingOccurrences(of: #"^https?://"#, with: "", options: .regularExpression)
    let selected = router.selection == .settings
    return Button { router.selection = .settings } label: {
      HStack(spacing: 12) {
        Icon("settings", size: 20)
        VStack(alignment: .leading, spacing: 1) {
          Text("Settings").font(.system(size: 15))
          if let c { Text([c.username, host].compactMap { $0 }.joined(separator: " · ")).font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(1) }
        }
        Spacer(minLength: 0)
      }
      .padding(.horizontal, 10)
      .frame(minHeight: 48)
      .foregroundStyle(selected ? t.accent : t.text2)
      .background(selected ? AnyShapeStyle(.selection.opacity(0.25)) : AnyShapeStyle(.clear), in: .rect(cornerRadius: 10))
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .padding(10)
    .overlay(alignment: .top) { Divider() }
    .accessibilityLabel("Settings")
  }
}

/// Brief confirmations ("Added to playlist") on a small glass capsule above the player.
private struct ToastView: View {
  @Environment(AppModel.self) private var app
  @Environment(\.tokens) private var t
  var body: some View {
    ZStack {
      if let toast = app.toast {
        Text(toast.message)
          .font(.meta)
          .foregroundStyle(toast.isError ? t.danger : t.text)
          .padding(.horizontal, 18).padding(.vertical, 10)
          .glassEffect(.regular, in: .capsule)
          .transition(.move(edge: .bottom).combined(with: .opacity))
          .id(toast.id)
          .accessibilityAddTraits(.isStaticText)
      }
    }
    .animation(.spring(duration: 0.4), value: app.toast)
  }
}

/// The web's unmodified shortcuts (src/app/shortcuts.ts). Never fires while typing, with modifiers, in a sheet,
/// or when the focused control owns the key (space on a button, arrows in a list).
@MainActor
final class KeyMonitor {
  private var token: Any?

  func install(player: PlayerModel, router: Router) {
    remove()
    token = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
      // AppKit delivers local monitor events on the main thread.
      MainActor.assumeIsolated { Self.handle(event, player: player, router: router) } ? nil : event
    }
  }

  /// True when the key was handled (and must not reach the focused view).
  private static func handle(_ event: NSEvent, player: PlayerModel, router: Router) -> Bool {
    guard event.modifierFlags.intersection([.command, .control, .option]).isEmpty, let window = event.window,
          window.attachedSheet == nil, !(window is NSPanel) else { return false }
    let responder = window.firstResponder
    if responder is NSText { return false } // typing in a field
    let ownsArrows = responder is NSTableView || responder is NSOutlineView || responder is NSScrollView || responder is NSSlider
    switch event.keyCode {
    case 49: // space
      if responder is NSButton || event.isARepeat { return false }
      player.togglePlay()
    case 123, 124: // ← →
      if responder is NSSlider { return false }
      player.seek(by: event.keyCode == 124 ? PlayerModel.seekStep : -PlayerModel.seekStep)
    case 125, 126: // ↓ ↑
      if ownsArrows { return false }
      player.setVolume(player.volume + (event.keyCode == 126 ? PlayerModel.volumeStep : -PlayerModel.volumeStep))
    default:
      switch (event.charactersIgnoringModifiers ?? "").lowercased() {
      case "n": player.next()
      case "p": player.previous()
      case "/": router.searchRequests += 1
      default: return false
      }
    }
    return true
  }

  func remove() {
    if let token { NSEvent.removeMonitor(token) }
    token = nil
  }
}
