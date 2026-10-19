import { kvCache } from '../../lib/kvCache'
import type { Lyrics, LyricsTrack } from './types'

const NOT_FOUND_TTL_MS = 24 * 60 * 60 * 1000
// Spicy Lyrics terms: anything stored must be refetched or discarded within 30 days. Applied to every source, with margin.
const FOUND_TTL_MS = 7 * 24 * 60 * 60 * 1000

const store = kvCache<Lyrics | null>('lyrics-cache', 300, (l) => (l === null ? NOT_FOUND_TTL_MS : FOUND_TTL_MS))

/** Scoped by server + user, and by track identity and lookup mode, so lyrics never leak between tracks. */
export function lyricsKey(scope: { baseUrl: string; username: string }, track: LyricsTrack, external: boolean, spotifyId?: string) {
  // The Spotify id is part of the identity: re-linking a track must not serve lyrics fetched for another id.
  return ['lyrics', scope.baseUrl, scope.username, track.id, `${track.title}|${track.artist}|${Math.round(track.duration)}`, external, spotifyId ?? null] as const
}

const storageKey = (key: readonly unknown[]) => JSON.stringify(key)

/** Cached lyrics (`null` = remembered "not found"); `undefined` = miss. Failures are never cached. */
export const readCached = (key: readonly unknown[]) => store.get(storageKey(key))
export const writeCached = (key: readonly unknown[], lyrics: Lyrics | null) => store.set(storageKey(key), lyrics)
export const removeCached = (key: readonly unknown[]) => store.remove(storageKey(key))
export const clearLyricsCache = () => store.clear()

/** Test hook: forget the in-memory copy so the next read goes to IndexedDB. */
export const resetLyricsCacheMemory = store.forgetMemory
