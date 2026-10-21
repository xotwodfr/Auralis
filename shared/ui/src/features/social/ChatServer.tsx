// Chat server conversations inside Social (CHAT.md §10.6): the list source, the thread, new-message / new-group dialogs
// and group info. Message text is rendered as plain text nodes only, never as HTML.
import { useEffect, useId, useMemo, useState, type FormEvent } from 'react'
import { Link, Navigate, NavLink, useNavigate, useParams } from 'react-router'
import type { Conversation, UserSummary } from '../../../../chat-protocol'
import { ChatError, chatErrorMessage } from '../../api/chat/client'
import { conversationTitle, unreadOf, useChat, type Pending } from '../../state/chat'
import { chatServerApi, useChatServer } from '../../state/chatServer'
import { toast } from '../../state/toast'
import { ConfirmDialog, Dialog } from '../../ui/Dialog'
import { Icon } from '../../ui/Icon'
import { EmptyState, ErrorState } from '../../ui/State'
import { Avatar, Badge, Composer, MessageLog, ThreadBack, type LogItem } from './Social'

export const conversationHref = (id: string) => `/social/chat/c/${encodeURIComponent(id)}`
const SEARCH_DEBOUNCE_MS = 250

const useMyId = () => useChatServer((s) => s.user?.id)

function useSortedConversations(): Conversation[] {
  const all = useChat((s) => s.conversations)
  return useMemo(() => Object.values(all).sort((a, b) => (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt)), [all])
}

export function useConversationTitle(id: string | undefined): string {
  const c = useChat((s) => (id ? s.conversations[id] : undefined))
  const myId = useMyId()
  return c ? conversationTitle(c, myId) : 'Chat'
}

/** Shown wherever chat is offered but no chat server is set up. */
export function SetupChatServerNote() {
  const configured = useChatServer((s) => s.url !== null)
  return (
    <p className="social__note">
      Direct and group messages need an Auralis chat server.{' '}
      <Link to="/settings">{configured ? 'Sign in to your chat server in Settings' : 'Set up a chat server in Settings'}</Link>.
    </p>
  )
}

function connectionNote(c: ReturnType<typeof useChatServer.getState>['connection']): string | null {
  if (c.status === 'reconnecting') return 'Reconnecting to the chat server…'
  if (c.status === 'connecting') return 'Connecting to the chat server…'
  return null
}

/** The chat server's conversations, newest activity first, plus New message / New group. */
export function ChatServerConversations() {
  const list = useSortedConversations()
  const status = useChat((s) => s.status)
  const error = useChat((s) => s.error)
  const reload = useChat((s) => s.loadConversations)
  const name = useChatServer((s) => s.info?.name ?? 'Chat server')
  const note = connectionNote(useChatServer((s) => s.connection))
  const myId = useMyId()
  const [dialog, setDialog] = useState<'direct' | 'group' | null>(null)

  return (
    <section className="social__source" aria-label={name}>
      <div className="social__source-head">
        <h2 className="social__heading">{name}</h2>
        <div className="social__source-actions">
          <button type="button" className="btn btn--small" onClick={() => setDialog('direct')}>
            New message
          </button>
          <button type="button" className="btn btn--small" onClick={() => setDialog('group')}>
            New group
          </button>
        </div>
      </div>
      {note && (
        <p className="social__note" role="status">
          {note}
        </p>
      )}
      {status === 'error' && !list.length ? (
        <ErrorState message={error ?? 'Couldn’t load conversations.'} onRetry={() => void reload()} />
      ) : list.length ? (
        <ul className="list-panel social__list" aria-label={`Conversations on ${name}`}>
          {list.map((c) => {
            const title = conversationTitle(c, myId)
            const unread = unreadOf(c)
            const last = c.lastMessage
            const preview = !last ? 'No messages yet' : last.deleted ? 'Message deleted' : `${last.sender.id === myId ? 'You' : last.sender.displayName}: ${last.body}`
            return (
              <li key={c.id}>
                <NavLink to={conversationHref(c.id)} className="row social__conv" aria-label={`${title}${unread ? `, ${unread} unread` : ''}`}>
                  {c.kind === 'group' ? (
                    <span className="avatar" aria-hidden>
                      <Icon name="people" size={18} />
                    </span>
                  ) : (
                    <Avatar name={title} />
                  )}
                  <span className="row__text">
                    <span className="row__title">{title}</span>
                    <span className="row__sub social__preview">{preview}</span>
                  </span>
                  <Badge count={unread} />
                </NavLink>
              </li>
            )
          })}
        </ul>
      ) : status === 'ready' ? (
        <p className="social__note">No conversations yet. Start one with New message.</p>
      ) : (
        <p className="social__note" role="status">
          Loading conversations…
        </p>
      )}
      {dialog && <NewConversationDialog mode={dialog} onClose={() => setDialog(null)} />}
    </section>
  )
}

