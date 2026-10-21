// buildApp(config, db): the whole HTTP + WebSocket server as a Fastify instance, without listening. main.ts listens;
// tests use app.inject() and real sockets.
import websocket from '@fastify/websocket'
import Fastify, { type FastifyInstance } from 'fastify'
import type { Writable } from 'node:stream'
import type { ServerInfo } from '../../../shared/chat-protocol/index.ts'
import { adminRoutes } from './admin.ts'
import { authenticate, authRoutes, publicAuthRoutes, type Auth } from './auth.ts'
import type { Config } from './config.ts'
import { conversationRoutes } from './conversations.ts'
import { instanceId, schemaReady, type Db } from './db.ts'
import { ApiError, enforce, limiter, sendError } from './http.ts'
import { Hub, socketRoute } from './hub.ts'
import { messageRoutes } from './messages.ts'

declare module 'fastify' {
  interface FastifyRequest {
    auth: Auth
  }
}

export interface Ctx {
  config: Config
  db: Db
  hub: Hub
  state: { shuttingDown: boolean; instanceId?: string }
}

const BODY_LIMIT = 32 * 1024
const DB_DOWN = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', '57P01', '57P02', '57P03', '08000', '08003', '08006'])
const isDbDown = (err: { code?: string; message?: string }) =>
  DB_DOWN.has(err.code ?? '') || /Connection terminated|timeout exceeded when trying to connect/i.test(err.message ?? '')

export async function buildApp(config: Config, db: Db, options: { logger?: false; logStream?: Writable } = {}) {
  const app: FastifyInstance = Fastify({
    bodyLimit: BODY_LIMIT,
    // Reject unknown properties (400) instead of silently dropping them.
    ajv: { customOptions: { removeAdditional: false } },
    logger: options.logger === false ? false : {
      level: config.logLevel,
      ...(options.logStream ? { stream: options.logStream } : {}),
      // Tokens and passwords never reach the log; message bodies are never logged at all (no body logging anywhere).
      redact: ['req.headers.authorization', '*.password', '*.newPassword', '*.currentPassword', '*.token', '*.inviteCode'],
      serializers: {
        // Path only: query strings can carry search terms.
        req: (req) => ({ method: req.method, url: req.url.split('?')[0] }),
      },
    },
  })
  const hub = new Hub()
  const ctx: Ctx = { config, db, hub, state: { shuttingDown: false } }
  app.decorateRequest('auth', null as unknown as Auth)
  // The authoritative route list, used by the route-inventory security test.
  const routes: { method: string; url: string }[] = []
  app.addHook('onRoute', (r) => {
    for (const method of [r.method].flat()) if (method !== 'HEAD') routes.push({ method, url: r.url })
  })

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string; validation?: unknown }, req, reply) => {
    if (err instanceof ApiError) return sendError(reply, err)
    if (err.validation) return sendError(reply, new ApiError(400, 'bad_request', err.message))
    if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE') return sendError(reply, new ApiError(413, 'payload_too_large', 'Request body is too large'))
    if (err.statusCode && err.statusCode < 500) return sendError(reply, new ApiError(err.statusCode, 'bad_request', err.message))
    if (isDbDown(err)) return sendError(reply, new ApiError(503, 'service_unavailable', 'The chat database is unavailable'))
    // Code and message only: database errors can quote row contents (a message body) in their detail.
    req.log.error({ code: err.code, msg: err.message }, 'request failed')
    return sendError(reply, new ApiError(500, 'internal', 'Internal server error'))
  })
  app.setNotFoundHandler((_req, reply) => sendError(reply, new ApiError(404, 'not_found', 'Not found')))

  // Exact-origin CORS (never `*`, never credentials). Native clients send no Origin and are unaffected.
  const allowed = new Set(config.allowedOrigins)
  app.addHook('onRequest', async (req, reply) => {
    const origin = req.headers.origin
    if (!origin) return
    reply.header('vary', 'Origin')
    const ok = allowed.has(origin)
    if (ok) reply.header('access-control-allow-origin', origin)
    if (req.method === 'OPTIONS') {
      if (!ok) return sendError(reply, new ApiError(403, 'origin_not_allowed', 'Origin not allowed'))
      return reply
        .code(204)
        .header('access-control-allow-methods', 'GET, POST, PATCH, DELETE')
        .header('access-control-allow-headers', 'authorization, content-type')
        .header('access-control-max-age', '600')
        .send()
    }
  })
  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff').header('referrer-policy', 'no-referrer').header('cache-control', 'no-store')
  })

  app.get('/healthz', { logLevel: 'warn' }, async (_req, reply) => (ctx.state.shuttingDown ? reply.code(503).send({ ok: false }) : { ok: true }))
  app.get('/readyz', { logLevel: 'warn' }, async (_req, reply) => {
    const ready = !ctx.state.shuttingDown && (await schemaReady(db))
    return reply.code(ready ? 200 : 503).send({ ready })
  })
  app.get('/api/v1/server-info', async (): Promise<ServerInfo> => {
    ctx.state.instanceId ??= await instanceId(db)
    return {
      instanceId: ctx.state.instanceId,
      name: config.serverName,
      version: config.version,
      protocol: 1,
      registration: config.registration,
      limits: { maxMessageChars: config.maxMessageChars, maxGroupMembers: config.maxGroupMembers },
      ...(config.navidromeUrl ? { musicServer: new URL(config.navidromeUrl).origin } : {}),
    }
  })

  await app.register(websocket, {
    options: { maxPayload: 16 * 1024 },
    // Our own close code (1001) tells clients to reconnect with backoff instead of treating it as an error.
    preClose(done) {
      ctx.state.shuttingDown = true
      for (const client of app.websocketServer.clients) client.close(1001, 'server restarting')
      done()
    },
  })
  socketRoute(app, ctx)
  publicAuthRoutes(app, ctx)

  // Everything registered inside this scope requires a valid session; there is no way to add a route here without it.
  await app.register(async (scope) => {
    const perUser = limiter(300, 60_000)
    scope.addHook('onRequest', async (req) => {
      const match = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')
      const auth = match ? await authenticate(ctx, match[1]) : null
      if (!auth) throw new ApiError(401, 'unauthorized', 'Sign in again')
      enforce(perUser.hit(auth.user.id))
      req.auth = auth
    })
    authRoutes(scope, ctx)
    conversationRoutes(scope, ctx)
    messageRoutes(scope, ctx)
    adminRoutes(scope, ctx)
  })

  hub.start(ctx)
  app.addHook('onClose', async () => hub.stop())
  return { app, ctx, routes }
}
