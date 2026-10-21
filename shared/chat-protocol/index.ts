// Wire types shared by the chat server (server/chat) and the Auralis client (shared/ui/src/api/chat). Type-only on purpose:
// both sides use `import type`, so this file is erased by Node's type stripping and by Vite and never needs packaging.
// See CHAT.md §5. Bump PROTOCOL_VERSION (and the server's `protocol` field) on any incompatible change.

export type ProtocolVersion = 1

export type RegistrationMode = 'closed' | 'invite' | 'open'
export type UserRole = 'admin' | 'user'
export type ConversationKind = 'direct' | 'group'
export type MemberRole = 'owner' | 'admin' | 'member'

export interface ServerInfo {
  instanceId: string
  name: string
  version: string
  protocol: ProtocolVersion
  registration: RegistrationMode
  limits: { maxMessageChars: number; maxGroupMembers: number }
}

export interface UserSummary {
  id: string
  username: string
  displayName: string
}

export interface Me extends UserSummary {
  role: UserRole
  createdAt: string
}

export interface SessionInfo {
  id: string
  deviceName: string | null
  createdAt: string
  lastUsedAt: string
  expiresAt: string
  current: boolean
}

export interface AuthResult {
  user: Me
  token: string
  session: SessionInfo
}

export interface Member extends UserSummary {
  role: MemberRole
  lastReadSeq: number
}

export interface Message {
  id: string
  conversationId: string
  seq: number
  sender: UserSummary
  /** Only present on messages the caller sent. */
  clientMessageId?: string
  /** Empty string when deleted. */
  body: string
  createdAt: string
  deleted: boolean
}

export interface Conversation {
  id: string
  kind: ConversationKind
  /** Groups only; direct conversations are titled by the other member on the client. */
  title: string | null
  lastSeq: number
  lastMessageAt: string | null
  lastMessage: Message | null
  lastReadSeq: number
  unreadCount: number
  members: Member[]
  createdAt: string
}

export interface MessagePage {
  messages: Message[]
  hasMore: boolean
}

export interface Invite {
  id: string
  code: string
  maxUses: number
  expiresAt: string
}

export interface AdminUser extends Me {
  disabled: boolean
}

export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'invalid_credentials'
  | 'forbidden'
  | 'not_found'
  | 'conversation_not_found'
  | 'user_not_found'
  | 'username_taken'
  | 'registration_closed'
  | 'invalid_invite'
  | 'conflict'
  | 'payload_too_large'
  | 'rate_limited'
  | 'origin_not_allowed'
  | 'service_unavailable'
  | 'internal'

export interface ErrorBody {
  error: { code: ErrorCode; message: string; details?: unknown[] }
}

// ---- WebSocket (CHAT.md §5.4) ----

// Typing and presence (CHAT.md Phase 6, optional) are not implemented; the server answers unknown frame types with `error`.
export type ClientFrame = { v: 1; type: 'auth'; data: { token: string } }

export type ServerEvent =
  | { type: 'ready'; data: { userId: string; sessionId: string; serverTime: string; heartbeatSec: number; protocol: ProtocolVersion } }
  | { type: 'message.created'; data: { message: Message } }
  | { type: 'message.deleted'; data: { conversationId: string; messageId: string; seq: number } }
  | { type: 'conversation.created'; data: { conversation: Conversation } }
  | { type: 'conversation.updated'; data: { conversation: Conversation } }
  | { type: 'conversation.removed'; data: { conversationId: string } }
  | { type: 'member.added'; data: { conversationId: string; user: UserSummary } }
  | { type: 'member.removed'; data: { conversationId: string; user: UserSummary } }
  | { type: 'read.updated'; data: { conversationId: string; userId: string; seq: number } }
  | { type: 'session.revoked'; data: Record<string, never> }
  | { type: 'error'; data: { code: ErrorCode; message: string } }

export type ServerFrame = ServerEvent & { v: 1 }

/** WebSocket close codes. 4401 means "signed out": clients must not reconnect until the user signs in again. */
export type CloseCode = 1001 | 1009 | 1013 | 4400 | 4401 | 4408 | 4429
