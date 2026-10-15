import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { Link, Navigate, NavLink, Outlet, useLocation, useNavigate, useParams } from 'react-router'
import { IS_MOBILE_APP } from '../../app/platform'
import { SubsonicError } from '../../api/subsonic/errors'
import type { ChatMessage, NowPlayingEntry } from '../../api/subsonic/types'
import { useAuth } from '../../state/auth'
import { usePlayback } from '../../state/playback'
import { useSettings } from '../../state/settings'
import { MAX_MESSAGE, sameUser, useSocial } from '../../state/social'
import { Icon } from '../../ui/Icon'
import { EmptyState, ErrorState, Skeleton } from '../../ui/State'
import { Toggle } from '../../ui/Toggle'
import { connectErrorMessage } from '../connect/errorMessage'
import { Cover } from '../library/components'
import { CHAT_POLL_OPEN_MS, formatMessageTime, isLive, statusText, useActivity, useChatPolling, useMe, usePeople, useUnread, type Person } from './data'

/** Subsonic has one chat room per server; the id leaves room for direct and group conversations later. */
export const SERVER_ROOM = 'server'
export const profileHref = (name: string) => `/social/people/${encodeURIComponent(name)}`
const roomHref = (room: string) => `/social/chat/${room}`
const albumHref = (id: string) => `/library/albums/${encodeURIComponent(id)}`
const useHost = () => useAuth((s) => s.session?.credentials.baseUrl.replace(/^https?:\/\//, '') ?? 'this server')

const TABS = [
  { to: '/social', label: 'Activity', end: true },
  { to: '/social/chat', label: 'Chat', end: false },
  { to: '/social/people', label: 'People', end: false },
]

/** Initial in a neutral circle: Subsonic servers don't give other users' avatars to ordinary accounts. */
export function Avatar({ name, large = false }: { name: string; large?: boolean }) {
  return (
    <span className={large ? 'avatar avatar--lg' : 'avatar'} aria-hidden>
      {(Array.from(name.trim())[0] ?? '?').toUpperCase()}
    </span>
  )
}

/** A count for a nav item or tab; the number is spoken through the parent's label. */
export function Badge({ count }: { count: number }) {
  if (count <= 0) return null
  return (
    <span className="badge" aria-hidden>
      {count > 99 ? '99+' : count}
    </span>
  )
}

export function SocialTabs() {
  const unread = useUnread()
  return (
    <nav className={IS_MOBILE_APP ? 'm-chips social__tabs' : 'tabs social__tabs'} aria-label="Social">
      {TABS.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.end}
          className={IS_MOBILE_APP ? 'm-chip' : 'tabs__item'}
          aria-label={t.label === 'Chat' && unread ? `Chat, ${unread} unread` : undefined}
        >
          {t.label}
          {t.label === 'Chat' && <Badge count={unread} />}
        </NavLink>
      ))}
    </nav>
  )
}

/** The web app's Social page; the phone UI wraps the same sections in its own page header (mobile/pages). */
export function SocialLayout() {
  return (
    <section className="page social">
      <h1 className="page__title">Social</h1>
      <SocialTabs />
      <Outlet />
    </section>
  )
}

function ShareListening() {
  const on = useSettings((s) => s.shareListening)
  const setOn = useSettings((s) => s.setShareListening)
  const host = useHost()
  return (
    <section className="social__privacy" aria-label="Your listening activity">
      <Toggle label="Share what I’m playing" checked={on} onChange={setOn} className="social__toggle" labelClassName="social__toggle-label" />
      <p className="social__note">
        {on
          ? `On: Auralis tells ${host} which track you start, and everyone signed in there can see it.`
          : `Off: Auralis doesn’t tell ${host} what you’re playing, so it doesn’t show up for anyone.`}
      </p>
    </section>
  )
}

export function ActivityCard({ entry, showName = true }: { entry: NowPlayingEntry; showName?: boolean }) {
  const playTracks = usePlayback((s) => s.playTracks)
  const { song } = entry
  return (
    <div className="activity">
      {showName && (
        <Link to={profileHref(entry.username)} className="activity__avatar" aria-label={`${entry.username}’s profile`}>
          <Avatar name={entry.username} />
        </Link>
      )}
      <div className="activity__body">
        <p className="activity__line">
          {showName && (
            <Link to={profileHref(entry.username)} className="activity__name">
              {entry.username}
            </Link>
          )}
          <span className={isLive(entry) ? 'activity__status activity__status--live' : 'activity__status'}>{statusText(entry)}</span>
        </p>
        <div className="activity__track">
          <span className="activity__art">
            <Cover id={song.coverArt} size={96} />
          </span>
          <span className="activity__text">
            <span className="activity__title">{song.title}</span>
            <span className="activity__sub">
              {song.artist}
              {song.album && ' · '}
              {song.album && song.albumId ? <Link to={albumHref(song.albumId)}>{song.album}</Link> : song.album}
            </span>
          </span>
        </div>
      </div>
      <button type="button" className="icon-btn activity__play" aria-label={`Play ${song.title}`} title="Play" onClick={() => playTracks([song])}>
        <Icon name="play" size={20} />
      </button>
    </div>
  )
}

