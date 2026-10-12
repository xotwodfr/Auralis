import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'
import { getStarred2, setStarred, type StarKind } from '../../api/subsonic/endpoints'
import type { Album, Artist, SearchResults, Song } from '../../api/subsonic/types'
import { useAuth } from '../../state/auth'
import { toast } from '../../state/toast'
import { useLibraryQuery } from './queries'

export type StarTarget = { kind: 'song'; item: Song } | { kind: 'album'; item: Album } | { kind: 'artist'; item: Artist }

const tag = (kind: StarKind, id: string) => `${kind}:${id}`
const bucket = { song: 'songs', album: 'albums', artist: 'artists' } as const

/**
 * Every heart in the app reads the one `getStarred2` list the Favorites page already loads, so a star
 * shown anywhere and the Favorites page can never disagree.
 */
export function useStarred(): Set<string> {
  const q = useLibraryQuery(['starred'], getStarred2)
  return useMemo(() => {
    const ids = new Set<string>()
    if (q.data) {
      for (const a of q.data.artists) ids.add(tag('artist', a.id))
      for (const a of q.data.albums) ids.add(tag('album', a.id))
      for (const s of q.data.songs) ids.add(tag('song', s.id))
    }
    return ids
  }, [q.data])
}

export const isStarred = (ids: Set<string>, kind: StarKind, id: string) => ids.has(tag(kind, id))

const EMPTY: SearchResults = { artists: [], albums: [], songs: [] }

/** Flips the cached list first so the heart responds instantly, then reconciles with the server. */
export function useToggleStar() {
  const credentials = useAuth((s) => s.session?.credentials)
  const queryClient = useQueryClient()

  return useCallback(
    async ({ kind, item }: StarTarget) => {
      if (!credentials) return
      const key = [credentials.baseUrl, credentials.username, 'starred']
      const previous = queryClient.getQueryData<SearchResults>(key)
      const list = bucket[kind]
      const on = !(previous?.[list] as { id: string }[] | undefined)?.some((x) => x.id === item.id)

      queryClient.setQueryData<SearchResults>(key, (data) => {
        const base = data ?? EMPTY
        const rest = (base[list] as { id: string }[]).filter((x) => x.id !== item.id)
        return { ...base, [list]: on ? [...rest, item] : rest }
      })
      try {
        await setStarred(credentials, kind, item.id, on)
      } catch {
        if (previous) queryClient.setQueryData(key, previous)
        toast.error(on ? "Couldn't add to favorites." : "Couldn't remove from favorites.")
      }
      void queryClient.invalidateQueries({ queryKey: key })
    },
    [credentials, queryClient],
  )
}
