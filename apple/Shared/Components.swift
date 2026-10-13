import AuralisKit
import SwiftUI

/// The web's line icons (src/ui/Icon.tsx), shipped as template SVGs in Assets.xcassets/Icons.
struct Icon: View {
  let name: String
  var size: CGFloat = 22

  init(_ name: String, size: CGFloat = 22) { self.name = name; self.size = size }

  var body: some View {
    Image("icon-\(name)").resizable().renderingMode(.template).frame(width: size, height: size).accessibilityHidden(true)
  }
}

struct CoverArtView: View {
  @Environment(AppModel.self) private var app
  @Environment(\.tokens) private var t
  let id: String?
  var size = 300
  var radius = Metric.rThumb

  var body: some View {
    // Placeholder art is the theme gradient (`.artwork { background: var(--grad-blue) }`).
    Rectangle().fill(t.placeholder)
      .overlay {
        if let id, let url = app.coverURL(id, size: size) {
          AsyncImage(url: url, transaction: Transaction(animation: .easeOut(duration: 0.2))) { phase in
            if let image = phase.image { image.resizable().scaledToFill() }
          }
        }
      }
      .aspectRatio(1, contentMode: .fit)
      .clipShape(.rect(cornerRadius: radius))
      .accessibilityHidden(true)
  }
}

/// `.page__title`.
struct PageTitle: View {
  @Environment(\.tokens) private var t
  let text: String
  var body: some View {
    Text(text).font(.pageTitle).kerning(-1.08).foregroundStyle(t.text).frame(maxWidth: .infinity, alignment: .leading)
      .accessibilityAddTraits(.isHeader)
  }
}

/// `.section` + `.section__title`.
struct PageSection<Content: View>: View {
  let title: String
  @ViewBuilder let content: Content
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(title).font(.sectionTitle).kerning(-0.4).accessibilityAddTraits(.isHeader)
      content
    }
    .padding(.top, 32)
  }
}

/// `.panel` / `.list-panel`: solid surface, hairline border, card shadow. Content, never glass.
struct PanelModifier: ViewModifier {
  @Environment(\.tokens) private var t
  var padding: CGFloat = 22
  func body(content: Content) -> some View {
    content
      .padding(padding)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(t.surface, in: .rect(cornerRadius: Metric.rPanel))
      .overlay(RoundedRectangle(cornerRadius: Metric.rPanel).strokeBorder(t.hairline))
      .shadow(color: .black.opacity(t.scheme == .dark ? 0.3 : 0.05), radius: 12, y: 8)
  }
}

extension View {
  func panel(padding: CGFloat = 22) -> some View { modifier(PanelModifier(padding: padding)) }
}

/// `.btn` and `.btn--primary`: 44pt pill buttons.
struct PillButtonStyle: ButtonStyle {
  @Environment(\.tokens) private var t
  @Environment(\.isEnabled) private var enabled
  var primary = false
  var danger = false

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.body16)
      .lineLimit(1)
      .padding(.horizontal, 22)
      .frame(minHeight: 44)
      .foregroundStyle(primary || danger ? Color.white : t.text)
      .background(danger ? t.danger : primary ? t.accentFill : t.surface, in: .capsule)
      .overlay(Capsule().strokeBorder(primary || danger ? .clear : t.hairline))
      .opacity(enabled ? (configuration.isPressed ? 0.8 : 1) : 0.4)
      .contentShape(.capsule)
  }
}

extension ButtonStyle where Self == PillButtonStyle {
  static var pill: PillButtonStyle { PillButtonStyle() }
  static var pillPrimary: PillButtonStyle { PillButtonStyle(primary: true) }
}

/// `.icon-btn`: 44pt round hit area, hover tint.
struct IconButtonStyle: ButtonStyle {
  var active = false
  var size: CGFloat = 44

  func makeBody(configuration: Configuration) -> some View {
    IconButtonBody(configuration: configuration, active: active, size: size)
  }

  // A ButtonStyle can't own state; the hover flag lives in this view.
  private struct IconButtonBody: View {
    @Environment(\.tokens) private var t
    @Environment(\.isEnabled) private var enabled
    let configuration: ButtonStyleConfiguration
    let active: Bool
    let size: CGFloat
    @State private var hover = false