/** /social/chat with a chat server: the pane beside the list until a conversation is picked (hidden on phones, where the
 *  list is the whole page). */
export function ChatServerIndex() {
  const status = useChat((s) => s.status)
  const any = useChat((s) => Object.keys(s.conversations).length > 0)
  return (
    <section className="thread-placeholder" aria-label="Chat">
      {status === 'loading' || status === 'idle' ? (
        <p className="thread__status" role="status">
          Loading conversations…
        </p>
      ) : (
        <EmptyState
          title={any ? 'Choose a conversation' : 'No conversations yet'}
          hint={any ? 'Or start a new one with New message.' : 'Start one with New message. Messages are stored on your chat server, and whoever runs it can read them.'}
        />
      )}
    </section>
  )
}

// ---- people search (new conversations, adding members) ----

function UserSearch({ onPick, exclude = [], label }: { onPick: (u: UserSummary) => void; exclude?: string[]; label: string }) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<UserSummary[] | null>(null)
  const [error, setError] = useState('')
  const id = useId()
  const needle = q.trim()

  useEffect(() => {
    if (needle.length < 2) return
    const ctl = new AbortController()
    const timer = setTimeout(() => {
      chatServerApi()
        ?.searchUsers(needle, ctl.signal)
        .then(
          (r) => (setResults(r), setError('')),
          (e) => !ctl.signal.aborted && (setResults([]), setError(chatErrorMessage(e))),
        )
    }, SEARCH_DEBOUNCE_MS)
    return () => (clearTimeout(timer), ctl.abort())
  }, [needle])

  const shown = results?.filter((u) => !exclude.includes(u.id)) ?? []
  const searching = needle.length >= 2
  return (
    <div className="chat-search">
      <label className="field" htmlFor={`${id}-q`}>
        <span>{label}</span>
        <input id={`${id}-q`} type="search" autoComplete="off" autoCapitalize="off" spellCheck={false} placeholder="Username" value={q} onChange={(e) => setQ(e.target.value)} data-autofocus />
      </label>
      {!searching ? (
        <p className="hint">Type at least two letters of a username.</p>
      ) : error ? (
        <p className="hint" role="alert">
          {error}
        </p>
      ) : results === null ? (
        <p className="hint" role="status">
          Searching…
        </p>
      ) : shown.length ? (
        <ul className="chat-search__results" aria-label="People found">
          {shown.map((u) => (
            <li key={u.id}>
              <button type="button" className="row chat-search__pick" onClick={() => onPick(u)}>
                <Avatar name={u.displayName} />
                <span className="row__text">
                  <span className="row__title">{u.displayName}</span>
                  <span className="row__sub">@{u.username}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="hint" role="status">
          No one found with a username starting “{needle}”.
        </p>
      )}
    </div>
  )
}

function NewConversationDialog({ mode, onClose }: { mode: 'direct' | 'group'; onClose: () => void }) {
  const navigate = useNavigate()
  const upsert = useChat((s) => s.upsert)
  const myId = useMyId()
  const [title, setTitle] = useState('')
  const [picked, setPicked] = useState<UserSummary[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const max = useChatServer((s) => s.info?.limits.maxGroupMembers ?? 64)

  async function open(create: () => Promise<Conversation> | undefined) {
    setBusy(true)
    setError('')
    try {
      const c = await create()
      if (!c) return
      upsert(c)
      onClose()
      navigate(conversationHref(c.id))
    } catch (e) {
      setError(chatErrorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  if (mode === 'direct') {
    return (
      <Dialog title="New message" onClose={onClose}>
        <UserSearch label="Who do you want to message?" exclude={myId ? [myId] : []} onPick={(u) => void open(() => chatServerApi()?.createDirect(u.id))} />
        {error && (
          <p className="hint" role="alert">
            {error}
          </p>
        )}
        <div className="actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </Dialog>
    )
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!title.trim()) return setError('Give the group a name.')
    void open(() => chatServerApi()?.createGroup(title.trim(), picked.map((u) => u.id)))
  }
  return (
    <Dialog title="New group" onClose={onClose}>
      <form onSubmit={submit} className="chat-form">
        <label className="field">
          <span>Group name</span>
          <input value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} required />
        </label>
        {picked.length > 0 && (
          <ul className="chat-chips" aria-label="Members to add">
            {picked.map((u) => (
              <li key={u.id}>
                <button type="button" className="chip" aria-label={`Remove ${u.displayName}`} onClick={() => setPicked(picked.filter((p) => p.id !== u.id))}>
                  {u.displayName} ×
                </button>
              </li>
            ))}
          </ul>
        )}
        {picked.length + 1 < max ? (
          <UserSearch label="Add people" exclude={[...(myId ? [myId] : []), ...picked.map((u) => u.id)]} onPick={(u) => setPicked([...picked, u])} />
        ) : (
          <p className="hint">Groups can have at most {max} members.</p>
        )}
        {error && (
          <p className="hint" role="alert">
            {error}
          </p>
        )}
        <div className="actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn--primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create group'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

// ---- group info ----

function GroupInfoDialog({ c, onClose, onLeft }: { c: Conversation; onClose: () => void; onLeft: () => void }) {
  const myId = useMyId()
  const upsert = useChat((s) => s.upsert)
  const mine = c.members.find((m) => m.id === myId)
  const manager = mine?.role === 'owner' || mine?.role === 'admin'
  const [title, setTitle] = useState(c.title ?? '')
  const [error, setError] = useState('')
  const [confirm, setConfirm] = useState<{ userId: string; label: string; self: boolean } | null>(null)
  const max = useChatServer((s) => s.info?.limits.maxGroupMembers ?? 64)

  const run = async (op: () => Promise<unknown> | undefined) => {
    setError('')
    try {
      const r = await op()
      if (r && typeof r === 'object' && 'id' in r) upsert(r as Conversation)
    } catch (e) {
      setError(chatErrorMessage(e))
    }
  }

  return (
    <Dialog title={c.title ?? 'Group'} onClose={onClose}>
      {manager && (
        <form
          className="chat-form"
          onSubmit={(e) => {
            e.preventDefault()
            if (title.trim() && title.trim() !== c.title) void run(() => chatServerApi()?.rename(c.id, title.trim()))
          }}
        >
          <label className="field">
            <span>Group name</span>
            <input value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} required />
          </label>
          <div className="actions">
            <button type="submit" className="btn">
              Rename
            </button>
          </div>
        </form>
      )}
      <h3 className="social__heading">{c.members.length === 1 ? '1 member' : `${c.members.length} members`}</h3>
      <ul className="chat-members" aria-label="Members">
        {c.members.map((m) => (
          <li key={m.id} className="row">
            <Avatar name={m.displayName} />
            <span className="row__text">
              <span className="row__title">
                {m.displayName}
                {m.id === myId && ' (you)'}
              </span>
              <span className="row__sub">
                @{m.username}
                {m.role !== 'member' && ` · ${m.role}`}
              </span>
            </span>
            {manager && m.id !== myId && m.role !== 'owner' && (
              <button type="button" className="link-btn" onClick={() => setConfirm({ userId: m.id, label: m.displayName, self: false })}>
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
      {manager && c.members.length < max && (
        <UserSearch label="Add people" exclude={c.members.map((m) => m.id)} onPick={(u) => void run(() => chatServerApi()?.addMembers(c.id, [u.id]))} />
      )}
      {error && (
        <p className="hint" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button type="button" className="btn btn--danger" onClick={() => setConfirm({ userId: myId ?? '', label: '', self: true })}>
          Leave group
        </button>
        <button type="button" className="btn" onClick={onClose} data-autofocus>
          Done
        </button>
      </div>
      {confirm && (
        <ConfirmDialog
          title={confirm.self ? 'Leave this group?' : `Remove ${confirm.label}?`}
          message={confirm.self ? 'You won’t receive its messages any more, and someone in the group would have to add you back.' : 'They won’t receive this group’s messages any more.'}
          confirmLabel={confirm.self ? 'Leave' : 'Remove'}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const { userId, self } = confirm
            setConfirm(null)
            void run(async () => {
              await chatServerApi()?.removeMember(c.id, userId)
              if (self) onLeft()
            })
          }}
        />
      )}
    </Dialog>
  )
}

// ---- the thread ----

function pendingFooter(p: Pending, retry: () => void, discard: () => void) {
  if (p.status === 'failed') {
    return (
      <p className="msg__state msg__state--failed" role="alert">
        Not sent{p.error ? `: ${p.error}` : '.'}{' '}
        <button type="button" className="link-btn" onClick={retry}>
          Retry
        </button>{' '}
        <button type="button" className="link-btn" onClick={discard}>
          Discard
        </button>
      </p>
    )
  }
  return <p className="msg__state">{p.status === 'waiting' ? 'Waiting for the connection…' : 'Sending…'}</p>
}

/** A chat server conversation. `compact` drops the title row (the phone page shows the title in its own header). */
export function ConversationThread({ compact = false }: { compact?: boolean }) {
  const { conversationId = '' } = useParams()
  const navigate = useNavigate()
  const signedIn = useChatServer((s) => s.token !== null)
  const maxChars = useChatServer((s) => s.info?.limits.maxMessageChars ?? 4000)
  const myId = useMyId()
  const c = useChat((s) => s.conversations[conversationId])
  const messages = useChat((s) => s.messages[conversationId])
  const hasOlder = useChat((s) => s.hasOlder[conversationId] ?? false)
  const missing = useChat((s) => s.missing[conversationId] === true)
  const outbox = useChat((s) => s.outbox[conversationId])
  const { openConversation, loadOlder, send, retry, discard, markRead, deleteMessage } = useChat.getState()
  // Keyed by conversation, so switching conversations never shows the previous one's failure.
  const [failure, setFailure] = useState<{ id: string; error: unknown } | null>(null)
  const error = failure?.id === conversationId ? failure.error : null
  const [olderBusy, setOlderBusy] = useState(false)
  const [info, setInfo] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const title = c ? conversationTitle(c, myId) : 'Conversation'
  const manager = c?.kind === 'group' && ['owner', 'admin'].includes(c.members.find((m) => m.id === myId)?.role ?? '')

  useEffect(() => {
    openConversation(conversationId).catch((e: unknown) => setFailure({ id: conversationId, error: e }))
    return () => void useChat.getState().openConversation(null)
  }, [conversationId, openConversation])

  // Reading the open conversation clears its unread count (only while the window is actually visible).
  useEffect(() => {
    if (document.visibilityState === 'visible') markRead(conversationId)
  }, [messages, conversationId, markRead])

  const items = useMemo<LogItem[]>(() => {
    const sent: LogItem[] = (messages ?? []).map((m) => {
      const mine = m.sender.id === myId
      return {
        key: m.id,
        mine,
        who: m.sender.displayName,
        time: Date.parse(m.createdAt),
        text: m.deleted ? 'Message deleted' : m.body,
        className: m.deleted ? 'msg--deleted' : undefined,
        action:
          !m.deleted && (mine || manager) ? (
            <button type="button" className="link-btn msg__action" aria-label={`Delete message: ${m.body.slice(0, 40)}`} onClick={() => setDeleting(m.id)}>
              Delete
            </button>
          ) : undefined,
      }
    })
    const pending: LogItem[] = (outbox ?? []).map((p) => ({
      key: p.clientMessageId,
      mine: true,
      who: 'You',
      time: Date.parse(p.createdAt),
      text: p.body,
      className: p.status === 'failed' ? 'msg--failed' : 'msg--pending',
      footer: pendingFooter(p, () => retry(conversationId, p.clientMessageId), () => discard(conversationId, p.clientMessageId)),
    }))
    return [...sent, ...pending]
  }, [messages, outbox, myId, manager, conversationId, retry, discard])

  if (!signedIn) return <Navigate to="/social/chat" replace />
  if (missing) {
    return (
      <section className="thread" aria-label="Conversation not found">
        <EmptyState title="Conversation not found" hint="It doesn’t exist, or you’re not a member of it." />
      </section>
    )
  }

  return (
    <section className="thread" aria-label={`Chat with ${title}`}>
      {(!compact || c?.kind === 'group') && (
        <header className="thread__head">
          {!compact && <ThreadBack />}
          {!compact && <h2 className="thread__title">{title}</h2>}
          {c?.kind === 'group' && (
            <button type="button" className="btn btn--small" onClick={() => setInfo(true)}>
              Group info
            </button>
          )}
        </header>
      )}
      {error ? (
        <ErrorState message={chatErrorMessage(error)} onRetry={() => (setFailure(null), openConversation(conversationId).catch((e: unknown) => setFailure({ id: conversationId, error: e })))} />
      ) : !messages ? (
        <p className="thread__status" role="status">
          Loading messages…
        </p>
      ) : items.length ? (
        <MessageLog
          items={items}
          before={
            hasOlder && (
              <p className="thread__older">
                <button
                  type="button"
                  className="link-btn"
                  disabled={olderBusy}
                  onClick={() => {
                    setOlderBusy(true)
                    loadOlder(conversationId)
                      .catch((e) => toast.error(chatErrorMessage(e)))
                      .finally(() => setOlderBusy(false))
                  }}
                >
                  {olderBusy ? 'Loading…' : 'Load earlier messages'}
                </button>
              </p>
            )
          }
        />
      ) : (
        <EmptyState title="No messages yet" hint="Say hello. Messages are stored on your chat server, and whoever runs it can read them." />
      )}
      {!error && messages && (
        <Composer
          key={conversationId}
          maxLength={maxChars}
          label={`Message ${title}`}
          onSend={async (text) => send(conversationId, text)}
        />
      )}
      {info && c && <GroupInfoDialog c={c} onClose={() => setInfo(false)} onLeft={() => (setInfo(false), navigate('/social/chat'))} />}
      {deleting && (
        <ConfirmDialog
          title="Delete this message?"
          message="It is removed for everyone in the conversation."
          confirmLabel="Delete"
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const id = deleting
            setDeleting(null)
            deleteMessage(conversationId, id).catch((e) => toast.error(e instanceof ChatError ? chatErrorMessage(e) : 'Couldn’t delete the message.'))
          }}
        />
      )}
    </section>
  )
}
