import { useId, useState } from 'react'
import { Link, NavLink, Outlet, useParams } from 'react-router'
import { isMobileApp } from '../../app/platform'
import { SubsonicError } from '../../api/subsonic/errors'
import type { NowPlayingEntry } from '../../api/subsonic/types'
import { useAuth } from '../../state/auth'
import { usePlayback } from '../../state/playback'
import { useSettings } from '../../state/settings'
import { Icon } from '../../ui/Icon'
import { EmptyState, ErrorState, Skeleton } from '../../ui/State'
import { Toggle } from '../../ui/Toggle'
import { connectErrorMessage } from '../connect/errorMessage'
import { Cover } from '../library/components'
import { isLive, sameUser, statusText, useActivity, useMe, usePeople, type Person } from './data'

export const profileHref = (name: string) => `/social/people/${encodeURIComponent(name)}`
const albumHref = (id: string) => `/library/albums/${encodeURIComponent(id)}`
const useHost = () => useAuth((s) => s.session?.credentials.baseUrl.replace(/^https?:\/\//, '') ?? 'this server')

const TABS = [
  { to: '/social', label: 'Activity', end: true },
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

export function SocialTabs() {
  return (
    <nav className={isMobileApp() ? 'm-chips social__tabs' : 'tabs social__tabs'} aria-label="Social">
      {TABS.map((t) => (
        <NavLink key={t.to} to={t.to} end={t.end} className={isMobileApp() ? 'm-chip' : 'tabs__item'}>
          {t.label}
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
        <EmptyState title="No one else is around right now" hint="People show up here while they share what they play." />
      )}
      <p className="social__note">Friend lists and friend requests aren’t part of the Subsonic API, so Auralis shows the people your server reports as active.</p>
    </div>
  )
}

export function Profile() {
  const { name = '' } = useParams()
  const { activity, people } = usePeople()
  const me = useMe()
  const titleId = useId()
  const self = sameUser(name, me)
  const person = people.find((p) => sameUser(p.name, name))
  const own = self ? activity.data?.find((e) => sameUser(e.username, me)) : undefined
  const entry = person?.entry ?? own
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
      {entry && (
        <section className="social__section" aria-label="Now playing">
          <h3 className="social__heading">{isLive(entry) ? 'Now playing' : 'Last reported'}</h3>
          <div className="list-panel">
            <ActivityCard entry={entry} showName={false} />
          </div>
        </section>
      )}
      <p className="social__note">
        Profiles show only what your server shares: the track being played. Friend requests would need a social service that Subsonic servers don’t have.
      </p>
    </article>
  )
}
