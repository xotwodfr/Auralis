import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useShallow } from 'zustand/react/shallow'
import { currentEntry, nextIndex } from '../audio/queue'
import { Cover, StarButton } from '../features/library/components'
import { isStarred, useStarred } from '../features/library/starred'
import LyricsView from '../features/lyrics/LyricsView'
import QueuePanel from '../features/queue/QueuePanel'
import { formatDuration } from '../lib/format'
import { usePlayback } from '../state/playback'
import { Icon } from '../ui/Icon'
import { Slider } from '../ui/Slider'
import { TransportControls } from '../ui/TransportControls'
import { tintStyle, useCoverTint } from './parts'

function Seek() {
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
        <span>{formatDuration(duration)}</span>
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
  const closeButton = useRef<HTMLButtonElement>(null)
  const close = () => (history.length > 1 ? navigate(-1) : navigate('/home', { replace: true }))

  useEffect(() => closeButton.current?.focus(), [])
  // The page underneath must not scroll behind the sheet.
  useEffect(() => {
    document.body.classList.add('m-locked')
    return () => document.body.classList.remove('m-locked')
  }, [])

  const playing = s.status === 'playing' || s.status === 'buffering' || (s.status === 'loading' && s.autoplay)
  return (
    <div className="m-player" role="dialog" aria-modal="true" aria-label="Now Playing" style={tintStyle(tint)}>
      <header className="m-player__bar">
        <button ref={closeButton} type="button" className="m-round m-round--plain" aria-label="Close player" onClick={close}>
          <Icon name="down" size={26} />
        </button>
        <p className="m-player__from">
          <span>Playing from</span>
          <strong>{track?.album ?? 'your queue'}</strong>
        </p>
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
          <section className="m-lyrics" aria-labelledby="m-lyrics-title">
            <h2 id="m-lyrics-title" className="m-lyrics__title">
              Lyrics
            </h2>
            <LyricsView
              key={track.id}
              track={{ id: track.id, title: track.title, artist: track.artist, album: track.album, duration: track.duration, isrc: track.isrc, explicit: track.explicit }}
            />
          </section>
        </>
      )}

      {queueOpen && <QueuePanel onClose={() => setQueueOpen(false)} />}
    </div>
  )
}
