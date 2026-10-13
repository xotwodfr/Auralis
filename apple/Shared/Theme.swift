import AuralisKit
import SwiftUI

/// The web's theme presets (src/app/theme.ts) with the exact values from src/styles/tokens.css.
enum ThemePref: String, CaseIterable, Identifiable {
  case system, light, dark, midnight, oled, nord, sunset, forest, sakura, artwork
  var id: String { rawValue }

  var label: String {
    switch self {
    case .system: "System"; case .light: "Light"; case .dark: "Dark"; case .midnight: "Midnight"; case .oled: "OLED Black"
    case .nord: "Nord"; case .sunset: "Sunset"; case .forest: "Forest"; case .sakura: "Sakura"; case .artwork: "Album Artwork"
    }
  }

  /// Caption under the swatch in Settings.
  var caption: String {
    switch self {
    case .system: "Follows your OS"
    case .light, .sakura: "Light"
    default: "Dark"
    }
  }
}

/// Design tokens (DESIGN.md §1). Views read colours only from here, never hard-coded.
struct Tokens: Equatable {
  var scheme: ColorScheme
  var bg, surface, hover, text, textBody, text2, text3, text4, faint, hairline, track: Color
  var accent, accentFill, accentLink, danger: Color
  var gradStart, gradEnd: Color
  /// The star colour (`--heat`).
  var heat = Color(hex: "#ff6b00")

  static let light = Tokens(
    scheme: .light, bg: .init(hex: "#f5f5f7"), surface: .white, hover: .init(hex: "#fbfbfd"), text: .init(hex: "#1d1d1f"),
    textBody: .init(hex: "#424245"), text2: .init(hex: "#6e6e73"), text3: .init(hex: "#707076"), text4: .init(hex: "#aeaeb2"),
    faint: .init(hex: "#d2d2d7"), hairline: .black.opacity(0.07), track: .init(hex: "#e8e8ed"), accent: .init(hex: "#0071e3"),
    accentFill: .init(hex: "#0071e3"), accentLink: .init(hex: "#0066cc"), danger: .init(hex: "#b33b00"),
    gradStart: .init(hex: "#0a84ff"), gradEnd: .init(hex: "#5e5ce6")
  )

  static let dark = Tokens(
    scheme: .dark, bg: .init(hex: "#0b0b0d"), surface: .init(hex: "#161618"), hover: .init(hex: "#1c1c1e"), text: .init(hex: "#f5f5f7"),
    textBody: .init(hex: "#d1d1d6"), text2: .init(hex: "#a1a1a6"), text3: .init(hex: "#8e8e93"), text4: .init(hex: "#636366"),
    faint: .init(hex: "#3a3a3c"), hairline: .white.opacity(0.09), track: .init(hex: "#2c2c2e"), accent: .init(hex: "#0a84ff"),
    accentFill: .init(hex: "#0a6cd6"), accentLink: .init(hex: "#409cff"), danger: .init(hex: "#ff9c66"),
    gradStart: .init(hex: "#0a84ff"), gradEnd: .init(hex: "#5e5ce6")
  )

  static func preset(_ pref: ThemePref, system: ColorScheme, palette: ArtworkPalette?) -> Tokens {
    switch pref {
    case .system: return system == .dark ? dark : light
    case .light: return light
    case .dark: return dark
    case .midnight: return midnight
    case .artwork: return palette.map(artwork) ?? midnight
    case .oled:
      var t = dark
      t.bg = .black; t.surface = .init(hex: "#0a0a0a"); t.hover = .init(hex: "#151515"); t.text = .init(hex: "#f2f2f2")
      t.text2 = .init(hex: "#a3a3a3"); t.text3 = .init(hex: "#8f8f8f"); t.faint = .init(hex: "#333333")
      t.hairline = .white.opacity(0.12); t.track = .init(hex: "#262626")
      return t
    case .nord:
      return dark.with(bg: "#2e3440", surface: "#3b4252", hover: "#434c5e", text: "#eceff4", body: "#d8dee9", text2: "#c5cddb",
                       text3: "#b2bccd", faint: "#4c566a", track: "#4c566a", accent: "#88c0d0", link: "#9fd0de", fill: "#3d6a80",
                       hairline: Color(red: 236 / 255, green: 239 / 255, blue: 244 / 255).opacity(0.1), danger: "#ffb38a")
    case .sunset:
      return dark.with(bg: "#1c1220", surface: "#2a1a2e", hover: "#35223a", text: "#fbeee6", body: "#ecd6cd", text2: "#d4b8b3",
                       text3: "#c1a3a1", faint: "#4a3050", track: "#3f2945", accent: "#ff9f5a", link: "#ffb27a", fill: "#b3441d",
                       hairline: Color(red: 1, green: 220 / 255, blue: 200 / 255).opacity(0.1), grad: ("#ff9f5a", "#c2467a"))
    case .forest:
      return dark.with(bg: "#0e1612", surface: "#16211b", hover: "#1d2b23", text: "#e8f1ea", body: "#cfdcd2", text2: "#a9bfae",
                       text3: "#96ad9c", faint: "#2f4538", track: "#26382d", accent: "#8fc79a", link: "#a6d5b0", fill: "#2f7d4f",
                       hairline: Color(red: 200 / 255, green: 1, blue: 220 / 255).opacity(0.09), grad: ("#5fa777", "#2f7d4f"))
    case .sakura:
      return light.with(bg: "#fbf3f6", surface: "#ffffff", hover: "#fdf8fa", text: "#2b1f26", body: "#4a3a43", text2: "#6b5560",
                        text3: "#765f6b", faint: "#ead9e1", track: "#efe1e8", accent: "#c2467a", link: "#a8346a", fill: "#b83a72",
                        hairline: Color(red: 80 / 255, green: 30 / 255, blue: 60 / 255).opacity(0.09), grad: ("#e58bb0", "#a995e0"))
    }
  }

