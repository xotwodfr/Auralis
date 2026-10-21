// Conversations, membership, permissions, messages: ordering, idempotency, pagination, read state, deletion.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Conversation, Message } from '../../../../shared/chat-protocol/index.ts'
import { call, setup, user, uuid, type TestApp } from '../helpers.ts'

let t: TestApp
beforeAll(async () => (t = await setup()))
afterAll(() => t.close())

const send = (token: string, id: string, body: string, clientMessageId = uuid()) => call(t, 'POST', `/api/v1/conversations/${id}/messages`, token, { clientMessageId, body })

describe('direct conversations', () => {
  it('are idempotent per pair, including under a race', async () => {
    const a = await user(t)
    const b = await user(t)
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => call(t, 'POST', '/api/v1/conversations/direct', i % 2 ? a.token : b.token, { userId: i % 2 ? b.user.id : a.user.id })))
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1)
    expect(results.filter((r) => r.status === 201)).toHaveLength(1)
    const rows = await t.db.selectFrom('conversations').select('id').where('kind', '=', 'direct').where('dm_key', '=', [a.user.id, b.user.id].sort().join(':')).execute()
    expect(rows).toHaveLength(1)
    expect(results[0].body.members.map((m: { id: string }) => m.id).sort()).toEqual([a.user.id, b.user.id].sort())
  })

  it('refuse self, unknown and disabled users, and cannot be left', async () => {
    const a = await user(t)
    const b = await user(t)
    expect((await call(t, 'POST', '/api/v1/conversations/direct', a.token, { userId: a.user.id })).status).toBe(400)
    expect((await call(t, 'POST', '/api/v1/conversations/direct', a.token, { userId: uuid() })).status).toBe(400)
    const dm = await call(t, 'POST', '/api/v1/conversations/direct', a.token, { userId: b.user.id })
    expect((await call(t, 'DELETE', `/api/v1/conversations/${dm.body.id}/members/${a.user.id}`, a.token)).status).toBe(403)
    await t.db.updateTable('users').set({ disabled_at: new Date() }).where('id', '=', b.user.id).execute()
    expect((await send(a.token, dm.body.id, 'hello?')).status).toBe(403)
    expect((await call(t, 'GET', `/api/v1/conversations/${dm.body.id}/messages`, a.token)).status).toBe(200)
  })
})

describe('groups', () => {
  it('enforce roles for rename, add and remove, and hand ownership over when the owner leaves', async () => {
    const owner = await user(t)
    const m1 = await user(t)
    const m2 = await user(t)
    const later = await user(t)
    const g = await call(t, 'POST', '/api/v1/conversations/group', owner.token, { title: '  Band  practice ', memberIds: [m1.user.id, m2.user.id, owner.user.id] })
    expect(g.status).toBe(201)
    const id = g.body.id
    expect(g.body).toMatchObject({ kind: 'group', title: 'Band practice' })
    expect(g.body.members.find((m: { id: string }) => m.id === owner.user.id).role).toBe('owner')

    expect((await call(t, 'PATCH', `/api/v1/conversations/${id}`, m1.token, { title: 'Mine' })).status).toBe(403)
    expect((await call(t, 'PATCH', `/api/v1/conversations/${id}`, owner.token, { title: 'Gig' })).body.title).toBe('Gig')
    expect((await call(t, 'POST', `/api/v1/conversations/${id}/members`, m1.token, { userIds: [later.user.id] })).status).toBe(403)
    expect((await call(t, 'DELETE', `/api/v1/conversations/${id}/members/${m2.user.id}`, m1.token)).status).toBe(403)

    // A newly added member sees the full history (CHAT.md §14 decision 5).
    await send(owner.token, id, 'before you joined')
    expect((await call(t, 'POST', `/api/v1/conversations/${id}/members`, owner.token, { userIds: [later.user.id] })).body.members).toHaveLength(4)
    expect((await call(t, 'GET', `/api/v1/conversations/${id}/messages`, later.token)).body.messages[0].body).toBe('before you joined')

    expect((await call(t, 'DELETE', `/api/v1/conversations/${id}/members/${later.user.id}`, owner.token)).status).toBe(204)
    expect((await call(t, 'GET', `/api/v1/conversations/${id}/messages`, later.token)).status).toBe(404)
    expect((await call(t, 'DELETE', `/api/v1/conversations/${id}/members/${m2.user.id}`, m2.token)).status).toBe(204)

    expect((await call(t, 'DELETE', `/api/v1/conversations/${id}/members/${owner.user.id}`, owner.token)).status).toBe(204)
    const after = await call(t, 'GET', `/api/v1/conversations/${id}`, m1.token)
    expect(after.body.members).toEqual([expect.objectContaining({ id: m1.user.id, role: 'owner' })])
    expect((await call(t, 'GET', `/api/v1/conversations/${id}`, owner.token)).status).toBe(404)
  })

  it('validate titles, member counts and member ids', async () => {
    const small = await setup({ config: { maxGroupMembers: 3 } })
    try {
      const a = await user(small)
      const [b, c, d] = [await user(small), await user(small), await user(small)]
      const make = (body: unknown) => call(small, 'POST', '/api/v1/conversations/group', a.token, body)
      expect((await make({ title: '', memberIds: [] })).status).toBe(400)
      expect((await make({ title: 'x'.repeat(81), memberIds: [] })).status).toBe(400)
      expect((await make({ title: 'ok', memberIds: [b.user.id, c.user.id, d.user.id] })).status).toBe(400)
      expect((await make({ title: 'ok', memberIds: [uuid()] })).status).toBe(400)
      expect((await make({ title: 'ok', memberIds: ['not-a-uuid'] })).status).toBe(400)
      const g = await make({ title: 'ok', memberIds: [b.user.id, c.user.id] })
      expect(g.status).toBe(201)
      expect((await call(small, 'POST', `/api/v1/conversations/${g.body.id}/members`, a.token, { userIds: [d.user.id] })).status).toBe(400)
    } finally {
      await small.close()
    }
  })
})