    var body: some View {
      configuration.label
        .foregroundStyle(active ? t.accent : (hover ? t.text : t.text2))
        .frame(width: size, height: size)
        .background(Circle().fill(t.text.opacity(hover || configuration.isPressed ? 0.06 : 0)))
        .contentShape(.circle)
        .scaleEffect(configuration.isPressed ? 0.94 : 1)
        .opacity(enabled ? 1 : 0.35)
        .onHover { hover = $0 }
    }
  }
}

/// `.empty`: a designed empty state, centred.
struct EmptyState: View {
  @Environment(\.tokens) private var t
  let title: String
  var hint: String?
  var body: some View {
    VStack(spacing: 10) {
      Text(title).font(.body16.weight(.semibold))
      if let hint { Text(hint).foregroundStyle(t.text2) }
    }
    .multilineTextAlignment(.center)
    .frame(maxWidth: .infinity)
    .padding(.vertical, 32)
  }
}

struct ErrorState: View {
  let message: String
  var actionLabel = "Try again"
  let retry: () -> Void
  var body: some View {
    VStack(spacing: 10) {
      Text(message).font(.body16.weight(.semibold)).multilineTextAlignment(.center)
      Button(actionLabel, action: retry).buttonStyle(.pill)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 32)
    .accessibilityElement(children: .contain)
  }
}

/// `.skeleton`: rows shaped like the content, so nothing jumps when it arrives.
struct Skeleton: View {
  @Environment(\.tokens) private var t
  var body: some View {
    VStack(spacing: 10) {
      ForEach(0..<6, id: \.self) { _ in RoundedRectangle(cornerRadius: Metric.rThumb).fill(t.track).frame(height: 56) }
    }
    .accessibilityElement()
    .accessibilityLabel("Loading")
  }
}

/// Loading skeleton / error with retry; otherwise the content. A rejected session offers "Sign in again".
struct LoadView<Value, Content: View>: View {
  @Environment(AppModel.self) private var app
  let state: Load<Value>
  let retry: () async -> Void
  @ViewBuilder let content: (Value) -> Content

  var body: some View {
    switch state {
    case .idle, .loading: Skeleton()
    case .failed(let error):
      if error as? SubsonicError == .auth {
        ErrorState(message: "Your session was rejected by the server.", actionLabel: "Sign in again") { app.signOut() }
      } else {
        ErrorState(message: AppModel.message(for: error)) { Task { await retry() } }
      }
    case .loaded(let value): content(value)
    }
  }
}

/// The one favourite control: the same heart on tracks, albums and artists.
struct StarButton: View {
  @Environment(AppModel.self) private var app
  @Environment(\.tokens) private var t
  let item: AppModel.StarItem
  let name: String
  var onArtwork = false

  private var starred: Bool {
    switch item {
    case .song(let s): app.isStarred(.song, s.id)
    case .album(let a): app.isStarred(.album, a.id)
    case .artist(let a): app.isStarred(.artist, a.id)
    }
  }

  var body: some View {
    Button { Task { await app.toggleStar(item) } } label: {
      Icon(starred ? "heart-fill" : "heart", size: 20).foregroundStyle(starred ? t.heat : (onArtwork ? .white : t.text2))
    }
    .buttonStyle(IconButtonStyle())
    .help(starred ? "Remove from favorites" : "Add to favorites")
    .accessibilityLabel(starred ? "Remove \(name) from favorites" : "Add \(name) to favorites")
    .accessibilityAddTraits(starred ? .isSelected : [])
  }
}

/// Seconds → `m:ss` or `h:mm:ss`.
func formatTime(_ seconds: Double) -> String {
  guard seconds.isFinite else { return "0:00" }
  let total = max(0, Int(seconds.rounded()))
  let h = total / 3600, m = total % 3600 / 60, s = total % 60
  return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
}

func formatDate(_ date: Date?) -> String { date.map { $0.formatted(date: .abbreviated, time: .omitted) } ?? "" }
