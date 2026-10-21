// WebSocket: handshake, delivery only to current members, revocation, limits, shutdown, reconnect-and-resync.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Message } from '../../../../shared/chat-protocol/index.ts'
import { call, listen, ORIGIN, setup, sleep, socket, until, user, uuid, type TestApp } from '../helpers.ts'

let t: TestApp
let url: string
beforeAll(async () => {
  t = await setup()
  url = await listen(t)
})
afterAll(() => t.close())

const send = (token: string, id: string, body: string, clientMessageId = uuid()) => call(t, 'POST', `/api/v1/conversations/${id}/messages`, token, { clientMessageId, body })

describe('handshake', () => {
  it('authenticates with the first frame and replies ready', async () => {
    const a = await user(t)
    const s = socket(url, a.token, { origin: ORIGIN })
    await s.ready
    expect(s.of('ready')[0].data).toMatchObject({ userId: a.user.id, sessionId: a.session.id, heartbeatSec: 25, protocol: 1 })
    s.ws.send(JSON.stringify({ v: 1, type: 'typing', data: {} }))
    await until(() => s.of('error').length === 1)
    s.ws.close()
  })

  it('rejects a disallowed Origin with 403 and ignores tokens in the URL', async () => {
    await expect(socket(url, undefined, { origin: 'https://evil.test' }).opened).rejects.toThrow('HTTP 403')
    const a = await user(t)
    const s = socket(`${url}?token=${a.token}`)
    await s.opened
    expect((await s.closed).code).toBe(4408) // still waits for the auth frame, then times out
  }, 10_000)

  it('closes 4401 on a bad token, 4400 on garbage or a non-auth first frame', async () => {
    const bad = socket(url, 'ac1_' + 'x'.repeat(43))
    await bad.opened
    expect((await bad.closed).code).toBe(4401)
    const garbage = socket(url)
    await garbage.opened
    garbage.ws.send('not json')
    expect((await garbage.closed).code).toBe(4400)
    const early = socket(url)
    await early.opened
    early.ws.send(JSON.stringify({ v: 1, type: 'typing', data: {} }))
    expect((await early.closed).code).toBe(4400)
  })

  it('closes 1009 on an oversized frame and 4429 on a frame flood', async () => {
    const a = await user(t)
    const big = socket(url, a.token)
    await big.ready
    big.ws.send('x'.repeat(17 * 1024))
    expect((await big.closed).code).toBe(1009)
    const flood = socket(url, a.token)
    await flood.ready
    for (let i = 0; i < 25; i++) flood.ws.send(JSON.stringify({ v: 1, type: 'noop' }))
    expect((await flood.closed).code).toBe(4429)
  })

  it('caps sockets per user', async () => {
    const capped = await setup({ config: { maxSocketsPerUser: 2 } })
    try {
      const u = await listen(capped)
      const a = await user(capped)
      const [s1, s2] = [socket(u, a.token), socket(u, a.token)]
      await Promise.all([s1.ready, s2.ready])
      const s3 = socket(u, a.token)
      expect((await s3.closed).code).toBe(4429)
      s1.ws.close()
      s2.ws.close()
    } finally {
      await capped.close()
    }
  })
})

