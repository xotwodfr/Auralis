import { useRef, useState } from 'react'
import { NavLink } from 'react-router'
import { useShallow } from 'zustand/react/shallow'
import { nextIndex, currentEntry } from '../../audio/queue'
import { formatDuration } from '../../lib/format'
import { usePlayback } from '../../state/playback'
import { Icon } from '../../ui/Icon'
import { Slider } from '../../ui/Slider'
import { TransportControls } from '../../ui/TransportControls'
import { Cover } from '../library/components'
import QueuePanel from '../queue/QueuePanel'

/** Re-renders on every playhead tick, so it is kept separate from the rest of the bar. */
function Progress() {
  const position = usePlayback((s) => s.position)
  const duration = usePlayback((s) => s.duration)
  const hasTrack = usePlayback((s) => currentEntry(s.queue) !== undefined)
  const seek = usePlayback((s) => s.seek)
  return (
    <div className="progress">
      <span className="progress__time">{formatDuration(position)}</span>
      <Slider
        label="Seek"
        value={Math.min(position, duration)}
        max={duration}
        disabled={!hasTrack || !duration}
        valueText={`${formatDuration(position)} of ${formatDuration(duration)}`}
        onCommit={seek}
      />
      <span className="progress__time">{formatDuration(duration)}</span>
    </div>
  )
}

function Volume() {
  const volume = usePlayback((s) => s.volume)
  const setVolume = usePlayback((s) => s.setVolume)
  return (
    <div className="volume">
      <Icon name="volume" size={20} />
      <Slider label="Volume" value={volume} max={1} step={0.01} live valueText={`${Math.round(volume * 100)}%`} onCommit={setVolume} />
    </div>
  )
}

export default function PlayerBar() {
  // Everything except position/duration, so playhead ticks only re-render <Progress>.
  const s = usePlayback(
    useShallow(({ queue, status, autoplay, error, togglePlay, previous, next, setShuffle, cycleRepeat, retry }) => ({
      queue, status, autoplay, error, togglePlay, previous, next, setShuffle, cycleRepeat, retry,
    })),
  )
  const [queueOpen, setQueueOpen] = useState(false)
  const queueButton = useRef<HTMLButtonElement>(null)

  const entry = currentEntry(s.queue)
  const track = entry?.track
  const playing = s.status === 'playing' || s.status === 'buffering' || (s.status === 'loading' && s.autoplay)
  const status = s.error ? null : s.status === 'loading' ? 'Loading…' : s.status === 'buffering' ? 'Buffering…' : null

  return (
    <section className="player glass-nav" aria-label="Player">
      <div className="player__track">
        <div className="player__art">
          <Cover id={track?.coverArt} size={112} />
        </div>
        <div className="player__meta">
          <span className="player__title">{track?.title ?? 'Nothing playing'}</span>
          <span className="player__artist">{track ? [track.artist, track.album].filter(Boolean).join(' · ') : 'Pick something from your library.'}</span>
          <span className="player__status" role="status">
            {status}
          </span>
        </div>
      </div>

      <div className="player__center">
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
        <Progress />
        {s.error && (
          <p className="player__error" role="alert">
            {s.error.message}{' '}
            {s.error.kind !== 'auth' && (
              <button type="button" className="link-btn" onClick={s.retry}>
                Retry
              </button>
            )}
          </p>
        )}
      </div>

      <div className="player__right">
        <Volume />
        <NavLink to="/now-playing" className="icon-btn" aria-label="Lyrics" title="Now Playing and lyrics">
          <Icon name="lyrics" />
        </NavLink>
        <button ref={queueButton} type="button" className="icon-btn" aria-label="Queue" title="Queue" aria-expanded={queueOpen} aria-controls="queue-panel" onClick={() => setQueueOpen((o) => !o)}>
          <Icon name="queue" />
        </button>
      </div>

      {queueOpen && (
        <QueuePanel
          onClose={() => {
            setQueueOpen(false)
            queueButton.current?.focus()
          }}
        />
      )}
    </section>
  )
}
