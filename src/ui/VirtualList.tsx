import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

interface Props {
  count: number
  /** Fixed row height in px. */
  rowHeight: number
  label: string
  renderRow: (index: number) => ReactNode
  /** The list is as tall as its rows, up to this CSS length, then scrolls. */
  maxHeight?: string
  overscan?: number
}

/** Fixed-height windowing: only rows near the viewport are in the DOM. */
export function VirtualList({ count, rowHeight, label, renderRow, maxHeight = '70dvh', overscan = 6 }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  // Only the first visible row index is state, so scrolling within a row causes no render.
  const [first, setFirst] = useState(0)
  const [viewport, setViewport] = useState(600)

  // Scrolling only reads scrollTop; the height comes from the ResizeObserver, so no frame forces a layout.
  const onScroll = useCallback(() => {
    const el = ref.current
    if (el) setFirst(Math.floor(el.scrollTop / rowHeight))
  }, [rowHeight])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      setViewport(el.clientHeight || 600)
      setFirst(Math.floor(el.scrollTop / rowHeight))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [rowHeight])

  const start = Math.max(0, first - overscan)
  const end = Math.min(count, first + Math.ceil(viewport / rowHeight) + overscan)
  const rows = []
  for (let i = start; i < end; i++) {
    rows.push(
      <div
        key={i}
        role="listitem"
        aria-setsize={count}
        aria-posinset={i + 1}
        className="vlist__row"
        style={{ height: rowHeight, transform: `translateY(${i * rowHeight}px)` }}
      >
        {renderRow(i)}
      </div>,
    )
  }

  return (
    // Scrollable regions must be keyboard-focusable.
    <div ref={ref} className="vlist" role="list" aria-label={label} tabIndex={0} style={{ maxHeight }} onScroll={onScroll}>
      <div className="vlist__spacer" style={{ height: count * rowHeight }}>
        {rows}
      </div>
    </div>
  )
}
