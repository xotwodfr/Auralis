import { describe, expect, it } from 'vitest'
import type { Conversation, Message } from '../../../chat-protocol'
import { ChatError, chatErrorMessage, uuid4 } from '../../src/api/chat/client'
import { backoffDelay } from '../../src/api/chat/socket'
import { checkChatUrl, socketUrl } from '../../src/api/chat/url'
import { parseEvent } from '../../src/api/chat/validate'
import { conversationTitle, mergeMessages, planResync, unreadOf } from '../../src/state/chat'

describe('chat server URL policy (CHAT.md §10.3)', () => {
  const lan = { allowInsecure: true, pageIsHttps: false }
  const strict = { allowInsecure: false, pageIsHttps: false }
  it.each([
    ['https://chat.example.com/', strict, 'https://chat.example.com', true],
    ['https://box.tail1234.ts.net/chat/', strict, 'https://box.tail1234.ts.net/chat', true],
    ['http://localhost:8790', strict, 'http://localhost:8790', false],
    ['http://127.0.0.1:8790', { allowInsecure: false, pageIsHttps: true }, 'http://127.0.0.1:8790', false],
    ['http://192.168.1.20:8790', lan, 'http://192.168.1.20:8790', false],
    ['http://10.0.0.5', lan, 'http://10.0.0.5', false],
    ['http://172.20.1.1', lan, 'http://172.20.1.1', false],
    ['http://100.101.102.103:8790', lan, 'http://100.101.102.103:8790', false],
    ['http://alwaysonpc.local:8790', lan, 'http://alwaysonpc.local:8790', false],
    ['http://[fe80::1]:8790', lan, 'http://[fe80::1]:8790', false],
  ])('allows %s', (input, opts, url, encrypted) => {
    expect(checkChatUrl(input, opts)).toEqual({ url, encrypted })
  })

  it.each([
    ['http://192.168.1.20:8790', strict, /Allow unencrypted/],
    ['http://192.168.1.20:8790', { allowInsecure: true, pageIsHttps: true }, /blocks unencrypted/],
    ['http://chat.example.com', lan, /only allowed on your own network/],
    ['http://172.32.0.1', lan, /only allowed on your own network/],
    ['http://8.8.8.8', lan, /only allowed on your own network/],
    ['ws://chat.example.com', lan, /must start with https/],
    ['https://user:pw@chat.example.com', lan, /Remove the username/],
    ['https://chat.example.com/?token=x', lan, /Remove the username/],
    ['chat.example.com', lan, /full address/],
  ])('rejects %s', (input, opts, message) => {
    const r = checkChatUrl(input, opts)
    expect('error' in r && r.error).toMatch(message)
  })

  it('derives the socket URL with the same host and prefix, and no token', () => {
    expect(socketUrl('https://box.ts.net/chat')).toBe('wss://box.ts.net/chat/api/v1/ws')
    expect(socketUrl('http://192.168.1.20:8790')).toBe('ws://192.168.1.20:8790/api/v1/ws')
  })
})

describe('reconnect backoff', () => {
  it('is full jitter, doubling up to a 30 s cap', () => {
    expect(backoffDelay(0, () => 1)).toBe(1000)
    expect(backoffDelay(3, () => 1)).toBe(8000)
    expect(backoffDelay(10, () => 1)).toBe(30_000)
    expect(backoffDelay(10, () => 0)).toBe(0)
    expect(backoffDelay(2, () => 0.5)).toBe(2000)
  })
})

const user = (id: string) => ({ id, username: id, displayName: id.toUpperCase() })
const msg = (seq: number, over: Partial<Message> = {}): Message => ({
  id: `m${seq}`, conversationId: 'c1', seq, sender: user('a'), body: `#${seq}`, createdAt: new Date(seq * 1000).toISOString(), deleted: false, ...over,
})

describe('message merging and resync', () => {
  it('de-duplicates by id and orders by seq', () => {
    const merged = mergeMessages([msg(1), msg(3)], [msg(2), msg(3, { body: 'edited copy' }), msg(1)])
    expect(merged.map((m) => [m.seq, m.body])).toEqual([[1, '#1'], [2, '#2'], [3, 'edited copy']])
  })

  it('plans what to fetch after a reconnect', () => {
    expect(planResync(undefined, 10)).toBe('none') // nothing loaded: nothing to catch up
    expect(planResync(10, 10)).toBe('none')
    expect(planResync(10, 9)).toBe('none')
    expect(planResync(10, 14)).toEqual({ afterSeq: 10 })
    expect(planResync(10, 510)).toEqual({ afterSeq: 10 })
    expect(planResync(10, 511)).toBe('reload')
  })
})

describe('conversation helpers', () => {
  const base: Conversation = {
    id: 'c1', kind: 'direct', title: null, lastSeq: 7, lastReadSeq: 4, unreadCount: 3, lastMessage: null, lastMessageAt: null, createdAt: '2026-10-20T00:00:00.000Z',
    members: [{ ...user('me'), role: 'member', lastReadSeq: 4 }, { ...user('alex'), role: 'member', lastReadSeq: 7 }],
  }
  it('titles direct conversations by the other person and groups by their name', () => {
    expect(conversationTitle(base, 'me')).toBe('ALEX')
    expect(conversationTitle({ ...base, kind: 'group', title: 'Band' }, 'me')).toBe('Band')
    expect(conversationTitle({ ...base, members: [base.members[0]!] }, 'me')).toBe('Just you')
  })
  it('counts unread from the read pointer', () => {
    expect(unreadOf(base)).toBe(3)
    expect(unreadOf({ ...base, lastReadSeq: 9 })).toBe(0)
  })
})

describe('protocol parsing', () => {
  it('accepts known well-formed frames and ignores everything else', () => {
    expect(parseEvent(JSON.stringify({ v: 1, type: 'message.created', data: { message: msg(1) } }))?.type).toBe('message.created')
    expect(parseEvent(JSON.stringify({ v: 1, type: 'message.created', data: { message: { id: 1 } } }))).toBeNull()
    expect(parseEvent(JSON.stringify({ v: 1, type: 'unknown.thing', data: {} }))).toBeNull()
    expect(parseEvent('not json')).toBeNull()
    expect(parseEvent(JSON.stringify({ type: 'ready' }))).toBeNull()
    expect(parseEvent(new ArrayBuffer(4))).toBeNull()
  })

  it('makes v4 UUIDs without a secure context', () => {
    const ids = new Set(Array.from({ length: 200 }, uuid4))
    expect(ids.size).toBe(200)
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('turns errors into specific, token-free messages', () => {
    expect(chatErrorMessage(new ChatError('http', 'x', 401), 'login')).toBe('Wrong username or password.')
    expect(chatErrorMessage(new ChatError('network', 'x'))).toMatch(/same network or Tailscale.*CHAT_ALLOWED_ORIGINS/)
    expect(chatErrorMessage(new ChatError('http', 'x', 503))).toMatch(/starting up/)
    expect(chatErrorMessage(new ChatError('http', 'Groups can have at most 3 members', 400))).toBe('Groups can have at most 3 members')
    expect(new ChatError('http', 'x', 429).retryable).toBe(true)
    expect(new ChatError('http', 'x', 400).retryable).toBe(false)
  })
})
