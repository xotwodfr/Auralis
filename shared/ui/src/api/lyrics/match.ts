import type { LyricsTrack } from './types'

const VERSION_TOKENS = ['remix', 'live', 'acoustic', 'instrumental', 'cover', 'demo', 'edit']
const BASE_TOLERANCE_S = 3
const EXACT_TOLERANCE_S = 5

/** Casefold, drop bracketed qualifiers and `feat.` suffixes, strip punctuation, collapse spaces. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[([{][^)\]}]*[)\]}]/g, ' ')
    .replace(/\s(?:feat|ft)\.?\s.*$/, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const versionTokens = (...texts: string[]) => {
  const words = new Set(texts.join(' ').toLowerCase().split(/[^\p{L}\p{N}]+/u))
  return VERSION_TOKENS.filter((t) => words.has(t))
}

export interface LyricsCandidate {
  trackName: string
  artistName: string
  albumName?: string
  /** Seconds. */
  duration?: number
}

/**
 * Whether a candidate is the same recording as the track: normalized title + artist must match,
 * duration within tolerance, and neither side may carry a version token (live/remix/…) the other lacks.
 * shortcut: artists compare by exact normalized equality, so "A & B" vs "A" is rejected; loosen if reports appear.
 */
export function isMatch(track: LyricsTrack, c: LyricsCandidate): boolean {
  if (!normalize(track.title) || normalize(track.title) !== normalize(c.trackName)) return false
  if (normalize(track.artist) !== normalize(c.artistName)) return false

  const exact = track.title.trim().toLowerCase() === c.trackName.trim().toLowerCase()
  const tolerance = exact ? EXACT_TOLERANCE_S : BASE_TOLERANCE_S
  if (c.duration === undefined || Math.abs(c.duration - track.duration) > tolerance) return false

  const mine = versionTokens(track.title)
  const theirs = versionTokens(c.trackName)
  // A token in either title must also appear somewhere (title or album) on the other side.
  return (
    mine.every((t) => versionTokens(c.trackName, c.albumName ?? '').includes(t)) &&
    theirs.every((t) => versionTokens(track.title, track.album).includes(t))
  )
}
