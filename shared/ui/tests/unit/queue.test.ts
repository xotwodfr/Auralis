import { initialQueue, nextIndex, previousIndex, queueReducer, currentEntry, type QueueAction, type QueueState } from '../../src/audio/queue'

type T = { id: string }
const t = (...ids: string[]): T[] => ids.map((id) => ({ id }))
const run = (actions: QueueAction<T>[], from: QueueState<T> = initialQueue<T>()) => actions.reduce(queueReducer, from)
const ids = (q: QueueState<T>) => q.items.map((e) => e.track.id).join('')
const cur = (q: QueueState<T>) => currentEntry(q)?.track.id
const never = () => 0 // deterministic "random": reverses the rest

describe('queue basics', () => {
  it('set starts at the chosen track; keys are unique even for duplicate tracks', () => {
    const q = run([{ type: 'set', tracks: t('a', 'b', 'a'), start: 1 }])
    expect([ids(q), cur(q)]).toEqual(['aba', 'b'])
    expect(new Set(q.items.map((e) => e.key)).size).toBe(3)
  })

  it('addNext inserts after the current track; addToQueue appends', () => {
    const q = run([
      { type: 'set', tracks: t('a', 'b', 'c'), start: 0 },
      { type: 'addNext', tracks: t('x') },
      { type: 'addToQueue', tracks: t('y') },
    ])
    expect([ids(q), cur(q)]).toEqual(['axbcy', 'a'])
  })

  it('adding to an empty queue does not make anything current', () => {
    const q = run([{ type: 'addToQueue', tracks: t('a') }])
    expect([ids(q), q.index]).toEqual(['a', -1])
    expect(nextIndex(q, true)).toBe(0)
  })

  it('remove keeps the current track current when removing before/after it', () => {
    const base = run([{ type: 'set', tracks: t('a', 'b', 'c', 'd'), start: 2 }])
    expect(cur(queueReducer(base, { type: 'remove', index: 0 }))).toBe('c')
    expect(cur(queueReducer(base, { type: 'remove', index: 3 }))).toBe('c')
  })

  it('removing the current track makes the next one current; removing the last leaves nothing current', () => {
    const base = run([{ type: 'set', tracks: t('a', 'b', 'c'), start: 1 }])
    const q = queueReducer(base, { type: 'remove', index: 1 })
    expect([ids(q), cur(q)]).toEqual(['ac', 'c'])
    const end = queueReducer(q, { type: 'remove', index: 1 })
    expect([ids(end), end.index]).toEqual(['a', -1])
  })

  it('reorder keeps the same track current', () => {
    const base = run([{ type: 'set', tracks: t('a', 'b', 'c'), start: 1 }])
    const q = queueReducer(base, { type: 'reorder', from: 1, to: 0 })
    expect([ids(q), cur(q), q.index]).toEqual(['bac', 'b', 0])
    expect(queueReducer(base, { type: 'reorder', from: 0, to: 5 })).toBe(base)
  })

  it('clear empties the queue but keeps shuffle/repeat', () => {
    const q = run([{ type: 'set', tracks: t('a'), start: 0 }, { type: 'setRepeat', repeat: 'all' }, { type: 'clear' }])
    expect([ids(q), q.index, q.repeat]).toEqual(['', -1, 'all'])
  })
})

describe('next / previous', () => {
  const three = (repeat: 'off' | 'all' | 'one', start = 2) =>
    run([{ type: 'set', tracks: t('a', 'b', 'c'), start }, { type: 'setRepeat', repeat }])

  it('at the end: off stops, all wraps, one repeats on auto-advance but moves on manually', () => {
    expect(nextIndex(three('off'), false)).toBeNull()
    expect(nextIndex(three('off'), true)).toBeNull()
    expect(nextIndex(three('all'), false)).toBe(0)
    expect(nextIndex(three('one'), false)).toBe(2)
    expect(nextIndex(three('one', 0), true)).toBe(1)
  })

  it('previous goes back, restarts at the start, wraps with repeat-all', () => {
    expect(previousIndex(three('off', 1))).toBe(0)
    expect(previousIndex(three('off', 0))).toBe(0)
    expect(previousIndex(three('all', 0))).toBe(2)
  })
})

describe('shuffle', () => {
  it('keeps the current track first, permutes the rest, and restores order when turned off', () => {
    const base = run([{ type: 'set', tracks: t('a', 'b', 'c', 'd'), start: 1 }])
    const on = queueReducer(base, { type: 'setShuffle', on: true, rand: never })
    expect([cur(on), on.index, on.items.length]).toEqual(['b', 0, 4])
    expect(ids(on)).not.toBe('abcd')
    expect([...ids(on)].sort().join('')).toBe('abcd')

    const off = queueReducer(on, { type: 'setShuffle', on: false })
    expect([ids(off), cur(off)]).toEqual(['abcd', 'b'])
  })

  it('edits made while shuffled survive turning shuffle off', () => {
    let q = run([{ type: 'set', tracks: t('a', 'b', 'c'), start: 0 }, { type: 'setShuffle', on: true, rand: never }])
    q = run([{ type: 'addToQueue', tracks: t('z') }, { type: 'remove', index: q.items.findIndex((e) => e.track.id === 'b') }], q)
    expect(ids(queueReducer(q, { type: 'setShuffle', on: false }))).toBe('acz')
  })

  it('set while shuffle is on starts at the chosen track', () => {
    const q = run([{ type: 'setShuffle', on: true }, { type: 'set', tracks: t('a', 'b', 'c'), start: 2, rand: never }])
    expect([cur(q), q.items.length]).toEqual(['c', 3])
  })
})
