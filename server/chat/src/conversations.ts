// Conversations, membership, user search, and the single authorization module (CHAT.md §7.5).
import type { FastifyInstance } from 'fastify'
import { sql } from 'kysely'
import { Type, type Static } from 'typebox'
import type { Conversation, ConversationKind, Member, MemberRole, Message, UserSummary } from '../../../shared/chat-protocol/index.ts'
import type { Ctx } from './app.ts'
import type { Db } from './db.ts'
import { ApiError, badRequest, charLength, cleanText, enforce, forbidden, limiter, notFound } from './http.ts'

// ---- authorization: the only place that decides who may do what ----

export type Action = 'rename' | 'addMembers' | 'removeMember' | 'deleteMessage'

export function can(action: Action, kind: ConversationKind, actor: MemberRole, extra: { self?: boolean; sender?: boolean; target?: MemberRole } = {}): boolean {
  const manager = actor === 'owner' || actor === 'admin'
  switch (action) {
    case 'rename':
    case 'addMembers':
      return kind === 'group' && manager
    case 'removeMember':
      return kind === 'group' && (extra.self === true || (manager && extra.target !== 'owner'))
    case 'deleteMessage':
      return extra.sender === true || (kind === 'group' && manager)
  }
}

/** Every conversation-scoped handler calls this first. Non-members get 404, so membership cannot be probed. */
export async function requireMember(db: Db, conversationId: string, userId: string) {
  const row = await db
    .selectFrom('conversation_members as cm')
    .innerJoin('conversations as c', 'c.id', 'cm.conversation_id')
    .select(['cm.role', 'c.kind', 'c.dm_key'])
    .where('cm.conversation_id', '=', conversationId)
    .where('cm.user_id', '=', userId)
    .where('cm.left_at', 'is', null)
    .executeTakeFirst()
  if (!row) throw notFound()
  return row
}

export const LOBBY_TITLE = 'Lobby'

/** Puts the user in the one server-wide room, creating it (owned by the first user to arrive) if needed. Idempotent;
 *  someone who left on purpose is not pulled back in on later calls, only new accounts and the startup backfill join. */
