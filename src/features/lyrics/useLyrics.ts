import { useQuery, useQueryClient } from '@tanstack/react-query'
import { lyricsKey, readCached, removeCached, writeCached } from '../../api/lyrics/cache'
import { spicyProvider } from '../../api/lyrics/providers/spicy'
import { lrclibProvider } from '../../api/lyrics/providers/lrclib'
import { serverProvider } from '../../api/lyrics/providers/server'
import { lookupLyrics } from '../../api/lyrics/registry'
import { forgetSpotifyMatch, matchKey, resolveSpotifyTrack } from '../../api/lyrics/resolve'
import type { LyricsTrack } from '../../api/lyrics/types'
import { useAuth } from '../../state/auth'
import { NO_SPOTIFY, linkKey, useSpotifyLinks } from '../../state/spotifyLinks'
import { useSettings } from '../../state/settings'
import { useLyricsBackend } from './useLyricsBackend'

/**
 * Lyrics for one track. First the track's Spotify identity (a link the user made, else an automatic match), then the
 * lyrics: Spicy Lyrics for that id, falling back to the server and LRCLIB. Query keys carry the track identity, so a
 * response for a previous track can never land on the current one, and TanStack Query aborts superseded requests.
 */
export function useLyrics(track: LyricsTrack | undefined) {
  const session = useAuth((s) => s.session)
  const external = useSettings((s) => s.externalLookups)
  const settingsReady = useSettings((s) => s.hydrated)
  const serverOn = useSettings((s) => s.lyricsServerEnabled)
  const client = useQueryClient()
  const credentials = session?.credentials
  const linked = useSpotifyLinks((s) => (credentials && track ? s.links[linkKey(credentials, track.id)] : undefined))
  const backend = useLyricsBackend()

  // Automatic matching: only with external lookups on, no link of the user's own, and a backend that can search.
  const auto = external && serverOn && !linked && backend.data?.matching === true
  const mKey = credentials && track ? matchKey(credentials, track) : ''
  const match = useQuery({
    queryKey: ['spotify-match', mKey],
    enabled: auto && !!mKey && settingsReady,
    staleTime: Infinity,
    queryFn: ({ signal }) => resolveSpotifyTrack(credentials!, track!, signal),
  })
  const resolution = auto ? match.data : undefined
  const autoId = resolution?.status === 'matched' ? resolution.id : undefined
  const spotifyId = external && serverOn ? (linked && linked !== NO_SPOTIFY ? linked : autoId) : undefined
  // Settle the identity before fetching, so the preferred source isn't skipped and lyrics don't swap mid-song.
  const resolving = external && serverOn && !linked && (backend.isPending || (auto && match.isPending))

  const key = credentials && track ? lyricsKey(credentials, track, external, spotifyId) : undefined
  const query = useQuery({
    queryKey: key ?? ['lyrics', 'none'],
    enabled: !!key && settingsReady && !resolving,
    staleTime: 5 * 60_000,
    queryFn: async ({ signal }) => {
      const cached = await readCached(key!)
      if (cached !== undefined) return cached
      const providers = [...(spotifyId ? [spicyProvider(spotifyId)] : []), serverProvider(credentials!, session!.capabilities.songLyrics), ...(external ? [lrclibProvider] : [])]
      const found = await lookupLyrics(providers, track!, signal)
      await writeCached(key!, found)
      return found
    },
  })

  /** Forget the stored result (including a remembered "not found" or an unsure match) and look again. */
  async function refresh() {
    if (!key) return
    if (auto && resolution?.status !== 'matched') {
      await forgetSpotifyMatch(credentials!, track!)
      await client.invalidateQueries({ queryKey: ['spotify-match', mKey] })
    }
    await removeCached(key)
    await client.invalidateQueries({ queryKey: key })
  }

  // No backend answered (desktop build without VITE_AURALIS_BACKEND_URL, or it is down): say so instead of going quiet.
  const backendMissing = external && serverOn && backend.isError
  return { ...query, refresh, external, linked, resolution, resolving, spotifyId, matching: backend.data?.matching === true, backendMissing }
}