  static let midnight = dark.with(bg: "#0b0e14", surface: "#141922", hover: "#1b212d", text: "#eaf0fa", body: "#c9d3e3", text2: "#9eacc2",
                                  text3: "#8d9bb2", faint: "#333c4d", track: "#262e3d", accent: "#5b9dff", link: "#7fb2ff", fill: "#2f6fd6",
                                  hairline: .white.opacity(0.08))

  static func artwork(_ p: ArtworkPalette) -> Tokens {
    dark.with(bg: p.bg, surface: p.surface, hover: p.hover, text: p.text, body: p.textBody, text2: p.text2, text3: p.text3, faint: p.faint,
              track: p.track, accent: p.accent, link: p.accentLink, fill: p.accentFill, hairline: .white.opacity(0.09),
              grad: (p.gradStart, p.gradEnd))
  }

  private func with(bg: String, surface: String, hover: String, text: String, body: String, text2: String, text3: String, faint: String,
                    track: String, accent: String, link: String, fill: String, hairline: Color, danger: String? = nil,
                    grad: (String, String)? = nil) -> Tokens {
    var t = self
    t.bg = .init(hex: bg); t.surface = .init(hex: surface); t.hover = .init(hex: hover); t.text = .init(hex: text)
    t.textBody = .init(hex: body); t.text2 = .init(hex: text2); t.text3 = .init(hex: text3); t.faint = .init(hex: faint)
    t.track = .init(hex: track); t.accent = .init(hex: accent); t.accentLink = .init(hex: link); t.accentFill = .init(hex: fill)
    t.hairline = hairline
    if let danger { t.danger = .init(hex: danger) }
    if let grad { t.gradStart = .init(hex: grad.0); t.gradEnd = .init(hex: grad.1) }
    return t
  }

  var placeholder: LinearGradient { LinearGradient(colors: [gradStart, gradEnd], startPoint: .topLeading, endPoint: .bottomTrailing) }
}

/// Radius tiers, spacing and type sizes from tokens.css / global.css.
enum Metric {
  static let rThumb: CGFloat = 12, rCard: CGFloat = 18, rPanel: CGFloat = 22, rChip: CGFloat = 6
  static let padX: CGFloat = 22
  static let maxRead: CGFloat = 720
  static let rowHeight: CGFloat = 56
}

extension Font {
  /// `.page__title`: 2.25rem / 600 / -0.03em.
  static let pageTitle = Font.system(size: 36, weight: .semibold)
  static let sectionTitle = Font.system(size: 20, weight: .semibold)
  static let panelTitle = Font.system(size: 17, weight: .semibold)
  static let body16 = Font.system(size: 16)
  static let meta = Font.system(size: 14)
  static let hint = Font.system(size: 13)
}

extension Color {
  init(hex: String) {
    let (r, g, b) = ColorMath.hexToRGB(hex)
    self.init(.sRGB, red: r / 255, green: g / 255, blue: b / 255)
  }
}

private struct TokensKey: EnvironmentKey { static let defaultValue = Tokens.light }

extension EnvironmentValues {
  var tokens: Tokens {
    get { self[TokensKey.self] }
    set { self[TokensKey.self] = newValue }
  }
}

/// Applies the chosen theme: colour scheme, accent and the tokens every view reads.
struct ThemeRoot<Content: View>: View {
  @Environment(SettingsStore.self) private var settings
  @Environment(AppModel.self) private var app
  @Environment(PlayerModel.self) private var player
  @Environment(\.colorScheme) private var system
  @ViewBuilder let content: Content

  var body: some View {
    let tokens = Tokens.preset(settings.theme, system: system, palette: app.artworkPalette)
    content
      .environment(\.tokens, tokens)
      .tint(tokens.accent)
      .foregroundStyle(tokens.text)
      .preferredColorScheme(settings.theme == .system ? nil : tokens.scheme)
      // The artwork theme follows the playing cover.
      .task(id: settings.theme == .artwork ? player.current?.coverArt : nil) {
        guard settings.theme == .artwork, let cover = player.current?.coverArt else { return }
        await app.loadPalette(cover: cover)
      }
  }
}