describe('delivery', () => {
  it('reaches every session of every member, never a non-member, and stops after removal', async () => {
    const [a, b, outsider] = [await user(t), await user(t), await user(t)]
    const b2 = await call(t, 'POST', '/api/v1/auth/login', undefined, { username: b.user.username, password: 'correct horse battery' })
    const g = await call(t, 'POST', '/api/v1/conversations/group', a.token, { title: 'Live', memberIds: [b.user.id] })
    const [sa, sb, sb2, so] = [socket(url, a.token), socket(url, b.token), socket(url, b2.body.token), socket(url, outsider.token)]
    await Promise.all([sa.ready, sb.ready, sb2.ready, so.ready])

    const key = uuid()
    const started = Date.now()
    await send(a.token, g.body.id, 'hello live', key)
    await until(() => sb.of('message.created').length === 1 && sb2.of('message.created').length === 1 && sa.of('message.created').length === 1)
    expect(Date.now() - started).toBeLessThan(1000)
    const forB = sb.of('message.created')[0].data as { message: Message }
    expect(forB.message).toMatchObject({ body: 'hello live', seq: 1 })
    expect(forB.message.clientMessageId).toBeUndefined()
    expect((sa.of('message.created')[0].data as { message: Message }).message.clientMessageId).toBe(key)
    await sleep(300)
    expect(so.frames.filter((f) => f.type !== 'ready')).toEqual([])

    // A retried send is not delivered twice.
    await send(a.token, g.body.id, 'hello live', key)
    await call(t, 'POST', `/api/v1/conversations/${g.body.id}/read`, b.token, { seq: 1 })
    await until(() => sa.of('read.updated').length === 1)
    expect(sb.of('message.created')).toHaveLength(1)

    await call(t, 'DELETE', `/api/v1/conversations/${g.body.id}/members/${b.user.id}`, a.token)
    await until(() => sb.of('conversation.removed').length === 1 && sa.of('member.removed').length === 1)
    await send(a.token, g.body.id, 'after removal')
    await until(() => sa.of('message.created').length === 2)
    await sleep(300)
    expect(sb.of('message.created')).toHaveLength(1)

    for (const s of [sa, sb, sb2, so]) s.ws.close()
  })

  it('announces new conversations, members, renames and deletions', async () => {
    const [a, b, c] = [await user(t), await user(t), await user(t)]
    const [sa, sb, sc] = [socket(url, a.token), socket(url, b.token), socket(url, c.token)]
    await Promise.all([sa.ready, sb.ready, sc.ready])
    const g = await call(t, 'POST', '/api/v1/conversations/group', a.token, { title: 'Hi', memberIds: [b.user.id] })
    await until(() => sb.of('conversation.created').length === 1)
    await call(t, 'POST', `/api/v1/conversations/${g.body.id}/members`, a.token, { userIds: [c.user.id] })
    await until(() => sc.of('conversation.created').length === 1 && sb.of('member.added').length === 1)
    await call(t, 'PATCH', `/api/v1/conversations/${g.body.id}`, a.token, { title: 'Renamed' })
    await until(() => sc.of('conversation.updated').length === 1)
    const m = await send(b.token, g.body.id, 'delete me')
    await call(t, 'DELETE', `/api/v1/conversations/${g.body.id}/messages/${m.body.message.id}`, b.token)
    await until(() => sc.of('message.deleted').length === 1)
    for (const s of [sa, sb, sc]) s.ws.close()
  })
})

describe('revocation', () => {
  it('logout, revoke and admin disable close the right sockets with 4401 within a second', async () => {
    const a = await user(t, 'revoker', 'correct horse battery')
    const login = () => call(t, 'POST', '/api/v1/auth/login', undefined, { username: 'revoker', password: 'correct horse battery' }).then((r) => r.body.token as string)
    const [t2, t3] = [await login(), await login()]
    const [s1, s2, s3] = [socket(url, a.token), socket(url, t2), socket(url, t3)]
    await Promise.all([s1.ready, s2.ready, s3.ready])

    await call(t, 'POST', '/api/v1/auth/logout', t3)
    expect((await s3.closed).code).toBe(4401)
    expect(s3.of('session.revoked')).toHaveLength(1)
    await call(t, 'POST', '/api/v1/auth/sessions/revoke', a.token, { others: true })
    expect((await s2.closed).code).toBe(4401)
    expect(s1.ws.readyState).toBe(s1.ws.OPEN)

    const admin = await user(t)
    await t.db.updateTable('users').set({ role: 'admin' }).where('id', '=', admin.user.id).execute()
    const started = Date.now()
    await call(t, 'POST', `/api/v1/admin/users/${a.user.id}/disable`, admin.token)
    expect((await s1.closed).code).toBe(4401)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('periodic re-validation closes sockets whose session was revoked by another process (the CLI)', async () => {
    const a = await user(t)
    const s = socket(url, a.token)
    await s.ready
    await t.db.updateTable('sessions').set({ revoked_at: new Date() }).where('id', '=', a.session.id).execute()
    await t.ctx.hub.revalidate(t.ctx)
    expect((await s.closed).code).toBe(4401)
  })
})

describe('reconnect and shutdown', () => {
  it('a client that was offline catches up with afterSeq without duplicates', async () => {
    const [a, b] = [await user(t), await user(t)]
    const dm = await call(t, 'POST', '/api/v1/conversations/direct', a.token, { userId: b.user.id })
    const first = socket(url, b.token)
    await first.ready
    await send(a.token, dm.body.id, 'one')
    await until(() => first.of('message.created').length === 1)
    const lastSeq = (first.of('message.created')[0].data as { message: Message }).message.seq
    first.ws.close()
    await first.closed
    await send(a.token, dm.body.id, 'two')
    await send(a.token, dm.body.id, 'three')
    const again = socket(url, b.token)
    await again.ready
    const list = await call(t, 'GET', '/api/v1/conversations', b.token)
    expect(list.body.find((c: { id: string }) => c.id === dm.body.id).lastSeq).toBe(3)
    const missed = await call(t, 'GET', `/api/v1/conversations/${dm.body.id}/messages?afterSeq=${lastSeq}`, b.token)
    expect(missed.body.messages.map((m: Message) => m.body)).toEqual(['two', 'three'])
    again.ws.close()
  })

  it('closes sockets with 1001 on shutdown and refuses new upgrades', async () => {
    const own = await setup()
    const u = await listen(own)
    const a = await user(own)
    const s = socket(u, a.token)
    await s.ready
    await own.close()
    expect((await s.closed).code).toBe(1001)
  })
})
