// Admin API and the operations shared with the CLI: invites, disabling users, maintenance. CHAT.md §5.2, §7.4, Phase 7.
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { sql } from 'kysely'
import { Type, type Static } from 'typebox'
import type { AdminUser, Invite } from '../../../shared/chat-protocol/index.ts'
import type { Ctx } from './app.ts'
import { revokeSessions, toMe } from './auth.ts'
import { newInviteCode, sha256 } from './crypto.ts'
import type { Db } from './db.ts'
import { ApiError, badRequest, forbidden } from './http.ts'

export async function createInvite(db: Db, createdBy: string, maxUses: number, expiresInHours: number): Promise<Invite> {
  const code = newInviteCode()
  const row = await db
    .insertInto('invites')
    .values({ code_hash: sha256(code), created_by: createdBy, max_uses: maxUses, expires_at: new Date(Date.now() + expiresInHours * 3_600_000) })
    .returning(['id', 'expires_at'])
    .executeTakeFirstOrThrow()
  // Only the hash is stored; the code is shown once.
  return { id: row.id, code, maxUses, expiresAt: row.expires_at.toISOString() }
}

/** Disabling revokes every session. A running server also closes the user's sockets (immediately when done through the
 *  API, within a minute when done from the CLI, see Hub.revalidate). */
export async function setDisabled(db: Db, userId: string, disabled: boolean): Promise<boolean> {
  const updated = await db.updateTable('users').set({ disabled_at: disabled ? new Date() : null, updated_at: new Date() }).where('id', '=', userId).returning('id').executeTakeFirst()
  if (updated && disabled) await db.updateTable('sessions').set({ revoked_at: new Date() }).where('user_id', '=', userId).where('revoked_at', 'is', null).execute()
  return !!updated
}

const CHUNK = 500
const MAX_CHUNKS = 100 // bounds one run; the next run continues
/** Scrubs bodies of messages deleted more than `retentionDays` ago and drops long-dead sessions. Chunked and bounded. */
export async function runMaintenance(db: Db, retentionDays: number): Promise<{ scrubbed: number; sessions: number }> {
  let scrubbed = 0
  for (let i = 0; i < MAX_CHUNKS; i++) {
    const { rows } = await sql<{ id: string }>`
      UPDATE messages SET body = NULL WHERE id IN (
        SELECT id FROM messages WHERE deleted_at IS NOT NULL AND body IS NOT NULL
          AND deleted_at < now() - make_interval(days => ${retentionDays}) LIMIT ${CHUNK}
      ) RETURNING id`.execute(db)
    scrubbed += rows.length
    if (rows.length < CHUNK) break
  }
  const { numDeletedRows } = await db
    .deleteFrom('sessions')
    .where((eb) => eb.or([eb('expires_at', '<', sql<Date>`now() - interval '30 days'`), eb('revoked_at', '<', sql<Date>`now() - interval '30 days'`)]))
    .executeTakeFirst()
  return { scrubbed, sessions: Number(numDeletedRows) }
}

const Id = Type.String({ format: 'uuid' })
const Params = Type.Object({ id: Id })
const InviteBody = Type.Object(
  { maxUses: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })), expiresInHours: Type.Optional(Type.Integer({ minimum: 1, maximum: 8760 })) },
  { additionalProperties: false },
)

function requireAdmin(req: FastifyRequest) {
  if (req.auth.user.role !== 'admin') throw forbidden('Administrators only')
}

export function adminRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db, hub } = ctx

  app.post<{ Body: Static<typeof InviteBody> }>('/api/v1/admin/invites', { schema: { body: InviteBody } }, async (req, reply) => {
    requireAdmin(req)
    return reply.code(201).send(await createInvite(db, req.auth.user.id, req.body.maxUses ?? 1, req.body.expiresInHours ?? 72))
  })

  app.get('/api/v1/admin/users', async (req): Promise<AdminUser[]> => {
    requireAdmin(req)
    // ponytail: first 1000 by name, add paging if a server ever has more.
    const rows = await db.selectFrom('users').selectAll().orderBy('username').limit(1000).execute()
    return rows.map((u) => ({ ...toMe(u), disabled: u.disabled_at !== null }))
  })

  for (const action of ['disable', 'enable'] as const) {
    app.post<{ Params: Static<typeof Params> }>(`/api/v1/admin/users/:id/${action}`, { schema: { params: Params } }, async (req, reply) => {
      requireAdmin(req)
      if (req.params.id === req.auth.user.id) throw badRequest('You cannot disable or enable yourself')
      if (action === 'disable') await revokeSessions(ctx, req.params.id)
      if (!(await setDisabled(db, req.params.id, action === 'disable'))) throw new ApiError(404, 'user_not_found', 'User not found')
      if (action === 'disable') hub.closeUsers([req.params.id])
      return reply.code(204).send()
    })
  }
}
