// HTTP client for the Auralis chat server (CHAT.md §5). Bearer token, timeouts, typed errors that never contain the
// token, and every response checked before it reaches the store.
import type { AdminUser, AuthResult, Conversation, ErrorBody, Me, Message, MessagePage, ServerInfo, SessionInfo, UserSummary } from '../../../../chat-protocol'
import { isAuthResult, isConversation, isMe, isMessage, isPage, isServerInfo, isSession, isUser, listOf } from './validate'

export const PROTOCOL = 1
const TIMEOUT_MS = 15_000

/** `network` covers unreachable hosts, CORS refusals and untrusted certificates: the browser reports them identically. */
export type ChatErrorKind = 'network' | 'timeout' | 'http' | 'invalid-response'

export class ChatError extends Error {
  readonly kind: ChatErrorKind
  readonly status: number
  readonly code: string
  readonly retryAfter?: number
  constructor(kind: ChatErrorKind, message: string, status = 0, code = '', retryAfter?: number) {
    super(message)
    this.name = 'ChatError'
    this.kind = kind
    this.status = status
    this.code = code
    this.retryAfter = retryAfter
  }
  /** Worth sending again later: the request may never have arrived, or the server was busy. */
  get retryable() {
    return this.kind === 'network' || this.kind === 'timeout' || this.status === 429 || this.status >= 500
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  token?: string | null
  body?: unknown
  signal?: AbortSignal
}

async function request<T>(base: string, path: string, guard: ((v: unknown) => v is T) | null, opts: RequestOptions = {}): Promise<T> {
  // Combined by hand: AbortSignal.any is too new for some WebKitGTK/Safari versions the desktop and Apple builds meet.
  const ctl = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => ((timedOut = true), ctl.abort()), TIMEOUT_MS)
  const onAbort = () => ctl.abort()
  opts.signal?.addEventListener('abort', onAbort, { once: true })
  let res: Response
  try {
    res = await fetch(`${base}${path}`, {
      method: opts.method ?? 'GET',
      headers: {
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: ctl.signal,
      credentials: 'omit',
      cache: 'no-store',
    })
  } catch (e) {
    if (opts.signal?.aborted) throw e
    if (timedOut) throw new ChatError('timeout', 'The chat server took too long to answer.')
    throw new ChatError('network', 'Couldn’t reach the chat server.')
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onAbort)
  }
  const text = await res.text().catch(() => '')
  let json: unknown
  try {
    json = text ? JSON.parse(text) : undefined
  } catch {
    json = undefined
  }
  if (!res.ok) {
    const err = (json as ErrorBody | undefined)?.error
    const retry = Number(res.headers.get('retry-after')) || undefined
    throw new ChatError('http', typeof err?.message === 'string' ? err.message : `The chat server answered HTTP ${res.status}.`, res.status, typeof err?.code === 'string' ? err.code : '', retry)
  }
  if (guard === null) return undefined as T
  if (!guard(json)) throw new ChatError('invalid-response', 'The chat server sent something this app doesn’t understand.')
  return json
}

const isSent = (v: unknown): v is { message: Message } => typeof v === 'object' && v !== null && isMessage((v as { message: unknown }).message)
const isRead = (v: unknown): v is { lastReadSeq: number } => typeof v === 'object' && v !== null && typeof (v as { lastReadSeq: unknown }).lastReadSeq === 'number'
const isAdminUser = (v: unknown): v is AdminUser => isMe(v) && typeof (v as unknown as { disabled: unknown }).disabled === 'boolean'
const isInvite = (v: unknown): v is { code: string; expiresAt: string } => typeof v === 'object' && v !== null && typeof (v as { code: unknown }).code === 'string'

const id = encodeURIComponent

