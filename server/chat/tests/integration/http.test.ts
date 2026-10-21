// Health, server-info, auth/session lifecycle, registration modes, rate limits, CORS, limits, route inventory, logging.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createInvite, runMaintenance } from '../../src/admin.ts'
import { migrateToLatest } from '../../src/db.ts'
import { call, ORIGIN, setup, user, uuid, type TestApp } from '../helpers.ts'

let t: TestApp
beforeAll(async () => (t = await setup({ captureLogs: true })))
afterAll(() => t.close())

describe('health', () => {
  it('readyz is 503 until migrated, then 200; instanceId is stable', async () => {
    const fresh = await setup({ migrate: false })
    try {
      expect((await call(fresh, 'GET', '/healthz')).status).toBe(200)
      expect((await call(fresh, 'GET', '/readyz')).status).toBe(503)
      await migrateToLatest(fresh.db)
      expect((await call(fresh, 'GET', '/readyz')).status).toBe(200)
      const info = await call(fresh, 'GET', '/api/v1/server-info')
      expect(info.body).toMatchObject({ protocol: 1, version: '9.9.9', registration: 'open', limits: { maxMessageChars: 4000 } })
      expect(info.body.instanceId).toMatch(/^[0-9a-f-]{36}$/)
      fresh.ctx.state.instanceId = undefined
      expect((await call(fresh, 'GET', '/api/v1/server-info')).body.instanceId).toBe(info.body.instanceId)
      fresh.ctx.state.shuttingDown = true
      expect((await call(fresh, 'GET', '/healthz')).status).toBe(503)
      expect((await call(fresh, 'GET', '/readyz')).status).toBe(503)
    } finally {
      await fresh.close()
    }
  })

  it('reports a dead database as 503, not a crash', async () => {
    const dead = await setup()
    const alex = await user(dead)
    await dead.db.destroy()
    // A pool that can never connect stands in for a stopped `db` container.
    const { createDb } = await import('../../src/db.ts')
    dead.ctx.db = createDb('postgres://nobody:nothing@127.0.0.1:1/none')
    const { buildApp } = await import('../../src/app.ts')
    const down = await buildApp(dead.config, dead.ctx.db, { logger: false })
    try {
      expect((await down.app.inject({ url: '/readyz' })).statusCode).toBe(503)
      const res = await down.app.inject({ url: '/api/v1/me', headers: { authorization: `Bearer ${alex.token}` } })
      expect(res.statusCode).toBe(503)
      expect(res.json().error.code).toBe('service_unavailable')
    } finally {
      await down.app.close()
      await dead.app.close()
      await dead.ctx.db.destroy()
    }
  })
})

