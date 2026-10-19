import { useEffect, useState } from 'react'

interface Props {
  label: string
  value: number
  min?: number
  max: number
  step?: number
  disabled?: boolean
  /** Spoken value, e.g. "1:05 of 3:20". */
  valueText?: string
  /** Call `onCommit` on every change (volume) instead of only when a drag is released (seeking). */
  live?: boolean
  onCommit: (value: number) => void
}

/** Native range input: keyboard and screen-reader support come for free. */
export function Slider({ label, value, min = 0, max, step = 1, disabled, valueText, live = false, onCommit }: Props) {
  // While the pointer is down, show the thumb under the finger and only commit on release.
  const [drag, setDrag] = useState<number | null>(null)
  const shown = drag ?? value
  const fill = max > min ? Math.min(100, Math.max(0, ((shown - min) / (max - min)) * 100)) : 0

  useEffect(() => {
    if (drag === null) return
    const release = () => {
      onCommit(drag)
      setDrag(null)
    }
    window.addEventListener('pointerup', release, { once: true })
    window.addEventListener('pointercancel', release, { once: true })
    return () => {
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', release)
    }
  }, [drag, onCommit])

  return (
    <input
      type="range"
      className="slider"
      aria-label={label}
      aria-valuetext={valueText}
      min={min}
      max={max}
      step={step}
      value={shown}
      disabled={disabled}
      style={{ '--fill': `${fill}%` } as React.CSSProperties}
      onPointerDown={() => setDrag(value)}
      onChange={(e) => {
        const v = Number(e.target.value)
        if (live || drag === null) onCommit(v)
        if (drag !== null) setDrag(v)
      }}
    />
  )
}
