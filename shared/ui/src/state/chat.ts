import { create } from 'zustand'
import type { Conversation, Message, ServerEvent } from '../../../chat-protocol'
import { ChatError, chatErrorMessage, uuid4 } from '../api/chat/client'
import { ChatSocket } from '../api/chat/socket'
import { socketUrl } from '../api/chat/url'
import { chatKv } from '../lib/storage'
import { chatServerApi, useChatServer } from './chatServer'

// Chat server conversations and messages (CHAT.md §5.5, §10.5–10.6), fed by REST and the socket. Everything is keyed by
// conversation id and belongs to the signed-in chat account of one server instance; it is dropped when either changes.

/** Messages kept per conversation in memory. */
const KEEP = 2000
/** Sends are idempotent (clientMessageId), so a pending send is retried on reconnect up to this many times. */
export const MAX_ATTEMPTS = 5
/** A larger gap than this after a reconnect reloads the newest page instead of replaying everything. */
export const RESYNC_LIMIT = 500
const PAGE = 50

export interface Pending {
  clientMessageId: string
  body: string
  /** sending: in flight. waiting: will be retried when the connection is back. failed: needs the user (Retry/Discard). */
  status: 'sending' | 'waiting' | 'failed'
  attempts: number
  error?: string
  createdAt: string
}

interface ChatState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  conversations: Record<string, Conversation>
  messages: Record<string, Message[]>
  hasOlder: Record<string, boolean>
  /** Conversations the server answered 404 for: gone, or never ours. */
  missing: Record<string, true>
  outbox: Record<string, Pending[]>
  /** The conversation on screen; it is marked read as messages arrive while the window is visible. */
  open: string | null
  loadConversations: () => Promise<void>
  openConversation: (id: string | null) => Promise<void>
  loadOlder: (id: string) => Promise<void>
  send: (id: string, body: string) => void
  retry: (id: string, clientMessageId: string) => void
  discard: (id: string, clientMessageId: string) => void
  /** Sends everything that is waiting for the connection (on reconnect, and when the browser is back online). */
  flush: () => void
  markRead: (id: string) => void
  deleteMessage: (id: string, messageId: string) => Promise<void>
  /** Puts a conversation the server just returned (create, rename, add members) into the list. */
  upsert: (c: Conversation) => void
  handleEvent: (e: ServerEvent) => void
  reset: () => void
}

const INITIAL = { status: 'idle' as const, error: null, conversations: {}, messages: {}, hasOlder: {}, missing: {}, outbox: {}, open: null }

const me = () => useChatServer.getState().user?.id
/** Whose data this is: one chat account on one server instance. */
const ownerKey = () => `${useChatServer.getState().info?.instanceId}|${me()}`
export const unreadOf = (c: Conversation) => Math.max(0, c.lastSeq - c.lastReadSeq)

/** By id, ordered by seq. */
export function mergeMessages(list: Message[] | undefined, incoming: Message[]): Message[] {
  const byId = new Map((list ?? []).map((m) => [m.id, m]))
  for (const m of incoming) byId.set(m.id, m)
  return [...byId.values()].sort((a, b) => a.seq - b.seq).slice(-KEEP)
}

/** What a reconnect has to fetch for one conversation, given the newest seq we hold and the server's. */
export function planResync(localLast: number | undefined, serverLast: number): 'none' | 'reload' | { afterSeq: number } {
  if (localLast === undefined || serverLast <= localLast) return 'none'
  return serverLast - localLast > RESYNC_LIMIT ? 'reload' : { afterSeq: localLast }
}

/** Group title, or the other people's names for a direct conversation. */
export function conversationTitle(c: Conversation, myId: string | undefined): string {
  if (c.title) return c.title
  const others = c.members.filter((m) => m.id !== myId)
  return others.map((m) => m.displayName).join(', ') || 'Just you'
}

let socket: ChatSocket | null = null
const deliveries = new Map<string, Promise<void>>() // one chain per conversation keeps sends in order

