import { currentEntry } from '../audio/queue'
import { Cover, StarButton } from '../features/library/components'
import { isStarred, useStarred } from '../features/library/starred'
import { usePlayback } from '../state/playback'
import { Icon } from '../ui/Icon'
import { tintStyle, useCoverTint, useOpenPlayer } from './parts'

/** Re-renders on every playhead tick, so it is its own component. */
function Line() {
  const pct = usePlayback((s) => (s.duration ? Math.min(100, (s.position / s.duration) * 100) : 0))
  return (
    <span className="m-mini__line" aria-hidden>
      <span style={{ width: `${pct}%` }} />
    </span>
  )
}

export default function MiniPlayer() {
  const track = usePlayback((s) => currentEntry(s.queue)?.track)
  const status = usePlayback((s) => s.status)
  const autoplay = usePlayback((s) => s.autoplay)
  const error = usePlayback((s) => s.error)
  const togglePlay = usePlayback((s) => s.togglePlay)
  const ids = useStarred()
  const tint = useCoverTint(track?.coverArt, 24)
  const open = useOpenPlayer()
  if (!track) return null
  const playing = status === 'playing' || status === 'buffering' || (status === 'loading' && autoplay)
  return (
    <section className="m-mini" aria-label="Player" style={tintStyle(tint)}>
      <button type="button" className="m-mini__open" aria-label={`Open player: ${track.title}`} onClick={open}>
        <span className="m-thumb">
          <Cover id={track.coverArt} size={96} />
        </span>
        <span className="m-text">
          <span className="m-text__title">{track.title}</span>
          <span className={error ? 'm-text__sub m-text__sub--error' : 'm-text__sub'}>{error ? error.message : track.artist}</span>
        </span>
      </button>
      <StarButton target={{ kind: 'song', item: track }} name={track.title} starred={isStarred(ids, 'song', track.id)} />
      <button type="button" className="icon-btn m-mini__toggle" aria-label={playing ? 'Pause' : 'Play'} aria-busy={status === 'loading' || status === 'buffering'} onClick={togglePlay}>
        <Icon name={playing ? 'pause' : 'play'} size={26} />
      </button>
      <Line />
    </section>
  )
}
