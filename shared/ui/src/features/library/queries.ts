import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import type { Credentials } from '../../api/subsonic/types'
import { useAuth } from '../../state/auth'

const useCredentials = () => useAuth((s) => s.session?.credentials)

// Keys are scoped by server + user so a different login never sees another account's cache.
export function useLibraryQuery<T>(
  key: readonly unknown[],
  fn: (c: Credentials, signal: AbortSignal) => Promise<T>,
  enabled = true,
) {
  const c = useCredentials()
  return useQuery({
    queryKey: [c?.baseUrl, c?.username, ...key],
    queryFn: ({ signal }) => fn(c!, signal),
    enabled: !!c && enabled,
  })
}

/** Offset pagination: a page shorter than `pageSize` is the last one. */
export function usePagedQuery<T>(
  key: readonly unknown[],
  pageSize: number,
  fn: (c: Credentials, offset: number, signal: AbortSignal) => Promise<T[]>,
) {
  const c = useCredentials()
  return useInfiniteQuery({
    queryKey: [c?.baseUrl, c?.username, ...key],
    initialPageParam: 0,
    queryFn: ({ pageParam, signal }) => fn(c!, pageParam, signal),
    getNextPageParam: (last, _all, offset) => (last.length < pageSize ? undefined : offset + pageSize),
    enabled: !!c,
  })
}