export const useChat = create<ChatState>()((set, get) => {
  const api = () => {
    const a = chatServerApi()
    if (!a) throw new ChatError('invalid-response', 'No chat server is configured.')
    return a
  }
  /** Async results for anyone else are dropped. */
  const owner = ownerKey

  const setConversation = (c: Conversation) =>
    set((s) => {
      const missing = { ...s.missing }
      delete missing[c.id]
      return { conversations: { ...s.conversations, [c.id]: c }, missing }
    })

  const patchConversation = (id: string, patch: (c: Conversation) => Partial<Conversation>) =>
    set((s) => {
      const c = s.conversations[id]
      return c ? { conversations: { ...s.conversations, [id]: { ...c, ...patch(c) } } } : {}
    })

  const failed = (e: unknown) => {
    if (e instanceof ChatError && e.status === 401) useChatServer.getState().sessionEnded()
  }

  /** Everything after `afterSeq`, page by page. */
  async function fetchAfter(id: string, afterSeq: number) {
    const who = owner()
    let after = afterSeq
    for (let fetched = 0; fetched <= RESYNC_LIMIT; ) {
      const page = await api().messages(id, { afterSeq: after, limit: 100 })
      if (owner() !== who) return
      set((s) => ({ messages: { ...s.messages, [id]: mergeMessages(s.messages[id], page.messages) } }))
      fetched += page.messages.length
      if (!page.hasMore || !page.messages.length) return
      after = page.messages.at(-1)!.seq
    }
  }

  async function loadNewest(id: string) {
    const who = owner()
    const page = await api().messages(id, { limit: PAGE })
    if (owner() !== who) return
    set((s) => ({ messages: { ...s.messages, [id]: page.messages }, hasOlder: { ...s.hasOlder, [id]: page.hasMore } }))
  }

  function deliver(id: string, clientMessageId: string) {
    const run = async () => {
      const p = get().outbox[id]?.find((x) => x.clientMessageId === clientMessageId)
      if (!p || p.status === 'failed') return
      const update = (patch: Partial<Pending>) =>
        set((s) => ({ outbox: { ...s.outbox, [id]: (s.outbox[id] ?? []).map((x) => (x.clientMessageId === clientMessageId ? { ...x, ...patch } : x)) } }))
      update({ status: 'sending', attempts: p.attempts + 1 })
      try {
        const message = await api().send(id, clientMessageId, p.body)
        confirm(message)
      } catch (e) {
        failed(e)
        const retryable = e instanceof ChatError && e.retryable && e.status !== 401
        update(retryable && p.attempts + 1 < MAX_ATTEMPTS ? { status: 'waiting' } : { status: 'failed', error: chatErrorMessage(e) })
      }
    }
    const chain = (deliveries.get(id) ?? Promise.resolve()).then(run, run)
    deliveries.set(id, chain)
    return chain
  }

  /** A message the server has (from the send response or the socket): replaces its pending entry, updates the list. */
  function confirm(m: Message) {
    const mine = m.sender.id === me()
    set((s) => {
      const loaded = s.messages[m.conversationId]
      const outbox = m.clientMessageId ? (s.outbox[m.conversationId] ?? []).filter((p) => p.clientMessageId !== m.clientMessageId) : s.outbox[m.conversationId]
      return {
        messages: loaded ? { ...s.messages, [m.conversationId]: mergeMessages(loaded, [m]) } : s.messages,
        outbox: outbox ? { ...s.outbox, [m.conversationId]: outbox } : s.outbox,
      }
    })
    patchConversation(m.conversationId, (c) =>
      m.seq < c.lastSeq
        ? {}
        : { lastSeq: m.seq, lastMessage: m, lastMessageAt: m.createdAt, lastReadSeq: mine ? Math.max(c.lastReadSeq, m.seq) : c.lastReadSeq },
    )
  }

  return {
    ...INITIAL,

    async loadConversations() {
      const who = owner()
      if (get().status !== 'ready') set({ status: 'loading' })
      try {
        const list = await api().conversations()
        if (owner() !== who) return
        const before = get()
        set({ status: 'ready', error: null, conversations: Object.fromEntries(list.map((c) => [c.id, c])) })
        // Catch up every conversation we hold messages for (after a reconnect, or messages missed while away).
        for (const c of list) {
          const plan = planResync(before.messages[c.id]?.at(-1)?.seq, c.lastSeq)
          if (plan === 'reload') await loadNewest(c.id)
          else if (plan !== 'none') await fetchAfter(c.id, plan.afterSeq)
        }
        // Conversations we were removed from while away.
        set((s) => ({ messages: Object.fromEntries(Object.entries(s.messages).filter(([id]) => id in s.conversations)) }))
      } catch (e) {
        if (owner() !== who) return
        failed(e)
        set({ status: 'error', error: chatErrorMessage(e) })
      }
    },

    async openConversation(id) {
      set({ open: id })
      if (!id || get().messages[id]) return
      try {
        await loadNewest(id)
        get().markRead(id)
      } catch (e) {
        failed(e)
        if (e instanceof ChatError && e.status === 404) set((s) => ({ missing: { ...s.missing, [id]: true } }))
        else throw e
      }
    },

    async loadOlder(id) {
      const first = get().messages[id]?.[0]
      if (!first) return
      const who = owner()
      const page = await api().messages(id, { beforeSeq: first.seq, limit: PAGE })
      if (owner() !== who) return
      set((s) => ({ messages: { ...s.messages, [id]: mergeMessages(page.messages, s.messages[id] ?? []) }, hasOlder: { ...s.hasOlder, [id]: page.hasMore } }))
    },

    send(id, body) {
      const pending: Pending = { clientMessageId: uuid4(), body, status: 'sending', attempts: 0, createdAt: new Date().toISOString() }
      set((s) => ({ outbox: { ...s.outbox, [id]: [...(s.outbox[id] ?? []), pending] } }))
      void deliver(id, pending.clientMessageId)
    },

    retry(id, clientMessageId) {
      set((s) => ({ outbox: { ...s.outbox, [id]: (s.outbox[id] ?? []).map((p) => (p.clientMessageId === clientMessageId ? { ...p, status: 'waiting', attempts: 0, error: undefined } : p)) } }))
      void deliver(id, clientMessageId)
    },

    discard(id, clientMessageId) {
      set((s) => ({ outbox: { ...s.outbox, [id]: (s.outbox[id] ?? []).filter((p) => p.clientMessageId !== clientMessageId) } }))
    },

    flush() {
      for (const [id, list] of Object.entries(get().outbox)) for (const p of list) if (p.status === 'waiting') void deliver(id, p.clientMessageId)
    },

    markRead(id) {
      const c = get().conversations[id]
      if (!c || c.lastReadSeq >= c.lastSeq) return
      const seq = c.lastSeq
      patchConversation(id, () => ({ lastReadSeq: seq }))
      void chatServerApi()?.read(id, seq).catch(failed) // the next read or reload corrects it
    },

    async deleteMessage(id, messageId) {
      await api().deleteMessage(id, messageId)
      get().handleEvent({ type: 'message.deleted', data: { conversationId: id, messageId, seq: 0 } })
    },

    upsert: setConversation,

    handleEvent(e) {
      switch (e.type) {
        case 'ready':
          void get().loadConversations()
          get().flush()
          return
        case 'message.created': {
          const m = e.data.message
          const held = get().messages[m.conversationId]
          const last = held?.at(-1)?.seq
          if (!get().conversations[m.conversationId]) void get().loadConversations() // a conversation we haven't seen yet
          confirm(m)
          // A gap means frames were missed: fetch what lies between.
          if (held && last !== undefined && m.seq > last + 1) void fetchAfter(m.conversationId, last).catch(failed)
          if (get().open === m.conversationId && document.visibilityState === 'visible') get().markRead(m.conversationId)
          return
        }
        case 'message.deleted': {
          const { conversationId, messageId } = e.data
          const blank = (m: Message): Message => (m.id === messageId ? { ...m, body: '', deleted: true } : m)
          set((s) => ({ messages: s.messages[conversationId] ? { ...s.messages, [conversationId]: s.messages[conversationId].map(blank) } : s.messages }))
          patchConversation(conversationId, (c) => ({ lastMessage: c.lastMessage && blank(c.lastMessage) }))
          return
        }
        case 'conversation.created':
        case 'conversation.updated':
          return setConversation(e.data.conversation)
        case 'conversation.removed':
          return set((s) => {
            const conversations = { ...s.conversations }
            const messages = { ...s.messages }
            delete conversations[e.data.conversationId]
            delete messages[e.data.conversationId]
            return { conversations, messages, missing: { ...s.missing, [e.data.conversationId]: true } }
          })
        case 'member.added':
          return patchConversation(e.data.conversationId, (c) => ({
            members: c.members.some((m) => m.id === e.data.user.id) ? c.members : [...c.members, { ...e.data.user, role: 'member', lastReadSeq: 0 }],
          }))
        case 'member.removed':
          return patchConversation(e.data.conversationId, (c) => ({ members: c.members.filter((m) => m.id !== e.data.user.id) }))
        case 'read.updated': {
          const { conversationId, userId, seq } = e.data
          return patchConversation(conversationId, (c) =>
            userId === me()
              ? { lastReadSeq: Math.max(c.lastReadSeq, seq) }
              : { members: c.members.map((m) => (m.id === userId ? { ...m, lastReadSeq: Math.max(m.lastReadSeq, seq) } : m)) },
          )
        }
        default:
          return
      }
    },

    reset() {
      deliveries.clear()
      outboxOwner = null // before set(): an emptied store must not overwrite the saved outbox
      set(INITIAL)
    },
  }
})

