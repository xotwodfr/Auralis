import AuralisKit
import SwiftUI

// Port of src/features/lyrics (useLyrics.ts, LyricsView.tsx): the track's Spotify identity first (a link the user
// made, else an automatic match), then Spicy Lyrics for that id, falling back to the server and LRCLIB.

struct LyricsView: View {
  @Environment(AppModel.self) private var app
  @Environment(SettingsStore.self) private var settings
  @Environment(\.tokens) private var t
  let song: Song

  enum Phase { case loading(String), loaded(Lyrics?), failed(Error) }
  @State private var phase = Phase.loading("Loading lyrics…")
  @State private var resolution: SpotifyOutcome?
  @State private var spotifyID: String?
  @State private var refreshes = 0

  private var track: LyricsTrack { LyricsTrack(song) }
  private var linkKey: String? { app.client.map { SettingsStore.linkKey($0.credentials, trackID: song.id) } }
  private var linked: String? { linkKey.flatMap { settings.spotifyLinks[$0] } }
  private var serverOn: Bool { settings.lyricsServerEnabled }
  private var backendMissing: Bool {
    if case .failed = app.lyricsBackend { return settings.externalLookups && serverOn }
    return false
  }

  /// Everything the result depends on: a change to any of it looks again.
  private var key: String {
    [song.id, "\(settings.externalLookups)", "\(serverOn)", settings.backendBase, linked ?? "", "\(refreshes)",
     app.lyricsBackend.value.map { "\($0.matching)" } ?? "?"].joined(separator: "|")
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      content.frame(maxWidth: .infinity, maxHeight: .infinity)
      SpotifyPanel(song: song, resolution: resolution, spotifyID: spotifyID, phase: phase, backendMissing: backendMissing)
    }
    .task(id: key) { await load() }
  }

  @ViewBuilder private var content: some View {
    switch phase {
    case .loading(let label):
      VStack(alignment: .leading, spacing: 18) {
        ForEach([0.72, 0.54, 0.86, 0.4, 0.64], id: \.self) { w in
          GeometryReader { g in RoundedRectangle(cornerRadius: 8).fill(t.track).frame(width: g.size.width * w) }.frame(height: 28)
        }
      }
      .frame(maxHeight: .infinity)
      .accessibilityElement()
      .accessibilityLabel(label)
    case .failed(let error):
      ErrorState(message: (error as? LyricsError)?.errorDescription ?? "Couldn't load lyrics.") { refresh() }
    case .loaded(nil):
      VStack {
        EmptyState(title: "No lyrics found", hint: settings.externalLookups
          ? "Neither your server nor LRCLIB has lyrics for this track."
          : "Your server has no lyrics for this track. External lookups are off in Settings.")
        Button("Look again") { refresh() }.buttonStyle(.pill)
      }
    case .loaded(let lyrics?):
      if lyrics.instrumental {
        EmptyState(title: "Instrumental", hint: "This track has no lyrics.")
      } else if lyrics.synced {
        SyncedLyrics(lines: lyrics.lines) { source(lyrics) }
      } else {
        VStack(alignment: .leading, spacing: 12) {
          ScrollView {
            VStack(alignment: .leading, spacing: 0) {
              ForEach(Array(lyrics.lines.enumerated()), id: \.offset) { _, line in
                Text(line.text.isEmpty ? " " : line.text).font(.system(size: 20, weight: .semibold)).lineSpacing(12)
                  .frame(maxWidth: 520, alignment: .leading)
              }
            }
            .padding(.vertical, 32)
            .textSelection(.enabled)
          }
          source(lyrics)
        }
      }
    }
  }

  /// The provider name is always shown; community syncs also credit and link uploader and maker (API terms §6).
  @ViewBuilder private func source(_ lyrics: Lyrics) -> some View {
    HStack(spacing: 0) {
      if lyrics.source == .spicy, let a = lyrics.attribution {
        Text("Lyrics from \(a.provider) (via Spicy Lyrics)")
        ForEach(a.credits, id: \.role) { c in
          Text(" · \(c.role.rawValue): ")
          if let url = c.url { Link(c.name, destination: url).foregroundStyle(t.accentLink) } else { Text(c.name) }
        }
      } else {
        Text("Lyrics from \(lyrics.source == .server ? "your server" : "LRCLIB")")
      }
      Text(" · ")
      Button("Refresh") { refresh() }.buttonStyle(.plain).foregroundStyle(t.accentLink)
    }
    .font(.hint)
    .foregroundStyle(t.text3)
  }

  private func refresh() {
    Task {
      if let request = request(spotifyID: spotifyID) { await app.lyrics.forget(request) }
      refreshes += 1
    }
  }

  private func request(spotifyID: String?) -> LyricsRequest? {
    app.client.map {
      LyricsRequest(track: track, client: $0, songLyrics: app.songLyrics, external: settings.externalLookups, spotifyID: spotifyID,
                    backendBase: settings.backendBase)
    }
  }

  private func load() async {
    guard let client = app.client else { return }
    let external = settings.externalLookups
    // Settle the identity before fetching, so the preferred source isn't skipped and lyrics don't swap mid-song.
    if external && serverOn && linked == nil {
      phase = .loading("Finding this recording…")
      await app.probeLyricsBackend(settings.backendBase)
    }
    var autoID: String?
    resolution = nil
    if external, serverOn, linked == nil, app.lyricsBackend.value?.matching == true {
      guard let outcome = try? await app.lyrics.spotifyMatch(track, credentials: client.credentials, backendBase: settings.backendBase) else {
        return // cancelled: a newer lookup is running
      }
      resolution = outcome
      if case .resolved(.matched(let c, _)) = outcome { autoID = c.id }
    }
    let id = external && serverOn ? (linked.map { $0 == SpotifyLink.none ? nil : $0 } ?? autoID) : nil
    spotifyID = id
    phase = .loading("Loading lyrics…")
    guard let request = request(spotifyID: id) else { return }
    do {
      phase = .loaded(try await app.lyrics.lyrics(for: request))
    } catch is CancellationError {
    } catch {
      if !Task.isCancelled { phase = .failed(error) }
    }
  }
}

