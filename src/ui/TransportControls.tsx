import type { Repeat } from '../audio/queue'
import { Icon, SwapIcon } from './Icon'

interface Props {
  playing: boolean
  busy: boolean
  canPrev: boolean
  canNext: boolean
  shuffle: boolean
  repeat: Repeat
  onToggle: () => void
  onPrev: () => void
  onNext: () => void
  onShuffle: () => void
  onRepeat: () => void
}

export function TransportControls(p: Props) {
  return (
    <div className="transport" role="group" aria-label="Playback controls">
      <button type="button" className="icon-btn" aria-label="Shuffle" title="Shuffle" aria-pressed={p.shuffle} onClick={p.onShuffle}>
        <Icon name="shuffle" />
      </button>
      <button type="button" className="icon-btn" aria-label="Previous track" title="Previous" disabled={!p.canPrev} onClick={p.onPrev}>
        <Icon name="prev" />
      </button>
      <button type="button" className="icon-btn icon-btn--main" aria-label={p.playing ? 'Pause' : 'Play'} title={p.playing ? 'Pause (Space)' : 'Play (Space)'} aria-busy={p.busy} onClick={p.onToggle}>
        <SwapIcon name={p.playing ? 'pause' : 'play'} size={26} />
      </button>
      <button type="button" className="icon-btn" aria-label="Next track" title="Next" disabled={!p.canNext} onClick={p.onNext}>
        <Icon name="next" />
      </button>
      <button type="button" className="icon-btn" aria-label={`Repeat ${p.repeat}`} title="Repeat" aria-pressed={p.repeat !== 'off'} onClick={p.onRepeat}>
        <SwapIcon name={p.repeat === 'one' ? 'repeat-one' : 'repeat'} />
      </button>
    </div>
  )
}
