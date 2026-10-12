import { isMatch, type LyricsCandidate } from '../match'
import { parseLrc } from '../lrc'
import { LyricsError, type Lyrics, type LyricsProvider, type LyricsTrack } from '../types'

const BASE = 'https://lrclib.net/api'
const DEFAULT_RETRY_S = 60

interface LrclibRecord extends LyricsCandidate {
  instrumental?: boolean
  plainLyrics?: string | null
  syncedLyrics?: string | null
}

// Browsers forbid setting User-Agent, and a custom header would force a CORS preflight, so none is sent.
let blockedUntil = 0
export const resetLrclibBackoff = () => (blockedUntil = 0)

async function get<T>(path: string, params: Record<string, string>, signal: AbortSignal): Promise<T | null> {
  if (Date.now() < blockedUntil) throw new LyricsError('rate-limited', 'LRCLIB asked us to slow down')
  let res: Response
  try {
    res = await fetch(`${BASE}/${path}?${new URLSearchParams(params)}`, { signal })
  } catch {
    throw new LyricsError(signal.aborted ? 'aborted' : 'network', 'Could not reach LRCLIB')
  }
  if (res.status === 404) return null
  if (res.status === 429) {
    const retry = Number(res.headers.get('retry-after'))
    blockedUntil = Date.now() + (Number.isFinite(retry) && retry > 0 ? retry : DEFAULT_RETRY_S) * 1000
    throw new LyricsError('rate-limited', 'LRCLIB asked us to slow down')
  }
  if (!res.ok) throw new LyricsError('unavailable', `LRCLIB responded with HTTP ${res.status}`)
  try {
    return (await res.json()) as T
  } catch {
    throw signal.aborted ? new LyricsError('aborted', 'Cancelled') : new LyricsError('unavailable', 'LRCLIB sent an invalid response')
  }
}

function toLyrics(r: LrclibRecord): Lyrics | null {
  if (r.instrumental) return { synced: false, source: 'lrclib', lines: [], instrumental: true }
  const text = r.syncedLyrics?.trim() || r.plainLyrics?.trim()
  if (!text) return null
  const parsed = parseLrc(text)
  return parsed.lines.length ? { ...parsed, source: 'lrclib' } : null
}

/** Best accepted candidate: synced first, then closest duration. */
function best(track: LyricsTrack, records: LrclibRecord[]): LrclibRecord | undefined {
  return records
    .filter((r) => isMatch(track, r) && (r.instrumental || r.syncedLyrics || r.plainLyrics))
    .sort((a, b) => Number(!!b.syncedLyrics) - Number(!!a.syncedLyrics) || Math.abs(a.duration! - track.duration) - Math.abs(b.duration! - track.duration))[0]
}

/** `/api/get` exact lookup, then `/api/search` when it misses or its hit fails the match guards. */
export const lrclibProvider: LyricsProvider = {
  id: 'lrclib',
  async fetch(track, signal) {
    const query = { track_name: track.title, artist_name: track.artist }
    const exact = await get<LrclibRecord>('get', {
      ...query,
      ...(track.album && { album_name: track.album }),
      duration: String(Math.round(track.duration)),
    }, signal)
    const hit = exact && best(track, [exact])
    if (hit) return toLyrics(hit)
    const found = await get<LrclibRecord[]>('search', query, signal)
    const pick = found && best(track, found)
    return pick ? toLyrics(pick) : null
  },
}
