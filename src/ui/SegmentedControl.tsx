import type { KeyboardEvent, ReactNode } from 'react'

interface Option<T extends string> {
  value: T
  label: string
  /** `cards` variant only: visual preview and a short caption shown under the label. */
  preview?: ReactNode
  caption?: string
}

interface Props<T extends string> {
  label: string
  value: T
  options: Option<T>[]
  onChange: (value: T) => void
  variant?: 'pills' | 'cards'
}

/** Radio group with a roving tabindex: Tab enters/leaves, arrow keys move and select. */
export function SegmentedControl<T extends string>({ label, value, options, onChange, variant = 'pills' }: Props<T>) {
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!step) return
    e.preventDefault()
    const i = options.findIndex((o) => o.value === value)
    const next = options[(i + step + options.length) % options.length]!
    onChange(next.value)
    e.currentTarget.querySelectorAll<HTMLElement>('[role=radio]')[options.indexOf(next)]?.focus()
  }

  return (
    <div className={`segmented${variant === 'cards' ? ' segmented--cards' : ''}`} role="radiogroup" aria-label={label} onKeyDown={onKeyDown}>
      {options.map((o) => (
        // aria-label keeps the accessible name equal to the label even when a caption is shown.
        <button key={o.value} type="button" role="radio" aria-label={o.label} aria-checked={o.value === value} tabIndex={o.value === value ? 0 : -1} className="segmented__item" onClick={() => onChange(o.value)}>
          {o.preview}
          <span className="segmented__label">{o.label}</span>
          {o.caption && <span className="segmented__caption">{o.caption}</span>}
        </button>
      ))}
    </div>
  )
}
