import type { LyricsTrack } from './types'

/** A Spotify search result as our backend returns it (server/spotify.mjs keeps only these fields). */
export interface SpotifyCandidate {
  id: string
  name: string
  artists: string[]
  album: string
  albumType?: string
  durationMs: number
  explicit: boolean
  /** Uppercase, or '' when Spotify has none. */
  isrc: string
}

export type SignalName = 'isrc' | 'title' | 'artist' | 'duration' | 'album' | 'version' | 'explicit'
/** One reason a candidate scored as it did, for debugging and tests. */
export interface MatchSignal {
  name: SignalName
  /** Contribution to the score (negative for penalties). */
  value: number
  note: string
}

export interface ScoredCandidate {
  candidate: SpotifyCandidate
  /** 0..1. */
  score: number
  signals: MatchSignal[]
  /** Why the candidate can never be this recording. */
  rejected?: string
}

export type Resolution =
  | { status: 'matched'; id: string; confidence: number; candidate: SpotifyCandidate }
  /** Several different recordings fit about equally well: the user picks (or the fallback providers are used). */
  | { status: 'ambiguous'; candidates: SpotifyCandidate[] }
  | { status: 'none' }

// Accept on our own only above this, and only when no materially different recording is within MARGIN.
export const ACCEPT = 0.8
const MARGIN = 0.12
const SUGGEST = 0.5
const MAX_SUGGESTIONS = 5
const WEIGHTS = { title: 0.35, artist: 0.25, duration: 0.25, album: 0.15 }

