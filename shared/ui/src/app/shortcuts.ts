import { useEffect } from 'react'
import { usePlayback } from '../state/playback'

/** Single source for both the handler below and the reference shown in Settings. */
export const SHORTCUTS: { keys: string; action: string }[] = [
  { keys: 'Space', action: 'Play / pause' },
  { keys: '← / →', action: 'Seek back / forward 5 seconds' },
  { keys: '↑ / ↓', action: 'Volume up / down' },
  { keys: 'N / P', action: 'Next / previous track' },
  { keys: '/', action: 'Focus search' },
  { keys: 'Esc', action: 'Close the queue or a dialog' },
]

const SEEK_S = 5
const VOLUME_STEP = 0.05
const TYPING = 'input,textarea,select,[contenteditable="true"]'
const INTERACTIVE = 'button,a,[role="button"],[role="radio"]'
const SCROLL_REGION = '.lyrics,.vlist'

/** Global shortcuts. Never fire while typing, with modifiers, inside a modal, or when the focused control owns the key. */
export function useShortcuts() {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return
      const target = e.target instanceof Element ? e.target : document.body
      if (target.closest(TYPING) || document.querySelector('[aria-modal="true"]')) return
      const p = usePlayback.getState()
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
      // Space activates focused buttons/links; arrows scroll focused lists and lyrics.
      const owned = target.closest(SCROLL_REGION)

      switch (key) {
        case ' ':
          if (target.closest(INTERACTIVE) || owned || e.repeat) return
          p.togglePlay()
          break
        case 'ArrowLeft':
        case 'ArrowRight':
          if (target.closest('[role="radiogroup"]')) return
          p.seek(Math.max(0, p.position + (key === 'ArrowRight' ? SEEK_S : -SEEK_S)))
          break
        case 'ArrowUp':
        case 'ArrowDown':
          if (owned || target.closest('[role="radiogroup"]')) return
          p.setVolume(p.volume + (key === 'ArrowUp' ? VOLUME_STEP : -VOLUME_STEP))
          break
        case 'n':
          p.next()
          break
        case 'p':
          p.previous()
          break
        case '/':
          document.querySelector<HTMLInputElement>('input[type="search"]')?.focus()
          break
        default:
          return
      }
      e.preventDefault()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])
}
