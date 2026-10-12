// Pure queue model. Generic over the track type so audio/ stays independent of api/.

export type Repeat = 'off' | 'all' | 'one'

/** `key` is unique per queue slot, so the same track can be queued twice. */
export interface Entry<T> {
  key: number
  track: T
}

export interface QueueState<T> {
  items: Entry<T>[]
  /** Index of the current entry, or -1 when nothing is current (empty queue, or the last one was removed). */
  index: number
  repeat: Repeat
  shuffle: boolean
  /** Unshuffled order, kept in sync while shuffle is on; null otherwise. */
  original: Entry<T>[] | null
  nextKey: number
}

export type QueueAction<T> =
  | { type: 'set'; tracks: T[]; start: number; rand?: () => number }
  | { type: 'addNext'; tracks: T[] }
  | { type: 'addToQueue'; tracks: T[] }
  | { type: 'remove'; index: number }
  | { type: 'clear' }
  | { type: 'reorder'; from: number; to: number }
  | { type: 'jump'; index: number }
  | { type: 'setShuffle'; on: boolean; rand?: () => number }
  | { type: 'setRepeat'; repeat: Repeat }

export const initialQueue = <T>(): QueueState<T> => ({
  items: [],
  index: -1,
  repeat: 'off',
  shuffle: false,
  original: null,
  nextKey: 1,
})

export const currentEntry = <T>(q: QueueState<T>): Entry<T> | undefined => q.items[q.index]

/** Fisher–Yates on a copy. */
function shuffled<T>(list: T[], rand: () => number): T[] {
  const out = [...list]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

function entries<T>(q: QueueState<T>, tracks: T[]): Entry<T>[] {
  return tracks.map((track, i) => ({ key: q.nextKey + i, track }))
}

/** Where to go when the track ends (`manual: false`) or the user presses next. `null` = stop. */
export function nextIndex<T>(q: QueueState<T>, manual: boolean): number | null {
  if (!manual && q.repeat === 'one' && q.index >= 0) return q.index
  if (q.index + 1 < q.items.length) return q.index + 1
  // shortcut: repeat-all wraps to the same shuffled order; reshuffle per lap if users ask.
  return q.repeat === 'all' && q.items.length > 0 ? 0 : null
}

/** Where "previous" goes when the track is past its restart threshold; equals `index` to mean "restart". */
export function previousIndex<T>(q: QueueState<T>): number {
  if (q.index > 0) return q.index - 1
  return q.repeat === 'all' && q.items.length > 1 ? q.items.length - 1 : Math.max(0, q.index)
}

export function queueReducer<T>(q: QueueState<T>, action: QueueAction<T>): QueueState<T> {
  switch (action.type) {
    case 'set': {
      if (!action.tracks.length) return { ...initialQueue<T>(), repeat: q.repeat, shuffle: q.shuffle, original: q.shuffle ? [] : null, nextKey: q.nextKey }
      const all = entries(q, action.tracks)
      const start = Math.min(Math.max(action.start, 0), all.length - 1)
      const base = { ...q, nextKey: q.nextKey + all.length }
      if (!q.shuffle) return { ...base, items: all, index: start, original: null }
      const rest = shuffled(all.filter((_, i) => i !== start), action.rand ?? Math.random)
      return { ...base, items: [all[start]!, ...rest], index: 0, original: all }
    }
    case 'addNext': {
      const added = entries(q, action.tracks)
      const at = q.index + 1
      const cur = currentEntry(q)
      const originalAt = cur && q.original ? q.original.findIndex((e) => e.key === cur.key) + 1 : 0
      return {
        ...q,
        items: [...q.items.slice(0, at), ...added, ...q.items.slice(at)],
        original: q.original && [...q.original.slice(0, originalAt), ...added, ...q.original.slice(originalAt)],
        nextKey: q.nextKey + added.length,
      }
    }
    case 'addToQueue': {
      const added = entries(q, action.tracks)
      return {
        ...q,
        items: [...q.items, ...added],
        original: q.original && [...q.original, ...added],
        nextKey: q.nextKey + added.length,
      }
    }
    case 'remove': {
      const removed = q.items[action.index]
      if (!removed) return q
      const items = q.items.filter((e) => e !== removed)
      // Removing the current entry makes the following one current; if none follows, nothing is current.
      let index = q.index
      if (action.index < q.index) index--
      else if (action.index === q.index && index >= items.length) index = -1
      return { ...q, items, index, original: q.original && q.original.filter((e) => e !== removed) }
    }
    case 'clear':
      return { ...initialQueue<T>(), repeat: q.repeat, shuffle: q.shuffle, original: q.shuffle ? [] : null, nextKey: q.nextKey }
    case 'reorder': {
      const { from, to } = action
      if (from === to || !q.items[from] || to < 0 || to >= q.items.length) return q
      const cur = currentEntry(q)
      const items = [...q.items]
      items.splice(to, 0, items.splice(from, 1)[0]!)
      return { ...q, items, index: cur ? items.indexOf(cur) : -1 }
    }
    case 'jump':
      return q.items[action.index] ? { ...q, index: action.index } : q
    case 'setShuffle': {
      if (action.on === q.shuffle) return q
      const cur = currentEntry(q)
      if (!action.on) {
        const items = q.original ?? q.items
        return { ...q, shuffle: false, original: null, items, index: cur ? items.indexOf(cur) : -1 }
      }
      const rand = action.rand ?? Math.random
      const items = cur ? [cur, ...shuffled(q.items.filter((e) => e !== cur), rand)] : shuffled(q.items, rand)
      return { ...q, shuffle: true, original: q.items, items, index: cur ? 0 : -1 }
    }
    case 'setRepeat':
      return { ...q, repeat: action.repeat }
  }
}
