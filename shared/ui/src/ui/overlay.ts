import { useEffect, useRef } from 'react'

const EVENT = 'auralis:overlay'

/**
 * Side panels that open in the same place (the queue, audio effects): opening one closes the other instead of stacking
 * them. `close` should only hide the panel; focus belongs to the panel that just opened.
 */
export function useExclusiveOverlay(id: string, open: boolean, close: () => void) {
  const latest = useRef(close)
  useEffect(() => {
    latest.current = close
  })
  useEffect(() => {
    if (!open) return
    window.dispatchEvent(new CustomEvent(EVENT, { detail: id }))
    const onOther = (e: Event) => {
      if ((e as CustomEvent<string>).detail !== id) latest.current()
    }
    window.addEventListener(EVENT, onOther)
    return () => window.removeEventListener(EVENT, onOther)
  }, [id, open])
}