export async function joinLobby(db: Db, userId: string): Promise<void> {
  const run = async (trx: Db) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext('auralis-chat-lobby'))`.execute(trx)
    const meta = await trx.selectFrom('server_meta').select('value').where('key', '=', 'lobby_id').executeTakeFirst()
    let lobbyId = meta?.value
    if (!lobbyId) {
      const created = await trx.insertInto('conversations').values({ kind: 'group', title: LOBBY_TITLE, created_by: userId }).returning('id').executeTakeFirstOrThrow()
      await trx.insertInto('server_meta').values({ key: 'lobby_id', value: created.id }).execute()
      lobbyId = created.id
    }
    const role = meta ? 'member' : 'owner'
    await trx.insertInto('conversation_members').values({ conversation_id: lobbyId, user_id: userId, role }).onConflict((oc) => oc.columns(['conversation_id', 'user_id']).doNothing()).execute()
  }
  // Registration already runs inside a transaction; Kysely can't nest a new one.
  await (db.isTransaction ? run(db) : db.transaction().execute(run))
}

/** Startup backfill for accounts created before the lobby existed. Rows that already exist (including leavers) are untouched. */
export async function joinLobbyAll(db: Db): Promise<void> {
  const users = await db.selectFrom('users').select('id').where('disabled_at', 'is', null).execute()
  for (const { id } of users) await joinLobby(db, id)
}

// ---- DTOs ----

export const messageColumns = [
  'm.id', 'm.conversation_id', 'm.seq', 'm.sender_id', 'm.client_message_id', 'm.body', 'm.created_at', 'm.deleted_at',
  'u.username as sender_username', 'u.display_name as sender_display_name',
] as const

export type MessageRow = {
  id: string; conversation_id: string; seq: number; sender_id: string; client_message_id: string; body: string | null
  created_at: Date; deleted_at: Date | null; sender_username: string; sender_display_name: string
}

export function toMessage(m: MessageRow, viewerId: string): Message {
  return {
    id: m.id,
    conversationId: m.conversation_id,
    seq: m.seq,
    sender: { id: m.sender_id, username: m.sender_username, displayName: m.sender_display_name },
    // The idempotency key is only meaningful to (and only shown to) the sender.
    ...(m.sender_id === viewerId ? { clientMessageId: m.client_message_id } : {}),
    body: m.deleted_at ? '' : (m.body ?? ''),
    createdAt: m.created_at.toISOString(),
    deleted: m.deleted_at !== null,
  }
}

export const messageQuery = (db: Db) => db.selectFrom('messages as m').innerJoin('users as u', 'u.id', 'm.sender_id').select(messageColumns)

/** The viewer's conversations (all, or the given ids), newest activity first. Unread excludes the viewer's own messages
 *  because sending moves the sender's read pointer. */
export async function loadConversations(db: Db, viewerId: string, ids?: string[]): Promise<Conversation[]> {
  let q = db
    .selectFrom('conversation_members as cm')
    .innerJoin('conversations as c', 'c.id', 'cm.conversation_id')
    .select(['c.id', 'c.kind', 'c.title', 'c.last_seq', 'c.last_message_at', 'c.created_at', 'cm.last_read_seq'])
    .where('cm.user_id', '=', viewerId)
    .where('cm.left_at', 'is', null)
  if (ids) {
    if (!ids.length) return []
    q = q.where('c.id', 'in', ids)
  }
  const rows = await q.orderBy(sql`coalesce(c.last_message_at, c.created_at)`, 'desc').limit(1000).execute()
  if (!rows.length) return []
  const convIds = rows.map((r) => r.id)
  const [members, lasts] = await Promise.all([
    db
      .selectFrom('conversation_members as cm')
      .innerJoin('users as u', 'u.id', 'cm.user_id')
      .select(['cm.conversation_id', 'u.id', 'u.username', 'u.display_name', 'cm.role', 'cm.last_read_seq'])
      .where('cm.conversation_id', 'in', convIds)
      .where('cm.left_at', 'is', null)
      .orderBy('cm.joined_at')
      .execute(),
    messageQuery(db)
      .innerJoin('conversations as c', (j) => j.onRef('c.id', '=', 'm.conversation_id').onRef('c.last_seq', '=', 'm.seq'))
      .where('m.conversation_id', 'in', convIds)
      .execute(),
  ])
  const byConv = new Map<string, Member[]>()
  for (const m of members) {
    const list = byConv.get(m.conversation_id) ?? []
    list.push({ id: m.id, username: m.username, displayName: m.display_name, role: m.role, lastReadSeq: m.last_read_seq })
    byConv.set(m.conversation_id, list)
  }
  const lastByConv = new Map(lasts.map((m) => [m.conversation_id, toMessage(m, viewerId)]))
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    lastSeq: r.last_seq,
    lastMessageAt: r.last_message_at?.toISOString() ?? null,
    lastMessage: lastByConv.get(r.id) ?? null,
    lastReadSeq: r.last_read_seq,
    unreadCount: Math.max(0, r.last_seq - r.last_read_seq),
    members: byConv.get(r.id) ?? [],
    createdAt: r.created_at.toISOString(),
  }))
}

export async function currentMemberIds(db: Db, conversationId: string): Promise<string[]> {
  const rows = await db.selectFrom('conversation_members').select('user_id').where('conversation_id', '=', conversationId).where('left_at', 'is', null).execute()
  return rows.map((r) => r.user_id)
}

/** Sends each listed user their own view of the conversation (read state and unread differ per user). */
async function pushConversation(ctx: Ctx, conversationId: string, userIds: string[], type: 'conversation.created' | 'conversation.updated') {
  for (const userId of userIds) {
    if (!ctx.hub.isOnline(userId)) continue
    const [conversation] = await loadConversations(ctx.db, userId, [conversationId])
    if (conversation) ctx.hub.toUsers([userId], { type, data: { conversation } })
  }
}

async function activeUsers(db: Db, ids: string[]): Promise<UserSummary[]> {
  if (!ids.length) return []
  const rows = await db.selectFrom('users').select(['id', 'username', 'display_name']).where('id', 'in', ids).where('disabled_at', 'is', null).execute()
  if (rows.length !== new Set(ids).size) throw new ApiError(400, 'user_not_found', 'One or more users do not exist')
  return rows.map((u) => ({ id: u.id, username: u.username, displayName: u.display_name }))
}

function cleanTitle(raw: string): string {
  const title = cleanText(raw.replace(/\s+/g, ' '))
  if (charLength(title) < 1 || charLength(title) > 80) throw badRequest('Group names are 1–80 characters')
  return title
}

// ---- routes ----

const Id = Type.String({ format: 'uuid' })
const Params = Type.Object({ id: Id })
const MemberParams = Type.Object({ id: Id, userId: Id })
const SearchQuery = Type.Object({ q: Type.String({ minLength: 2, maxLength: 32 }) }, { additionalProperties: false })
const DirectBody = Type.Object({ userId: Id }, { additionalProperties: false })
const GroupBody = Type.Object({ title: Type.String({ maxLength: 200 }), memberIds: Type.Array(Id, { maxItems: 1000, uniqueItems: true }) }, { additionalProperties: false })
const RenameBody = Type.Object({ title: Type.String({ maxLength: 200 }) }, { additionalProperties: false })
const AddBody = Type.Object({ userIds: Type.Array(Id, { minItems: 1, maxItems: 1000, uniqueItems: true }) }, { additionalProperties: false })

export function conversationRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db, config, hub } = ctx
  const searches = limiter(30, 60_000)

  app.get<{ Querystring: Static<typeof SearchQuery> }>('/api/v1/users/search', { schema: { querystring: SearchQuery } }, async (req): Promise<UserSummary[]> => {
    enforce(searches.hit(req.auth.user.id), 'Too many searches')
    // Prefix match on usernames only, so the directory can't be scraped with broad patterns.
    const prefix = req.query.q.trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)
    const rows = await db
      .selectFrom('users')
      .select(['id', 'username', 'display_name'])
      .where('username', 'like', `${prefix}%`)
      .where('disabled_at', 'is', null)
      .where('id', '!=', req.auth.user.id)
      .orderBy('username')
      .limit(20)
      .execute()
    return rows.map((u) => ({ id: u.id, username: u.username, displayName: u.display_name }))
  })

  app.get('/api/v1/conversations', async (req) => loadConversations(db, req.auth.user.id))

  app.post<{ Body: Static<typeof DirectBody> }>('/api/v1/conversations/direct', { schema: { body: DirectBody } }, async (req, reply) => {
    const me = req.auth.user.id
    const other = req.body.userId
    if (other === me) throw badRequest('You cannot start a conversation with yourself')
    await activeUsers(db, [other])
    // dm_key is unique, so two people opening the same DM at once still get one conversation.
    const dmKey = [me, other].sort().join(':')
    const created = await db.transaction().execute(async (trx) => {
      const inserted = await trx
        .insertInto('conversations')
        .values({ kind: 'direct', dm_key: dmKey, created_by: me })
        .onConflict((oc) => oc.column('dm_key').doNothing())
        .returning('id')
        .executeTakeFirst()
      if (!inserted) return null
      await trx
        .insertInto('conversation_members')
        .values([me, other].map((user_id) => ({ conversation_id: inserted.id, user_id, role: 'member' as const })))
        .execute()
      return inserted.id
    })
    const id = created ?? (await db.selectFrom('conversations').select('id').where('dm_key', '=', dmKey).executeTakeFirstOrThrow()).id
    if (created) await pushConversation(ctx, id, [me, other], 'conversation.created')
    const [conversation] = await loadConversations(db, me, [id])
    return reply.code(created ? 201 : 200).send(conversation)
  })

  app.post<{ Body: Static<typeof GroupBody> }>('/api/v1/conversations/group', { schema: { body: GroupBody } }, async (req, reply) => {
    const me = req.auth.user.id
    const title = cleanTitle(req.body.title)
    const others = req.body.memberIds.filter((id) => id !== me)
    if (others.length + 1 > config.maxGroupMembers) throw badRequest(`Groups can have at most ${config.maxGroupMembers} members`)
    await activeUsers(db, others)
    const id = await db.transaction().execute(async (trx) => {
      const { id } = await trx.insertInto('conversations').values({ kind: 'group', title, created_by: me }).returning('id').executeTakeFirstOrThrow()
      await trx
        .insertInto('conversation_members')
        .values([
          { conversation_id: id, user_id: me, role: 'owner' as const },
          ...others.map((user_id) => ({ conversation_id: id, user_id, role: 'member' as const })),
        ])
        .execute()
      return id
    })
    await pushConversation(ctx, id, [me, ...others], 'conversation.created')
    const [conversation] = await loadConversations(db, me, [id])
    return reply.code(201).send(conversation)
  })

  app.get<{ Params: Static<typeof Params> }>('/api/v1/conversations/:id', { schema: { params: Params } }, async (req) => {
    await requireMember(db, req.params.id, req.auth.user.id)
    const [conversation] = await loadConversations(db, req.auth.user.id, [req.params.id])
    return conversation
  })

  app.patch<{ Params: Static<typeof Params>; Body: Static<typeof RenameBody> }>(
    '/api/v1/conversations/:id',
    { schema: { params: Params, body: RenameBody } },
    async (req) => {
      const member = await requireMember(db, req.params.id, req.auth.user.id)
      if (!can('rename', member.kind, member.role)) throw forbidden('Only group owners and admins can rename a group')
      await db.updateTable('conversations').set({ title: cleanTitle(req.body.title), updated_at: new Date() }).where('id', '=', req.params.id).execute()
      await pushConversation(ctx, req.params.id, await currentMemberIds(db, req.params.id), 'conversation.updated')
      const [conversation] = await loadConversations(db, req.auth.user.id, [req.params.id])
      return conversation
    },
  )

  app.post<{ Params: Static<typeof Params>; Body: Static<typeof AddBody> }>(
    '/api/v1/conversations/:id/members',
    { schema: { params: Params, body: AddBody } },
    async (req) => {
      const conversationId = req.params.id
      const member = await requireMember(db, conversationId, req.auth.user.id)
      if (!can('addMembers', member.kind, member.role)) throw forbidden('Only group owners and admins can add members')
      const existing = await currentMemberIds(db, conversationId)
      const adding = req.body.userIds.filter((id) => !existing.includes(id))
      if (existing.length + adding.length > config.maxGroupMembers) throw badRequest(`Groups can have at most ${config.maxGroupMembers} members`)
      const users = await activeUsers(db, adding)
      if (adding.length) {
        // Someone who left earlier comes back as a plain member and sees the full history (CHAT.md §14 decision 5).
        await db
          .insertInto('conversation_members')
          .values(adding.map((user_id) => ({ conversation_id: conversationId, user_id, role: 'member' as const })))
          .onConflict((oc) => oc.columns(['conversation_id', 'user_id']).doUpdateSet({ left_at: null, role: 'member', joined_at: new Date() }))
          .execute()
        for (const user of users) hub.toUsers(existing, { type: 'member.added', data: { conversationId, user } })
        await pushConversation(ctx, conversationId, adding, 'conversation.created')
      }
      const [conversation] = await loadConversations(db, req.auth.user.id, [conversationId])
      return conversation
    },
  )

  app.delete<{ Params: Static<typeof MemberParams> }>(
    '/api/v1/conversations/:id/members/:userId',
    { schema: { params: MemberParams } },
    async (req, reply) => {
      const { id: conversationId, userId } = req.params
      const me = req.auth.user.id
      const member = await requireMember(db, conversationId, me)
      const self = userId === me
      const target = self ? member : await db.selectFrom('conversation_members').select('role').where('conversation_id', '=', conversationId).where('user_id', '=', userId).where('left_at', 'is', null).executeTakeFirst()
      if (!target) throw new ApiError(404, 'user_not_found', 'That user is not a member')
      if (!can('removeMember', member.kind, member.role, { self, target: target.role })) {
        throw forbidden(member.kind === 'direct' ? 'You cannot leave a direct conversation' : 'Only group owners and admins can remove members')
      }
      const removed = await db.transaction().execute(async (trx) => {
        await trx.updateTable('conversation_members').set({ left_at: new Date() }).where('conversation_id', '=', conversationId).where('user_id', '=', userId).execute()
        // A group never loses its owner: the longest-standing admin, else member, takes over.
        if (target.role === 'owner') {
          const heir = await trx
            .selectFrom('conversation_members')
            .select('user_id')
            .where('conversation_id', '=', conversationId)
            .where('left_at', 'is', null)
            .orderBy(sql`role = 'admin'`, 'desc')
            .orderBy('joined_at')
            .limit(1)
            .executeTakeFirst()
          if (heir) await trx.updateTable('conversation_members').set({ role: 'owner' }).where('conversation_id', '=', conversationId).where('user_id', '=', heir.user_id).execute()
        }
        return trx.selectFrom('users').select(['id', 'username', 'display_name']).where('id', '=', userId).executeTakeFirstOrThrow()
      })
      const user = { id: removed.id, username: removed.username, displayName: removed.display_name }
      hub.toUsers([userId], { type: 'conversation.removed', data: { conversationId } })
      hub.toUsers(await currentMemberIds(db, conversationId), { type: 'member.removed', data: { conversationId, user } })
      return reply.code(204).send()
    },
  )
}
