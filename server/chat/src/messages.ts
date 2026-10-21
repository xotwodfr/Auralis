// History, sending (idempotent, gap-free per-conversation seq), deletion and read pointers. CHAT.md §5.5, §6.3.
import type { FastifyInstance } from 'fastify'
import { sql } from 'kysely'
import { Type, type Static } from 'typebox'
import type { Message, MessagePage } from '../../../shared/chat-protocol/index.ts'
import type { Ctx } from './app.ts'
import { can, currentMemberIds, messageQuery, requireMember, toMessage, type MessageRow } from './conversations.ts'
import type { Db } from './db.ts'
import { ApiError, badRequest, charLength, cleanText, enforce, forbidden, limiter } from './http.ts'

const Id = Type.String({ format: 'uuid' })
const Params = Type.Object({ id: Id })
const MessageParams = Type.Object({ id: Id, messageId: Id })
const PageQuery = Type.Object(
  {
    beforeSeq: Type.Optional(Type.Integer({ minimum: 1 })),
    afterSeq: Type.Optional(Type.Integer({ minimum: 0 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false },
)
const SendBody = Type.Object({ clientMessageId: Id, body: Type.String({ maxLength: 16_000 }) }, { additionalProperties: false })
const ReadBody = Type.Object({ seq: Type.Integer({ minimum: 0 }) }, { additionalProperties: false })

/** Plain text only: NFC, control characters stripped, at most two blank lines in a row. */
export function cleanBody(raw: string, maxChars: number): string {
  const body = cleanText(raw.replace(/\r\n?/g, '\n')).replace(/\n{4,}/g, '\n\n\n')
  if (!body) throw badRequest('The message is empty')
  if (charLength(body) > maxChars) throw badRequest(`Messages can be at most ${maxChars} characters`)
  return body
}

async function sendMessage(db: Db, conversationId: string, senderId: string, clientMessageId: string, body: string): Promise<{ row: MessageRow; created: boolean }> {
  return db.transaction().execute(async (trx) => {
    // The row lock serialises sends per conversation, which is what makes seq gap-free.
    // ponytail: one busy group queues on one row; fine for a self-hosted server.
    const conv = await trx.selectFrom('conversations').select(['kind', 'dm_key']).where('id', '=', conversationId).forUpdate().executeTakeFirstOrThrow()
    // Checked after taking the lock, so a concurrent retry of the same send sees the first one's committed row.
    const existing = await messageQuery(trx).where('m.conversation_id', '=', conversationId).where('m.sender_id', '=', senderId).where('m.client_message_id', '=', clientMessageId).executeTakeFirst()
    if (existing) return { row: existing, created: false }
    if (conv.kind === 'direct') {
      const disabled = await trx.selectFrom('conversation_members as cm').innerJoin('users as u', 'u.id', 'cm.user_id').select('u.id').where('cm.conversation_id', '=', conversationId).where('u.disabled_at', 'is not', null).executeTakeFirst()
      if (disabled) throw forbidden('This person can no longer receive messages')
    }
    const { last_seq: seq } = await trx
      .updateTable('conversations')
      .set((eb) => ({ last_seq: eb('last_seq', '+', 1), last_message_at: new Date(), updated_at: new Date() }))
      .where('id', '=', conversationId)
      .returning('last_seq')
      .executeTakeFirstOrThrow()
    const { id } = await trx.insertInto('messages').values({ conversation_id: conversationId, seq, sender_id: senderId, client_message_id: clientMessageId, body }).returning('id').executeTakeFirstOrThrow()
    // Your own message is read by definition; this keeps unread counts to other people's messages.
    await trx.updateTable('conversation_members').set({ last_read_seq: seq }).where('conversation_id', '=', conversationId).where('user_id', '=', senderId).execute()
    return { row: await messageQuery(trx).where('m.id', '=', id).executeTakeFirstOrThrow(), created: true }
  })
}

export function messageRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db, config, hub } = ctx
  const burst = limiter(30, 10_000)
  const hourly = limiter(600, 60 * 60_000)

  app.get<{ Params: Static<typeof Params>; Querystring: Static<typeof PageQuery> }>(
    '/api/v1/conversations/:id/messages',
    { schema: { params: Params, querystring: PageQuery } },
    async (req): Promise<MessagePage> => {
      const { id } = req.params
      await requireMember(db, id, req.auth.user.id)
      const { beforeSeq, afterSeq, limit = 50 } = req.query
      if (beforeSeq !== undefined && afterSeq !== undefined) throw badRequest('Pass beforeSeq or afterSeq, not both')
      let q = messageQuery(db).where('m.conversation_id', '=', id)
      // Keyset pagination on (conversation_id, seq), which the unique index covers.
      if (afterSeq !== undefined) q = q.where('m.seq', '>', afterSeq).orderBy('m.seq', 'asc')
      else q = (beforeSeq !== undefined ? q.where('m.seq', '<', beforeSeq) : q).orderBy('m.seq', 'desc')
      const rows = await q.limit(limit + 1).execute()
      const hasMore = rows.length > limit
      const page = rows.slice(0, limit)
      if (afterSeq === undefined) page.reverse()
      return { messages: page.map((m) => toMessage(m, req.auth.user.id)), hasMore }
    },
  )

  app.post<{ Params: Static<typeof Params>; Body: Static<typeof SendBody> }>(
    '/api/v1/conversations/:id/messages',
    { schema: { params: Params, body: SendBody } },
    async (req, reply) => {
      const { id: conversationId } = req.params
      const me = req.auth.user.id
      await requireMember(db, conversationId, me)
      enforce(burst.hit(me), 'You are sending messages too fast')
      enforce(hourly.hit(me), 'You are sending messages too fast')
      const body = cleanBody(req.body.body, config.maxMessageChars)
      const { row, created } = await sendMessage(db, conversationId, me, req.body.clientMessageId, body)
      const message = toMessage(row, me)
      if (created) {
        // Fan-out after commit, to whoever is a member right now; the sender's sessions also get the clientMessageId.
        const members = await currentMemberIds(db, conversationId)
        const forOthers: Message = toMessage(row, '')
        hub.toUsers(members, (userId) => ({ type: 'message.created', data: { message: userId === me ? message : forOthers } }))
      }
      return reply.code(created ? 201 : 200).send({ message })
    },
  )

  app.delete<{ Params: Static<typeof MessageParams> }>(
    '/api/v1/conversations/:id/messages/:messageId',
    { schema: { params: MessageParams } },
    async (req, reply) => {
      const { id: conversationId, messageId } = req.params
      const member = await requireMember(db, conversationId, req.auth.user.id)
      const msg = await db.selectFrom('messages').select(['sender_id', 'seq', 'deleted_at']).where('id', '=', messageId).where('conversation_id', '=', conversationId).executeTakeFirst()
      if (!msg) throw new ApiError(404, 'not_found', 'Message not found')
      if (!can('deleteMessage', member.kind, member.role, { sender: msg.sender_id === req.auth.user.id })) throw forbidden('You can only delete your own messages')
      if (!msg.deleted_at) {
        await db.updateTable('messages').set({ deleted_at: new Date() }).where('id', '=', messageId).execute()
        hub.toUsers(await currentMemberIds(db, conversationId), { type: 'message.deleted', data: { conversationId, messageId, seq: msg.seq } })
      }
      return reply.code(204).send()
    },
  )

  app.post<{ Params: Static<typeof Params>; Body: Static<typeof ReadBody> }>(
    '/api/v1/conversations/:id/read',
    { schema: { params: Params, body: ReadBody } },
    async (req) => {
      const { id: conversationId } = req.params
      const me = req.auth.user.id
      await requireMember(db, conversationId, me)
      // Monotonic, and never past the newest message.
      const before = await db.selectFrom('conversation_members').select('last_read_seq').where('conversation_id', '=', conversationId).where('user_id', '=', me).executeTakeFirstOrThrow()
      const { last_read_seq: seq } = await db
        .updateTable('conversation_members')
        .set({ last_read_seq: sql`greatest(last_read_seq, least(${req.body.seq}::bigint, (SELECT last_seq FROM conversations WHERE id = ${conversationId})))` })
        .where('conversation_id', '=', conversationId)
        .where('user_id', '=', me)
        .returning('last_read_seq')
        .executeTakeFirstOrThrow()
      if (seq !== before.last_read_seq) hub.toUsers(await currentMemberIds(db, conversationId), { type: 'read.updated', data: { conversationId, userId: me, seq } })
      return { lastReadSeq: seq }
    },
  )
}
