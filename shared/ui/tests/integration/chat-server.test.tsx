// The chat server client end to end against an MSW fake: settings flow, live delivery over the socket, reconnect and
// resync, the outbox, 4401 sign-out, and server switching that leaves the `auralis` database untouched (CHAT.md §10).
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { HttpResponse, http, ws } from 'msw'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Conversation, Message, ServerInfo } from '../../../chat-protocol'
import { ChatServerSection } from '../../src/features/settings/ChatServerSection'
import { uuid4 } from '../../src/api/chat/client'
import { chatKv, kvGet, kvSet } from '../../src/lib/storage'
import { MAX_ATTEMPTS, startChat, stopChat, useChat } from '../../src/state/chat'
import { useChatServer } from '../../src/state/chatServer'
import { server } from '../server'

const CHAT = 'https://chat.test'
const INSTANCE = '11111111-1111-4111-8111-111111111111'
const TOKEN = `ac1_${'a'.repeat(43)}`
const ME = { id: 'u-me', username: 'me', displayName: 'Me', role: 'user' as const, createdAt: '2026-10-20T00:00:00.000Z' }
const ALEX = { id: 'u-alex', username: 'alex', displayName: 'Alex' }

const info = (over: Partial<ServerInfo> = {}): ServerInfo => ({
  instanceId: INSTANCE, name: 'Home chat', version: '0.2.7', protocol: 1, registration: 'open', limits: { maxMessageChars: 4000, maxGroupMembers: 64 }, ...over,
})

// ---- a tiny fake server ----
let messages: Message[]
let lastRead: number
let sendFailures: number
let sendCalls: number
let clients: { send: (data: string) => void; close: (code?: number, reason?: string) => void }[]
const link = ws.link(`wss://chat.test/api/v1/ws`)

const conversation = (): Conversation => ({
  id: 'c1', kind: 'direct', title: null, lastSeq: messages.at(-1)?.seq ?? 0, lastReadSeq: lastRead, unreadCount: Math.max(0, (messages.at(-1)?.seq ?? 0) - lastRead),
  lastMessage: messages.at(-1) ?? null, lastMessageAt: messages.at(-1)?.createdAt ?? null, createdAt: '2026-10-20T00:00:00.000Z',
  members: [{ ...ME, role: 'member', lastReadSeq: lastRead }, { ...ALEX, role: 'member', lastReadSeq: 0 }],
})
const message = (seq: number, from = ALEX, body = `hello ${seq}`, clientMessageId?: string): Message => ({
  id: `m${seq}`, conversationId: 'c1', seq, sender: from, body, createdAt: new Date(Date.UTC(2026, 9, 20, 10, 0, seq)).toISOString(), deleted: false,
  ...(clientMessageId ? { clientMessageId } : {}),
})
const authed = (request: Request) => request.headers.get('authorization') === `Bearer ${TOKEN}`
const denied = () => HttpResponse.json({ error: { code: 'unauthorized', message: 'Sign in again' } }, { status: 401 })

