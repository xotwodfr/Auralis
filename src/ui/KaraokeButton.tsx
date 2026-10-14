import { usePlayback } from '../state/playback'
import { Icon } from './Icon'
import { Slider } from './Slider'

/** Vocal remover toggle. Pressed while on; `mono` tracks cannot be processed, so the button says so. */
export function KaraokeButton({ className = 'icon-btn', size = 22 }: { className?: string; size?: number }) {
  const state = usePlayback((s) => s.karaoke)
  const setKaraoke = usePlayback((s) => s.setKaraoke)
  const on = state === 'on' || state === 'mono'
  const label = state === 'mono' ? 'Karaoke mode (mono track: bypassed)' : 'Karaoke mode'
  return (
    <button type="button" className={`${className} karaoke`} aria-pressed={on} aria-label={label} title={label} onClick={() => setKaraoke(!on)}>
      <Icon name="karaoke" size={size} />
    </button>
  )
}

/** Shown only while karaoke is on: how much of the centre (vocals) is removed. */
export function KaraokeIntensity() {
  const state = usePlayback((s) => s.karaoke)
  const amount = usePlayback((s) => s.karaokeAmount)
  const setAmount = usePlayback((s) => s.setKaraokeAmount)
  if (state !== 'on' && state !== 'mono') return null
  return (
    <div className="karaoke-intensity">
      <span>Vocal reduction</span>
      <Slider label="Vocal reduction" value={amount} max={1} step={0.01} live valueText={`${Math.round(amount * 100)}%`} onCommit={setAmount} />
      <span className="karaoke-intensity__value">{Math.round(amount * 100)}%</span>
    </div>
  )
}
