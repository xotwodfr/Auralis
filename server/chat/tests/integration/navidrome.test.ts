// Navidrome users sign in to chat with their music-server credentials; the account is created on first sign-in.
import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { Conversation } from '../../../../shared/chat-protocol/index.ts'
import { hashPassword } from '../../src/crypto.ts'
import { call, setup, type TestApp } from '../helpers.ts'

const PASSWORDS: Record<string, string> = { alice: 'short', boss: 'navidrome-pw' }
let navidrome: Server
let t: TestApp

beforeAll(async () => {
  navidrome = createServer((req, res) => {
    const q = new URL(req.url ?? '', 'http://x').searchParams
    const pw = PASSWORDS[(q.get('u') ?? '').toLowerCase()]
    const ok = req.url?.startsWith('/rest/ping.view') && pw !== undefined && createHash('md5').update(pw + q.get('s')).digest('hex') === q.get('t')
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ 'subsonic-response': ok ? { status: 'ok' } : { status: 'failed', error: { code: 40 } } }))
  })
  await new Promise<void>((r) => navidrome.listen(0, '127.0.0.1', r))
  t = await setup({ env: { CHAT_REGISTRATION: 'closed' }, config: { navidromeUrl: `http://127.0.0.1:${(navidrome.address() as AddressInfo).port}` } })
})
afterAll(async () => {
  await t.close()
  navidrome.close()
})

const login = (username: string, password: string) => call(t, 'POST', '/api/v1/auth/login', undefined, { username, password })

it('creates the chat account on first sign-in, in the lobby, and keeps working afterwards', async () => {
  const first = await login('Alice', 'short')
  expect(first.status).toBe(200)
  expect(first.body.user.username).toBe('alice')
  const convs = (await call(t, 'GET', '/api/v1/conversations', first.body.token)).body as Conversation[]
  expect(convs.map((c) => c.title)).toContain('Lobby')
  expect((await login('alice', 'short')).status).toBe(200)
  expect(await t.db.selectFrom('users').select('id').where('username', '=', 'alice').execute()).toHaveLength(1)
})

it('rejects wrong passwords and unknown Navidrome users', async () => {
  expect((await login('alice', 'wrong')).status).toBe(401)
  expect((await login('nobody', 'whatever')).status).toBe(401)
})

it('never lets Navidrome credentials into an admin account', async () => {
  await t.db.insertInto('users').values({ username: 'boss', display_name: 'boss', password_hash: await hashPassword('chat-admin-password', t.config.scryptLogN), role: 'admin' }).execute()
  expect((await login('boss', 'navidrome-pw')).status).toBe(401)
  expect((await login('boss', 'chat-admin-password')).status).toBe(200)
})
