import type { LyricLine } from './types'

// [mm:ss], [mm:ss.x], [mm:ss.xx], [mm:ss.xxx] (':' also appears as the fraction separator).
const TIMESTAMP = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/y
const META = /^\[([a-z]+):(.*)\]$/i
const WORD_TAG = /<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/g

export interface ParsedLyrics {
  synced: boolean
  lines: LyricLine[]
}

/**
 * Parses LRC (synchronized) or plain text. Text is only treated as synchronized if at least one
 * line carries a valid leading timestamp; malformed lines are skipped, never thrown on.
 */
export function parseLrc(input: string): ParsedLyrics {
  const raw = input.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)
  const timed: LyricLine[] = []
  let offsetMs = 0

  for (const row of raw) {
    const line = row.trim()
    const times: number[] = []
    let pos = 0
    for (;;) {
      TIMESTAMP.lastIndex = pos
      const m = TIMESTAMP.exec(line)
      if (!m) break
      const seconds = Number(m[2])
      pos = TIMESTAMP.lastIndex
      if (seconds < 60) times.push(Number(m[1]) * 60 + seconds + (m[3] ? Number(`0.${m[3]}`) : 0))
    }
    if (times.length) {
      const text = line.slice(pos).replace(WORD_TAG, '').trim()
      for (const time of times) timed.push({ time, text })
      continue
    }
    const meta = META.exec(line)
    if (meta?.[1]?.toLowerCase() === 'offset') offsetMs = Number(meta[2]) || 0
  }

  if (timed.length) {
    // Positive LRC offset makes lyrics appear sooner, so subtract it.
    const lines = timed.map((l) => ({ ...l, time: Math.max(0, l.time! - offsetMs / 1000) }))
    return { synced: true, lines: lines.sort((a, b) => a.time! - b.time!) }
  }
  return { synced: false, lines: parsePlain(raw) }
}

function parsePlain(rows: string[]): LyricLine[] {
  const lines: LyricLine[] = []
  for (const row of rows) {
    const text = row.replace(WORD_TAG, '').trim()
    if (META.test(text)) continue // [ar:..], [ti:..] etc.
    if (!text && (!lines.length || !lines[lines.length - 1]!.text)) continue // collapse blank runs, trim the start
    lines.push({ time: null, text })
  }
  while (lines.length && !lines[lines.length - 1]!.text) lines.pop()
  return lines
}

/** Index of the last line whose time is <= position, or -1 before the first line. */
export function activeLine(lines: LyricLine[], position: number): number {
  let lo = 0
  let hi = lines.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid]!.time! <= position) {
      found = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return found
}
