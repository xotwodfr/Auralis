// Accounts and sessions: register, login, logout, session list/revoke, password change, profile. CHAT.md §7.1–7.4.
import type { FastifyInstance } from 'fastify'
import { Type, type Static } from 'typebox'
import type { AuthResult, Me, SessionInfo } from '../../../shared/chat-protocol/index.ts'
import type { Ctx } from './app.ts'
import { joinLobby } from './conversations.ts'
import { burnPasswordCheck, hashPassword, md5Hex, newToken, sha256, TOKEN_SHAPE, verifyPassword } from './crypto.ts'
import type { Db, UserRow } from './db.ts'
import { ApiError, badRequest, charLength, cleanText, clientAddress, enforce, limiter } from './http.ts'

export interface Auth {
  user: UserRow
  sessionId: string
}

const DAY = 24 * 60 * 60 * 1000
const TOUCH_EVERY_MS = 60 * 60 * 1000 // last_used_at is refreshed at most hourly to limit writes

const DeviceName = Type.Optional(Type.String({ maxLength: 64 }))
const RegisterBody = Type.Object(
  {
    username: Type.String({ maxLength: 64 }),
    password: Type.String({ maxLength: 1024 }),
    displayName: Type.Optional(Type.String({ maxLength: 200 })),
    inviteCode: Type.Optional(Type.String({ maxLength: 64 })),
    deviceName: DeviceName,
  },
  { additionalProperties: false },
)
const LoginBody = Type.Object(
  { username: Type.String({ maxLength: 64 }), password: Type.String({ maxLength: 1024 }), deviceName: DeviceName },
  { additionalProperties: false },
)
const RevokeBody = Type.Object(
  { sessionId: Type.Optional(Type.String({ format: 'uuid' })), others: Type.Optional(Type.Literal(true)) },
  { additionalProperties: false },
)
const PasswordBody = Type.Object(
  { currentPassword: Type.String({ maxLength: 1024 }), newPassword: Type.String({ maxLength: 1024 }) },
  { additionalProperties: false },
)
const ProfileBody = Type.Object({ displayName: Type.String({ maxLength: 200 }) }, { additionalProperties: false })

export function normalizeUsername(raw: string): string {
  const name = raw.trim().toLowerCase()
  if (!/^[a-z0-9_.-]{3,32}$/.test(name)) throw badRequest('Usernames are 3–32 characters: letters, digits, "_", "." or "-"')
  return name
}

export function checkPassword(password: string, username: string): string {
  const pw = password.normalize('NFC')
  const len = charLength(pw)
  if (len < 10 || len > 256) throw badRequest('Passwords must be 10–256 characters')
  if (pw.toLowerCase() === username) throw badRequest('The password cannot be the username')
  return pw
}

export function cleanDisplayName(raw: string): string {
  const name = cleanText(raw.replace(/\s+/g, ' '))
  if (charLength(name) < 1 || charLength(name) > 64) throw badRequest('Display names are 1–64 characters')
  return name
}

/** Asks the music server whether these credentials are valid (Subsonic token auth: the password itself never travels).
 *  Any network or protocol failure counts as "no". The URL carries the token, so it is never logged. */
