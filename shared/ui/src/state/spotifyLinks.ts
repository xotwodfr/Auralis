import { create } from 'zustand'
import type { Credentials } from '../api/subsonic/types'
import { kvGet, kvSet } from '../lib/storage'

// Spicy Lyrics is addressed by Spotify track id, which Navidrome doesn't have. Tracks are matched automatically when
// the backend can search Spotify (api/lyrics/resolve.ts); a link the user makes or confirms here always wins over that.
const KEY = 'spotify-links'
/** Stored instead of an id when the user turned Spicy Lyrics off for a track (e.g. a wrong automatic match). */
export const NO_SPOTIFY = 'none'
const MAX_LINKS = 5000

const ID = /^[A-Za-z0-9]{22}$/

/** Accepts a bare id, `spotify:track:<id>`, or an open.spotify.com track URL (with optional /intl-xx/ and query). */
export function parseSpotifyTrackId(input: string): string | null {
  const text = input.trim()
  if (ID.test(text)) return text
  const uri = /^spotify:track:([A-Za-z0-9]{22})$/.exec(text)
  if (uri) return uri[1]!
  try {
    const url = new URL(text)
    if (url.protocol !== 'https:' || url.hostname !== 'open.spotify.com') return null
    const m = /^\/(?:intl-[a-z-]+\/)?track\/([A-Za-z0-9]{22})\/?$/.exec(url.pathname)
    return m ? m[1]! : null
  } catch {
    return null
  }
}

export const linkKey = (c: Pick<Credentials, 'baseUrl' | 'username'>, trackId: string) => `${c.baseUrl}|${c.username}|${trackId}`

interface LinksState {
  links: Record<string, string>
  link: (key: string, spotifyId: string) => void
  unlink: (key: string) => void
  clear: () => void
  restore: () => Promise<void>
}

const persist = (links: Record<string, string>) => void kvSet(KEY, links).catch(() => undefined)

export const useSpotifyLinks = create<LinksState>()((set, get) => ({
  links: {},
  link(key, spotifyId) {
    const links = { ...get().links }
    delete links[key] // re-insert at the end so the oldest are evicted first
    links[key] = spotifyId
    for (const old of Object.keys(links).slice(0, Math.max(0, Object.keys(links).length - MAX_LINKS))) delete links[old]
    set({ links })
    persist(links)
  },
  unlink(key) {
    const links = { ...get().links }
    delete links[key]
    set({ links })
    persist(links)
  },
  clear() {
    set({ links: {} })
    persist({})
  },
  async restore() {
    const saved = await kvGet<unknown>(KEY).catch(() => undefined)
    if (typeof saved !== 'object' || saved === null) return
    const valid = Object.fromEntries(Object.entries(saved).filter((e): e is [string, string] => typeof e[1] === 'string' && (ID.test(e[1]) || e[1] === NO_SPOTIFY)))
    set((s) => ({ links: { ...valid, ...s.links } })) // links made while reading win
  },
}))
