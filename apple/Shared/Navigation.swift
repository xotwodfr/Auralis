import AuralisKit
import SwiftUI

/// Detail pages, addressed like the web's `/library/<kind>/<id>` routes.
enum Route: Hashable {
  case artist(id: String, name: String)
  case album(id: String, name: String)
  case playlist(id: String, name: String)
}

private struct NavigateKey: EnvironmentKey { static let defaultValue: (Route) -> Void = { _ in } }

extension EnvironmentValues {
  /// Pushes a detail page onto the enclosing `RoutedStack` (for actions that aren't links, like "Go to album").
  var navigate: (Route) -> Void {
    get { self[NavigateKey.self] }
    set { self[NavigateKey.self] = newValue }
  }
}

/// A NavigationStack that owns its path and knows every detail page.
struct RoutedStack<Root: View>: View {
  @State private var path: [Route] = []
  @ViewBuilder let root: Root

  var body: some View {
    NavigationStack(path: $path) {
      root.navigationDestination(for: Route.self) { route in
        switch route {
        case .artist(let id, let name): ArtistDetailView(id: id, name: name)
        case .album(let id, let name): AlbumDetailView(id: id, name: name)
        case .playlist(let id, let name): PlaylistDetailView(id: id, name: name)
        }
      }
    }
    .environment(\.navigate) { path.append($0) }
  }
}

/// The scrolling page every library screen sits in: theme background, web paddings, readable width for text pages.
struct Page<Content: View>: View {
  @Environment(\.tokens) private var t
  var title: String?
  var maxWidth: CGFloat? = nil
  @ViewBuilder let content: Content

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 20) {
        if let title { PageTitle(text: title) }
        content
      }
      .frame(maxWidth: maxWidth ?? .infinity, alignment: .leading)
      .padding(.horizontal, Metric.padX)
      .padding(.top, 24)
      .padding(.bottom, 64)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .background(t.bg)
  }
}
