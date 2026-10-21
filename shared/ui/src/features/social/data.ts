import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo } from 'react'
import { getNowPlaying } from '../../api/subsonic/endpoints'
import type { ChatMessage, NowPlayingEntry } from '../../api/subsonic/types'
import { useAuth } from '../../state/auth'
import { startChat, useChatUnread } from '../../state/chat'
import { useChatServer } from '../../state/chatServer'
import { sameUser, unreadCount, useSocial } from '../../state/social'

/** How often a Social view refreshes who is playing what. */
export const ACTIVITY_POLL_MS = 30_000
/** Chat polling: in the background for the unread badge, and faster while a conversation is open. */
export const CHAT_POLL_BACKGROUND_MS = 60_000
export const CHAT_POLL_OPEN_MS = 10_000

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

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString()
const TIME = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const DAY_TIME = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
export const formatMessageTime = (ms: number, now = new Date()) => (sameDay(new Date(ms), now) ? TIME : DAY_TIME).format(ms)

export interface Person {
  name: string
  /** Their newest now-playing report, if the server has one. */
  entry?: NowPlayingEntry
  /** Their newest chat message, if any is loaded. */
  lastMessage?: ChatMessage
}

/**
 * Everyone the server has shown us: people with a now-playing report and people who posted in its chat. Subsonic has no
 * user directory or friends list for ordinary accounts, so this is all there is to know.
 */
export function people(entries: NowPlayingEntry[], messages: ChatMessage[], me: string | undefined): Person[] {
  const byName = new Map<string, Person>()
  const get = (name: string) => byName.get(name.toLowerCase()) ?? byName.set(name.toLowerCase(), { name }).get(name.toLowerCase())!
  for (const e of entries) {
    if (sameUser(e.username, me)) continue
    const p = get(e.username)
    if (!p.entry || e.minutesAgo < p.entry.minutesAgo) p.entry = e
  }
  for (const m of messages) if (!sameUser(m.username, me)) get(m.username).lastMessage = m // oldest first, so the last wins
  const rank = (p: Person) => (p.entry && isLive(p.entry) ? 0 : p.entry ? 1 : 2)
  return [...byName.values()].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

export function usePeople() {
  const me = useMe()
  const activity = useActivity()
  const messages = useSocial((s) => s.messages)
  const list = useMemo(() => people(activity.data ?? [], messages, me), [activity.data, messages, me])
  return { activity, people: list }
}

/** Unread across both sources: the Subsonic room and the chat server's conversations. */
export function useUnread(): number {
  const me = useMe()
  return useSocial((s) => unreadCount(s, me)) + useChatUnread()
}

/** Keeps the chat server socket open while signed in to it (one per app: the Shell / phone app mounts this). */
export function useChatConnection() {
  const url = useChatServer((s) => s.url)
  const token = useChatServer((s) => s.token)
  useEffect(() => (url && token ? startChat() : undefined), [url, token])
}

/** Keeps the chat (and so the unread count) fresh: every `ms` while the window is visible, and on returning to it. */
export function useChatPolling(ms: number) {
  const account = useAuth((s) => (s.session ? `${s.session.credentials.baseUrl}|${s.session.credentials.username}` : null))
  useEffect(() => {
    if (!account) return
    const refresh = () => {
      if (document.visibilityState === 'visible') void useSocial.getState().refreshChat()
    }
    refresh()
    const timer = window.setInterval(refresh, ms)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [account, ms])
}
