import AuralisKit
import SwiftUI

struct CoverArtView: View {
  @Environment(AppModel.self) private var app
  let id: String?
  var size = 300

  var body: some View {
    ZStack {
      Rectangle().fill(.quaternary)
      Image(systemName: "music.note").font(.largeTitle).foregroundStyle(.secondary)
      if let id, let url = app.coverURL(id, size: size) {
        AsyncImage(url: url) { phase in
          if let image = phase.image { image.resizable().scaledToFill() }
        }
      }
    }
    .aspectRatio(1, contentMode: .fit)
    .clipShape(.rect(cornerRadius: 12))
    .accessibilityHidden(true)
  }
}

/// Loading / empty / error for any `Load`; content is only built for a non-empty loaded value.
struct LoadView<Value: Collection, Content: View>: View {
  let state: Load<Value>
  let emptyTitle: String
  let emptySystemImage: String
  let retry: () async -> Void
  @ViewBuilder let content: (Value) -> Content

  var body: some View {
    switch state {
    case .idle, .loading:
      ProgressView("Loading…").frame(maxWidth: .infinity, maxHeight: .infinity)
    case .failed(let message):
      ContentUnavailableView {
        Label("Couldn't load", systemImage: "exclamationmark.triangle")
      } description: {
        Text(message)
      } actions: {
        Button("Try Again") { Task { await retry() } }.buttonStyle(.glass)
      }
    case .loaded(let value):
      if value.isEmpty {
        ContentUnavailableView(emptyTitle, systemImage: emptySystemImage)
      } else {
        content(value)
      }
    }
  }
}

func formatTime(_ seconds: Double) -> String {
  guard seconds.isFinite, seconds >= 0 else { return "0:00" }
  let total = Int(seconds)
  return String(format: "%d:%02d", total / 60, total % 60)
}
