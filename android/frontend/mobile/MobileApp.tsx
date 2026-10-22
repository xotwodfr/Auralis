import { useEffect } from 'react'
import { Navigate, NavLink, Outlet, Route, Routes, useLocation, type Location } from 'react-router'
import { useSettings } from '@auralis/ui/state/settings'
import ErrorBoundary from '@auralis/ui/app/ErrorBoundary'
import Connect from '@auralis/ui/features/connect/Connect'
import { ToastRegion } from '@auralis/ui/ui/Toast'
import { Icon, type IconName } from '@auralis/ui/ui/Icon'
import MiniPlayer from './MiniPlayer'
import Player from './Player'
import { useDynamicColor } from './parts'
import { AlbumPage, ArtistPage, BrowsePage, Home, Library, LikedPage, PlaylistPage, SearchPage, SocialPage, SocialProfilePage } from './pages'
import { Activity, People } from '@auralis/ui/features/social/Social'
import SettingsPage from './SettingsPage'
import { ShownLocation, usePlayerPresence, useShownLocation, useTransitionedLocation } from './transitions'

const TABS: { to: string; label: string; icon: IconName; match: (path: string) => boolean }[] = [
  { to: '/home', label: 'Home', icon: 'home', match: (p) => p === '/home' || p.startsWith('/browse') },
  { to: '/search', label: 'Search', icon: 'search', match: (p) => p === '/search' },
  { to: '/library', label: 'Your Library', icon: 'library', match: (p) => p.startsWith('/library') || p === '/settings' },
]

/** Lyric size is a CSS hook on <html>, so every lyrics view follows it. */
function useLyricSize() {
  const size = useSettings((s) => s.lyricSize)
  useEffect(() => {
    document.documentElement.dataset.lyricSize = size
  }, [size])
}

function Shell() {
  const { pathname } = useShownLocation()
  return (
    <div className="m-app">
      <main className="m-main">
        <ErrorBoundary key={pathname}>
          <div className="m-route">
            <Outlet />
          </div>
        </ErrorBoundary>
      </main>
      <div className="m-dock">
        <MiniPlayer />
        <nav className="m-tabs" aria-label="Main">
          {TABS.map((t) => (
            <NavLink key={t.to} to={t.to} className="m-tab" aria-current={t.match(pathname) ? 'page' : undefined}>
              <Icon name={t.icon} size={24} />
              <span>{t.label}</span>
            </NavLink>
          ))}
        </nav>
      </div>
      <ToastRegion />
    </div>
  )
}

export default function MobileApp({ signedIn }: { signedIn: boolean }) {
  if (!signedIn) {
    return (
      <Routes>
        <Route path="/connect" element={<Connect />} />
        <Route path="*" element={<Navigate to="/connect" replace />} />
      </Routes>
    )
  }
  return <SignedIn />
}

/** Now Playing is a modal route: the page underneath stays mounted (and keeps its scroll), and Back closes it. */
function SignedIn() {
  useLyricSize()
  useDynamicColor()
  const location = useLocation()
  const playerOpen = location.pathname === '/now-playing'
  const playerShown = usePlayerPresence(playerOpen)
  const background = (location.state as { background?: Location } | null)?.background
  const pages = useTransitionedLocation(playerOpen ? (background ?? { ...location, pathname: '/home' }) : location)
  return (
    <ShownLocation value={pages}>
      <Routes location={pages}>
        <Route element={<Shell />}>
          <Route path="/home" element={<Home />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="/library" element={<Library />} />
          <Route path="/library/favorites" element={<LikedPage />} />
          <Route path="/library/artists/:id" element={<ArtistPage />} />
          <Route path="/library/albums/:id" element={<AlbumPage />} />
          <Route path="/library/playlists/:id" element={<PlaylistPage />} />
          <Route path="/browse/:type" element={<BrowsePage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/social" element={<SocialPage />}>
            <Route index element={<Activity />} />
            <Route path="people" element={<People />} />
          </Route>
          <Route path="/social/people/:name" element={<SocialProfilePage />} />
        </Route>
        <Route path="*" element={<Navigate to="/home" replace />} />
      </Routes>
      {playerShown && <Player />}
    </ShownLocation>
  )
}
