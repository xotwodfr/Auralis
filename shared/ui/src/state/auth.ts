import { create } from 'zustand'
import { normalizeBaseUrl } from '../api/subsonic/auth'
import { clearLyricsCache } from '../api/lyrics/cache'
import { clearSpotifyMatches } from '../api/lyrics/resolve'
import { clearCoverArtUrls, getOpenSubsonicExtensions, ping } from '../api/subsonic/endpoints'
import { isAborted } from '../api/subsonic/errors'
import type { Capabilities, Session } from '../api/subsonic/types'
import { kvDelete, kvGet, kvSet } from '../lib/storage'

const KEY = 'session'

export interface ConnectInput {
  baseUrl: string
  username: string
  password: string
  remember: boolean
}

interface AuthState {
  session: Session | null
  /** False until the stored session (if any) has been read. */
  hydrated: boolean
  connect: (input: ConnectInput, signal?: AbortSignal) => Promise<void>
  restore: () => Promise<void>
  /** Drop the session and any stored credentials. */
  disconnect: () => Promise<void>
  /** Keep the session in memory but delete stored credentials. */
  forgetDevice: () => Promise<void>
}

const NO_CAPABILITIES: Capabilities = { openSubsonic: false, extensions: [], songLyrics: false }

/** Non-OpenSubsonic servers may reject this call; that just means "no extensions". */
async function detectCapabilities(baseUrl: string, signal?: AbortSignal): Promise<Capabilities> {
  try {
    const { openSubsonicExtensions: extensions = [] } = await getOpenSubsonicExtensions(baseUrl, signal)
    return { openSubsonic: true, extensions, songLyrics: extensions.some((e) => e.name === 'songLyrics') }
  } catch (e) {
    if (isAborted(e)) throw e
    return NO_CAPABILITIES
  }
}

const isSession = (v: unknown): v is Session => {
  const s = v as Partial<Session> | null
  return (
    typeof s === 'object' &&
    s !== null &&
    typeof s.credentials?.baseUrl === 'string' &&
    typeof s.credentials.username === 'string' &&
    typeof s.credentials.password === 'string' &&
    typeof s.server?.apiVersion === 'string' &&
    Array.isArray(s.capabilities?.extensions) &&
    typeof s.capabilities.songLyrics === 'boolean' &&
    typeof s.capabilities.openSubsonic === 'boolean' &&
    typeof s.remember === 'boolean'
  )
}

/** Per-session derived data: signed URLs carry tokens, and cached lyrics belong to the signed-out account. */
function forgetSessionData() {
  clearCoverArtUrls()
  void clearLyricsCache().catch(() => undefined)
  void clearSpotifyMatches().catch(() => undefined)
}

export const useAuth = create<AuthState>()((set, get) => ({
  session: null,
  hydrated: false,

  async connect({ baseUrl, username, password, remember }, signal) {
    const credentials = { baseUrl: normalizeBaseUrl(baseUrl), username: username.trim(), password }
    const info = await ping(credentials, signal)
    const capabilities = await detectCapabilities(credentials.baseUrl, signal)
    const session: Session = {
      credentials,
      capabilities,
      remember,
      server: { apiVersion: info.version, type: info.type, serverVersion: info.serverVersion },
    }
    const before = get().session?.credentials
    if (before && (before.baseUrl !== credentials.baseUrl || before.username !== credentials.username)) forgetSessionData()
    set({ session })
    // shortcut: a failed IndexedDB write silently leaves the session memory-only; surface it if users report it.
    await (remember ? kvSet(KEY, session) : kvDelete(KEY)).catch(() => undefined)
  },

  async restore() {
    const stored = await kvGet<unknown>(KEY).catch(() => undefined)
    if (stored !== undefined && !isSession(stored)) void kvDelete(KEY).catch(() => undefined) // corrupt: don't keep re-reading it
    set((s) => ({ hydrated: true, session: s.session ?? (isSession(stored) ? stored : null) }))
  },

  async disconnect() {
    set({ session: null })
    forgetSessionData()
    await kvDelete(KEY)
  },

  async forgetDevice() {
    await kvDelete(KEY)
    const { session } = get()
    if (session) set({ session: { ...session, remember: false } })
  },
}))
