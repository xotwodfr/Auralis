import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { Writable } from 'node:stream'
import pg from 'pg'
import { inject } from 'vitest'
import WebSocket from 'ws'
import type { AuthResult, ServerFrame } from '../../../shared/chat-protocol/index.ts'
import { buildApp } from '../src/app.ts'
import { createSession } from '../src/auth.ts'
import { hashPassword } from '../src/crypto.ts'
import { loadConfig, type Config } from '../src/config.ts'
import { createDb, migrateToLatest } from '../src/db.ts'

export const ORIGIN = 'http://allowed.test'

/** A fresh database (migrated unless `migrate: false`) and an app on top of it. */
export async function setup(opts: { env?: Record<string, string>; config?: Partial<Config>; migrate?: boolean; captureLogs?: boolean } = {}) {
  const base = new URL(inject('pgUrl'))
  const name = `t_${randomUUID().replace(/-/g, '')}`
  const admin = new pg.Client({ connectionString: base.toString() })
  await admin.connect()
  await admin.query(`CREATE DATABASE ${name}`)
  await admin.end()
  base.pathname = `/${name}`
  const { config } = loadConfig({ DATABASE_URL: base.toString(), CHAT_REGISTRATION: 'open', CHAT_ALLOWED_ORIGINS: ORIGIN, ...opts.env }, '9.9.9')
  Object.assign(config, { scryptLogN: 10 }, opts.config)
  const db = createDb(config.databaseUrl)
  if (opts.migrate !== false) await migrateToLatest(db)
  const logs: string[] = []
  const logStream = new Writable({ write: (chunk, _enc, cb) => (logs.push(String(chunk)), cb()) })
  if (opts.captureLogs) config.logLevel = 'trace'
  const { app, ctx, routes } = await buildApp(config, db, opts.captureLogs ? { logStream } : { logger: false })
  return {
    app,
    ctx,
    routes,
    db,
    config,
    logs,
    async close() {
      await app.close()
      await db.destroy()
    },
  }
}

export type TestApp = Awaited<ReturnType<typeof setup>>

let addr = 0
/** Each call comes from its own address unless `remoteAddress` is given, so per-address limits don't leak between tests. */
export async function call(t: TestApp, method: string, url: string, token?: string, body?: unknown, headers: Record<string, string> = {}, remoteAddress = `10.0.${(++addr >> 8) & 255}.${addr & 255}`) {
  const res = await t.app.inject({
    method: method as 'GET',
    url,
    remoteAddress,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body !== undefined ? { payload: body as object } : {}),
  })
  return { status: res.statusCode, body: res.body ? res.json() : undefined, headers: res.headers }
}

let counter = 0
/** Creates a user directly (registration is rate-limited per address, and every test request comes from loopback). */
export async function user(t: TestApp, name = `user${++counter}`, password = 'correct horse battery'): Promise<AuthResult> {
  const row = await t.db
    .insertInto('users')
    .values({ username: name.toLowerCase(), display_name: name.toLowerCase(), password_hash: await hashPassword(password, t.config.scryptLogN), role: 'user' })
    .returningAll()
    .executeTakeFirstOrThrow()
  return createSession(t.db, t.ctx, row)
}

export async function listen(t: TestApp): Promise<string> {
  if (!t.app.server.listening) await t.app.listen({ host: '127.0.0.1', port: 0 })
  return `ws://127.0.0.1:${(t.app.server.address() as AddressInfo).port}/api/v1/ws`
}

/** A connected socket that records every frame and close. `ready` resolves after auth. */
export function socket(url: string, token?: string, opts: { origin?: string } = {}) {
  const ws = new WebSocket(url, opts.origin ? { origin: opts.origin } : {})
  const frames: ServerFrame[] = []
  const closed = new Promise<{ code: number; reason: string }>((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })))
  const opened = new Promise<void>((resolve, reject) => {
    ws.on('open', () => resolve())
    ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)))
    ws.on('error', reject)
  })
  ws.on('message', (raw) => frames.push(JSON.parse(raw.toString())))
  const ready = opened.then(async () => {
    if (token) ws.send(JSON.stringify({ v: 1, type: 'auth', data: { token } }))
    await until(() => frames.some((f) => f.type === 'ready'))
  })
  ready.catch(() => {}) // sockets that are meant to fail never become ready; awaiting it still rejects
  return { ws, frames, closed, opened, ready, of: (type: string) => frames.filter((f) => f.type === type) }
}

export async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 10))
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
export const uuid = () => randomUUID()
