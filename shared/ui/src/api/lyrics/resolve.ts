import { backendUrl } from '../../lib/backend'
import { kvCache } from '../../lib/kvCache'
import { resolveMatch, type Resolution, type SpotifyCandidate } from './spotifyMatch'
import type { LyricsTrack } from './types'

// Our backend (server/spicy.mjs → server/spotify.mjs) searches Spotify; the client secret never reaches the browser.
const TIMEOUT_MS = 6000
/** Rapid skipping: a track has to stay current this long before we ask the network. Cache hits skip it. */
export const SETTLE_MS = 300
const DAY = 24 * 60 * 60 * 1000

/** `unavailable`: the lookup itself failed (backend missing, timeout, rate limit). Never cached. */
export type MatchOutcome = Resolution | { status: 'unavailable' }

// A confirmed id stays valid for a long time; "not found"/"unsure" are retried daily, as catalogues change.
const store = kvCache<Resolution>('spotify-matches', 1000, (r) => (r.status === 'matched' ? 30 * DAY : DAY))

/** Per server + user + track identity: a match made for one account or library item is never reused for another. */
export const matchKey = (scope: { baseUrl: string; username: string }, t: LyricsTrack) =>
  JSON.stringify([scope.baseUrl, scope.username, t.id, t.title, t.artist, t.album, Math.round(t.duration), t.isrc ?? [], t.explicit ?? null])

const inflight = new Map<string, { promise: Promise<MatchOutcome>; ctl: AbortController; waiters: number }>()
let blockedUntil = 0

const aborted = () => new DOMException('Aborted', 'AbortError')
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => (clearTimeout(timer), reject(aborted())), { once: true })
  })

const isCandidate = (c: unknown): c is SpotifyCandidate => {
  const x = c as SpotifyCandidate
  return (
    typeof x === 'object' && x !== null && typeof x.id === 'string' && /^[A-Za-z0-9]{22}$/.test(x.id) && typeof x.name === 'string' &&
    Array.isArray(x.artists) && x.artists.every((a) => typeof a === 'string') && typeof x.album === 'string' &&
    typeof x.durationMs === 'number' && typeof x.explicit === 'boolean' && typeof x.isrc === 'string'
  )
}

async function lookup(track: LyricsTrack, signal: AbortSignal): Promise<MatchOutcome> {
  if (Date.now() < blockedUntil) return { status: 'unavailable' }
  await sleep(SETTLE_MS, signal)
  const params = new URLSearchParams({ title: track.title.replace(/\s*[([](?:feat|ft)\.?\s[^)\]]*[)\]]/i, '').slice(0, 200) })
  const primary = track.artist.split(/\s*(?:,|;|\/|\bfeat\.?\s|\bft\.?\s|\bfeaturing\b)\s*/i)[0]?.trim()
  if (primary) params.set('artist', primary.slice(0, 200))
  if (track.isrc?.[0]) params.set('isrc', track.isrc[0])

  let res: Response
  try {
    res = await fetch(`${backendUrl('/api/spicy/match')}?${params}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]), headers: { accept: 'application/json' } })
  } catch {
    if (signal.aborted) throw aborted()
    return { status: 'unavailable' } // network failure or timeout
  }
  if (res.status === 429) {
    const wait = Number(res.headers.get('retry-after'))
    blockedUntil = Date.now() + (Number.isFinite(wait) && wait > 0 ? Math.min(wait, 600) : 30) * 1000
    return { status: 'unavailable' }
  }
  if (!res.ok || !res.headers.get('content-type')?.includes('json')) return { status: 'unavailable' }
  let json: unknown
  try {
    json = await res.json()
  } catch {
    if (signal.aborted) throw aborted()
    return { status: 'unavailable' }
  }
  const list = (json as { candidates?: unknown })?.candidates
  if (!Array.isArray(list)) return { status: 'unavailable' }
  return resolveMatch(track, list.filter(isCandidate))
}

/**
 * The Spotify recording for a library track, from cache or our backend. Concurrent calls for the same track share one
 * request, which is cancelled only when every caller has gone. Never throws except AbortError.
 */
export async function resolveSpotifyTrack(scope: { baseUrl: string; username: string }, track: LyricsTrack, signal: AbortSignal): Promise<MatchOutcome> {
  const key = matchKey(scope, track)
  const cached = await store.get(key)
  if (cached) return cached
  if (signal.aborted) throw aborted()

  let entry = inflight.get(key)
  if (!entry) {
    const ctl = new AbortController()
    const promise = lookup(track, ctl.signal)
      .then(async (r) => {
        if (r.status !== 'unavailable') await store.set(key, r)
        return r
      })
      .finally(() => inflight.get(key)?.promise === promise && inflight.delete(key))
    entry = { promise, ctl, waiters: 0 }
    inflight.set(key, entry)
  }
  const e = entry
  e.waiters++
  return new Promise<MatchOutcome>((resolve, reject) => {
    const leave = () => {
      if (--e.waiters === 0) {
        e.ctl.abort()
        if (inflight.get(key) === e) inflight.delete(key)
      }
      reject(aborted())
    }
    signal.addEventListener('abort', leave, { once: true })
    e.promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', leave))
  })
}

export const forgetSpotifyMatch = (scope: { baseUrl: string; username: string }, t: LyricsTrack) => store.remove(matchKey(scope, t))
export const clearSpotifyMatches = () => store.clear()
/** Test hooks. */
export const resetSpotifyMatchMemory = () => {
  store.forgetMemory()
  inflight.clear()
  blockedUntil = 0
}
