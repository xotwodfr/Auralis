import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router'
import PlayerBar from '../features/player/PlayerBar'
import { ToastRegion } from '../ui/Toast'
import { Icon, type IconName } from '../ui/Icon'
import SearchBox from '../features/search/SearchBox'
import { Badge } from '../features/social/Social'
import { CHAT_POLL_BACKGROUND_MS, useChatConnection, useChatPolling, useUnread } from '../features/social/data'
import { useAuth } from '../state/auth'
import ErrorBoundary from './ErrorBoundary'
import { useShortcuts } from './shortcuts'

interface Item {
  to: string
  label: string
  icon: IconName
}

/** Two groups: what the server holds, then what this user made. Settings/account live in the footer. */
const GROUPS: { title: string; items: Item[] }[] = [
  {
    title: 'Library',
    items: [
      { to: '/library/artists', label: 'Artists', icon: 'artist' },
      { to: '/library/albums', label: 'Albums', icon: 'album' },
      { to: '/library/recently-added', label: 'Recently Added', icon: 'added' },
    ],
  },
  {
    title: 'Yours',
    items: [
      { to: '/library/playlists', label: 'Playlists', icon: 'playlist' },
      { to: '/library/favorites', label: 'Favorites', icon: 'heart' },
      { to: '/library/recent', label: 'Recent', icon: 'clock' },
    ],
  },
]

// The toolbar already owns search ("/" focuses it), so the sidebar only needs the focal views. Social leads, in the
// top-left corner of the app (and first in the narrow-screen tab strip).
const TOP: Item[] = [
  { to: '/social', label: 'Social', icon: 'people' },
  { to: '/now-playing', label: 'Now Playing', icon: 'wave' },
]

const RAIL_KEY = 'auralis:rail'
/** Detail routes (`/library/<kind>/<id>`, a Social profile) get a back button; the top-level sections don't need one. */
const DETAIL = /^\/(library\/[^/]+|social\/people)\/.+/

function NavItem({ to, label, icon, rail, badge = 0 }: Item & { rail: boolean; badge?: number }) {
  return (
    <li>
      <NavLink to={to} className="navitem" title={rail ? label : undefined} aria-label={badge ? `${label}, ${badge} unread` : undefined}>
        <Icon name={icon} size={20} />
        <span className="navitem__label">{label}</span>
        <Badge count={badge} />
      </NavLink>
    </li>
  )
}

export default function Shell() {
  useShortcuts()
  useChatPolling(CHAT_POLL_BACKGROUND_MS)
  useChatConnection()
  const unread = useUnread()
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const account = useAuth((s) => s.session?.credentials.username)
  const server = useAuth((s) => s.session?.credentials.baseUrl)
  const [rail, setRail] = useState(() => {
    try {
      return localStorage.getItem(RAIL_KEY) === '1'
    } catch {
      return false // private mode / blocked storage
    }
  })

  // A new route starts at the top: the window scrolls the content, so it would otherwise keep the last page's offset.
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [pathname])

  function toggleRail() {
    setRail((r) => {
      try {
        localStorage.setItem(RAIL_KEY, r ? '0' : '1')
      } catch {
        // The choice just doesn't persist.
      }
      return !r
    })
  }

  return (
    <div className={rail ? 'app app--rail' : 'app'}>
      <nav className="sidebar" aria-label="Main">
        <div className="sidebar__head">
          <p className="sidebar__brand">
            <Icon name="wave" size={22} />
            <span className="sidebar__word">Auralis</span>
          </p>
          <button
            type="button"
            className="icon-btn sidebar__rail"
            aria-label={rail ? 'Expand the sidebar' : 'Collapse the sidebar'}
            aria-pressed={rail}
            title={rail ? 'Expand' : 'Collapse'}
            onClick={toggleRail}
          >
            <Icon name="rail" size={20} />
          </button>
        </div>

        <div className="sidebar__scroll">
          <ul className="sidebar__list">
            {TOP.map((i) => (
              <NavItem key={i.to} {...i} rail={rail} badge={i.to === '/social' ? unread : 0} />
            ))}
          </ul>
          {GROUPS.map((g) => (
            <div key={g.title} className="sidebar__group">
              <h2 className="sidebar__grouptitle" aria-hidden={rail || undefined}>
                {g.title}
              </h2>
              <ul className="sidebar__list" aria-label={g.title}>
                {g.items.map((i) => (
                  <NavItem key={i.to} {...i} rail={rail} />
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="sidebar__foot">
          {/* aria-label keeps the link's purpose as its accessible name; the account line is supplementary. */}
          <NavLink to="/settings" className="navitem sidebar__account" aria-label="Settings" title="Settings">
            <Icon name="settings" size={20} />
            <span className="navitem__label sidebar__accountlines">
              <span className="sidebar__user">Settings</span>
              {account && <span className="sidebar__server">{server ? `${account} · ${server.replace(/^https?:\/\//, '')}` : account}</span>}
            </span>
          </NavLink>
        </div>
      </nav>

      <div className="app__main">
        <header className="toolbar">
          {DETAIL.test(pathname) && (
            <button type="button" className="icon-btn" aria-label="Back" title="Back" onClick={() => navigate(-1)}>
              <Icon name="back" size={22} />
            </button>
          )}
          <SearchBox />
        </header>
        <main className="content">
          <ErrorBoundary key={pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
      <PlayerBar />
      <ToastRegion />
    </div>
  )
}