/** Casefold, strip Latin diacritics and punctuation, unify quotes and `&`, collapse whitespace. */
export function fold(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’‘`´']/g, '') // "don't" = "dont"
    .replace(/\s*[&+]\s*/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

// Recording variants with different audio (and so different lyric timing). Found only in bracketed or dash-suffixed
// qualifiers, never in the base title ("Live Forever" is a title, "Song (Live)" a version).
const MATERIAL: [string, RegExp][] = [
  ['live', /\blive\b|\bin concert\b|\bsessions?\b/],
  ['remix', /\bremix(?:ed)?\b|\brmx\b|\b(?:club|dub|vip|extended) mix\b|\brework\b|\bbootleg\b/],
  ['acoustic', /\bacoustic\b|\bunplugged\b/],
  ['instrumental', /\binstrumental\b|\bkaraoke\b|\boff vocal\b/],
  ['demo', /\bdemo\b/],
  ['cover', /\bcover\b/],
  ['extended', /\bextended\b/],
  ['edit', /\bedit\b/],
  ['tempo', /\bsped up\b|\bspeed up\b|\bslowed\b|\bnightcore\b/],
  ['orchestral', /\borchestral\b|\bsymphonic\b/],
  ['rerecorded', /\bre ?recorded\b|\btaylors version\b/],
]
// Same performance, different master or packaging: a mild preference, never a rejection.
const SOFT: [string, RegExp][] = [
  ['remaster', /\bremaster(?:ed)?\b/],
  ['mono', /\bmono\b/],
  ['version', /\bversion\b|\bmix\b/],
]
const FEATURING = /^(?:feat|ft|featuring|with)\b/

interface Title {
  /** Title without any bracketed/dashed qualifiers. */
  base: string
  /** Base plus the qualifiers that are not versions or credits ("(I Can't Get No) Satisfaction"). */
  full: string
  material: Set<string>
  soft: Set<string>
}

function tokens(folded: string, table: [string, RegExp][]) {
  return table.filter(([, re]) => re.test(folded)).map(([t]) => t)
}

export function parseTitle(raw: string): Title {
  const parts: string[] = []
  let base = raw.replace(/[([{]([^)\]}]*)[)\]}]/g, (_, inner: string) => (parts.push(inner), ' '))
  const dash = /\s[-–—]\s(.*)$/.exec(base)
  if (dash) {
    parts.push(dash[1]!)
    base = base.slice(0, dash.index)
  }
  base = base.replace(/\s(?:feat\.?|ft\.?|featuring)\s.*$/i, '') // unbracketed credit
  const material = new Set<string>()
  const soft = new Set<string>()
  const kept: string[] = []
  for (const p of parts) {
    const f = fold(p)
    if (!f || FEATURING.test(f)) continue
    const m = tokens(f, MATERIAL)
    const s = tokens(f, SOFT)
    m.forEach((t) => material.add(t))
    s.forEach((t) => soft.add(t))
    if (!m.length && !s.length && !/^\d{4}$/.test(f)) kept.push(f)
  }
  const b = fold(base)
  return { base: b, full: [b, ...kept].join(' '), material, soft }
}

/** Live albums mark their tracks as live even when the track title doesn't. Phrases only: "Live Forever" is not. */
const albumMaterial = (album: string) => {
  const f = fold(album)
  const t = new Set(tokens(f, MATERIAL.filter(([n]) => n === 'acoustic' || n === 'instrumental')))
  if (/^live$|\blive (?:at|in|from|on)\b|\bin concert\b/.test(f) || parseTitle(album).material.has('live')) t.add('live')
  return t
}

const UNKNOWN_ARTIST = new Set(['', 'unknown', 'unknown artist', 'various artists', 'various', 'va'])
const SPLIT_ARTISTS = /\s*(?:,|;|\/|\bfeat\.?|\bft\.?|\bfeaturing\b|\bwith\b|\bx\b|&|\band\b|\+)\s*/i

export const unknownArtist = (artist: string) => UNKNOWN_ARTIST.has(fold(artist))

function artistScore(trackArtist: string, names: string[]): number {
  const whole = fold(trackArtist.replace(/\s(?:feat\.?|ft\.?|featuring)\s.*$/i, ''))
  const theirs = names.map(fold)
  if (theirs.includes(whole) || fold(names.join(' & ')) === whole || fold(names.join(', ')) === whole) return 1
  const mine = trackArtist.split(SPLIT_ARTISTS).map(fold).filter(Boolean)
  if (mine[0] && mine[0] === theirs[0]) return 0.9
  return mine.some((a) => theirs.includes(a)) ? 0.6 : 0
}

function durationScore(diff: number): number | null {
  if (diff <= 2) return 1
  if (diff <= 4) return 0.7
  if (diff <= 7) return 0.35
  if (diff <= 10) return 0.1
  return null // a different edit/performance
}

const setsEqual = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x))
const diff = (a: Set<string>, b: Set<string>) => [...a].filter((x) => !b.has(x)).concat([...b].filter((x) => !a.has(x)))

/** Scores one candidate against the library track. Every point is explained by a signal. */
export function scoreCandidate(track: LyricsTrack, c: SpotifyCandidate): ScoredCandidate {
  const signals: MatchSignal[] = []
  const reject = (rejected: string): ScoredCandidate => ({ candidate: c, score: 0, signals, rejected })
  const mine = parseTitle(track.title)
  const theirs = parseTitle(c.name)
  const seconds = c.durationMs / 1000
  const delta = track.duration > 0 && seconds > 0 ? Math.abs(track.duration - seconds) : null
  const isrc = !!c.isrc && (track.isrc ?? []).includes(c.isrc)

  // Version: live/remix/acoustic/… on one side only is a different recording, whatever else matches.
  const myMaterial = new Set([...mine.material, ...albumMaterial(track.album)])
  const theirMaterial = new Set([...theirs.material, ...albumMaterial(c.album)])
  const versionGap = diff(myMaterial, theirMaterial)
  if (versionGap.length) return reject(`different version (${versionGap.join(', ')})`)
  if (delta !== null && durationScore(delta) === null) return reject(`duration differs by ${Math.round(delta)} s`)

  if (isrc && (delta === null || delta <= 3)) {
    // The same ISRC is the same recording: trust it over spelling differences (translations, transliterations).
    signals.push({ name: 'isrc', value: 0.97, note: `ISRC ${c.isrc}` })
  } else {
    const title = mine.full === theirs.full ? 1 : mine.base === theirs.base && mine.base ? 0.8 : 0
    if (!title) return reject('title differs')
    signals.push({ name: 'title', value: WEIGHTS.title * title, note: title === 1 ? 'title matches' : 'title matches without qualifiers' })

    if (!unknownArtist(track.artist)) {
      const artist = artistScore(track.artist, c.artists)
      if (!artist) return reject('artist differs')
      signals.push({ name: 'artist', value: WEIGHTS.artist * artist, note: artist === 1 ? 'artist matches' : 'artist partly matches' })
    }
    if (delta !== null) signals.push({ name: 'duration', value: WEIGHTS.duration * durationScore(delta)!, note: `duration within ${delta.toFixed(1)} s` })
    // Album is a tie-breaker (singles and compilations carry the same recording), never a gate.
    const myAlbum = parseTitle(track.album)
    const theirAlbum = parseTitle(c.album)
    const album = myAlbum.full && myAlbum.full === theirAlbum.full ? 1 : myAlbum.base && myAlbum.base === theirAlbum.base ? 0.8 : 0
    if (album) signals.push({ name: 'album', value: WEIGHTS.album * album, note: album === 1 ? 'album matches' : 'album matches without edition' })
  }

  const softGap = diff(mine.soft, theirs.soft)
  if (softGap.length) signals.push({ name: 'version', value: -0.08 * Math.min(2, softGap.length), note: `differs: ${softGap.join(', ')}` })
  if (track.explicit !== undefined && track.explicit !== c.explicit) signals.push({ name: 'explicit', value: -0.15, note: c.explicit ? 'explicit version' : 'clean version' })

  const score = Math.max(0, Math.min(1, signals.reduce((s, x) => s + x.value, 0)))
  return { candidate: c, score, signals }
}

/** Two candidates that are one recording released twice (single + album, re-release): picking either is fine. */
function sameRecording(track: LyricsTrack, a: SpotifyCandidate, b: SpotifyCandidate): boolean {
  if (a.isrc && a.isrc === b.isrc) return true
  const ta = parseTitle(a.name)
  const tb = parseTitle(b.name)
  return (
    ta.base === tb.base &&
    setsEqual(ta.material, tb.material) &&
    Math.abs(a.durationMs - b.durationMs) <= 1500 &&
    (track.explicit === undefined || a.explicit === b.explicit)
  )
}

/**
 * Decides whether the candidates contain the track's recording. Accepts automatically only a confident match with
 * no materially different recording close behind it; offers the plausible ones when unsure; otherwise none.
 * Without a known artist (or duration, which caps the score below ACCEPT) only an ISRC match is accepted.
 */
export function resolveMatch(track: LyricsTrack, candidates: SpotifyCandidate[]): Resolution {
  const viable = candidates
    .map((c, i) => ({ ...scoreCandidate(track, c), i }))
    .filter((s) => !s.rejected && s.score > 0)
    // Ties: when explicitness is unknown prefer the explicit (original) release, then Spotify's relevance order.
    .sort((a, b) => b.score - a.score || (track.explicit === undefined ? Number(b.candidate.explicit) - Number(a.candidate.explicit) : 0) || a.i - b.i)
  const best = viable[0]
  if (!best) return { status: 'none' }

  const viaIsrc = best.signals.some((s) => s.name === 'isrc')
  const rival = viable.find((s) => s !== best && s.score >= best.score - MARGIN && !sameRecording(track, best.candidate, s.candidate))
  if (best.score >= ACCEPT && !rival && (viaIsrc || !unknownArtist(track.artist))) {
    return { status: 'matched', id: best.candidate.id, confidence: Number(best.score.toFixed(2)), candidate: best.candidate }
  }
  if (best.score < SUGGEST && !unknownArtist(track.artist)) return { status: 'none' }

  // One entry per distinct recording, best first.
  const distinct: SpotifyCandidate[] = []
  for (const s of viable) {
    if (s.score < SUGGEST * 0.9 && distinct.length) break
    if (!distinct.some((d) => sameRecording(track, d, s.candidate))) distinct.push(s.candidate)
    if (distinct.length === MAX_SUGGESTIONS) break
  }
  return { status: 'ambiguous', candidates: distinct }
}
