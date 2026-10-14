import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { useShallow } from 'zustand/react/shallow'
import { currentEntry, nextIndex } from '../audio/queue'
import { Cover, StarButton } from '../features/library/components'
import { TrackActions } from '../features/library/TrackActions'
import { isStarred, useStarred } from '../features/library/starred'
import LyricsView from '../features/lyrics/LyricsView'
import QueuePanel from '../features/queue/QueuePanel'
import { formatDuration } from '../lib/format'
import { usePlayback } from '../state/playback'
import { Icon } from '../ui/Icon'
import { KaraokeButton, KaraokeIntensity } from '../ui/KaraokeButton'
import { Slider } from '../ui/Slider'
import { TransportControls } from '../ui/TransportControls'
import { Backdrop, tintStyle, useCoverTint } from './parts'

/** `remaining`: show the time left as -m:ss on the right, like Apple Music. */
function Seek({ remaining = false }: { remaining?: boolean }) {
  const position = usePlayback((s) => s.position)
  const duration = usePlayback((s) => s.duration)
  const seek = usePlayback((s) => s.seek)
  return (
    <div className="m-seek">
      <Slider
        label="Seek"
        value={Math.min(position, duration)}
        max={duration}
        disabled={!duration}
        valueText={`${formatDuration(position)} of ${formatDuration(duration)}`}
        onCommit={seek}
      />
      <div className="m-seek__times">
        <span>{formatDuration(position)}</span>
        <span>{remaining ? `-${formatDuration(Math.max(0, duration - position))}` : formatDuration(duration)}</span>
      </div>
    </div>
  )
}