// MARK: Synced lines

/// Synced lyrics driven by the audio clock: the active line follows playback at 32% from the top; word-synced lines
/// sweep syllable by syllable. A manual scroll stops following until "Back to current line".
private struct SyncedLyrics<Footer: View>: View {
  @Environment(PlayerModel.self) private var player
  @Environment(\.tokens) private var t
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let lines: [LyricLine]
  @ViewBuilder let footer: Footer
  @State private var follow = true
  @State private var active = -1

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      ScrollViewReader { proxy in
        ScrollView {
          TimelineView(.animation(paused: !player.isPlaying)) { _ in
            let time = player.playbackTime
            let now = LRC.activeLine(lines, at: time)
            LazyVStack(alignment: .leading, spacing: 0) {
              ForEach(Array(lines.enumerated()), id: \.offset) { i, line in
                LyricLineView(line: line, state: i == now ? .active : i < now ? .past : .next, time: i == now ? time : nil) {
                  if let time = line.time { player.seek(to: time) }
                  follow = true
                }
                .id(i)
              }
            }
            .padding(.vertical, 120)
            .onChange(of: now, initial: true) { _, new in active = new }
          }
        }
        .mask(LinearGradient(stops: [.init(color: .clear, location: 0), .init(color: .black, location: 0.09),
                                     .init(color: .black, location: 0.8), .init(color: .clear, location: 1)],
                             startPoint: .top, endPoint: .bottom))
        .onScrollPhaseChange { _, phase in if phase == .interacting { follow = false } }
        .onChange(of: active) { _, new in scroll(proxy, to: new) }
        .onChange(of: follow) { _, on in if on { scroll(proxy, to: active) } }
        .onAppear { scroll(proxy, to: active, animated: false) }
        .overlay(alignment: .bottom) {
          if !follow && active >= 0 {
            Button("Back to current line") { follow = true }
              .buttonStyle(.glass)
              .controlSize(.large)
              .padding(.bottom, 24)
              .transition(.opacity.combined(with: .scale(scale: 0.96)))
          }
        }
      }
      HStack {
        footer
        Spacer()
        Toggle("Follow playback", isOn: $follow).toggleStyle(.button).buttonStyle(.bordered).controlSize(.small)
          .foregroundStyle(follow ? t.accentLink : t.text2)
      }
    }
  }

  private func scroll(_ proxy: ScrollViewProxy, to index: Int, animated: Bool = true) {
    guard follow, index >= 0 else { return }
    if animated && !reduceMotion {
      withAnimation(.timingCurve(0.25, 1, 0.5, 1, duration: 0.7)) { proxy.scrollTo(index, anchor: UnitPoint(x: 0.5, y: 0.32)) }
    } else {
      proxy.scrollTo(index, anchor: UnitPoint(x: 0.5, y: 0.32))
    }
  }
}

