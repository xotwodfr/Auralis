import { kvDelete, kvGet, kvSet } from './storage'

interface Entry<T> {
  value: T
  at: number
}

/**
 * A bounded, expiring cache kept as one IndexedDB blob, loaded once. Insertion order doubles as age for eviction;
 * expired entries are dropped from disk on load. Writes are best effort (a failed write only loses persistence).
 */
export function kvCache<T>(key: string, max: number, ttlMs: (value: T) => number) {
  type Store = Record<string, Entry<T>>
  let loaded: Promise<Store> | undefined
  const live = (e: Entry<T> | undefined, t: number): e is Entry<T> => !!e && typeof e.at === 'number' && 'value' in e && t - e.at <= ttlMs(e.value)

  const load = (): Promise<Store> =>
    (loaded ??= kvGet<Store>(key).then(
      (v): Store => {
        const all = typeof v === 'object' && v !== null ? v : {}
        const t = Date.now()
        const kept = Object.entries(all).filter(([, e]) => live(e, t))
        if (kept.length !== Object.keys(all).length) void kvSet(key, Object.fromEntries(kept)).catch(() => undefined)
        return Object.fromEntries(kept)
      },
      (): Store => ({}),
    ))
  const save = (all: Store) => kvSet(key, all).catch(() => undefined)

  return {
    /** `undefined` = miss (or expired). */
    async get(k: string): Promise<T | undefined> {
      const e = (await load())[k]
      return live(e, Date.now()) ? e.value : undefined
    },
    async set(k: string, value: T): Promise<void> {
      const all = await load()
      delete all[k] // re-insert at the end
      all[k] = { value, at: Date.now() }
      for (const old of Object.keys(all).slice(0, Math.max(0, Object.keys(all).length - max))) delete all[old]
      await save(all)
    },
    async remove(k: string): Promise<void> {
      const all = await load()
      delete all[k]
      await save(all)
    },
    async clear(): Promise<void> {
      loaded = Promise.resolve({})
      await kvDelete(key)
    },
    /** Test hook: forget the in-memory copy so the next read goes to IndexedDB. */
    forgetMemory: () => void (loaded = undefined),
  }
}
