import { getLyrics, getLyricsBySongId } from '../../subsonic/endpoints'
import { SubsonicError } from '../../subsonic/errors'
import type { Credentials } from '../../subsonic/types'
import { parseLrc } from '../lrc'
import type { LyricLine, LyricsProvider } from '../types'

/** Server lyrics: `getLyricsBySongId` when the server advertises `songLyrics`, else legacy `getLyrics`. */
export function serverProvider(credentials: Credentials, hasSongLyrics: boolean): LyricsProvider {
  return {
    id: 'server',
    async fetch(track, signal) {
      try {
        if (hasSongLyrics) {
          const all = await getLyricsBySongId(credentials, track.id, signal)
          // Prefer a synchronized version; skip entries that carry no text.
          const usable = all.filter((l) => l.line.some((x) => x.value.trim()))
          const pick = usable.find((l) => l.synced && l.line.every((x) => typeof x.start === 'number')) ?? usable[0]
          if (!pick) return null
          const synced = pick.synced && pick.line.every((x) => typeof x.start === 'number')
          const offset = (pick.offset ?? 0) / 1000
          const lines: LyricLine[] = pick.line.map((x) => ({ time: synced ? Math.max(0, x.start! / 1000 - offset) : null, text: x.value.trim() }))
          return { synced, source: 'server', lines }
        }
        const text = await getLyrics(credentials, { artist: track.artist, title: track.title }, signal)
        if (!text.trim()) return null
        const parsed = parseLrc(text)
        return parsed.lines.length ? { ...parsed, source: 'server' } : null
      } catch (e) {
        if (e instanceof SubsonicError && e.kind === 'not-found') return null
        throw e
      }
    },
  }
}