function fakeServer(over: Partial<ServerInfo> = {}) {
  server.use(
    http.get(`${CHAT}/api/v1/server-info`, () => HttpResponse.json(info(over))),
    http.post(`${CHAT}/api/v1/auth/login`, async ({ request }) => {
      const body = (await request.json()) as { username: string; password: string }
      if (body.password !== 'correct horse battery') return HttpResponse.json({ error: { code: 'invalid_credentials', message: 'Wrong username or password' } }, { status: 401 })
      return HttpResponse.json({ user: ME, token: TOKEN, session: { id: 's1', deviceName: 'x', createdAt: ME.createdAt, lastUsedAt: ME.createdAt, expiresAt: ME.createdAt, current: true } })
    }),
    http.post(`${CHAT}/api/v1/auth/logout`, () => new HttpResponse(null, { status: 204 })),
    http.get(`${CHAT}/api/v1/conversations`, ({ request }) => (authed(request) ? HttpResponse.json([conversation()]) : denied())),
    http.get(`${CHAT}/api/v1/conversations/c1/messages`, ({ request }) => {
      if (!authed(request)) return denied()
      const q = new URL(request.url).searchParams
      const after = q.get('afterSeq')
      const limit = Number(q.get('limit') ?? 50)
      const list = after !== null ? messages.filter((m) => m.seq > Number(after)) : messages
      const page = after !== null ? list.slice(0, limit) : list.slice(-limit)
      return HttpResponse.json({ messages: page, hasMore: list.length > page.length })
    }),
    http.post(`${CHAT}/api/v1/conversations/c1/messages`, async ({ request }) => {
      sendCalls++
      if (sendFailures > 0) {
        sendFailures--
        return HttpResponse.error()
      }
      const body = (await request.json()) as { clientMessageId: string; body: string }
      const existing = messages.find((m) => m.clientMessageId === body.clientMessageId)
      if (existing) return HttpResponse.json({ message: existing })
      const m = message((messages.at(-1)?.seq ?? 0) + 1, ME, body.body, body.clientMessageId)
      messages.push(m)
      lastRead = m.seq
      return HttpResponse.json({ message: m }, { status: 201 })
    }),
    http.post(`${CHAT}/api/v1/conversations/c1/read`, async ({ request }) => {
      lastRead = Math.max(lastRead, ((await request.json()) as { seq: number }).seq)
      return HttpResponse.json({ lastReadSeq: lastRead })
    }),
    link.addEventListener('connection', ({ client }) => {
      client.addEventListener('message', (e) => {
        const frame = JSON.parse(String(e.data))
        if (frame.type !== 'auth') return client.close(4400, 'expected auth')
        if (frame.data.token !== TOKEN) return client.close(4401, 'unauthenticated')
        clients.push(client)
        client.send(JSON.stringify({ v: 1, type: 'ready', data: { userId: ME.id, sessionId: 's1', serverTime: new Date().toISOString(), heartbeatSec: 25, protocol: 1 } }))
      })
    }),
  )
}

const push = (event: object) => {
  for (const c of clients) c.send(JSON.stringify({ v: 1, ...event }))
}

async function signedIn(remember = false) {
  useChatServer.setState({ hydrated: true, url: CHAT, allowInsecure: false, info: info(), user: ME, token: TOKEN, remember })
  startChat()
  await waitFor(() => expect(useChatServer.getState().connection.status).toBe('connected'))
  await waitFor(() => expect(useChat.getState().status).toBe('ready'))
}

beforeEach(async () => {
  messages = [message(1), message(2)]
  lastRead = 2
  sendFailures = 0
  sendCalls = 0
  clients = []
  await chatKv.destroy()
  useChatServer.setState({ hydrated: true, url: null, allowInsecure: false, info: null, user: null, token: null, remember: false, connection: { status: 'closed' } })
  useChat.getState().reset()
})
afterEach(() => stopChat())

