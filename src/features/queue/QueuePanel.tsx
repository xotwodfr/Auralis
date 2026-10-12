import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { usePlayback } from '../../state/playback'
import { ConfirmDialog } from '../../ui/Dialog'
import { Icon } from '../../ui/Icon'
import { EmptyState } from '../../ui/State'
import { VirtualList } from '../../ui/VirtualList'
import { Cover } from '../library/components'

export default function QueuePanel({ onClose }: { onClose: () => void }) {
  const { queue, removeAt, reorder, jump, clearQueue } = usePlayback(
    useShallow(({ queue, removeAt, reorder, jump, clearQueue }) => ({ queue, removeAt, reorder, jump, clearQueue })),
  )
  const heading = useRef<HTMLHeadingElement>(null)
  const [confirming, setConfirming] = useState(false)
  const { items, index } = queue

  useEffect(() => heading.current?.focus(), [])

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose()
  }

  return (
    <aside id="queue-panel" className="queue glass-overlay" aria-label="Queue" onKeyDown={onKeyDown}>
      <header className="queue__head">
        <h2 ref={heading} tabIndex={-1} className="queue__title">
          Queue
          <span className="queue__count">{items.length ? ` · ${items.length - Math.max(index + 1, 0)} up next` : ''}</span>
        </h2>
        <button type="button" className="btn" onClick={() => setConfirming(true)} disabled={!items.length}>
          Clear queue
        </button>
        <button type="button" className="icon-btn" aria-label="Close queue" title="Close" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>

      {items.length === 0 ? (
        <EmptyState title="The queue is empty" hint="Play a track, or use “Add to queue” on any track." />
      ) : (
        <VirtualList
          count={items.length}
          rowHeight={60}
          maxHeight="55dvh"
          label="Queue"
          renderRow={(i) => {
            const { track } = items[i]!
            const state = i === index ? 'current' : i < index ? 'played' : 'upcoming'
            return (
              <div className={`qrow qrow--${state}`} aria-current={state === 'current' ? 'true' : undefined}>
                <button type="button" className="qrow__main" aria-label={`Play ${track.title}`} onClick={() => jump(i)}>
                  <span className="qrow__art">
                    <Cover id={track.coverArt} size={96} />
                  </span>
                  <span className="row__text">
                    <span className="row__title">{track.title}</span>
                    <span className="row__sub">
                      {state === 'current' ? 'Now playing · ' : ''}
                      {track.artist}
                    </span>
                  </span>
                </button>
                <button type="button" className="icon-btn" aria-label={`Move ${track.title} up`} title="Move up" disabled={i === 0} onClick={() => reorder(i, i - 1)}>
                  <Icon name="up" size={18} />
                </button>
                <button type="button" className="icon-btn" aria-label={`Move ${track.title} down`} title="Move down" disabled={i === items.length - 1} onClick={() => reorder(i, i + 1)}>
                  <Icon name="down" size={18} />
                </button>
                <button type="button" className="icon-btn" aria-label={`Remove ${track.title} from queue`} title="Remove" onClick={() => removeAt(i)}>
                  <Icon name="trash" size={18} />
                </button>
              </div>
            )
          }}
        />
      )}
      {confirming && (
        <ConfirmDialog
          title="Clear the queue?"
          message="This removes every track from the queue and stops playback."
          confirmLabel="Clear queue"
          onCancel={() => setConfirming(false)}
          onConfirm={() => {
            setConfirming(false)
            clearQueue()
          }}
        />
      )}
    </aside>
  )
}
