import { create } from 'zustand'
import type { Me, ServerInfo } from '../../../chat-protocol'
import { ChatError, PROTOCOL, chatApi, type ChatApi } from '../api/chat/client'
import type { SocketState } from '../api/chat/socket'
import { chatKv } from '../lib/storage'
import { useAuth } from './auth'

// The chat server connection (CHAT.md §10): its address, which server that is (instanceId), and the signed-in chat
// account. Stored separately from the Subsonic session (`auralis-chat`), but signed in with the same credentials: the
// chat server accepts Navidrome logins (CHAT.md §7.1), so a configured chat server signs in by itself (autoSignIn below).

interface SavedConfig {
  url: string
  allowInsecure: boolean
  info: ServerInfo
}
interface SavedSession {
  instanceId: string
  token: string
  user: Me
}

export type SaveResult = 'saved' | 'moved' | { otherServer: ServerInfo }

interface ChatServerState {
  hydrated: boolean
  url: string | null
  allowInsecure: boolean
  info: ServerInfo | null
  user: Me | null
  /** In memory; also in `auralis-chat` only when `remember` is on. Never a password: those are never stored. */
  token: string | null
  remember: boolean
  connection: SocketState
  restore: () => Promise<void>
  /** Reads server-info from an address without saving anything. Throws ChatError. */
  probe: (url: string) => Promise<ServerInfo>
  /** Same instanceId: only the address changes ("moved"). Different: the caller confirms, then calls switchServer. */
  saveAddress: (url: string, allowInsecure: boolean) => Promise<SaveResult>
  switchServer: (url: string, allowInsecure: boolean, info: ServerInfo) => Promise<void>
  signIn: (username: string, password: string, remember: boolean) => Promise<void>
  register: (fields: { username: string; password: string; displayName?: string; inviteCode?: string }, remember: boolean) => Promise<void>
  signOut: () => Promise<void>
  removeServer: () => Promise<void>
  /** The server ended the session (4401, or 401 on a request): forget the token, keep the address. */
  sessionEnded: () => void
  setConnection: (s: SocketState) => void
}

const INITIAL = { url: null, allowInsecure: false, info: null, user: null, token: null, remember: false, connection: { status: 'closed' } as SocketState }

/** The token and the unsent messages written with it (state/chat.ts) leave storage together. */
const forgetSession = () => Promise.all([chatKv.delete('session'), chatKv.delete('outbox')]).catch(() => undefined)

let cached: { url: string; api: ChatApi } | null = null
/** The API for the saved server, or null when none is configured. */
export function chatServerApi(): ChatApi | null {
  const { url } = useChatServer.getState()
  if (!url) return null
  if (cached?.url !== url) cached = { url, api: chatApi(url, () => useChatServer.getState().token) }
  return cached.api
}

const deviceName = () => `Auralis on ${(globalThis.navigator?.platform || 'this device').slice(0, 40)}`

function checkProtocol(info: ServerInfo) {
  if (info.protocol !== PROTOCOL) throw new ChatError('invalid-response', `The server is a different version (protocol ${info.protocol}, this app supports ${PROTOCOL}).`, 0, 'protocol')
  return info
}

export const useChatServer = create<ChatServerState>()((set, get) => {
  async function persistSession(token: string, user: Me, remember: boolean) {
    const info = get().info
    set({ token, user, remember })
    if (remember && info) await chatKv.set('session', { instanceId: info.instanceId, token, user } satisfies SavedSession).catch(() => undefined)
    else await forgetSession()
  }

  return {
    hydrated: false,
    ...INITIAL,

    async restore() {
      try {
        const [config, session] = await Promise.all([chatKv.get<SavedConfig>('config'), chatKv.get<SavedSession>('session')])
        if (config && typeof config.url === 'string' && config.info && typeof config.info.instanceId === 'string') {
          set({ url: config.url, allowInsecure: config.allowInsecure === true, info: config.info })
          // A session belongs to one server instance: never reuse it against another.
          if (session && session.instanceId === config.info.instanceId && typeof session.token === 'string' && session.user) {
            set({ token: session.token, user: session.user, remember: true })
          }
        }
      } catch {
        // Storage unavailable (private mode): start unconfigured.
      }
      set({ hydrated: true })
    },

    probe: (url) => chatApi(url, () => null).serverInfo().then(checkProtocol),

    async saveAddress(url, allowInsecure) {
      const info = await get().probe(url)
      const current = get().info
      if (current && current.instanceId !== info.instanceId) return { otherServer: info }
      const moved = !!current && get().url !== url
      set({ url, allowInsecure, info })
      await chatKv.set('config', { url, allowInsecure, info } satisfies SavedConfig)
      return moved ? 'moved' : 'saved'
    },

    async switchServer(url, allowInsecure, info) {
      await get().signOut()
      // Only the chat database goes: the music session, settings, queue and caches live in `auralis`.
      await chatKv.destroy().catch(() => undefined)
      set({ ...INITIAL, url, allowInsecure, info })
      await chatKv.set('config', { url, allowInsecure, info } satisfies SavedConfig)
    },

    async signIn(username, password, remember) {
      const api = chatServerApi()
      if (!api) throw new ChatError('invalid-response', 'Save the chat server address first.')
      const r = await api.login({ username: username.trim(), password, deviceName: deviceName() })
      await persistSession(r.token, r.user, remember)
    },

    async register(fields, remember) {
      const api = chatServerApi()
      if (!api) throw new ChatError('invalid-response', 'Save the chat server address first.')
      const r = await api.register({ ...fields, username: fields.username.trim(), deviceName: deviceName() })
      await persistSession(r.token, r.user, remember)
    },

    async signOut() {
      const api = chatServerApi()
      if (get().token && api) await api.logout().catch(() => undefined) // best effort: offline still signs out here
      set({ token: null, user: null, remember: false })
      await forgetSession()
    },

    async removeServer() {
      await get().signOut()
      await chatKv.destroy().catch(() => undefined)
      cached = null
      set({ ...INITIAL })
    },

    sessionEnded() {
      set({ token: null, user: null, remember: false })
      void forgetSession()
    },

    setConnection: (connection) => set({ connection }),
  }
})

// ---- automatic sign-in with the music-server credentials (CHAT.md §7.1) ----

/** One try per address + credentials per app run: a wrong password, a manual sign-out or a revoked session is not
 *  retried in a loop. The key lives in memory only. */
let tried: string | null = null

export function autoSignIn() {
  const chat = useChatServer.getState()
  const { session, hydrated } = useAuth.getState()
  if (!chat.hydrated || !hydrated || !chat.url || chat.token || !session) return
  const { username, password } = session.credentials
  const key = JSON.stringify([chat.url, username, password])
  if (tried === key) return
  tried = key
  chat.signIn(username, password, session.remember).catch(() => undefined) // the Settings form still works by hand
}

/** Signing in to the music server as someone else moves chat to that account too. */
useAuth.subscribe((s, prev) => {
  const before = prev.session?.credentials
  const now = s.session?.credentials
  const chat = useChatServer.getState()
  if (before && now && before.username !== now.username && chat.token && chat.user?.username !== now.username.toLowerCase()) {
    void chat.signOut().then(autoSignIn)
  } else autoSignIn()
})
useChatServer.subscribe(autoSignIn)
