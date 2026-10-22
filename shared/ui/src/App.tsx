import { useEffect, type ComponentType, type ReactNode } from 'react'
import { Navigate, Route, Routes } from 'react-router'
import Connect from './features/connect/Connect'
import Shell from './app/Shell'
import { AlbumDetail, Albums, ArtistDetail, Artists, Favorites, PlaylistDetail, Playlists, Recent, RecentlyAdded } from './features/library/views'
import NowPlaying from './features/nowplaying/NowPlaying'
import Search from './features/search/Search'
import Settings from './features/settings/Settings'
import { Activity, People, Profile, SocialLayout } from './features/social/Social'
import { useAuth } from './state/auth'
import { useSettings } from './state/settings'
import { useSpotifyLinks } from './state/spotifyLinks'
import { usePlayback } from './state/playback'

function RequireSession({ children }: { children: ReactNode }) {
  const signedIn = useAuth((s) => s.session !== null)
  return signedIn ? children : <Navigate to="/connect" replace />
}

/** `shell` replaces the routed desktop layout wholesale; the Android app passes its phone UI, everyone else omits it. */
export default function App({ shell: PlatformShell }: { shell?: ComponentType<{ signedIn: boolean }> }) {
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

  if (PlatformShell) return <PlatformShell signedIn={signedIn} />

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
        <Route path="/social" element={<SocialLayout />}>
          <Route index element={<Activity />} />
          <Route path="people" element={<People />} />
          <Route path="people/:name" element={<Profile />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to={signedIn ? '/library' : '/connect'} replace />} />
    </Routes>
  )
}
