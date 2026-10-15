import { useState } from 'react'
import { currentEntry } from '../../audio/queue'
import { usePlayback } from '../../state/playback'
import { KaraokeButton, KaraokeIntensity } from '../../ui/KaraokeButton'
import { EmptyState } from '../../ui/State'
import { useExclusiveOverlay } from '../../ui/overlay'
import { Cover, Page } from '../library/components'
import { EffectsButton, EffectsPanel } from '../effects/EffectsPanel'
import LyricsView from '../lyrics/LyricsView'

/** The persistent player owns playback; this view shows the current track with its lyrics as the focus. */
export default function NowPlaying() {
  const track = usePlayback((s) => currentEntry(s.queue)?.track)
  const [fxOpen, setFxOpen] = useState(false)
  useExclusiveOverlay('effects', fxOpen, () => setFxOpen(false))
  if (!track) {
    return (
      <Page title="Now Playing">
        <EmptyState title="Nothing playing" hint="Play a track from your library to see its lyrics here." />
      </Page>
    )
  }
  return (
    <div className="nowplaying">
      <div className="nowplaying__info">
        <div className="nowplaying__art">
          <div className="nowplaying__halo" aria-hidden>
            <Cover id={track.coverArt} size={600} />
          </div>
          <Cover id={track.coverArt} size={600} />
        </div>
        <div className="nowplaying__meta">
          <h1 className="page__title nowplaying__title">{track.title}</h1>
          <p className="nowplaying__artist">{track.artist}</p>
          {track.album && <p className="nowplaying__album">{track.album}</p>}
          <div className="nowplaying__tools">
            <KaraokeButton />
            <EffectsButton open={fxOpen} onClick={() => setFxOpen((o) => !o)} />
          </div>
          <KaraokeIntensity />
        </div>
      </div>
      <div className="nowplaying__lyrics">
        <h2 className="sr-only">
          Lyrics
        </h2>
        {/* Keyed by track so lyrics state never carries over between tracks. */}
        <LyricsView
          key={track.id}
          track={{ id: track.id, title: track.title, artist: track.artist, album: track.album, duration: track.duration, isrc: track.isrc, explicit: track.explicit }}
        />
      </div>
      {fxOpen && <EffectsPanel onClose={() => setFxOpen(false)} />}
    </div>
  )
}