/** Full-screen Now Playing, opened over the current page (MobileApp renders it as a modal route). */
export default function Player() {
  const navigate = useNavigate()
  const s = usePlayback(
    useShallow(({ queue, status, autoplay, error, togglePlay, previous, next, setShuffle, cycleRepeat, retry }) => ({
      queue, status, autoplay, error, togglePlay, previous, next, setShuffle, cycleRepeat, retry,
    })),
  )
  const track = currentEntry(s.queue)?.track
  const ids = useStarred()
  const tint = useCoverTint(track?.coverArt, 30)
  const [queueOpen, setQueueOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const closeButton = useRef<HTMLButtonElement>(null)
  // The mini-player's lyrics button opens straight into the fullscreen lyrics.
  const [lyricsOpen, setLyricsOpen] = useState((useLocation().state as { lyrics?: boolean } | null)?.lyrics === true)
  const close = () => (history.length > 1 ? navigate(-1) : navigate('/home', { replace: true }))

  useEffect(() => {
    closeButton.current?.focus()
  }, [])
  // The page underneath must not scroll behind the sheet.
  useEffect(() => {
    document.body.classList.add('m-locked')
    return () => document.body.classList.remove('m-locked')
  }, [])

  const playing = s.status === 'playing' || s.status === 'buffering' || (s.status === 'loading' && s.autoplay)
  const transport = (
    <TransportControls
      playing={playing}
      busy={s.status === 'loading' || s.status === 'buffering'}
      canPrev={s.queue.items.length > 0}
      canNext={nextIndex(s.queue, true) !== null}
      shuffle={s.queue.shuffle}
      repeat={s.queue.repeat}
      onToggle={s.togglePlay}
      onPrev={s.previous}
      onNext={s.next}
      onShuffle={() => s.setShuffle(!s.queue.shuffle)}
      onRepeat={s.cycleRepeat}
    />
  )
  return (
    <div className="m-player" role="dialog" aria-modal="true" aria-label="Now Playing" style={tintStyle(tint)}>
      <Backdrop />
      <header className="m-player__bar">
        <button ref={closeButton} type="button" className="m-round m-round--plain" aria-label="Close player" onClick={close}>
          <Icon name="down" size={26} />
        </button>
        <p className="m-player__from">
          <span>Playing from</span>
          <strong>{track?.album ?? 'your queue'}</strong>
        </p>
        <KaraokeButton className="m-round m-round--plain" size={24} />
        <button type="button" className="m-round m-round--plain" aria-label="Lyrics" onClick={() => setLyricsOpen(true)}>
          <Icon name="lyrics" size={24} />
        </button>
        <button type="button" className="m-round m-round--plain" aria-label="Queue" aria-expanded={queueOpen} onClick={() => setQueueOpen(true)}>
          <Icon name="queue" size={24} />
        </button>
      </header>

      {!track ? (
        <p className="m-player__empty">Nothing playing. Pick something from your library.</p>
      ) : (
        <>
          <div className="m-player__art">
            <Cover id={track.coverArt} size={800} />
          </div>
          <div className="m-player__meta">
            <div className="m-text">
              <h1 className="m-player__title">{track.title}</h1>
              {track.artistId ? (
                <Link className="m-player__artist" to={`/library/artists/${encodeURIComponent(track.artistId)}`} replace>
                  {track.artist}
                </Link>
              ) : (
                <p className="m-player__artist">{track.artist}</p>
              )}
            </div>
            <StarButton target={{ kind: 'song', item: track }} name={track.title} starred={isStarred(ids, 'song', track.id)} />
          </div>
          <Seek />
          {transport}
          <KaraokeIntensity />
          {s.error && (
            <p className="m-player__error" role="alert">
              {s.error.message}{' '}
              {s.error.kind !== 'auth' && (
                <button type="button" className="link-btn" onClick={s.retry}>
                  Retry
                </button>
              )}
            </p>
          )}
          {!lyricsOpen && (
          <section className="m-lyrics" aria-labelledby="m-lyrics-title">
            <h2 id="m-lyrics-title" className="m-lyrics__title">
              Lyrics
              <button type="button" className="m-lyrics__expand" aria-label="Fullscreen lyrics" onClick={() => setLyricsOpen(true)}>
                <Icon name="expand" size={20} />
              </button>
            </h2>
            <LyricsView
              key={track.id}
              track={{ id: track.id, title: track.title, artist: track.artist, album: track.album, duration: track.duration, isrc: track.isrc, explicit: track.explicit }}
            />
          </section>
          )}
        </>
      )}

      {lyricsOpen && track && (
        <div className="m-lyricsfull" role="dialog" aria-modal="true" aria-label="Lyrics">
          <Backdrop />
          <header className="m-lyricsfull__bar">
            <button type="button" className="m-round" aria-label="Close lyrics" autoFocus onClick={() => setLyricsOpen(false)}>
              <Icon name="down" size={26} />
            </button>
            <p className="m-lyricsfull__album">{track.album}</p>
            <button type="button" className="m-round" aria-label={`More actions for ${track.title}`} onClick={() => setMenuOpen(true)}>
              <Icon name="more" size={22} />
            </button>
          </header>
          <div className="m-lyricsfull__track">
            <span className="m-thumb">
              <Cover id={track.coverArt} size={128} />
            </span>
            <div className="m-text">
              <p className="m-text__title">{track.title}</p>
              <p className="m-text__sub">{track.artist}</p>
            </div>
            <StarButton target={{ kind: 'song', item: track }} name={track.title} starred={isStarred(ids, 'song', track.id)} />
          </div>
          <div className="m-lyricsfull__body">
            <LyricsView
              key={track.id}
              track={{ id: track.id, title: track.title, artist: track.artist, album: track.album, duration: track.duration, isrc: track.isrc, explicit: track.explicit }}
            />
            <KaraokeButton className="m-round m-round--glass" size={22} />
          </div>
          <footer className="m-lyricsfull__foot">
            <KaraokeIntensity />
            <Seek remaining />
            {transport}
            <div className="m-lyricsfull__tabs">
              <button type="button" className="icon-btn" aria-label="Hide lyrics" aria-pressed onClick={() => setLyricsOpen(false)}>
                <Icon name="lyrics" size={24} />
              </button>
              <button type="button" className="icon-btn" aria-label="Queue" onClick={() => setQueueOpen(true)}>
                <Icon name="queue" size={24} />
              </button>
            </div>
          </footer>
        </div>
      )}

      {menuOpen && track && (
        <TrackActions song={track} index={s.queue.index} starred={isStarred(ids, 'song', track.id)} onClose={() => setMenuOpen(false)} />
      )}

      {queueOpen && <QueuePanel onClose={() => setQueueOpen(false)} />}
    </div>
  )
}