/** Loading / error for a query that has no data yet; once it has data, a failed refresh keeps the last result on screen. */
function QueryState({ q }: { q: { isPending: boolean; isError: boolean; error: unknown; refetch: () => unknown } }) {
  if (q.isPending) return <Skeleton />
  if (q.isError) return <FailureState error={q.error} onRetry={() => void q.refetch()} />
  return null
}

function FailureState({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  if (error instanceof SubsonicError && (error.kind === 'auth' || error.kind === 'not-authorized')) {
    return <ErrorState message="Your session was rejected by the server." actionLabel="Sign in again" onRetry={() => void useAuth.getState().disconnect()} />
  }
  return <ErrorState message={connectErrorMessage(error)} onRetry={onRetry} />
}

export function Activity() {
  const q = useActivity()
  const me = useMe()
  const host = useHost()
  const others = (q.data ?? []).filter((e) => !sameUser(e.username, me)).sort((a, b) => Number(isLive(b)) - Number(isLive(a)) || a.minutesAgo - b.minutesAgo)
  return (
    <div className="social__section">
      <ShareListening />
      <h2 className="social__heading">Playing on {host}</h2>
      {!q.data ? (
        <QueryState q={q} />
      ) : others.length ? (
        <ul className="list-panel social__list" aria-label="Listening activity">
          {others.map((e, i) => (
            <li key={`${e.username}-${i}`}>
              <ActivityCard entry={e} />
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="Nobody else is playing anything right now" hint="When someone on your server plays music and shares it, it shows up here." />
      )}
      {q.data && q.isRefetchError && <p className="social__note" role="status">Couldn’t refresh. Showing the last update.</p>}
      <p className="social__note">Your server shares only what is playing now, not anyone’s listening history. This list refreshes every 30 seconds.</p>
    </div>
  )
}

function personStatus(p: Person): string {
  if (p.entry) return `${statusText(p.entry)}: ${p.entry.song.title}`
  if (p.lastMessage) return `Posted in chat, ${formatMessageTime(p.lastMessage.time)}`
  return ''
}

export function People() {
  const { activity, people } = usePeople()
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const shown = needle ? people.filter((p) => p.name.toLowerCase().includes(needle)) : people
  return (
    <div className="social__section">
      <input type="search" className="social__search" aria-label="Search people" placeholder="Search people" autoComplete="off" value={query} onChange={(e) => setQuery(e.target.value)} />
      {!people.length && !activity.data ? (
        <QueryState q={activity} />
      ) : shown.length ? (
        <ul className="list-panel social__list" aria-label="People">
          {shown.map((p) => (
            <li key={p.name}>
              <Link className="row social__person" to={profileHref(p.name)}>
                <Avatar name={p.name} />
                <span className="row__text">
                  <span className="row__title">{p.name}</span>
                  <span className="row__sub">{personStatus(p)}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : needle ? (
        <EmptyState title={`No one matching “${query.trim()}”`} />
      ) : (
        <EmptyState title="No one else is around right now" hint="People show up here while they share what they play, or after they post in the server chat." />
      )}
      <p className="social__note">Friend lists and friend requests aren’t part of the Subsonic API, so Auralis shows the people your server reports as active.</p>
    </div>
  )
}

export function Profile() {
  const { name = '' } = useParams()
  const { activity, people } = usePeople()
  const me = useMe()
  const chat = useSocial((s) => s.chat)
  const messages = useSocial((s) => s.messages)
  const navigate = useNavigate()
  const titleId = useId()
  const self = sameUser(name, me)
  const person = people.find((p) => sameUser(p.name, name))
  const own = self ? activity.data?.find((e) => sameUser(e.username, me)) : undefined
  const entry = person?.entry ?? own
  const recent = messages.filter((m) => sameUser(m.username, name)).slice(-5).reverse()
  return (
    <article className="social__section social__profile" aria-labelledby={titleId}>
      <header className="profile__head">
        <Avatar name={name} large />
        <div className="profile__lines">
          <h2 id={titleId} className="profile__name">
            {person?.name ?? name}
            {self && <span className="profile__you"> (you)</span>}
          </h2>
          <p className={entry && isLive(entry) ? 'activity__status activity__status--live' : 'activity__status'}>
            {entry ? statusText(entry) : activity.isPending ? 'Checking…' : 'Not playing anything your server knows of'}
          </p>
        </div>
      </header>
      {chat === 'ready' && !self && (
        <button type="button" className="btn btn--primary profile__action" onClick={() => navigate(roomHref(SERVER_ROOM), { state: { draft: `@${person?.name ?? name} ` } })}>
          Mention in server chat
        </button>
      )}
      {entry && (
        <section className="social__section" aria-label="Now playing">
          <h3 className="social__heading">{isLive(entry) ? 'Now playing' : 'Last reported'}</h3>
          <div className="list-panel">
            <ActivityCard entry={entry} showName={false} />
          </div>
        </section>
      )}
      {recent.length > 0 && (
        <section className="social__section" aria-label="Recent messages">
          <h3 className="social__heading">Recent messages in server chat</h3>
          <ul className="list-panel social__list">
            {recent.map((m) => (
              <li key={`${m.time}-${m.message}`} className="profile__msg">
                <time dateTime={new Date(m.time).toISOString()}>{formatMessageTime(m.time)}</time>
                <p>{m.message}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="social__note">
        Profiles show only what your server shares: the track being played and messages in its chat room. Direct messages and friend requests would need a
        social service that Subsonic servers don’t have.
      </p>
    </article>
  )
}

function ChatUnavailable() {
  const type = useAuth((s) => s.session?.server.type)
  const name = type ? type.charAt(0).toUpperCase() + type.slice(1) : 'This server'
  return (
    <EmptyState
      title="Chat isn’t available on this server"
      hint={`${name} doesn’t provide the Subsonic chat room, so there is nothing to read or send. Servers such as Airsonic do.`}
    />
  )
}

export function ConversationList() {
  const chat = useSocial((s) => s.chat)
  const last = useSocial((s) => s.messages.at(-1))
  const unread = useUnread()
  const me = useMe()
  const host = useHost()
  if (chat === 'unsupported') return <ChatUnavailable />
  const preview = chat === 'unknown' || chat === 'loading' ? 'Loading…' : last ? `${sameUser(last.username, me) ? 'You' : last.username}: ${last.message}` : chat === 'error' ? 'Couldn’t load messages' : 'No messages yet'
  return (
    <div className="social__convs">
      <ul className="list-panel social__list" aria-label="Conversations">
        <li>
          <NavLink to={roomHref(SERVER_ROOM)} className="row social__conv" aria-label={`Everyone on ${host}${unread ? `, ${unread} unread` : ''}`}>
            <span className="avatar" aria-hidden>
              <Icon name="people" size={18} />
            </span>
            <span className="row__text">
              <span className="row__title">Everyone on {host}</span>
              <span className="row__sub social__preview">{preview}</span>
            </span>
            <Badge count={unread} />
          </NavLink>
        </li>
      </ul>
      <p className="social__note">Your server’s shared chat room: everyone signed in can read it. Subsonic servers have no direct or group messages.</p>
    </div>
  )
}

/** Web: conversations beside the open one (one room today, so it opens straight away). */
export function ChatLayout() {
  const chat = useSocial((s) => s.chat)
  if (chat === 'unsupported') return <ChatUnavailable />
  return (
    <div className="social__chat">
      <ConversationList />
      <Outlet />
    </div>
  )
}

export const ChatIndex = () => <Navigate to={roomHref(SERVER_ROOM)} replace />

function sendErrorText(e: unknown): string {
  if (e instanceof SubsonicError) {
    if (e.kind === 'network') return 'Couldn’t reach the server. Your message wasn’t sent.'
    if (e.kind === 'auth' || e.kind === 'not-authorized') return 'The server rejected your session. Your message wasn’t sent.'
    return `The server didn’t accept the message (${e.message}).`
  }
  return 'Your message wasn’t sent. Try again.'
}

function Composer() {
  const location = useLocation()
  const [draft, setDraft] = useState(() => (location.state as { draft?: unknown } | null)?.draft?.toString() ?? '')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const send = useSocial((s) => s.sendChat)
  const field = useRef<HTMLTextAreaElement>(null)
  const id = useId()
  const text = draft.trim()
  const left = MAX_MESSAGE - draft.length

  // Arriving with a mention ("Mention in server chat"): focus the field with the caret after it.
  const mention = useRef(draft !== '')
  useEffect(() => {
    const el = field.current
    if (!mention.current || !el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])

  async function submit(e?: FormEvent) {
    e?.preventDefault()
    if (!text || sending) return
    setSending(true)
    setError('')
    try {
      await send(text)
      setDraft('')
    } catch (err) {
      setError(sendErrorText(err)) // the draft stays, so nothing typed is lost
    } finally {
      setSending(false)
      field.current?.focus()
    }
  }

  return (
    <form className="composer" onSubmit={(e) => void submit(e)}>
      <label className="sr-only" htmlFor={`${id}-text`}>
        Message everyone on this server
      </label>
      <textarea
        id={`${id}-text`}
        ref={field}
        className="composer__field"
        rows={1}
        maxLength={MAX_MESSAGE}
        enterKeyHint="send"
        placeholder="Write a message"
        value={draft}
        aria-describedby={error ? `${id}-error` : left < 100 ? `${id}-left` : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          // Enter sends; Shift+Enter (and an IME composing a character) inserts a newline.
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            void submit()
          }
        }}
      />
      <button type="submit" className="icon-btn composer__send" aria-label="Send" title="Send" disabled={!text || sending}>
        <Icon name="send" size={20} />
      </button>
      {left < 100 && (
        <span id={`${id}-left`} className="composer__left">
          {left} characters left
        </span>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="composer__error">
          {error}
        </p>
      )}
    </form>
  )
}

function MessageLog({ messages, me }: { messages: ChatMessage[]; me: string | undefined }) {
  const log = useRef<HTMLDivElement>(null)
  const atEnd = useRef(true)
  // Follow new messages only while the reader is at the end; scrolling up to read stays put.
  useLayoutEffect(() => {
    const el = log.current
    if (el && atEnd.current) el.scrollTop = el.scrollHeight
  }, [messages])
  return (
    <div
      ref={log}
      className="thread__log"
      role="log"
      aria-label="Messages"
      tabIndex={0}
      onScroll={(e) => {
        const el = e.currentTarget
        atEnd.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
      }}
    >
      <ol className="thread__msgs">
      {messages.map((m) => {
        const mine = sameUser(m.username, me)
        return (
          <li key={`${m.time}|${m.username}|${m.message}`} className={mine ? 'msg msg--mine' : 'msg'}>
            {!mine && <Avatar name={m.username} />}
            <div className="msg__body">
              <p className="msg__meta">
                {mine ? (
                  <span className="msg__who">You</span>
                ) : (
                  <Link className="msg__who" to={profileHref(m.username)}>
                    {m.username}
                  </Link>
                )}
                <time dateTime={new Date(m.time).toISOString()}>{formatMessageTime(m.time)}</time>
              </p>
              <p className="msg__text">{m.message}</p>
            </div>
          </li>
        )
      })}
      </ol>
    </div>
  )
}

export function ChatThread() {
  const { room } = useParams()
  useChatPolling(CHAT_POLL_OPEN_MS)
  const chat = useSocial((s) => s.chat)
  const chatError = useSocial((s) => s.chatError)
  const messages = useSocial((s) => s.messages)
  const markRead = useSocial((s) => s.markRead)
  const refresh = useSocial((s) => s.refreshChat)
  const me = useMe()
  const host = useHost()

  // Reading the open conversation clears its unread count (only while the window is actually visible).
  useEffect(() => {
    if (document.visibilityState === 'visible') markRead()
  }, [messages, markRead])

  if (room !== SERVER_ROOM) return <Navigate to="/social/chat" replace />
  if (chat === 'unsupported') return <ChatUnavailable />
  const loading = chat === 'unknown' || chat === 'loading'
  return (
    <section className="thread" aria-label={`Chat with everyone on ${host}`}>
      {loading ? (
        <p className="thread__status" role="status">
          Loading messages…
        </p>
      ) : chat === 'error' && !messages.length ? (
        <FailureState error={chatError} onRetry={() => void refresh()} />
      ) : messages.length ? (
        <MessageLog messages={messages} me={me} />
      ) : (
        <EmptyState title="No messages yet" hint="Say hello. Everyone signed in to your server can read what you post here." />
      )}
      {chat === 'error' && messages.length > 0 && (
        <p className="thread__warn" role="status">
          Couldn’t check for new messages.{' '}
          <button type="button" className="link-btn" onClick={() => void refresh()}>
            Try again
          </button>
        </p>
      )}
      {!loading && !(chat === 'error' && !messages.length) && <Composer />}
    </section>
  )
}