private struct LyricLineView: View {
  enum LineState { case past, active, next }
  @Environment(\.tokens) private var t
  let line: LyricLine
  let state: LineState
  /// Only the active line gets the clock, so the others don't re-render every frame.
  let time: Double?
  let seek: () -> Void
  @State private var hover = false

  private var dim: Double { t.scheme == .dark ? 0.4 : 0.5 }
  private var unsung: Double { t.scheme == .dark ? 0.6 : 0.64 }

  var body: some View {
    if line.text.isEmpty {
      // An instrumental gap: a quiet marker while it is "sung", nothing otherwise.
      Text("• • •").font(.system(size: 20)).kerning(4).foregroundStyle(t.text2).opacity(state == .active ? 1 : 0)
        .frame(height: 24).padding(.horizontal, 12).accessibilityHidden(true)
    } else {
      Button(action: seek) {
        VStack(alignment: line.opposite ? .trailing : .leading, spacing: 4) {
          words(line.words, fallback: line.text, size: 30, weight: .bold)
          ForEach(Array(line.background.enumerated()), id: \.offset) { _, b in
            words(b.words, fallback: b.text, size: 19, weight: .semibold)
          }
        }
        .multilineTextAlignment(line.opposite ? .trailing : .leading)
        .frame(maxWidth: .infinity, alignment: line.opposite ? .trailing : .leading)
        .padding(.vertical, 9).padding(.horizontal, 12)
        .background(t.text.opacity(hover ? 0.05 : 0), in: .rect(cornerRadius: Metric.rThumb))
        .contentShape(.rect)
      }
      .buttonStyle(.plain)
      .opacity(state == .active ? 1 : dim)
      .animation(.easeOut(duration: 0.5), value: state)
      .onHover { hover = $0 }
      .accessibilityLabel(line.text)
      .accessibilityAddTraits(state == .active ? .isSelected : [])
    }
  }

  /// Word-synced text: each syllable brightens from "unsung" to full as it is sung.
  private func words(_ words: [LyricWord]?, fallback: String, size: CGFloat, weight: Font.Weight) -> Text {
    let font = Font.system(size: size, weight: weight)
    guard let words, let time else { return Text(fallback).font(font).kerning(-0.022 * size) }
    var out = Text("")
    for (i, w) in words.enumerated() {
      let p = w.end > w.start ? min(1, max(0, (time - w.start) / (w.end - w.start))) : (time >= w.end ? 1 : 0)
      out = out + Text(w.text).foregroundStyle(t.text.opacity(unsung + (1 - unsung) * p))
      if !w.joinNext && i < words.count - 1 { out = out + Text(" ") }
    }
    return out.font(font).kerning(-0.022 * size)
  }
}

// MARK: Spotify identity

/// The track's Spotify identity, which Spicy Lyrics is addressed by: what was matched (or why not), a chooser when
/// several recordings fit, and a manual link that always wins.
private struct SpotifyPanel: View {
  @Environment(AppModel.self) private var app
  @Environment(SettingsStore.self) private var settings
  @Environment(\.tokens) private var t
  let song: Song
  let resolution: SpotifyOutcome?
  let spotifyID: String?
  let phase: LyricsView.Phase
  let backendMissing: Bool
  @State private var text = ""
  @State private var invalid = false
  @State private var expanded = false

  private var key: String? { app.client.map { SettingsStore.linkKey($0.credentials, trackID: song.id) } }
  private var linked: String? { key.flatMap { settings.spotifyLinks[$0] } }
  private var off: Bool { linked == SpotifyLink.none }
  private var matching: Bool { app.lyricsBackend.value?.matching == true }
  private var candidates: [SpotifyCandidate] {
    if linked == nil, case .resolved(.ambiguous(let c)) = resolution { return c }
    return []
  }
  private var matched: SpotifyCandidate? {
    if linked == nil, case .resolved(.matched(let c, _)) = resolution { return c }
    return nil
  }

