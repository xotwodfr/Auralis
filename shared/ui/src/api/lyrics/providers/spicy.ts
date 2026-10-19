import { LyricsError, type Attribution, type Credit, type LyricLine, type LyricWord, type Lyrics, type LyricsProvider } from '../types'
import { backendUrl } from '../../../lib/backend'
import { fillTimes } from '../lrc'

// Talks to OUR backend (server/spicy.mjs), never to Spicy Lyrics directly: the secret key lives only there.
/** Lyrics that end well after the track does belong to a different recording (live/extended/wrong id). */
const OVERRUN_TOLERANCE_S = 5

const PROVIDERS: Record<string, string> = { spicy_lyrics: 'Spicy Lyrics', apple_music: 'Apple Music', spotify: 'Spotify' }

type Json = Record<string, unknown>
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const str = (v: unknown): v is string => typeof v === 'string'

/** Syllables of one vocal. A syllable missing its times keeps its text and borrows timing from its neighbours. */
function words(v: Json): LyricWord[] {
  if (!Array.isArray(v.Syllables)) return []
  const w = v.Syllables.flatMap((s): LyricWord[] =>
    isObj(s) && str(s.Text) && s.Text.trim()
      ? [{ text: s.Text.trim(), start: num(s.StartTime) ? s.StartTime : NaN, end: num(s.EndTime) ? s.EndTime : NaN, ...(s.IsPartOfWord === true && { joinNext: true }) }]
      : [],
  )
  return fillTimes(w, num(v.StartTime) ? v.StartTime : NaN, num(v.EndTime) ? v.EndTime : NaN)
}

export const joinWords = (w: LyricWord[]) => w.reduce((out, x, i) => out + x.text + (x.joinNext || i === w.length - 1 ? '' : ' '), '')

function credit(role: Credit['role'], v: unknown): Credit[] {
  if (!isObj(v)) return []
  const name = [v.username, v.Username, v.name, v.Name].find(str)
  if (!name) return []
  const url = [v.url, v.Url, v.profileUrl].find(str)
  return [{ role, name, ...(url && /^https?:\/\//i.test(url) && { url }) }]
}

/** Provider name is always shown; uploader/maker only exist (and are required) for community syncs. */
function attribution(body: Json): Attribution {
  const source = str(body.source) ? body.source : ''
  const up = isObj(body.UploadAttribution) ? body.UploadAttribution : {}
  return {
    provider: PROVIDERS[source] ?? 'an unknown source',
    credits: source === 'spicy_lyrics' ? [...credit('Uploader', up.Uploader), ...credit('Maker', up.Maker)] : [],
  }
}

/**
 * Normalizes a Spicy Lyrics `Body`. Verified against the live API: `Type: "Syllable"` with `Content[]` of
 * `{Type:"Vocal", Lead:{Syllables[], StartTime, EndTime}, Background?:[{Syllables[]…}], OppositeAligned}`,
 * times in seconds. shortcut: the `Line` / `Static` shapes below are inferred, not observed; they fail closed
 * (null) on anything unexpected. Returns null for unusable data or an implausible match.
 */
export function parseSpicy(body: unknown, trackDuration: number): Lyrics | null {
  if (!isObj(body) || !Array.isArray(body.Content)) return null
  const lines: LyricLine[] = []
  let synced = true

  for (const item of body.Content) {
    if (!isObj(item)) continue
    if (body.Type === 'Syllable') {
      if (item.Type !== 'Vocal' || !isObj(item.Lead)) continue
      const w = words(item.Lead)
      if (!w.length) continue
      const background = (Array.isArray(item.Background) ? item.Background : []).flatMap((b) => {
        const bw = isObj(b) ? words(b) : []
        return bw.length ? [{ text: joinWords(bw), words: bw }] : []
      })
      lines.push({ time: w[0]!.start, text: joinWords(w), words: w, ...(background.length && { background }), ...(item.OppositeAligned === true && { opposite: true }) })
    } else if (body.Type === 'Line' && str(item.Text) && item.Text.trim() && num(item.StartTime)) {
      lines.push({ time: item.StartTime, text: item.Text.trim() })
    } else if (body.Type === 'Static' && str(item.Text) && item.Text.trim()) {
      synced = false
      lines.push({ time: null, text: item.Text.trim() })
    }
  }
  if (!lines.length) return null

  if (synced) {
    lines.sort((a, b) => a.time! - b.time!)
    const end = Math.max(...lines.map((l) => Math.max(l.time!, ...(l.words ?? []).map((w) => w.end))))
    if (lines[0]!.time! < 0 || (trackDuration > 0 && end > trackDuration + OVERRUN_TOLERANCE_S)) return null
  }
  return { synced, source: 'spicy', lines, attribution: attribution(body) }
}

/** Spicy Lyrics, via our backend, for a track the user has linked to a Spotify track id. */
export function spicyProvider(spotifyId: string): LyricsProvider {
  return {
    id: 'spicy',
    async fetch(track, signal) {
      let res: Response
      try {
        res = await fetch(`${backendUrl('/api/spicy/lyrics')}/${encodeURIComponent(spotifyId)}`, { signal, headers: { accept: 'application/json' } })
      } catch {
        throw new LyricsError(signal.aborted ? 'aborted' : 'network', 'Could not reach the lyrics service')
      }
      if (res.status === 404 || res.status === 400 || res.status === 503) return null // none for this id / not configured here
      if (res.status === 429) throw new LyricsError('rate-limited', 'The lyrics service is busy')
      if (!res.ok) throw new LyricsError('unavailable', `Lyrics service responded with HTTP ${res.status}`)
      if (!res.headers.get('content-type')?.includes('json')) return null // no backend on this host (static hosting)
      let json: unknown
      try {
        json = await res.json()
      } catch {
        throw signal.aborted ? new LyricsError('aborted', 'Cancelled') : new LyricsError('unavailable', 'Invalid response from the lyrics service')
      }
      return parseSpicy(isObj(json) ? json.Body : null, track.duration)
    },
  }
}
