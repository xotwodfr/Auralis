import AuralisKit
import SwiftUI

/// Settings, section for section as in src/features/settings/Settings.tsx.
struct SettingsView: View {
  @Environment(AppModel.self) private var app
  @Environment(SettingsStore.self) private var settings
  @Environment(\.tokens) private var t
  @State private var pending: Pending?

  enum Pending: String, Identifiable {
    case disconnect, credentials, lyrics
    var id: String { rawValue }
    var title: String {
      switch self { case .disconnect: "Disconnect?"; case .credentials: "Clear stored credentials?"; case .lyrics: "Clear cached lyrics?" }
    }
    var message: String {
      switch self {
      case .disconnect: "You will be signed out and any stored credentials removed from this device."
      case .credentials: "You stay connected now, but will need to sign in again next time."
      case .lyrics: "Lyrics and Spotify matches will be looked up again the next time you play each track."
      }
    }
    var label: String {
      switch self { case .disconnect: "Disconnect"; case .credentials: "Clear credentials"; case .lyrics: "Clear cache" }
    }
  }

  var body: some View {
    @Bindable var settings = settings
    Page(title: "Settings", maxWidth: Metric.maxRead) {
      VStack(alignment: .leading, spacing: 18) {
        SettingsPanel("Appearance") {
          ThemePicker()
          if settings.theme == .artwork { Hint("Colours follow the cover of the playing track.") }
        }

        SettingsPanel("Connection") {
          Rows(rows: connectionRows)
          HStack(spacing: 10) {
            if app.remember { Button("Clear stored credentials") { pending = .credentials }.buttonStyle(.pill) }
            Button("Disconnect") { pending = .disconnect }.buttonStyle(.pillPrimary)
          }
          .padding(.top, 18)
        }

        SettingsPanel("Playback") {
          Check("Report plays to your server", isOn: $settings.reportPlays)
          Hint("Tell your own server which track is playing and record it once you have heard half of it. This is what keeps its play counts, “recently played” lists and smart playlists accurate. Nothing is sent anywhere else.")
        }

        SettingsPanel("Lyrics") {
          Check("External lookups", isOn: $settings.externalLookups)
          Hint("When your server has no lyrics, send the track title, artist, album and length to lrclib.net. Turn off to use only your server.")
          LyricsServerForm()
          Rows(rows: [("Spicy Lyrics (word-synced, via the Auralis backend)", spicyStatus.0), ("Automatic Spotify matching", spicyStatus.1)])
          HStack(spacing: 10) {
            Button("Clear cached lyrics") { pending = .lyrics }.buttonStyle(.pill)
            Button("Remove Spotify links") {
              settings.clearLinks()
              app.show("Spotify links removed.")
            }
            .buttonStyle(.pill)
          }
          .padding(.top, 18)
        }

        #if os(macOS)
        SettingsPanel("Keyboard shortcuts") {
          Rows(rows: Shortcut.all.map { ($0.action, $0.keys) }, monospaced: true)
        }
        #endif
      }
    }
    .task(id: "\(settings.lyricsServerEnabled)|\(settings.backendBase)") {
      if settings.lyricsServerEnabled { await app.probeLyricsBackend(settings.backendBase) }
    }
    .alert(pending?.title ?? "", isPresented: Binding(get: { pending != nil }, set: { if !$0 { pending = nil } }), presenting: pending) { p in
      Button(p.label, role: .destructive) { confirm(p) }
      Button("Cancel", role: .cancel) {}
    } message: { p in
      Text(p.message)
    }
  }

  private var connectionRows: [(String, String)] {
    let s = app.server
    return [
      ("Server", app.client?.credentials.baseURL.absoluteString ?? ""),
      ("User", app.client?.credentials.username ?? ""),
      ("Software", [s?.type, s?.serverVersion].compactMap { $0 }.joined(separator: " ").nonEmpty ?? "Unknown"),
      ("API version", s?.apiVersion ?? ""),
      ("OpenSubsonic", s?.openSubsonic == true ? "Yes" : "No"),
      ("Server lyrics", app.songLyrics ? "Supported" : "Not available"),
      ("Credentials stored on this device", app.remember ? "Yes" : "No"),
    ]
  }

