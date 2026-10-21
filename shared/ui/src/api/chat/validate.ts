// Structural checks for everything the chat server sends. A malformed payload becomes an error, never a crash or a
// half-shaped object in the store (the same stance as api/subsonic/endpoints.ts).
import type { AuthResult, Conversation, Me, Member, Message, MessagePage, ServerEvent, ServerInfo, SessionInfo, UserSummary } from '../../../../chat-protocol'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): v is string => typeof v === 'string'
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const strOrNull = (v: unknown) => v === null || str(v)

export const isUser = (v: unknown): v is UserSummary => isObj(v) && str(v.id) && str(v.username) && str(v.displayName)
export const isMe = (v: unknown): v is Me => isUser(v) && isObj(v) && ['admin', 'user'].includes(v.role as string)
const isMember = (v: unknown): v is Member => isUser(v) && isObj(v) && ['owner', 'admin', 'member'].includes(v.role as string) && num(v.lastReadSeq)

export const isMessage = (v: unknown): v is Message =>
  isObj(v) && str(v.id) && str(v.conversationId) && num(v.seq) && isUser(v.sender) && str(v.body) && str(v.createdAt) && typeof v.deleted === 'boolean' && (v.clientMessageId === undefined || str(v.clientMessageId))

export const isConversation = (v: unknown): v is Conversation =>
  isObj(v) && str(v.id) && (v.kind === 'direct' || v.kind === 'group') && strOrNull(v.title) && num(v.lastSeq) && num(v.lastReadSeq) && num(v.unreadCount) &&
  (v.lastMessage === null || isMessage(v.lastMessage)) && Array.isArray(v.members) && v.members.every(isMember)

export const isServerInfo = (v: unknown): v is ServerInfo =>
  isObj(v) && str(v.instanceId) && str(v.name) && str(v.version) && num(v.protocol) && ['closed', 'invite', 'open'].includes(v.registration as string) && isObj(v.limits) && num(v.limits.maxMessageChars)

export const isSession = (v: unknown): v is SessionInfo => isObj(v) && str(v.id) && strOrNull(v.deviceName) && str(v.lastUsedAt) && typeof v.current === 'boolean'
export const isAuthResult = (v: unknown): v is AuthResult => isObj(v) && isMe(v.user) && str(v.token) && isSession(v.session)
export const isPage = (v: unknown): v is MessagePage => isObj(v) && Array.isArray(v.messages) && v.messages.every(isMessage) && typeof v.hasMore === 'boolean'
export const listOf = <T>(guard: (v: unknown) => v is T) => (v: unknown): v is T[] => Array.isArray(v) && v.every(guard)

/** A server frame we understand, or null (unknown or malformed frames are ignored, not fatal). */
export function parseEvent(raw: unknown): ServerEvent | null {
  let f: unknown
  try {
    f = typeof raw === 'string' ? JSON.parse(raw) : null
  } catch {
    return null
  }
  if (!isObj(f) || !str(f.type) || !isObj(f.data)) return null
  const d = f.data
  const ok: Record<string, () => boolean> = {
    ready: () => str(d.userId) && str(d.sessionId) && num(d.protocol),
    'message.created': () => isMessage(d.message),
    'message.deleted': () => str(d.conversationId) && str(d.messageId) && num(d.seq),
    'conversation.created': () => isConversation(d.conversation),
    'conversation.updated': () => isConversation(d.conversation),
    'conversation.removed': () => str(d.conversationId),
    'member.added': () => str(d.conversationId) && isUser(d.user),
    'member.removed': () => str(d.conversationId) && isUser(d.user),
    'read.updated': () => str(d.conversationId) && str(d.userId) && num(d.seq),
    'session.revoked': () => true,
    error: () => str(d.message),
  }
  return ok[f.type]?.() ? ({ type: f.type, data: d } as ServerEvent) : null
}
