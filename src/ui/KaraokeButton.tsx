import { usePlayback } from '../state/playback'
import { Icon } from './Icon'

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