describe('accounts and sessions', () => {
  it('registers, signs in, and never returns token material in session lists', async () => {
    const res = await call(t, 'POST', '/api/v1/auth/register', undefined, { username: 'Alice', password: 'correct horse battery' })
    expect(res.status).toBe(201)
    const reg = res.body
    expect(reg.user).toMatchObject({ username: 'alice', displayName: 'alice', role: 'user' })
    expect(reg.token).toMatch(/^ac1_/)
    expect((await call(t, 'POST', '/api/v1/auth/register', undefined, { username: 'ALICE', password: 'another password' })).status).toBe(409)

    const login = await call(t, 'POST', '/api/v1/auth/login', undefined, { username: 'alice', password: 'correct horse battery', deviceName: 'Phone' })
    expect(login.status).toBe(200)
    const me = await call(t, 'GET', '/api/v1/me', login.body.token)
    expect(me.body.username).toBe('alice')
    const sessions = await call(t, 'GET', '/api/v1/auth/sessions', login.body.token)
    expect(sessions.body).toHaveLength(2)
    expect(sessions.body.find((s: { current: boolean }) => s.current).deviceName).toBe('Phone')
    expect(JSON.stringify(sessions.body)).not.toContain('ac1_')

    const stored = await t.db.selectFrom('users').select('password_hash').where('username', '=', 'alice').executeTakeFirstOrThrow()
    expect(stored.password_hash).toMatch(/^scrypt\$/)
    const tokens = await t.db.selectFrom('sessions').select('token_hash').execute()
    expect(tokens.every((s) => s.token_hash.length === 32)).toBe(true)
  })

  it('answers wrong usernames and wrong passwords identically', async () => {
    await user(t, 'bob')
    const a = await call(t, 'POST', '/api/v1/auth/login', undefined, { username: 'bob', password: 'wrong wrong wrong' })
    const b = await call(t, 'POST', '/api/v1/auth/login', undefined, { username: 'nobody-here', password: 'wrong wrong wrong' })
    expect([a.status, b.status]).toEqual([401, 401])
    expect(a.body).toEqual(b.body)
  })

  it('logout, revoke one, revoke others and password change all take effect on the next request', async () => {
    const first = await user(t, 'carol', 'correct horse battery')
    const login = () => call(t, 'POST', '/api/v1/auth/login', undefined, { username: 'carol', password: 'correct horse battery' }).then((r) => r.body.token as string)
    const second = await login()
    const third = await login()

    expect((await call(t, 'POST', '/api/v1/auth/logout', third)).status).toBe(204)
    expect((await call(t, 'GET', '/api/v1/me', third)).status).toBe(401)

    const fourth = await login()
    const fourthId = (await call(t, 'GET', '/api/v1/auth/sessions', fourth)).body.find((s: { current: boolean }) => s.current).id
    expect((await call(t, 'POST', '/api/v1/auth/sessions/revoke', first.token, { sessionId: fourthId })).status).toBe(204)
    expect((await call(t, 'GET', '/api/v1/me', fourth)).status).toBe(401)
    expect((await call(t, 'POST', '/api/v1/auth/sessions/revoke', first.token, { sessionId: uuid() })).status).toBe(404)
    expect((await call(t, 'POST', '/api/v1/auth/sessions/revoke', first.token, {})).status).toBe(400)

    expect((await call(t, 'POST', '/api/v1/auth/sessions/revoke', first.token, { others: true })).status).toBe(204)
    expect((await call(t, 'GET', '/api/v1/me', second)).status).toBe(401)
    expect((await call(t, 'GET', '/api/v1/me', first.token)).status).toBe(200)

    const fifth = await login()
    expect((await call(t, 'POST', '/api/v1/auth/password', first.token, { currentPassword: 'nope nope nope', newPassword: 'brand new password' })).status).toBe(403)
    expect((await call(t, 'POST', '/api/v1/auth/password', first.token, { currentPassword: 'correct horse battery', newPassword: 'brand new password' })).status).toBe(204)
    expect((await call(t, 'GET', '/api/v1/me', fifth)).status).toBe(401)
    expect((await call(t, 'GET', '/api/v1/me', first.token)).status).toBe(200)
    expect((await call(t, 'POST', '/api/v1/auth/login', undefined, { username: 'carol', password: 'brand new password' })).status).toBe(200)
  })

  it('expires idle and absolute sessions', async () => {
    const dave = await user(t, 'dave')
    await t.db.updateTable('sessions').set({ last_used_at: new Date(Date.now() - 31 * 86_400_000) }).where('id', '=', dave.session.id).execute()
    expect((await call(t, 'GET', '/api/v1/me', dave.token)).status).toBe(401)
    const again = await user(t, 'dave2')
    await t.db.updateTable('sessions').set({ expires_at: new Date(Date.now() - 1000) }).where('id', '=', again.session.id).execute()
    expect((await call(t, 'GET', '/api/v1/me', again.token)).status).toBe(401)
  })

  it('updates the display name and rejects bad input with 400 and no stack trace', async () => {
    const erin = await user(t, 'erin')
    expect((await call(t, 'PATCH', '/api/v1/me', erin.token, { displayName: ' Erin  E. ' })).body.displayName).toBe('Erin E.')
    for (const body of [{ displayName: '' }, { displayName: { a: 1 } }, { displayName: 'x', extra: 1 }]) {
      const res = await call(t, 'PATCH', '/api/v1/me', erin.token, body)
      expect(res.status).toBe(400)
      expect(JSON.stringify(res.body)).not.toMatch(/at .*\.ts/)
    }
  })

  it('throttles repeated failed sign-ins with 429 and Retry-After', async () => {
    await user(t, 'frank')
    const statuses: number[] = []
    let retry: string | undefined
    for (let i = 0; i < 7; i++) {
      const res = await call(t, 'POST', '/api/v1/auth/login', undefined, { username: 'frank', password: 'wrong wrong wrong' }, {}, '192.0.2.1')
      statuses.push(res.status)
      retry ??= res.headers['retry-after'] as string | undefined
    }
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401])
    expect(statuses.slice(5)).toEqual([429, 429])
    expect(Number(retry)).toBeGreaterThan(0)
  })
})