// ---- durable outbox ----
// Unsent messages survive a restart in `auralis-chat`, but only for a remembered session (a session kept out of storage
// keeps its drafts out too), tagged with their owner, and deleted with the session on sign-out (chatServer.ts).

interface SavedOutbox {
  owner: string
  outbox: Record<string, Pending[]>
}

/** The account whose outbox may be written back; null until restoreOutbox has run for it. */
let outboxOwner: string | null = null

const STATUSES: readonly string[] = ['sending', 'waiting', 'failed']
const isPending = (p: unknown): p is Pending => {
  const x = p as Pending | null
  return !!x && typeof x.clientMessageId === 'string' && typeof x.body === 'string' && typeof x.attempts === 'number' && typeof x.createdAt === 'string' && STATUSES.includes(x.status)
}

async function restoreOutbox() {
  const who = ownerKey()
  const saved = useChatServer.getState().remember ? await chatKv.get<SavedOutbox>('outbox').catch(() => undefined) : undefined
  if (ownerKey() !== who) return
  const restored: Record<string, Pending[]> = {}
  if (saved?.owner === who && saved.outbox && typeof saved.outbox === 'object') {
    for (const [id, list] of Object.entries(saved.outbox)) {
      // In flight when the app closed: the send is idempotent, so it simply goes again.
      if (Array.isArray(list)) restored[id] = list.filter(isPending).map((p) => (p.status === 'sending' ? { ...p, status: 'waiting' } : p))
    }
  }
  useChat.setState((s) => {
    const outbox = { ...s.outbox }
    for (const [id, list] of Object.entries(restored)) {
      const live = outbox[id] ?? [] // sends made before this finished win over their stored copy
      outbox[id] = [...list.filter((p) => !live.some((l) => l.clientMessageId === p.clientMessageId)), ...live]
    }
    return { outbox }
  })
  outboxOwner = who
  useChat.getState().flush()
}