describe('Settings → Chat server', () => {
  const field = (name: RegExp) => screen.getByLabelText(name)
  const renderSection = () =>
    render(
      <MemoryRouter>
        <ChatServerSection />
      </MemoryRouter>,
    )

  it('tests without saving, saves, signs in, and explains a wrong password', async () => {
    fakeServer()
    renderSection()
    fireEvent.change(field(/Chat server address/), { target: { value: 'https://chat.test/' } })
    fireEvent.click(screen.getByRole('button', { name: 'Test address' }))
    expect(await screen.findByText('Home chat')).toBeInTheDocument()
    expect(screen.getByText('Encrypted (HTTPS)')).toBeInTheDocument()
    expect(useChatServer.getState().url).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Save address' }))
    await waitFor(() => expect(useChatServer.getState().url).toBe(CHAT))
    expect((await chatKv.get<{ url: string }>('config'))?.url).toBe(CHAT)

    fireEvent.change(field(/^Username/), { target: { value: 'me' } })
    fireEvent.change(field(/^Password/), { target: { value: 'wrong wrong wrong' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong username or password.')

    fireEvent.change(field(/^Password/), { target: { value: 'correct horse battery' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText('Me (@me)')).toBeInTheDocument()
    // Not "kept signed in": the token stays in memory only.
    expect(await chatKv.get('session')).toBeUndefined()
  })

  it('names both possibilities when the server cannot be reached', async () => {
    server.use(http.get(`${CHAT}/api/v1/server-info`, () => HttpResponse.error()))
    renderSection()
    fireEvent.change(field(/Chat server address/), { target: { value: CHAT } })
    fireEvent.click(screen.getByRole('button', { name: 'Test address' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Couldn’t reach the chat server.*CHAT_ALLOWED_ORIGINS/)
  })

  it('refuses another protocol version and plain http to a LAN address without the opt-in', async () => {
    fakeServer({ protocol: 2 as 1 })
    renderSection()
    fireEvent.change(field(/Chat server address/), { target: { value: 'http://192.168.1.20:8790' } })
    fireEvent.click(screen.getByRole('button', { name: 'Test address' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/Allow unencrypted connection/)
    fireEvent.change(field(/Chat server address/), { target: { value: CHAT } })
    fireEvent.click(screen.getByRole('button', { name: 'Test address' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/protocol 2, this app supports 1/)
  })
})

describe('addresses and switching servers', () => {
  it('keeps the session when the new address is the same server (same instanceId)', async () => {
    fakeServer()
    server.use(http.get('https://box.tail1234.ts.net/api/v1/server-info', () => HttpResponse.json(info())))
    useChatServer.setState({ url: CHAT, info: info(), user: ME, token: TOKEN })
    expect(await useChatServer.getState().saveAddress('https://box.tail1234.ts.net', false)).toBe('moved')
    expect(useChatServer.getState()).toMatchObject({ url: 'https://box.tail1234.ts.net', token: TOKEN })
  })

  it('switching to a different server clears only auralis-chat; the auralis database is untouched', async () => {
    fakeServer()
    const other = info({ instanceId: '22222222-2222-4222-8222-222222222222', name: 'Elsewhere' })
    server.use(http.get('https://other.test/api/v1/server-info', () => HttpResponse.json(other)))
    // The music side: session, settings, queue, lyrics cache, Subsonic chat read state.
    const music = {
      session: { credentials: { baseUrl: 'https://music.test', username: 'alice', password: 'sesame' } },
      settings: { theme: 'dark', lyricsServerUrl: 'https://lyrics.test', eqEnabled: true },
      queue: { ids: ['s1', 's2'], index: 1 },
      'lyrics:abc': { lines: ['la'] },
      'social:lastRead:https://music.test|alice': 12345,
    }
    for (const [k, v] of Object.entries(music)) await kvSet(k, v)
    useChatServer.setState({ url: CHAT, info: info(), user: ME, token: TOKEN, remember: true })
    await chatKv.set('config', { url: CHAT, allowInsecure: false, info: info() })
    await chatKv.set('session', { instanceId: INSTANCE, token: TOKEN, user: ME })

    const r = await useChatServer.getState().saveAddress('https://other.test', false)
    expect(r).toEqual({ otherServer: other })
    expect(useChatServer.getState().token).toBe(TOKEN) // nothing happens before the user confirms
    await useChatServer.getState().switchServer('https://other.test', false, other)

    expect(useChatServer.getState()).toMatchObject({ url: 'https://other.test', token: null, user: null, info: other })
    expect(await chatKv.get('session')).toBeUndefined()
    expect((await chatKv.get<{ info: ServerInfo }>('config'))?.info.instanceId).toBe(other.instanceId)
    for (const [k, v] of Object.entries(music)) expect(JSON.stringify(await kvGet(k))).toBe(JSON.stringify(v))
  })

  it('never restores a saved session against a different instance', async () => {
    await chatKv.set('config', { url: CHAT, allowInsecure: false, info: info() })
    await chatKv.set('session', { instanceId: 'someone-else', token: TOKEN, user: ME })
    await useChatServer.getState().restore()
    expect(useChatServer.getState()).toMatchObject({ url: CHAT, token: null })
  })
})

describe('live messages', () => {
  it('delivers over the socket, counts unread, and never authenticates through the URL', async () => {
    fakeServer()
    let socketUrl = ''
    server.use(link.addEventListener('connection', ({ client }) => void (socketUrl = client.url.toString())))
    await signedIn()
    expect(socketUrl).toBe('wss://chat.test/api/v1/ws')
    await act(() => useChat.getState().openConversation('c1'))
    expect(useChat.getState().messages.c1?.map((m) => m.seq)).toEqual([1, 2])
    await act(() => useChat.getState().openConversation(null))

    messages.push(message(3))
    act(() => push({ type: 'message.created', data: { message: message(3) } }))
    await waitFor(() => expect(useChat.getState().messages.c1?.map((m) => m.seq)).toEqual([1, 2, 3]))
    expect(useChat.getState().conversations.c1).toMatchObject({ lastSeq: 3, lastReadSeq: 2 })

    // A frame was missed (4 never arrived): the gap is fetched with afterSeq, without duplicates.
    messages.push(message(4), message(5))
    act(() => push({ type: 'message.created', data: { message: message(5) } }))
    await waitFor(() => expect(useChat.getState().messages.c1?.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5]))
  })

  it('resyncs after a reconnect and signs out (without reconnecting) on 4401', async () => {
    fakeServer()
    await signedIn()
    await act(() => useChat.getState().openConversation('c1'))
    // Recorded, not polled: full-jitter backoff can be ~0 ms, too brief a `reconnecting` for waitFor to catch.
    const seen: string[] = []
    const unsubscribe = useChatServer.subscribe((s) => seen.push(s.connection.status))
    act(() => clients.splice(0).forEach((c) => c.close(1001, 'server restarting')))
    messages.push(message(3), message(4))
    // Backoff is up to 1 s for the first retry; the online event skips the wait.
    await waitFor(() => expect(seen).toContain('reconnecting'))
    unsubscribe()
    act(() => void window.dispatchEvent(new Event('online')))
    await waitFor(() => expect(useChat.getState().messages.c1?.map((m) => m.seq)).toEqual([1, 2, 3, 4]))

    act(() => clients.forEach((c) => c.close(4401, 'signed out')))
    await waitFor(() => expect(useChatServer.getState().token).toBeNull())
    expect(useChat.getState().conversations).toEqual({})
  })
})

describe('outbox', () => {
  it('replaces the pending message with the confirmed one and keeps order', async () => {
    fakeServer()
    await signedIn()
    await act(() => useChat.getState().openConversation('c1'))
    act(() => {
      useChat.getState().send('c1', 'first')
      useChat.getState().send('c1', 'second')
    })
    expect(useChat.getState().outbox.c1?.map((p) => p.body)).toEqual(['first', 'second'])
    await waitFor(() => expect(useChat.getState().outbox.c1).toEqual([]))
    expect(useChat.getState().messages.c1?.slice(-2).map((m) => m.body)).toEqual(['first', 'second'])
    // The socket echo of the same message must not duplicate it.
    act(() => push({ type: 'message.created', data: { message: messages.at(-1)! } }))
    expect(useChat.getState().messages.c1).toHaveLength(4)
  })

  it('waits while offline, retries on reconnect, and fails after the attempt cap with a manual Retry', async () => {
    fakeServer()
    await signedIn()
    await act(() => useChat.getState().openConversation('c1'))
    sendFailures = 1
    act(() => useChat.getState().send('c1', 'flaky'))
    await waitFor(() => expect(useChat.getState().outbox.c1?.[0]?.status).toBe('waiting'))
    act(() => push({ type: 'ready', data: { userId: ME.id, sessionId: 's1', serverTime: '', heartbeatSec: 25, protocol: 1 } }))
    await waitFor(() => expect(useChat.getState().outbox.c1).toEqual([]))
    expect(messages.filter((m) => m.body === 'flaky')).toHaveLength(1)

    sendFailures = 100
    act(() => useChat.getState().send('c1', 'doomed'))
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await waitFor(() => expect(['waiting', 'failed']).toContain(useChat.getState().outbox.c1?.[0]?.status))
      if (useChat.getState().outbox.c1?.[0]?.status === 'failed') break
      act(() => push({ type: 'ready', data: { userId: ME.id, sessionId: 's1', serverTime: '', heartbeatSec: 25, protocol: 1 } }))
    }
    await waitFor(() => expect(useChat.getState().outbox.c1?.[0]?.status).toBe('failed'))
    const calls = sendCalls
    sendFailures = 0
    const pending = useChat.getState().outbox.c1![0]!
    act(() => useChat.getState().retry('c1', pending.clientMessageId))
    await waitFor(() => expect(useChat.getState().outbox.c1).toEqual([]))
    expect(sendCalls).toBe(calls + 1)
    expect(messages.at(-1)).toMatchObject({ body: 'doomed', clientMessageId: pending.clientMessageId })
  })

  it('survives an app restart when remembered, is sent exactly once, and is wiped on sign-out', async () => {
    fakeServer()
    await signedIn(true)
    sendFailures = 100
    act(() => useChat.getState().send('c1', 'while offline'))
    await waitFor(() => expect(useChat.getState().outbox.c1?.[0]?.status).toBe('waiting'))
    await waitFor(async () => expect((await chatKv.get<{ outbox: Record<string, unknown[]> }>('outbox'))?.outbox.c1).toHaveLength(1))

    // "Restart": memory is gone, IndexedDB is not.
    stopChat()
    useChat.getState().reset()
    expect(useChat.getState().outbox).toEqual({})
    sendFailures = 0
    startChat()
    await waitFor(() => expect(messages.filter((m) => m.body === 'while offline')).toHaveLength(1))
    await waitFor(() => expect(useChat.getState().outbox.c1).toEqual([]))
    await waitFor(async () => expect(await chatKv.get('outbox')).toBeUndefined())

    sendFailures = 100
    act(() => useChat.getState().send('c1', 'never sent'))
    await waitFor(async () => expect(await chatKv.get('outbox')).toBeDefined())
    await act(() => useChatServer.getState().signOut())
    expect(await chatKv.get('outbox')).toBeUndefined()
  })

  it('keeps the outbox of a session that is not remembered out of storage', async () => {
    fakeServer()
    await signedIn()
    sendFailures = 100
    act(() => useChat.getState().send('c1', 'ephemeral'))
    await waitFor(() => expect(useChat.getState().outbox.c1?.[0]?.status).toBe('waiting'))
    expect(await chatKv.get('outbox')).toBeUndefined()
  })

  it('never restores an outbox saved by another account', async () => {
    fakeServer()
    const stranger = { clientMessageId: uuid4(), body: 'not mine', status: 'waiting', attempts: 0, createdAt: ME.createdAt }
    await chatKv.set('outbox', { owner: `${INSTANCE}|u-someone-else`, outbox: { c1: [stranger] } })
    await signedIn(true)
    await act(() => new Promise((r) => setTimeout(r, 20)))
    expect(useChat.getState().outbox.c1 ?? []).toEqual([])
    expect(messages.some((m) => m.body === 'not mine')).toBe(false)
  })
})

describe('untrusted input', () => {
  it('a malformed conversation list is an error state, not a crash', async () => {
    fakeServer()
    server.use(http.get(`${CHAT}/api/v1/conversations`, () => HttpResponse.json([{ id: 5, members: 'nope' }])))
    useChatServer.setState({ hydrated: true, url: CHAT, info: info(), user: ME, token: TOKEN })
    await act(() => useChat.getState().loadConversations())
    expect(useChat.getState()).toMatchObject({ status: 'error', conversations: {} })
    expect(useChat.getState().error).toMatch(/doesn’t understand|isn’t an Auralis chat server/)
  })
})

describe('Social with a chat server', () => {
  it('on a server without a Subsonic room, lists the chat server conversations, opens one, shows history and sends', async () => {
    const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
    const { default: App } = await import('../../src/App')
    const { useAuth } = await import('../../src/state/auth')
    const { BASE, PASSWORD, USER } = await import('../server')
    fakeServer()
    server.use(
      http.get(`${BASE}/rest/getChatMessages`, () => new HttpResponse('Gone', { status: 410 })),
      http.get(`${BASE}/rest/getNowPlaying`, () => HttpResponse.json({ 'subsonic-response': { status: 'ok', version: '1.16.1', nowPlaying: {} } })),
    )
    useAuth.setState({
      hydrated: true,
      session: {
        credentials: { baseUrl: BASE, username: USER, password: PASSWORD },
        server: { apiVersion: '1.16.1', type: 'navidrome' },
        capabilities: { openSubsonic: true, extensions: [], songLyrics: false },
        remember: false,
      },
    })
    // Restored from auralis-chat on start, like a real reload.
    await chatKv.set('config', { url: CHAT, allowInsecure: false, info: info() })
    await chatKv.set('session', { instanceId: INSTANCE, token: TOKEN, user: ME })
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/social/chat']}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    // The list stays (with a "choose" pane beside it); the Subsonic room isn't offered because the server has none.
    const conv = await screen.findByRole('link', { name: 'Alex' })
    expect(conv).toHaveAttribute('href', '/social/chat/c/c1')
    expect(await screen.findByText('Choose a conversation')).toBeInTheDocument()
    expect(screen.queryByText(/Everyone on/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('link', { name: 'Alex' }))
    const log = await screen.findByRole('log', { name: 'Messages' })
    expect(log).toHaveTextContent('hello 1')
    expect(log).toHaveTextContent('hello 2')

    fireEvent.change(screen.getByLabelText('Message Alex'), { target: { value: '<b>not html</b>' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() => expect(messages.at(-1)?.body).toBe('<b>not html</b>'))
    // Rendered as text, never as markup.
    expect(await screen.findByText('<b>not html</b>')).toBeInTheDocument()
    expect(log.querySelector('b')).toBeNull()

    // A failed send keeps the message with Retry / Discard.
    sendFailures = 100
    useChat.setState((s) => ({ outbox: { ...s.outbox, c1: [{ clientMessageId: 'x', body: 'stuck', status: 'failed', attempts: 5, error: 'offline', createdAt: new Date().toISOString() }] } }))
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    await waitFor(() => expect(screen.queryByText('stuck')).not.toBeInTheDocument())
  })
})

describe('automatic sign-in', () => {
  it('signs in to chat with the music-server credentials, once, and not again after a manual sign-out', async () => {
    const { useAuth } = await import('../../src/state/auth')
    fakeServer()
    const logins: string[] = []
    server.events.on('request:start', ({ request }) => void (request.url.endsWith('/auth/login') && logins.push(request.url)))
    useAuth.setState({
      hydrated: true,
      session: {
        credentials: { baseUrl: 'https://music.test', username: 'me', password: 'correct horse battery' },
        server: { apiVersion: '1.16.1', type: 'navidrome' },
        capabilities: { openSubsonic: true, extensions: [], songLyrics: false },
        remember: false,
      },
    })
    useChatServer.setState({ url: CHAT, info: info({ musicServer: 'https://music.test' }) })
    await waitFor(() => expect(useChatServer.getState().token).toBe(TOKEN))
    expect(useChatServer.getState().user).toEqual(ME)
    await act(() => useChatServer.getState().signOut())
    await new Promise((r) => setTimeout(r, 50))
    expect(useChatServer.getState().token).toBeNull()
    expect(logins).toHaveLength(1)
    server.events.removeAllListeners()
    useAuth.setState({ session: null })
  })

  // The music-server password only goes to a chat server that says it is tied to that music server, over HTTPS.
  it.each([
    ['advertises no music server', CHAT, {}],
    ['is tied to a different music server', CHAT, { musicServer: 'https://evil.test' }],
    ['is plain http', 'http://chat.test', { musicServer: 'https://music.test' }],
  ] as const)('never sends the music-server credentials to a chat server that %s', async (_, url, over) => {
    const { useAuth } = await import('../../src/state/auth')
    fakeServer()
    server.use(http.post('http://chat.test/api/v1/auth/login', () => HttpResponse.json({}, { status: 500 })))
    const logins: string[] = []
    server.events.on('request:start', ({ request }) => void (request.url.endsWith('/auth/login') && logins.push(request.url)))
    useChatServer.setState({ url, info: info(over), token: null, user: null })
    useAuth.setState({
      hydrated: true,
      session: {
        credentials: { baseUrl: 'https://music.test', username: 'me', password: `secret-${url}-${JSON.stringify(over)}` },
        server: { apiVersion: '1.16.1', type: 'navidrome' },
        capabilities: { openSubsonic: true, extensions: [], songLyrics: false },
        remember: false,
      },
    })
    await new Promise((r) => setTimeout(r, 50))
    expect(logins).toEqual([])
    server.events.removeAllListeners()
    useAuth.setState({ session: null })
  })
})
