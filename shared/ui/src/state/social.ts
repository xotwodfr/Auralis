import { create } from 'zustand'
import { addChatMessage, getChatMessages } from '../api/subsonic/endpoints'
import { SubsonicError } from '../api/subsonic/errors'
import type { ChatMessage, Credentials } from '../api/subsonic/types'
import { kvGet, kvSet } from '../lib/storage'
import { useAuth } from './auth'

/** Longest message we send: it travels in the request URL (see `addChatMessage`). */
export const MAX_MESSAGE = 1000
/** Messages kept in memory; older ones scroll away. */
const KEEP = 300

/**
 * `unknown` until the first fetch; `unsupported` when the server has no chat (Navidrome answers HTTP 410). `error` keeps
 * whatever messages were already loaded on screen.
 */
export type ChatStatus = 'unknown' | 'loading' | 'ready' | 'unsupported' | 'error'

interface SocialState {
  chat: ChatStatus
  chatError: unknown
  /** The server-wide room, oldest first. */
  messages: ChatMessage[]
  /** Time of the newest message the user has seen; others' messages after it are unread. Undefined until loaded. */
  lastRead: number | undefined
  /** Fetches new messages (all of them the first time). Never throws; the outcome lands in `chat`/`chatError`. */
  refreshChat: () => Promise<void>
  /** Throws on failure so the composer can keep the draft and say so. Nothing is shown as sent until the server has it. */
  sendChat: (text: string) => Promise<void>
  markRead: () => void
  reset: () => void
}

const credentials = (): Credentials | undefined => useAuth.getState().session?.credentials
const accountKey = (c: Credentials) => `${c.baseUrl}|${c.username}`
const readKey = (c: Credentials) => `social:lastRead:${accountKey(c)}`
const id = (m: ChatMessage) => `${m.time}|${m.username}|${m.message}`

/** Servers without chat answer with an HTTP error, a "not found" code, or (behind an SPA fallback) a non-Subsonic page. */
export function isUnsupported(e: unknown): boolean {
  if (!(e instanceof SubsonicError)) return false
  if (e.kind === 'http') return e.status === 404 || e.status === 405 || e.status === 410 || e.status === 501
  return e.kind === 'not-found' || e.kind === 'invalid-response'
}

export const sameUser = (a: string, b: string | undefined) => !!b && a.toLowerCase() === b.toLowerCase()

/** Others' messages since `lastRead`. */
export const unreadCount = (s: Pick<SocialState, 'messages' | 'lastRead'>, me: string | undefined) =>
  s.lastRead === undefined ? 0 : s.messages.reduce((n, m) => (m.time > s.lastRead! && !sameUser(m.username, me) ? n + 1 : n), 0)

let inFlight: Promise<void> | null = null

const INITIAL = { chat: 'unknown' as ChatStatus, chatError: null, messages: [] as ChatMessage[], lastRead: undefined }

export const useSocial = create<SocialState>()((set, get) => ({
  ...INITIAL,

  refreshChat() {
    const c = credentials()
    if (!c || get().chat === 'unsupported') return Promise.resolve()
    inFlight ??= (async () => {
      const key = accountKey(c)
      const before = get().messages
      if (!before.length && get().chat !== 'error') set({ chat: 'loading' })
      try {
        const [fresh, stored] = await Promise.all([
          getChatMessages(c, before.at(-1)?.time),
          get().lastRead === undefined ? kvGet<number>(readKey(c)).catch(() => undefined) : Promise.resolve(get().lastRead),
        ])
        const now = credentials()
        if (!now || accountKey(now) !== key) return // signed out or switched account meanwhile
        const seen = new Set(get().messages.map(id))
        const messages = [...get().messages, ...fresh.filter((m) => !seen.has(id(m)))].sort((a, b) => a.time - b.time).slice(-KEEP)
        // First visit ever: what is already there counts as read, so an old backlog doesn't light the badge.
        const lastRead = typeof stored === 'number' ? stored : (messages.at(-1)?.time ?? 0)
        if (stored === undefined) void kvSet(readKey(c), lastRead).catch(() => undefined)
        set({ chat: 'ready', chatError: null, messages, lastRead })
      } catch (e) {
        const now = credentials()
        if (!now || accountKey(now) !== key) return
        set(isUnsupported(e) ? { chat: 'unsupported', chatError: null } : { chat: 'error', chatError: e })
      }
    })().finally(() => {
      inFlight = null
    })
    return inFlight
  },

  async sendChat(text) {
    const c = credentials()
    const message = text.trim()
    if (!c) throw new SubsonicError('auth', 'Not signed in')
    if (!message || message.length > MAX_MESSAGE) throw new Error('invalid message')
    await addChatMessage(c, message)
    await inFlight // a poll that started before the send wouldn't include it
    await get().refreshChat()
    get().markRead()
  },

  markRead() {
    const c = credentials()
    const newest = get().messages.at(-1)?.time
    if (!c || newest === undefined || newest === get().lastRead) return
    set({ lastRead: newest })
    void kvSet(readKey(c), newest).catch(() => undefined)
  },

  reset() {
    inFlight = null
    set(INITIAL)
  },
}))

const accountOf = (s: { session: { credentials: Credentials } | null }) => (s.session ? accountKey(s.session.credentials) : null)

// Messages and read state belong to the account they were fetched for.
useAuth.subscribe((s, prev) => {
  if (accountOf(s) !== accountOf(prev)) useSocial.getState().reset()
})