describe('messages', () => {
  it('get gap-free, strictly increasing seq under 50 concurrent senders', async () => {
    const users = await Promise.all(Array.from({ length: 5 }, () => user(t)))
    const g = await call(t, 'POST', '/api/v1/conversations/group', users[0].token, { title: 'Busy', memberIds: users.map((u) => u.user.id) })
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => send(users[i % 5].token, g.body.id, `m${i}`)))
    expect(results.every((r) => r.status === 201)).toBe(true)
    const seqs = results.map((r) => r.body.message.seq).sort((x, y) => x - y)
    expect(seqs).toEqual(Array.from({ length: 50 }, (_, i) => i + 1))
  })

  it('are idempotent per clientMessageId and a retry does not consume a seq', async () => {
    const a = await user(t)
    const b = await user(t)
    const dm = await call(t, 'POST', '/api/v1/conversations/direct', a.token, { userId: b.user.id })
    const key = uuid()
    const [first, second] = await Promise.all([send(a.token, dm.body.id, 'once', key), send(a.token, dm.body.id, 'once', key)])
    expect([first.status, second.status].sort()).toEqual([200, 201])
    expect(first.body.message.id).toBe(second.body.message.id)
    expect(first.body.message.clientMessageId).toBe(key)
    const next = await send(a.token, dm.body.id, 'twice')
    expect(next.body.message.seq).toBe(2)
    // The same key from another sender is a different message.
    expect((await send(b.token, dm.body.id, 'mine', key)).status).toBe(201)
    // The other side never sees the sender's idempotency key.
    const seen = await call(t, 'GET', `/api/v1/conversations/${dm.body.id}/messages`, b.token)
    expect(seen.body.messages.find((m: Message) => m.sender.id === a.user.id).clientMessageId).toBeUndefined()
  })

  it('paginate backwards and forwards with every message exactly once', async () => {
    const a = await user(t)
    const b = await user(t)
    const dm = await call(t, 'POST', '/api/v1/conversations/direct', a.token, { userId: b.user.id })
    for (let i = 1; i <= 37; i++) await send(i % 2 ? a.token : b.token, dm.body.id, `n${i}`)
    for (const size of [1, 5, 10, 36, 37, 100]) {
      const seen: number[] = []
      let before: number | undefined
      for (;;) {
        const page = await call(t, 'GET', `/api/v1/conversations/${dm.body.id}/messages?limit=${size}${before ? `&beforeSeq=${before}` : ''}`, a.token)
        seen.unshift(...page.body.messages.map((m: Message) => m.seq))
        if (!page.body.hasMore) break
        before = page.body.messages[0].seq
      }
      expect(seen).toEqual(Array.from({ length: 37 }, (_, i) => i + 1))
      const forward: number[] = []
      let after = 0
      for (;;) {
        const page = await call(t, 'GET', `/api/v1/conversations/${dm.body.id}/messages?limit=${size}&afterSeq=${after}`, a.token)
        forward.push(...page.body.messages.map((m: Message) => m.seq))
        if (!page.body.hasMore) break
        after = forward.at(-1)!
      }
      expect(forward).toEqual(seen)
    }
    expect((await call(t, 'GET', `/api/v1/conversations/${dm.body.id}/messages?limit=101`, a.token)).status).toBe(400)
    expect((await call(t, 'GET', `/api/v1/conversations/${dm.body.id}/messages?beforeSeq=5&afterSeq=1`, a.token)).status).toBe(400)
  })

  it('enforce length and sanitising', async () => {
    const a = await user(t)
    const b = await user(t)
    const dm = await call(t, 'POST', '/api/v1/conversations/direct', a.token, { userId: b.user.id })
    expect((await send(a.token, dm.body.id, 'x'.repeat(4000))).status).toBe(201)
    expect((await send(a.token, dm.body.id, 'x'.repeat(4001))).status).toBe(400)
    expect((await send(a.token, dm.body.id, '   ')).status).toBe(400)
    expect((await send(a.token, dm.body.id, '<b>hi</b>\u0000')).body.message.body).toBe('<b>hi</b>')
    expect((await call(t, 'POST', `/api/v1/conversations/${dm.body.id}/messages`, a.token, { clientMessageId: uuid(), body: 'x', html: true })).status).toBe(400)
  })

  it('track read state monotonically and count unread from other people only', async () => {
    const a = await user(t)
    const b = await user(t)
    const dm = await call(t, 'POST', '/api/v1/conversations/direct', a.token, { userId: b.user.id })
    for (let i = 0; i < 3; i++) await send(a.token, dm.body.id, `hi ${i}`)
    const list = async (token: string) => (await call(t, 'GET', '/api/v1/conversations', token)).body.find((c: Conversation) => c.id === dm.body.id) as Conversation
    expect((await list(a.token)).unreadCount).toBe(0)
    const forB = await list(b.token)
    expect([forB.unreadCount, forB.lastSeq, forB.lastMessage?.body]).toEqual([3, 3, 'hi 2'])
    expect((await call(t, 'POST', `/api/v1/conversations/${dm.body.id}/read`, b.token, { seq: 2 })).body.lastReadSeq).toBe(2)
    expect((await call(t, 'POST', `/api/v1/conversations/${dm.body.id}/read`, b.token, { seq: 1 })).body.lastReadSeq).toBe(2)
    expect((await call(t, 'POST', `/api/v1/conversations/${dm.body.id}/read`, b.token, { seq: 99 })).body.lastReadSeq).toBe(3)
    expect((await list(b.token)).unreadCount).toBe(0)
  })

  it('soft-delete: sender or group managers only, body hidden afterwards', async () => {
    const owner = await user(t)
    const m = await user(t)
    const g = await call(t, 'POST', '/api/v1/conversations/group', owner.token, { title: 'G', memberIds: [m.user.id] })
    const mine = await send(m.token, g.body.id, 'oops')
    const theirs = await send(owner.token, g.body.id, 'keep')
    expect((await call(t, 'DELETE', `/api/v1/conversations/${g.body.id}/messages/${theirs.body.message.id}`, m.token)).status).toBe(403)
    expect((await call(t, 'DELETE', `/api/v1/conversations/${g.body.id}/messages/${mine.body.message.id}`, owner.token)).status).toBe(204)
    expect((await call(t, 'DELETE', `/api/v1/conversations/${g.body.id}/messages/${uuid()}`, owner.token)).status).toBe(404)
    const page = await call(t, 'GET', `/api/v1/conversations/${g.body.id}/messages`, m.token)
    expect(page.body.messages[0]).toMatchObject({ deleted: true, body: '' })
    expect(JSON.stringify(page.body)).not.toContain('oops')
  })
})

