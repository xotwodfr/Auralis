import { lazy, Suspense, useEffect, type ReactNode } from 'react'
import { Navigate, Route, Routes } from 'react-router'
import Connect from './features/connect/Connect'
import Shell from './app/Shell'
import { AlbumDetail, Albums, ArtistDetail, Artists, Favorites, PlaylistDetail, Playlists, Recent, RecentlyAdded } from './features/library/views'
import NowPlaying from './features/nowplaying/NowPlaying'
import Search from './features/search/Search'
import Settings from './features/settings/Settings'
import { useAuth } from './state/auth'
import { useSettings } from './state/settings'
import { useSpotifyLinks } from './state/spotifyLinks'
import { usePlayback } from './state/playback'
import { IS_MOBILE_APP } from './app/platform'

// Loaded only inside the Android app, so the web bundle doesn't carry the phone UI.
const MobileApp = lazy(() => import('./mobile/MobileApp'))

function RequireSession({ children }: { children: ReactNode }) {
  const signedIn = useAuth((s) => s.session !== null)
  return signedIn ? children : <Navigate to="/connect" replace />
}

export default function App() {
  const hydrated = useAuth((s) => s.hydrated)
  const signedIn = useAuth((s) => s.session !== null)

  useEffect(() => {
    void useAuth.getState().restore()
    void useSettings.getState().restore()
    void useSpotifyLinks.getState().restore()
  }, [])

  // Rehydrate the queue (paused) once we know who is signed in.
  useEffect(() => {
    if (signedIn) void usePlayback.getState().restore()
  }, [signedIn])

  if (!hydrated) return null

  if (IS_MOBILE_APP) {
    return (
      <Suspense fallback={null}>
        <MobileApp signedIn={signedIn} />
      </Suspense>
    )
  }

  return (
    <Routes>
      <Route path="/connect" element={signedIn ? <Navigate to="/library" replace /> : <Connect />} />
      <Route element={<RequireSession><Shell /></RequireSession>}>
        <Route path="/library" element={<Navigate to="artists" replace />} />
        <Route path="/library/artists" element={<Artists />} />
        <Route path="/library/artists/:id" element={<ArtistDetail />} />
        <Route path="/library/albums" element={<Albums />} />
        <Route path="/library/albums/:id" element={<AlbumDetail />} />
        <Route path="/library/recently-added" element={<RecentlyAdded />} />
        <Route path="/library/playlists" element={<Playlists />} />
        <Route path="/library/playlists/:id" element={<PlaylistDetail />} />
        <Route path="/library/favorites" element={<Favorites />} />
        <Route path="/library/recent" element={<Recent />} />
        <Route path="/library/search" element={<Search />} />
        <Route path="/now-playing" element={<NowPlaying />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
      <Route path="*" element={<Navigate to={signedIn ? '/library' : '/connect'} replace />} />
    </Routes>
  )
}