  private var spicyStatus: (String, String) {
    guard settings.lyricsServerEnabled else { return ("Off: lyrics server lookup is disabled", "Off") }
    switch app.lyricsBackend {
    case .idle, .loading: return ("Checking…", "Checking…")
    case .failed(let error): return (error.localizedDescription, "Not available")
    case .loaded(let b):
      if !b.enabled { return ("Backend running, but SPICY_LYRICS_SECRET_KEY is not set", "Off: needs Spicy Lyrics first") }
      return ("Ready", b.matching ? "On (Spotify search)" : "Off: SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET are not set; link tracks by hand")
    }
  }

  private func confirm(_ p: Pending) {
    switch p {
    case .disconnect: app.signOut()
    case .credentials:
      app.forgetDevice()
      app.show("Stored credentials cleared.")
    case .lyrics:
      Task {
        await app.lyrics.clearCaches()
        app.show("Cached lyrics cleared.")
      }
    }
  }
}

/// The lyrics server address: validated, testable, saved locally. Holds no secrets: those live on the server.
private struct LyricsServerForm: View {
  @Environment(AppModel.self) private var app
  @Environment(SettingsStore.self) private var settings
  @Environment(\.tokens) private var t
  @State private var draft = ""
  @State private var result: (ok: Bool, text: String)?
  @State private var busy = false

  var body: some View {
    @Bindable var settings = settings
    VStack(alignment: .leading, spacing: 10) {
      Check("Use a lyrics server", isOn: $settings.lyricsServerEnabled)
      Hint("Word-synced lyrics and automatic Spotify matching come from a lyrics server. It receives the title, artist and ISRC of tracks you play, never your music server address or login. Turn off to stay on your server and LRCLIB.")
      VStack(alignment: .leading, spacing: 6) {
        Text("Auralis backend URL").font(.meta).foregroundStyle(t.text2)
        TextField(LyricsServer.defaultURL, text: $draft)
          .textFieldStyle(.roundedBorder)
          .autocorrectionDisabled()
          .onChange(of: draft) { result = nil }
          .onSubmit(save)
      }
      .disabled(!settings.lyricsServerEnabled)
      HStack(spacing: 10) {
        Button("Save", action: save).buttonStyle(.pill)
        Button(busy ? "Testing…" : "Test connection") { Task { await test() } }.buttonStyle(.pill).disabled(busy)
        Button("Reset to default") {
          settings.lyricsServerURL = ""
          draft = LyricsServer.defaultURL
          result = nil
        }
        .buttonStyle(.pill)
      }
      .disabled(!settings.lyricsServerEnabled)
      if let result { Hint(result.text, color: result.ok ? nil : t.danger) }
    }
    .padding(.top, 8)
    .onAppear { draft = settings.lyricsServerURL.isEmpty ? LyricsServer.defaultURL : settings.lyricsServerURL }
  }

  /// An empty field means "use the default".
  private func normalized() -> LyricsServer.Check {
    draft.trimmingCharacters(in: .whitespaces).isEmpty ? .ok(LyricsServer.defaultURL) : LyricsServer.check(draft)
  }

  private func save() {
    switch normalized() {
    case .invalid(let message): result = (false, message)
    case .ok(let url):
      settings.lyricsServerURL = url == LyricsServer.defaultURL ? "" : url
      draft = url
      result = (true, "Saved on this device.")
    }
  }

  private func test() async {
    guard case .ok(let url) = normalized() else {
      if case .invalid(let message) = normalized() { result = (false, message) }
      return
    }
    busy = true
    result = nil
    do {
      let b = try await app.lyrics.probe(url)
      result = (true, !b.enabled ? "Connected, but the server has no Spicy Lyrics key configured."
        : b.matching ? "Connected. Word-synced lyrics and automatic Spotify matching are available."
        : "Connected. Word-synced lyrics are available; automatic Spotify matching is not configured on that server.")
    } catch {
      result = (false, (error as? ServerCheckError)?.message ?? "The check failed.")
    }
    busy = false
  }
}

/// Theme cards, each previewing the theme with its own tokens.
private struct ThemePicker: View {
  @Environment(SettingsStore.self) private var settings
  @Environment(AppModel.self) private var app
  @Environment(\.tokens) private var t