export async function navidromeAccepts(baseUrl: string, username: string, password: string): Promise<boolean> {
  const s = newToken().slice(-12)
  const q = new URLSearchParams({ u: username, t: md5Hex(password + s), s, v: '1.16.1', c: 'auralis-chat', f: 'json' })
  try {
    const res = await fetch(`${baseUrl}/rest/ping.view?${q}`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return false
    const body = (await res.json()) as { 'subsonic-response'?: { status?: string } }
    return body['subsonic-response']?.status === 'ok'
  } catch {
    return false
  }
}

/** Creates the chat account for a Navidrome user (or adopts their current Navidrome password) and puts it in the lobby.
 *  The chat password policy doesn't apply: the password was chosen on the music server. */
async function adoptNavidromeUser(ctx: Ctx, username: string, password: string): Promise<UserRow | null> {
  const password_hash = await hashPassword(password.normalize('NFC'), ctx.config.scryptLogN)
  return ctx.db.transaction().execute(async (trx) => {
    const user = await trx
      .insertInto('users')
      .values({ username, display_name: username, password_hash, role: 'user' })
      .onConflict((oc) => oc.column('username').doUpdateSet({ password_hash, updated_at: new Date() }).where('users.role', '!=', 'admin').where('users.disabled_at', 'is', null))
      .returningAll()
      .executeTakeFirst()
    if (user) await joinLobby(trx, user.id)
    return user ?? null
  })
}

export const toMe = (u: UserRow): Me => ({ id: u.id, username: u.username, displayName: u.display_name, role: u.role, createdAt: u.created_at.toISOString() })

type SessionRow = { id: string; device_name: string | null; created_at: Date; last_used_at: Date; expires_at: Date }
const toSession = (s: SessionRow, currentId: string): SessionInfo => ({
  id: s.id,
  deviceName: s.device_name,
  createdAt: s.created_at.toISOString(),
  lastUsedAt: s.last_used_at.toISOString(),
  expiresAt: s.expires_at.toISOString(),
  current: s.id === currentId,
})

export async function createSession(db: Db, ctx: Ctx, user: UserRow, deviceName?: string): Promise<AuthResult> {
  const token = newToken()
  const session = await db
    .insertInto('sessions')
    .values({
      user_id: user.id,
      token_hash: sha256(token),
      device_name: deviceName ? cleanText(deviceName).slice(0, 64) || null : null,
      expires_at: new Date(Date.now() + ctx.config.sessionMaxDays * DAY),
    })
    .returning(['id', 'device_name', 'created_at', 'last_used_at', 'expires_at'])
    .executeTakeFirstOrThrow()
  return { user: toMe(user), token, session: toSession(session, session.id) }
}

/** Looks the token up on every call: revocation and disabling take effect on the very next request. */
export async function authenticate(ctx: Ctx, token: string): Promise<Auth | null> {
  if (!TOKEN_SHAPE.test(token)) return null
  const now = Date.now()
  const row = await ctx.db
    .selectFrom('sessions as s')
    .innerJoin('users as u', 'u.id', 's.user_id')
    .selectAll('u')
    .select(['s.id as session_id', 's.last_used_at as session_used'])
    .where('s.token_hash', '=', sha256(token))
    .where('s.revoked_at', 'is', null)
    .where('s.expires_at', '>', new Date(now))
    .where('s.last_used_at', '>', new Date(now - ctx.config.sessionIdleDays * DAY))
    .where('u.disabled_at', 'is', null)
    .executeTakeFirst()
  if (!row) return null
  if (now - row.session_used.getTime() > TOUCH_EVERY_MS) {
    await ctx.db.updateTable('sessions').set({ last_used_at: new Date(now) }).where('id', '=', row.session_id).execute()
  }
  const { session_id, session_used, ...user } = row
  void session_used
  return { user, sessionId: session_id }
}

/** Revokes sessions in the database first, then closes their sockets: a crash in between leaves nothing usable. */
export async function revokeSessions(ctx: Ctx, userId: string, scope: { only?: string; except?: string } = {}): Promise<number> {
  let q = ctx.db.updateTable('sessions').set({ revoked_at: new Date() }).where('user_id', '=', userId).where('revoked_at', 'is', null)
  if (scope.only) q = q.where('id', '=', scope.only)
  if (scope.except) q = q.where('id', '!=', scope.except)
  const rows = await q.returning('id').execute()
  ctx.hub.closeSessions(rows.map((r) => r.id))
  return rows.length
}

export function publicAuthRoutes(app: FastifyInstance, ctx: Ctx) {
  const { config, db } = ctx
  const registerPerIp = limiter(5, 60 * 60_000)
  const loginPerIp = limiter(10, 5 * 60_000)
  const failuresPerIpUser = limiter(5, 15 * 60_000)
  const failuresPerUser = limiter(20, 15 * 60_000) // global slowdown for one username across addresses

  app.post<{ Body: Static<typeof RegisterBody> }>('/api/v1/auth/register', { schema: { body: RegisterBody } }, async (req, reply) => {
    enforce(registerPerIp.hit(clientAddress(req, config.trustProxy)), 'Too many accounts created from this address')
    if (config.registration === 'closed') throw new ApiError(403, 'registration_closed', 'This server does not allow sign-ups')
    const username = normalizeUsername(req.body.username)
    const password = checkPassword(req.body.password, username)
    const displayName = cleanDisplayName(req.body.displayName || username)
    const passwordHash = await hashPassword(password, config.scryptLogN)

    const result = await db.transaction().execute(async (trx) => {
      if (config.registration === 'invite') {
        const code = req.body.inviteCode?.trim()
        if (!code) throw new ApiError(400, 'invalid_invite', 'An invite code is required')
        const used = await trx
          .updateTable('invites')
          .set((eb) => ({ uses: eb('uses', '+', 1) }))
          .where('code_hash', '=', sha256(code))
          .where('revoked_at', 'is', null)
          .where('expires_at', '>', new Date())
          .whereRef('uses', '<', 'max_uses')
          .returning('id')
          .executeTakeFirst()
        if (!used) throw new ApiError(403, 'invalid_invite', 'The invite code is invalid, used up or expired')
      }
      const user = await trx
        .insertInto('users')
        .values({ username, display_name: displayName, password_hash: passwordHash, role: 'user' })
        .onConflict((oc) => oc.column('username').doNothing())
        .returningAll()
        .executeTakeFirst()
      if (!user) throw new ApiError(409, 'username_taken', 'That username is taken')
      await joinLobby(trx, user.id)
      return createSession(trx, ctx, user, req.body.deviceName)
    })
    return reply.code(201).send(result)
  })

  app.post<{ Body: Static<typeof LoginBody> }>('/api/v1/auth/login', { schema: { body: LoginBody } }, async (req): Promise<AuthResult> => {
    const ip = clientAddress(req, config.trustProxy)
    enforce(loginPerIp.hit(ip), 'Too many sign-in attempts')
    const username = req.body.username.trim().toLowerCase()
    const key = `${ip}|${username}`
    enforce(failuresPerIpUser.check(key), 'Too many failed sign-ins for this account')
    enforce(failuresPerUser.check(username), 'Too many failed sign-ins for this account')

    let user = await db.selectFrom('users').selectAll().where('username', '=', username).executeTakeFirst()
    let ok = false
    let upgrade = false
    if (user) ({ ok, upgrade } = await verifyPassword(req.body.password, user.password_hash, config.scryptLogN))
    else if (!config.navidromeUrl) await burnPasswordCheck(req.body.password, config.scryptLogN)
    // Navidrome accounts sign in with their music-server password; admins and disabled accounts are never taken over.
    if (!ok && config.navidromeUrl && user?.role !== 'admin' && !user?.disabled_at && /^[a-z0-9_.-]{3,32}$/.test(username)) {
      if (await navidromeAccepts(config.navidromeUrl, req.body.username.trim(), req.body.password)) {
        const adopted = await adoptNavidromeUser(ctx, username, req.body.password)
        if (adopted) ({ user, ok, upgrade } = { user: adopted, ok: true, upgrade: false })
      }
    }
    if (!user || !ok || user.disabled_at) {
      failuresPerIpUser.hit(key)
      failuresPerUser.hit(username)
      throw new ApiError(401, 'invalid_credentials', 'Wrong username or password')
    }
    failuresPerIpUser.reset(key)
    if (upgrade) {
      const password_hash = await hashPassword(req.body.password, config.scryptLogN)
      await db.updateTable('users').set({ password_hash, updated_at: new Date() }).where('id', '=', user.id).execute()
    }
    return createSession(db, ctx, user, req.body.deviceName)
  })
}

export function authRoutes(app: FastifyInstance, ctx: Ctx) {
  const { config, db } = ctx
  const passwordFailures = limiter(5, 15 * 60_000)

  app.post('/api/v1/auth/logout', async (req, reply) => {
    await revokeSessions(ctx, req.auth.user.id, { only: req.auth.sessionId })
    return reply.code(204).send()
  })

  app.get('/api/v1/auth/sessions', async (req): Promise<SessionInfo[]> => {
    const rows = await db
      .selectFrom('sessions')
      .select(['id', 'device_name', 'created_at', 'last_used_at', 'expires_at'])
      .where('user_id', '=', req.auth.user.id)
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', new Date())
      .where('last_used_at', '>', new Date(Date.now() - config.sessionIdleDays * DAY))
      .orderBy('last_used_at', 'desc')
      .limit(200)
      .execute()
    return rows.map((s) => toSession(s, req.auth.sessionId))
  })

  app.post<{ Body: Static<typeof RevokeBody> }>('/api/v1/auth/sessions/revoke', { schema: { body: RevokeBody } }, async (req, reply) => {
    const { sessionId, others } = req.body
    if (!sessionId === !others) throw badRequest('Pass either sessionId or others: true')
    const n = await revokeSessions(ctx, req.auth.user.id, sessionId ? { only: sessionId } : { except: req.auth.sessionId })
    if (sessionId && n === 0) throw new ApiError(404, 'not_found', 'Session not found')
    return reply.code(204).send()
  })

  app.post<{ Body: Static<typeof PasswordBody> }>('/api/v1/auth/password', { schema: { body: PasswordBody } }, async (req, reply) => {
    const { user, sessionId } = req.auth
    enforce(passwordFailures.check(user.id), 'Too many wrong passwords')
    const { ok } = await verifyPassword(req.body.currentPassword, user.password_hash, config.scryptLogN)
    if (!ok) {
      passwordFailures.hit(user.id)
      // 403, not 401: the session is fine, only the confirmation failed.
      throw new ApiError(403, 'invalid_credentials', 'The current password is wrong')
    }
    const password_hash = await hashPassword(checkPassword(req.body.newPassword, user.username), config.scryptLogN)
    await db.updateTable('users').set({ password_hash, updated_at: new Date() }).where('id', '=', user.id).execute()
    await revokeSessions(ctx, user.id, { except: sessionId })
    return reply.code(204).send()
  })

  app.get('/api/v1/me', async (req) => toMe(req.auth.user))

  app.patch<{ Body: Static<typeof ProfileBody> }>('/api/v1/me', { schema: { body: ProfileBody } }, async (req) => {
    const user = await db
      .updateTable('users')
      .set({ display_name: cleanDisplayName(req.body.displayName), updated_at: new Date() })
      .where('id', '=', req.auth.user.id)
      .returningAll()
      .executeTakeFirstOrThrow()
    return toMe(user)
  })
}