useChat.subscribe((s, prev) => {
  if (s.outbox === prev.outbox || outboxOwner === null || outboxOwner !== ownerKey()) return
  const outbox = Object.fromEntries(Object.entries(s.outbox).filter(([, list]) => list.length))
  const keep = useChatServer.getState().remember && Object.keys(outbox).length > 0
  void (keep ? chatKv.set('outbox', { owner: outboxOwner, outbox } satisfies SavedOutbox) : chatKv.delete('outbox')).catch(() => undefined)
})

/** Total unread chat-server messages, for the Social badge. */
export const useChatUnread = () => useChat((s) => Object.values(s.conversations).reduce((n, c) => n + unreadOf(c), 0))

// ---- connection lifecycle ----

function onWake(e: Event) {
  if (e.type === 'online') useChat.getState().flush()
  if (document.visibilityState !== 'visible') return
  socket?.nudge()
  const { open } = useChat.getState()
  if (open) useChat.getState().markRead(open)
}

/** Starts the socket for the signed-in account; returns the stop function. Called by useChatConnection only. */
export function startChat(): () => void {
  const { url, token } = useChatServer.getState()
  if (!url || !token || socket) return stopChat
  socket = new ChatSocket(socketUrl(url), token, (e) => useChat.getState().handleEvent(e), (state) => {
    useChatServer.getState().setConnection(state)
    if (state.status === 'signed-out') useChatServer.getState().sessionEnded()
  })
  socket.connect()
  void restoreOutbox()
  void useChat.getState().loadConversations() // REST works even where sockets can't connect
  window.addEventListener('online', onWake)
  document.addEventListener('visibilitychange', onWake)
  return stopChat
}

export function stopChat() {
  socket?.close()
  socket = null
  window.removeEventListener('online', onWake)
  document.removeEventListener('visibilitychange', onWake)
}

// Data belongs to one chat account on one server instance; anything else (a new address, a new token) only reconnects,
// which useChatConnection does.
useChatServer.subscribe((s, prev) => {
  if (s.info?.instanceId !== prev.info?.instanceId || s.user?.id !== prev.user?.id) useChat.getState().reset()
})
