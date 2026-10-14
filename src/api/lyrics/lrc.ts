import type { LyricLine, LyricWord } from './types'

// [mm:ss], [mm:ss.x], [mm:ss.xx], [mm:ss.xxx] (':' also appears as the fraction separator).
const TIMESTAMP = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/y
const META = /^\[([a-z]+):(.*)\]$/i
const WORD_TAG = /<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/g
// Enhanced LRC (A2): <mm:ss.xx> before each word, optionally one more at the end of the line.
const WORD_SPLIT = /<(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?>/
/** A pause between sung lines this long gets an instrumental marker. */
export const GAP_S = 4
/** The marker finishes this long before the next line, so the line can be scrolled in ahead of its first word. */
const GAP_TAIL_S = 0.5
const seconds = (m: string, s: string, f?: string) => Number(m) * 60 + Number(s) + (f ? Number(`0.${f}`) : 0)

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
      pos = TIMESTAMP.lastIndex
      if (Number(m[2]) < 60) times.push(seconds(m[1]!, m[2]!, m[3]))
    }
    if (times.length) {
      const body = line.slice(pos)
      const text = body.replace(WORD_TAG, '').trim()
      // Word times are absolute, so they only belong to a line with a single timestamp.
      const words = times.length === 1 ? wordTags(body, times[0]!) : undefined
      for (const time of times) timed.push({ time, text, ...(words && { words }) })
      continue
    }
    const meta = META.exec(line)
    if (meta?.[1]?.toLowerCase() === 'offset') offsetMs = Number(meta[2]) || 0
  }

  if (timed.length) {
    // Positive LRC offset makes lyrics appear sooner, so subtract it.
    const shift = (t: number) => Math.max(0, t - offsetMs / 1000)
    const lines = timed
      .map((l) => ({ ...l, time: shift(l.time!), ...(l.words && { words: l.words.map((w) => ({ ...w, start: shift(w.start), end: shift(w.end) })) }) }))
      .sort((a, b) => a.time - b.time)
    // A last word without a closing tag ends where the next line starts.
    lines.forEach((l, i) => l.words && fillTimes(l.words, l.time, lines[i + 1]?.time ?? NaN))
    return { synced: true, lines }
  }
  return { synced: false, lines: parsePlain(raw) }
}

/** Word timings from enhanced-LRC tags; undefined when the line has none or they are not in order. */
function wordTags(body: string, lineTime: number): LyricWord[] | undefined {
  const parts = body.split(WORD_SPLIT) // [before, mm, ss, frac, text, mm, ss, frac, text, …]
  if (parts.length < 5) return undefined
  const marks: { time: number; text: string }[] = parts[0]!.trim() ? [{ time: lineTime, text: parts[0]! }] : []
  for (let i = 1; i + 3 < parts.length; i += 4) {
    if (Number(parts[i + 1]) >= 60) return undefined
    marks.push({ time: seconds(parts[i]!, parts[i + 1]!, parts[i + 2]), text: parts[i + 3]! })
  }
  if (marks.some((m, i) => i > 0 && m.time < marks[i - 1]!.time)) return undefined
  const words: LyricWord[] = []
  marks.forEach((m, i) => {
    const text = m.text.trim()
    if (!text) return // a closing tag: it only ends the word before it
    const next = marks[i + 1]
    const joinNext = !!next?.text.trim() && !/\s$/.test(m.text) && !/^\s/.test(next.text)
    words.push({ text, start: m.time, end: next?.time ?? NaN, ...(joinNext && { joinNext: true }) })
  })
  return words.length ? words : undefined
}

/**
 * Fills missing word times (NaN) from their neighbours, in place, and keeps each word's end at or after its start.
 * Returns [] when nothing anchors the line in time.
 */
export function fillTimes(words: LyricWord[], lineStart: number, lineEnd: number): LyricWord[] {
  const ok = Number.isFinite
  let prev = ok(lineStart) ? lineStart : words.find((w) => ok(w.start))?.start ?? NaN
  if (!ok(prev)) return []
  words.forEach((w, i) => {
    if (!ok(w.start)) w.start = prev
    if (!ok(w.end)) w.end = words.slice(i + 1).find((n) => ok(n.start))?.start ?? (ok(lineEnd) ? lineEnd : w.start)
    w.end = Math.max(w.start, w.end)
    prev = w.end
  })
  return words
}

/** When a line's singing ends: its last word (or backing vocal), or -Infinity when only the start is known. */
export function lineEnd(line: LyricLine): number {
  let end = -Infinity
  for (const w of line.words ?? []) end = Math.max(end, w.end)
  for (const b of line.background ?? []) for (const w of b.words ?? []) end = Math.max(end, w.end)
  return end
}

/**
 * Instrumental markers for synced lyrics: three dots timed across every pause, so the painter fills them like words.
 * Adds one for a long intro and after word-timed lines that end well before the next; times existing LRC gaps.
 */
export function withGaps(lines: LyricLine[]): LyricLine[] {
  const dots = (from: number, to: number): LyricLine => {
    const end = Math.max(from, to - GAP_TAIL_S)
    const step = (end - from) / 3
    return { time: from, text: '', words: [0, 1, 2].map((k) => ({ text: '•', start: from + k * step, end: from + (k + 1) * step })) }
  }
  const out: LyricLine[] = []
  if (lines[0]?.text && lines[0].time! >= GAP_S) out.push(dots(0, lines[0].time!))
  lines.forEach((l, i) => {
    const next = lines[i + 1]
    if (!l.text) return void out.push(next ? dots(l.time!, next.time!) : l)
    out.push(l)
    const end = lineEnd(l)
    if (next?.text && end > -Infinity && next.time! - end >= GAP_S) out.push(dots(end, next.time!))
  })
  return out
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
