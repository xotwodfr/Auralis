// Real-time delivery: the in-memory socket registry (userId → sockets) and the /api/v1/ws route. CHAT.md §3.4, §5.4.
// Clients never subscribe: recipients are decided at fan-out time from the database's current membership.
import type { FastifyInstance } from 'fastify'
import type { WebSocket } from 'ws'
import type { ServerEvent } from '../../../shared/chat-protocol/index.ts'
import type { Ctx } from './app.ts'
import { authenticate } from './auth.ts'

export const HEARTBEAT_SEC = 25
const AUTH_TIMEOUT_MS = 5000
const MAX_BUFFERED = 1024 * 1024
const FRAMES_PER_WINDOW = 20
const FRAME_WINDOW_MS = 10_000
const REVALIDATE_EVERY = 2 // heartbeats; ≈ 50 s

interface Conn {
  socket: WebSocket
  userId: string
  sessionId: string
  alive: boolean
}

export class Hub {
  private byUser = new Map<string, Set<Conn>>()
  private timer?: NodeJS.Timeout

  add(socket: WebSocket, userId: string, sessionId: string): Conn {
    const conn: Conn = { socket, userId, sessionId, alive: true }
    let set = this.byUser.get(userId)
    if (!set) this.byUser.set(userId, (set = new Set()))
    set.add(conn)
    socket.on('pong', () => (conn.alive = true))
    socket.on('close', () => {
      set.delete(conn)
      if (!set.size && this.byUser.get(userId) === set) this.byUser.delete(userId)
    })
    return conn
  }

  count(userId: string): number {
    return this.byUser.get(userId)?.size ?? 0
  }

  isOnline(userId: string): boolean {
    return this.count(userId) > 0
  }

  private *all(): Iterable<Conn> {
    for (const set of this.byUser.values()) yield* set
  }

  send(conn: Conn, event: ServerEvent) {
    const { socket } = conn
    if (socket.readyState !== socket.OPEN) return
    // A slow consumer must never grow server memory: drop it, it resyncs over REST on reconnect.
    if (socket.bufferedAmount > MAX_BUFFERED) {
      socket.close(1013, 'slow consumer')
      setTimeout(() => socket.terminate(), 5000).unref()
      return
    }
    socket.send(JSON.stringify({ v: 1, ...event }))
  }

  toUsers(userIds: Iterable<string>, event: ServerEvent | ((userId: string) => ServerEvent)) {
    for (const userId of new Set(userIds)) {
      const set = this.byUser.get(userId)
      if (!set) continue
      const ev = typeof event === 'function' ? event(userId) : event
      for (const conn of set) this.send(conn, ev)
    }
  }

  private revoke(conns: Conn[]) {
    for (const conn of conns) {
      this.send(conn, { type: 'session.revoked', data: {} })
      conn.socket.close(4401, 'signed out')
    }
  }

  closeSessions(sessionIds: string[]) {
    if (!sessionIds.length) return
    const ids = new Set(sessionIds)
    this.revoke([...this.all()].filter((c) => ids.has(c.sessionId)))
  }

  closeUsers(userIds: string[]) {
    this.revoke(userIds.flatMap((id) => [...(this.byUser.get(id) ?? [])]))
  }

  /** Heartbeat (ping, terminate if no pong since the last one) and periodic session re-validation, which catches
   *  expiry and revocations made by another process (the CLI). */
  start(ctx: Ctx) {
    let tick = 0
    this.timer = setInterval(async () => {
      for (const conn of this.all()) {
        if (!conn.alive) {
          conn.socket.terminate()
          continue
        }
        conn.alive = false
        conn.socket.ping()
      }
      if (++tick % REVALIDATE_EVERY === 0) await this.revalidate(ctx).catch(() => {}) // db down: try again next time
    }, HEARTBEAT_SEC * 1000)
    this.timer.unref()
  }

  async revalidate(ctx: Ctx) {
    const conns = [...this.all()]
    if (!conns.length) return
    const now = new Date()
    const idleCutoff = new Date(now.getTime() - ctx.config.sessionIdleDays * 86_400_000)
    const valid = await ctx.db
      .selectFrom('sessions as s')
      .innerJoin('users as u', 'u.id', 's.user_id')
      .select('s.id')
      .where('s.id', 'in', [...new Set(conns.map((c) => c.sessionId))])
      .where('s.revoked_at', 'is', null)
      .where('s.expires_at', '>', now)
      .where('s.last_used_at', '>', idleCutoff)
      .where('u.disabled_at', 'is', null)
      .execute()
    const ok = new Set(valid.map((r) => r.id))
    this.revoke(conns.filter((c) => !ok.has(c.sessionId)))
  }

  stop() {
    clearInterval(this.timer)
  }
}

export function socketRoute(app: FastifyInstance, ctx: Ctx) {
  const { hub, config } = ctx
  const allowed = new Set(config.allowedOrigins)

  app.get(
    '/api/v1/ws',
    {
      websocket: true,
      // Cross-site WebSocket hijacking defence. Native clients send no Origin and are allowed.
      preValidation: async (req, reply) => {
        const origin = req.headers.origin
        if (origin && !allowed.has(origin)) return reply.code(403).send({ error: { code: 'origin_not_allowed', message: 'Origin not allowed' } })
        if (ctx.state.shuttingDown) return reply.code(503).send({ error: { code: 'service_unavailable', message: 'Server is restarting' } })
      },
    },
    (socket) => {
      let conn: Conn | null = null
      let authenticating = false
      const frames: number[] = []
      const authTimer = setTimeout(() => socket.close(4408, 'auth timeout'), AUTH_TIMEOUT_MS)
      socket.on('close', () => clearTimeout(authTimer))
      socket.on('error', () => socket.terminate())

      socket.on('message', async (raw, isBinary) => {
        const now = Date.now()
        while (frames.length && now - frames[0] > FRAME_WINDOW_MS) frames.shift()
        if (frames.push(now) > FRAMES_PER_WINDOW) return socket.close(4429, `retry:${FRAME_WINDOW_MS / 1000}`)
        let frame: { v?: unknown; type?: unknown; data?: { token?: unknown } }
        try {
          if (isBinary) throw new Error('binary')
          frame = JSON.parse(raw.toString())
          if (!frame || typeof frame.type !== 'string') throw new Error('shape')
        } catch {
          return socket.close(4400, 'malformed frame')
        }

        if (!conn) {
          if (frame.type !== 'auth' || typeof frame.data?.token !== 'string') return socket.close(4400, 'expected auth')
          if (authenticating) return
          authenticating = true
          const auth = await authenticate(ctx, frame.data.token).catch(() => null)
          clearTimeout(authTimer)
          if (socket.readyState !== socket.OPEN) return
          if (!auth) return socket.close(4401, 'unauthenticated')
          if (hub.count(auth.user.id) >= config.maxSocketsPerUser) return socket.close(4429, 'retry:30')
          conn = hub.add(socket, auth.user.id, auth.sessionId)
          hub.send(conn, { type: 'ready', data: { userId: auth.user.id, sessionId: auth.sessionId, serverTime: new Date().toISOString(), heartbeatSec: HEARTBEAT_SEC, protocol: 1 } })
          return
        }
        hub.send(conn, { type: 'error', data: { code: 'bad_request', message: `Unsupported frame type "${frame.type}"` } })
      })
    },
  )
}