describe('registration modes', () => {
  it('limits sign-ups per address', async () => {
    const statuses = []
    for (let i = 0; i < 6; i++) statuses.push((await call(t, 'POST', '/api/v1/auth/register', undefined, { username: `burst${i}`, password: 'correct horse battery' }, {}, '192.0.2.2')).status)
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429])
  })

  it('closed refuses sign-up', async () => {
    const closed = await setup({ env: { CHAT_REGISTRATION: 'closed' } })
    try {
      const res = await call(closed, 'POST', '/api/v1/auth/register', undefined, { username: 'zed', password: 'correct horse battery' })
      expect([res.status, res.body.error.code]).toEqual([403, 'registration_closed'])
    } finally {
      await closed.close()
    }
  })

  it('invite requires a valid code and exhausts it', async () => {
    const inv = await setup({ env: { CHAT_REGISTRATION: 'invite' } })
    try {
      const admin = await inv.db.insertInto('users').values({ username: 'root', display_name: 'root', password_hash: 'x', role: 'admin' }).returning('id').executeTakeFirstOrThrow()
      const { code } = await createInvite(inv.db, admin.id, 1, 1)
      const reg = (inviteCode?: string, username = 'newbie') => call(inv, 'POST', '/api/v1/auth/register', undefined, { username, password: 'correct horse battery', inviteCode })
      expect((await reg()).status).toBe(400)
      expect((await reg('wrong-code')).status).toBe(403)
      expect((await reg(code)).status).toBe(201)
      expect((await reg(code, 'second')).status).toBe(403)
      const { code: expired } = await createInvite(inv.db, admin.id, 5, 1)
      await inv.db.updateTable('invites').set({ expires_at: new Date(Date.now() - 1000) }).execute()
      expect((await reg(expired, 'third')).status).toBe(403)
    } finally {
      await inv.close()
    }
  })
})

describe('admin', () => {
  it('only admins create invites and disable users; disabling signs the user out', async () => {
    const boss = await user(t, 'boss')
    await t.db.updateTable('users').set({ role: 'admin' }).where('id', '=', boss.user.id).execute()
    const victim = await user(t, 'victim')
    expect((await call(t, 'POST', '/api/v1/admin/invites', victim.token, {})).status).toBe(403)
    const invite = await call(t, 'POST', '/api/v1/admin/invites', boss.token, { maxUses: 3, expiresInHours: 2 })
    expect(invite.status).toBe(201)
    expect(invite.body.code).toBeTruthy()
    expect((await call(t, 'GET', '/api/v1/admin/users', boss.token)).body.some((u: { username: string }) => u.username === 'victim')).toBe(true)
    expect((await call(t, 'POST', `/api/v1/admin/users/${victim.user.id}/disable`, boss.token)).status).toBe(204)
    expect((await call(t, 'GET', '/api/v1/me', victim.token)).status).toBe(401)
    expect((await call(t, 'POST', '/api/v1/auth/login', undefined, { username: 'victim', password: 'correct horse battery' })).status).toBe(401)
    expect((await call(t, 'POST', `/api/v1/admin/users/${victim.user.id}/enable`, boss.token)).status).toBe(204)
    expect((await call(t, 'POST', '/api/v1/auth/login', undefined, { username: 'victim', password: 'correct horse battery' })).status).toBe(200)
    expect((await call(t, 'POST', `/api/v1/admin/users/${uuid()}/disable`, boss.token)).status).toBe(404)
  })
})

describe('transport', () => {
  it('CORS echoes only allowed origins, answers preflight, and never sets cookies', async () => {
    const ok = await call(t, 'GET', '/api/v1/server-info', undefined, undefined, { origin: ORIGIN })
    expect(ok.headers['access-control-allow-origin']).toBe(ORIGIN)
    expect(ok.headers.vary).toContain('Origin')
    expect(ok.headers['access-control-allow-credentials']).toBeUndefined()
    const bad = await call(t, 'GET', '/api/v1/server-info', undefined, undefined, { origin: 'https://evil.test' })
    expect(bad.headers['access-control-allow-origin']).toBeUndefined()

    const pre = await t.app.inject({ method: 'OPTIONS', url: '/api/v1/auth/login', headers: { origin: ORIGIN, 'access-control-request-method': 'POST' } })
    expect(pre.statusCode).toBe(204)
    expect(pre.headers['access-control-allow-headers']).toContain('authorization')
    const preBad = await t.app.inject({ method: 'OPTIONS', url: '/api/v1/auth/login', headers: { origin: 'https://evil.test' } })
    expect(preBad.statusCode).toBe(403)

    for (const res of [ok, bad]) {
      expect(res.headers['set-cookie']).toBeUndefined()
      expect(res.headers['x-content-type-options']).toBe('nosniff')
      expect(res.headers['cache-control']).toBe('no-store')
    }
  })

  it('rejects bodies over 32 KiB with 413', async () => {
    const res = await call(t, 'POST', '/api/v1/auth/login', undefined, { username: 'x', password: 'y'.repeat(40_000) })
    expect(res.status).toBe(413)
  })
})