/** One server's API. `token` is read at call time, so the client survives sign-in/out. */
export function chatApi(base: string, token: () => string | null) {
  const call = <T>(path: string, guard: ((v: unknown) => v is T) | null, opts: Omit<RequestOptions, 'token'> = {}) => request(base, path, guard, { ...opts, token: token() })
  return {
    serverInfo: (signal?: AbortSignal) => request<ServerInfo>(base, '/api/v1/server-info', isServerInfo, { signal }),
    login: (body: { username: string; password: string; deviceName?: string }) => request<AuthResult>(base, '/api/v1/auth/login', isAuthResult, { method: 'POST', body }),
    register: (body: { username: string; password: string; displayName?: string; inviteCode?: string; deviceName?: string }) =>
      request<AuthResult>(base, '/api/v1/auth/register', isAuthResult, { method: 'POST', body }),
    logout: () => call('/api/v1/auth/logout', null, { method: 'POST' }),
    sessions: () => call<SessionInfo[]>('/api/v1/auth/sessions', listOf(isSession)),
    revokeSession: (sessionId: string) => call('/api/v1/auth/sessions/revoke', null, { method: 'POST', body: { sessionId } }),
    revokeOtherSessions: () => call('/api/v1/auth/sessions/revoke', null, { method: 'POST', body: { others: true } }),
    me: () => call<Me>('/api/v1/me', isMe),
    searchUsers: (q: string, signal?: AbortSignal) => call<UserSummary[]>(`/api/v1/users/search?q=${id(q)}`, listOf(isUser), { signal }),
    conversations: () => call<Conversation[]>('/api/v1/conversations', listOf(isConversation)),
    conversation: (cid: string) => call<Conversation>(`/api/v1/conversations/${id(cid)}`, isConversation),
    createDirect: (userId: string) => call<Conversation>('/api/v1/conversations/direct', isConversation, { method: 'POST', body: { userId } }),
    createGroup: (title: string, memberIds: string[]) => call<Conversation>('/api/v1/conversations/group', isConversation, { method: 'POST', body: { title, memberIds } }),
    rename: (cid: string, title: string) => call<Conversation>(`/api/v1/conversations/${id(cid)}`, isConversation, { method: 'PATCH', body: { title } }),
    addMembers: (cid: string, userIds: string[]) => call<Conversation>(`/api/v1/conversations/${id(cid)}/members`, isConversation, { method: 'POST', body: { userIds } }),
    removeMember: (cid: string, userId: string) => call(`/api/v1/conversations/${id(cid)}/members/${id(userId)}`, null, { method: 'DELETE' }),
    messages: (cid: string, q: { beforeSeq?: number; afterSeq?: number; limit?: number }) => {
      const params = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))
      return call<MessagePage>(`/api/v1/conversations/${id(cid)}/messages?${params}`, isPage)
    },
    send: (cid: string, clientMessageId: string, body: string) => call(`/api/v1/conversations/${id(cid)}/messages`, isSent, { method: 'POST', body: { clientMessageId, body } }).then((r) => r.message),
    deleteMessage: (cid: string, messageId: string) => call(`/api/v1/conversations/${id(cid)}/messages/${id(messageId)}`, null, { method: 'DELETE' }),
    read: (cid: string, seq: number) => call(`/api/v1/conversations/${id(cid)}/read`, isRead, { method: 'POST', body: { seq } }),
    createInvite: (maxUses: number, expiresInHours: number) => call('/api/v1/admin/invites', isInvite, { method: 'POST', body: { maxUses, expiresInHours } }),
    adminUsers: () => call<AdminUser[]>('/api/v1/admin/users', listOf(isAdminUser)),
  }
}

export type ChatApi = ReturnType<typeof chatApi>

/**
 * UUID v4 from getRandomValues. Not crypto.randomUUID: that exists only in secure contexts, and a plain-http LAN origin
 * isn't one.
 */
export function uuid4(): string {
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6]! & 0x0f) | 0x40
  b[8] = (b[8]! & 0x3f) | 0x80
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** What to tell the user about a failed chat request (CHAT.md §10.2). `origin` is this app's origin, for the CORS hint. */
export function chatErrorMessage(e: unknown, context: 'connect' | 'login' | 'action' = 'action'): string {
  if (!(e instanceof ChatError)) return 'Something went wrong. Try again.'
  if (e.kind === 'network') {
    const origin = globalThis.location?.origin
    return `Couldn’t reach the chat server. Check the address and that this device is on the same network or Tailscale. If the server is up, its certificate may not be trusted, or it may not allow this app (ask the admin to add ${origin && origin !== 'null' ? origin : 'this app’s origin'} to CHAT_ALLOWED_ORIGINS).`
  }
  if (e.kind === 'timeout') return 'The chat server took too long to answer. Try again.'
  if (e.kind === 'invalid-response' && e.code === 'protocol') return e.message
  if (e.kind === 'invalid-response') return 'That address answered, but it isn’t an Auralis chat server (or is an incompatible version).'
  if (e.status === 401 && context === 'login') return 'Wrong username or password.'
  if (e.status === 401) return 'Your chat session has ended. Sign in again.'
  if (e.status === 503) return 'The chat server is starting up (not ready). Try again in a moment.'
  return e.message
}