describe('user search', () => {
  it('matches username prefixes only, excludes self and disabled users, and escapes wildcards', async () => {
    const me = await user(t, 'searcher')
    await user(t, 'searchable')
    const off = await user(t, 'searchoff')
    await t.db.updateTable('users').set({ disabled_at: new Date() }).where('id', '=', off.user.id).execute()
    const names = async (q: string) => (await call(t, 'GET', `/api/v1/users/search?q=${encodeURIComponent(q)}`, me.token)).body.map((u: { username: string }) => u.username)
    expect(await names('search')).toEqual(['searchable'])
    expect(await names('%a')).toEqual([])
    expect(await names('__')).toEqual([])
    expect((await call(t, 'GET', '/api/v1/users/search?q=a', me.token)).status).toBe(400)
  })
})

describe('lobby', () => {
  it('every registered account joins the one shared room and can talk in it', async () => {
    const reg = (username: string) => call(t, 'POST', '/api/v1/auth/register', undefined, { username, password: 'correct horse battery' })
    const a = (await reg('lobby_a')).body
    const b = (await reg('lobby_b')).body
    const [la] = (await call(t, 'GET', '/api/v1/conversations', a.token)).body.filter((c: Conversation) => c.title === 'Lobby')
    const [lb] = (await call(t, 'GET', '/api/v1/conversations', b.token)).body.filter((c: Conversation) => c.title === 'Lobby')
    expect(la.id).toBe(lb.id)
    expect((await send(a.token, la.id, 'hello everyone')).status).toBe(201)
    const history = await call(t, 'GET', `/api/v1/conversations/${lb.id}/messages`, b.token)
    expect(history.body.messages.map((m: Message) => m.body)).toContain('hello everyone')
  })
})