describe('route inventory (CHAT.md §13.2)', () => {
  const PUBLIC = new Set(['GET /healthz', 'GET /readyz', 'GET /api/v1/server-info', 'POST /api/v1/auth/register', 'POST /api/v1/auth/login', 'GET /api/v1/ws'])
  // A valid body per conversation-scoped route, so the 404 comes from requireMember and not from validation.
  const BODIES: Record<string, unknown> = {
    'GET /api/v1/conversations/:id': undefined,
    'PATCH /api/v1/conversations/:id': { title: 'renamed' },
    'POST /api/v1/conversations/:id/members': { userIds: [uuid()] },
    'DELETE /api/v1/conversations/:id/members/:userId': undefined,
    'GET /api/v1/conversations/:id/messages': undefined,
    'POST /api/v1/conversations/:id/messages': { clientMessageId: uuid(), body: 'hi' },
    'DELETE /api/v1/conversations/:id/messages/:messageId': undefined,
    'POST /api/v1/conversations/:id/read': { seq: 1 },
  }

  it('every non-public route needs a token, and every conversation route hides non-members behind 404', async () => {
    const routes = t.routes.filter((r) => r.method !== 'OPTIONS')
    expect(routes.length).toBeGreaterThan(20)
    for (const r of routes.filter((r) => !PUBLIC.has(`${r.method} ${r.url}`))) {
      const url = r.url.replace(/:[a-zA-Z]+/g, uuid())
      const res = await call(t, r.method, url, undefined, r.method === 'GET' || r.method === 'DELETE' ? undefined : {})
      expect(res.status, `${r.method} ${r.url}`).toBe(401)
      expect((await call(t, r.method, url, 'ac1_' + 'x'.repeat(43), {})).status, `${r.method} ${r.url} bad token`).toBe(401)
    }

    const a = await user(t)
    const b = await user(t)
    const outsider = await user(t)
    const group = await call(t, 'POST', '/api/v1/conversations/group', a.token, { title: 'Private', memberIds: [b.user.id] })
    const msg = await call(t, 'POST', `/api/v1/conversations/${group.body.id}/messages`, a.token, { clientMessageId: uuid(), body: 'secret' })
    const scoped = routes.filter((r) => r.url.startsWith('/api/v1/conversations/:id'))
    expect(scoped.map((r) => `${r.method} ${r.url}`).sort()).toEqual(Object.keys(BODIES).sort())
    for (const r of scoped) {
      const url = r.url.replace(':id', group.body.id).replace(':userId', b.user.id).replace(':messageId', msg.body.message.id)
      const res = await call(t, r.method, url, outsider.token, BODIES[`${r.method} ${r.url}`])
      expect(res.status, `${r.method} ${r.url}`).toBe(404)
      expect(JSON.stringify(res.body)).not.toContain('secret')
    }
  })
})

describe('logging', () => {
  it('never logs tokens, passwords, invite codes or message bodies', async () => {
    const secret = 'unique-password-9f3k2'
    const a = await user(t, 'logger1', secret)
    const b = await user(t, 'logger2')
    const dm = await call(t, 'POST', '/api/v1/conversations/direct', a.token, { userId: b.user.id })
    const body = 'the secret message body 7731'
    await call(t, 'POST', `/api/v1/conversations/${dm.body.id}/messages`, a.token, { clientMessageId: uuid(), body })
    await call(t, 'POST', `/api/v1/conversations/${dm.body.id}/messages`, a.token, { clientMessageId: 'not-a-uuid', body })
    await call(t, 'GET', '/api/v1/users/search?q=logger', a.token)
    await call(t, 'POST', '/api/v1/auth/login', undefined, { username: 'logger1', password: secret })
    await call(t, 'POST', '/api/v1/auth/login', undefined, { username: 'logger1', password: `${secret}-wrong` })
    const all = t.logs.join('\n')
    expect(all.length).toBeGreaterThan(0)
    for (const leaked of [secret, a.token, b.token, body, 'q=logger']) expect(all).not.toContain(leaked)
  })
})

describe('maintenance', () => {
  it('scrubs bodies of messages deleted longer ago than the retention', async () => {
    const a = await user(t, 'scrub1')
    const b = await user(t, 'scrub2')
    const dm = await call(t, 'POST', '/api/v1/conversations/direct', a.token, { userId: b.user.id })
    const sent = await call(t, 'POST', `/api/v1/conversations/${dm.body.id}/messages`, a.token, { clientMessageId: uuid(), body: 'to be scrubbed' })
    await call(t, 'DELETE', `/api/v1/conversations/${dm.body.id}/messages/${sent.body.message.id}`, a.token)
    await t.db.updateTable('messages').set({ deleted_at: new Date(Date.now() - 31 * 86_400_000) }).where('id', '=', sent.body.message.id).execute()
    const r = await runMaintenance(t.db, 30)
    expect(r.scrubbed).toBeGreaterThanOrEqual(1)
    const row = await t.db.selectFrom('messages').select('body').where('id', '=', sent.body.message.id).executeTakeFirstOrThrow()
    expect(row.body).toBeNull()
  })
})
