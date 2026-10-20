import AuralisKit
import SwiftUI

/// The focal view (src/features/nowplaying): the cover with its soft halo and the track on one side, lyrics on the other.
/// The persistent player owns playback, so there are no controls here.
struct NowPlayingView: View {
  @Environment(PlayerModel.self) private var player
  @Environment(\.tokens) private var t

  var body: some View {
    Group {
      if let song = player.current {
        GeometryReader { g in
          let wide = g.size.width > 720
          let layout = wide ? AnyLayout(HStackLayout(alignment: .center, spacing: min(96, max(28, g.size.width * 0.05))))
            : AnyLayout(VStackLayout(spacing: 28))
          layout {
            TrackInfo(song: song, artSide: min(440, g.size.height * 0.44, wide ? g.size.width * 0.33 : g.size.width))
              .frame(maxWidth: wide ? g.size.width * 4 / 11 : .infinity)
            // Keyed by track so lyrics state never carries over between tracks.
            LyricsView(song: song).id(song.id)
              .frame(maxWidth: .infinity, maxHeight: wide ? .infinity : max(360, g.size.height * 0.6))
          }
          .frame(maxWidth: 1320, maxHeight: .infinity)
          .frame(maxWidth: .infinity)
        }
        .padding(.horizontal, Metric.padX)
        .padding(.vertical, 24)
      } else {
        Page(title: "Now Playing") {
          EmptyState(title: "Nothing playing", hint: "Play a track from your library to see its lyrics here.")
        }
      }
    }
    .background(t.bg)
    .navigationTitle("Now Playing")
  }
}

private struct TrackInfo: View {
  @Environment(\.tokens) private var t
  let song: Song
  let artSide: CGFloat

  var body: some View {
    VStack(spacing: 4) {
      ZStack {
        // The cover's own colours as a soft glow behind it.
        CoverArtView(id: song.coverArt, size: 600, radius: Metric.rCard)
          .padding(artSide * 0.08)
          .blur(radius: 44)
          .saturation(1.4)
          .opacity(0.38)
          .scaleEffect(1.06)
          .offset(y: artSide * 0.08)
          .accessibilityHidden(true)
        CoverArtView(id: song.coverArt, size: 600, radius: Metric.rCard)
          .shadow(color: .black.opacity(t.scheme == .dark ? 0.35 : 0.05), radius: 20, y: 14)
      }
      .frame(width: artSide, height: artSide)
      .padding(.bottom, 18)
      Text(song.title).font(.system(size: 28, weight: .semibold)).kerning(-0.84).multilineTextAlignment(.center).lineLimit(3)
        .accessibilityAddTraits(.isHeader)
      Text(song.artist).font(.system(size: 17, weight: .medium)).foregroundStyle(t.text2)
      if !song.album.isEmpty { Text(song.album).font(.system(size: 15)).foregroundStyle(t.text3) }
    }
    .multilineTextAlignment(.center)
  }
}
