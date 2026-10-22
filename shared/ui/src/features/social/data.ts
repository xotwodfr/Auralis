import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { getNowPlaying } from '../../api/subsonic/endpoints'
import type { NowPlayingEntry } from '../../api/subsonic/types'
import { useAuth } from '../../state/auth'

/** How often a Social view refreshes who is playing what. */
export const ACTIVITY_POLL_MS = 30_000

export const sameUser = (a: string, b: string | undefined) => !!b && a.toLowerCase() === b.toLowerCase()

export const useMe = () => useAuth((s) => s.session?.credentials.username)

/** Everyone's current track on this server, refreshed while a Social view is mounted and the window is visible. */
export function useActivity() {
  const c = useAuth((s) => s.session?.credentials)
  return useQuery({
    queryKey: [c?.baseUrl, c?.username, 'social', 'nowPlaying'],
    queryFn: ({ signal }) => getNowPlaying(c!, signal),
    enabled: !!c,
    refetchInterval: ACTIVITY_POLL_MS,
    staleTime: 10_000,
  })
}

/**
 * "Listening now" only while the report is fresh: within the track's length (plus a minute of slack) and not paused.
 * Anything older is shown as a past play with its age, never as live.
 */
export function isLive(e: NowPlayingEntry): boolean {
  if (e.paused) return false
  return e.minutesAgo <= (e.song.duration > 0 ? e.song.duration / 60 + 1 : 10)
}

export function formatAgo(minutes: number): string {
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${Math.round(minutes)} min ago`
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} h ago`
  return `${Math.round(minutes / 60 / 24)} d ago`
}

export function statusText(e: NowPlayingEntry): string {
  const state = e.paused ? 'Paused' : isLive(e) ? 'Listening now' : `Played ${formatAgo(e.minutesAgo)}`
  return e.playerName ? `${state} · ${e.playerName}` : state
}

export interface Person {
  name: string
  /** Their newest now-playing report, if the server has one. */
  entry?: NowPlayingEntry
}

/** Everyone the server has shown us. Subsonic has no user directory or friends list for ordinary accounts, so this is all there is to know. */
export function people(entries: NowPlayingEntry[], me: string | undefined): Person[] {
  const byName = new Map<string, Person>()
  const get = (name: string) => byName.get(name.toLowerCase()) ?? byName.set(name.toLowerCase(), { name }).get(name.toLowerCase())!
  for (const e of entries) {
    if (sameUser(e.username, me)) continue
    const p = get(e.username)
    if (!p.entry || e.minutesAgo < p.entry.minutesAgo) p.entry = e
  }
  const rank = (p: Person) => (p.entry && isLive(p.entry) ? 0 : p.entry ? 1 : 2)
  return [...byName.values()].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

export function usePeople() {
  const me = useMe()
  const activity = useActivity()
  const list = useMemo(() => people(activity.data ?? [], me), [activity.data, me])
  return { activity, people: list }
}