  private var status: String {
    if off { return " · off for this track" }
    if linked != nil { return " · linked" }
    if backendMissing { return " · no lyrics backend, so no automatic Spotify match" }
    switch resolution {
    case .unavailable?: return " · Spotify lookup failed, try Refresh"
    case .resolved(.matched)?: return " · matched automatically"
    case .resolved(.ambiguous)?: return " · choose a recording"
    case .resolved(.none)?: return " · no Spotify match"
    case nil: return ""
    }
  }

  private var noSpicy: Bool {
    if spotifyID != nil, case .loaded(let l) = phase, l?.source != .spicy { return true }
    return false
  }

  var body: some View {
    DisclosureGroup(isExpanded: Binding(get: { expanded || !candidates.isEmpty }, set: { expanded = $0 })) {
      VStack(alignment: .leading, spacing: 12) {
        if let m = matched {
          Text("Matched automatically to “\(m.name)” by \(m.artists.joined(separator: ", ")) (\(describe(m))).").font(.hint).foregroundStyle(t.text3)
        }
        if !candidates.isEmpty {
          Text("Which recording is this?").font(.body16.weight(.semibold))
          Text("Several Spotify recordings fit this track. Pick the one you are playing, so the word timing matches.").font(.hint).foregroundStyle(t.text3)
          ForEach(candidates, id: \.id) { c in
            Button { link(c.id) } label: {
              VStack(alignment: .leading, spacing: 2) {
                Text("\(c.name) — \(c.artists.joined(separator: ", "))").font(.body16.weight(.semibold))
                Text(describe(c)).font(.meta).foregroundStyle(t.text2)
              }
              .padding(.horizontal, 14).padding(.vertical, 8)
              .frame(maxWidth: .infinity, alignment: .leading)
              .background(t.surface, in: .rect(cornerRadius: Metric.rThumb))
              .overlay(RoundedRectangle(cornerRadius: Metric.rThumb).strokeBorder(t.hairline))
            }
            .buttonStyle(.plain)
          }
          Button("None of these") { link(SpotifyLink.none) }.buttonStyle(.pill)
        }
        Text((matching ? "Tracks are matched to Spotify automatically. To correct a match, paste" : "Paste")
          + " this track’s Spotify link (or its 22-character id). It is saved on this device and sent, with no other track details, to your Auralis server, which asks Spicy Lyrics."
          + (settings.externalLookups ? "" : " Turn on External lookups in Settings to use it."))
          .font(.hint).foregroundStyle(t.text3).fixedSize(horizontal: false, vertical: true)
        VStack(alignment: .leading, spacing: 6) {
          Text("Spotify track link").font(.meta).foregroundStyle(t.text2)
          TextField("https://open.spotify.com/track/…", text: $text).textFieldStyle(.roundedBorder).autocorrectionDisabled()
            .onSubmit(submit)
        }
        if invalid { Text("That isn’t a Spotify track link or id.").font(.meta).foregroundStyle(t.danger) }
        HStack(spacing: 10) {
          Button(linked != nil && !off ? "Replace link" : "Link track", action: submit).buttonStyle(.pill)
            .disabled(text.trimmingCharacters(in: .whitespaces).isEmpty)
          if linked != nil, let key {
            Button(off ? (matching ? "Match automatically again" : "Use Spicy Lyrics again") : "Remove link") { settings.unlink(key) }.buttonStyle(.pill)
          }
          if matched != nil { Button("Wrong recording") { link(SpotifyLink.none) }.buttonStyle(.pill) }
        }
      }
      .padding(.top, 10)
    } label: {
      Text("Word-synced lyrics (Spicy Lyrics)\(status)\(noSpicy ? " · none for this recording" : "")").font(.meta).foregroundStyle(t.text2)
    }
  }

  private func describe(_ c: SpotifyCandidate) -> String {
    [c.album, formatTime(c.durationMs / 1000), c.explicit ? "Explicit" : nil].compactMap { $0 }.joined(separator: " · ")
  }

  private func link(_ id: String) { if let key { settings.link(key, to: id) } }

  private func submit() {
    let id = SpotifyLink.parseTrackID(text)
    invalid = id == nil
    if let id { link(id); text = "" }
  }
}