  var body: some View {
    LazyVGrid(columns: [GridItem(.adaptive(minimum: 120), spacing: 12)], spacing: 12) {
      ForEach(ThemePref.allCases) { pref in
        let selected = settings.theme == pref
        Button { settings.theme = pref } label: {
          VStack(alignment: .leading, spacing: 8) {
            if pref == .system {
              HStack(spacing: 0) { Swatch(tokens: .light); Swatch(tokens: .dark) }.clipShape(.rect(cornerRadius: 8))
            } else {
              Swatch(tokens: .preset(pref, system: .light, palette: app.artworkPalette)).clipShape(.rect(cornerRadius: 8))
            }
            VStack(alignment: .leading, spacing: 0) {
              Text(pref.label).font(.meta.weight(.semibold))
              Text(pref.caption).font(.hint).foregroundStyle(t.text2)
            }
          }
          .padding(8)
          .background(t.surface, in: .rect(cornerRadius: Metric.rThumb + 2))
          .overlay(RoundedRectangle(cornerRadius: Metric.rThumb + 2).strokeBorder(selected ? t.accent : t.hairline, lineWidth: selected ? 2 : 1))
          .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(pref.label) theme")
        .accessibilityAddTraits(selected ? .isSelected : [])
      }
    }
    .padding(.top, 14)
  }
}

/// A mini window painted by a theme's own tokens.
private struct Swatch: View {
  let tokens: Tokens
  var body: some View {
    HStack(spacing: 0) {
      Rectangle().fill(tokens.surface).frame(width: 18)
      VStack(alignment: .leading, spacing: 6) {
        Capsule().fill(tokens.text.opacity(0.8)).frame(width: 34, height: 5)
        Capsule().fill(tokens.text2.opacity(0.6)).frame(width: 24, height: 4)
        Spacer()
        Circle().fill(tokens.accent).frame(width: 10, height: 10)
      }
      .padding(8)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(tokens.bg)
    }
    .frame(height: 56)
  }
}

private struct SettingsPanel<Content: View>: View {
  let title: String
  let content: Content
  init(_ title: String, @ViewBuilder content: () -> Content) { self.title = title; self.content = content() }
  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text(title).font(.panelTitle).accessibilityAddTraits(.isHeader).padding(.bottom, 6)
      content
    }
    .panel()
  }
}

/// `dl.rows`: label left, value right, hairline between.
private struct Rows: View {
  @Environment(\.tokens) private var t
  let rows: [(String, String)]
  var monospaced = false
  var body: some View {
    VStack(spacing: 0) {
      ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
        HStack(alignment: .firstTextBaseline, spacing: 16) {
          Text(row.0).foregroundStyle(t.text2)
          Spacer(minLength: 8)
          Text(row.1).font(monospaced ? .body16.monospaced() : .body16.monospacedDigit()).multilineTextAlignment(.trailing).textSelection(.enabled)
        }
        .padding(.vertical, 12)
        .overlay(alignment: .bottom) { Rectangle().fill(t.hairline).frame(height: 1) }
      }
    }
  }
}

private struct Check: View {
  let label: String
  @Binding var isOn: Bool
  init(_ label: String, isOn: Binding<Bool>) { self.label = label; _isOn = isOn }
  var body: some View {
    Toggle(label, isOn: $isOn)
      #if os(macOS)
      .toggleStyle(.checkbox)
      #endif
      .font(.body16)
      .frame(minHeight: 44, alignment: .leading)
  }
}

/// `.hint`.
struct Hint: View {
  @Environment(\.tokens) private var t
  let text: String
  var color: Color?
  init(_ text: String, color: Color? = nil) { self.text = text; self.color = color }
  var body: some View {
    Text(text).font(.hint).foregroundStyle(color ?? t.text3).fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading)
  }
}

/// Single source for the macOS key handling and the reference shown in Settings.
struct Shortcut {
  let keys: String
  let action: String

  static let all = [
    Shortcut(keys: "Space", action: "Play / pause"),
    Shortcut(keys: "← / →", action: "Seek back / forward 5 seconds"),
    Shortcut(keys: "↑ / ↓", action: "Volume up / down"),
    Shortcut(keys: "N / P", action: "Next / previous track"),
    Shortcut(keys: "/ or ⌘F", action: "Focus search"),
    Shortcut(keys: "⌘,", action: "Settings"),
    Shortcut(keys: "Esc", action: "Close the queue or a dialog"),
  ]
}

private extension String {
  var nonEmpty: String? { isEmpty ? nil : self }
}
