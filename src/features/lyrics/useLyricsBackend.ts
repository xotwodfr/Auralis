import { useQuery } from '@tanstack/react-query'
import { backendBase, backendUrl } from '../../lib/backend'
import { useSettings } from '../../state/settings'

export interface LyricsBackend {
  /** The Spicy Lyrics key is configured. */
  enabled: boolean
  /** Spotify credentials are configured too: tracks can be matched automatically. */
  matching: boolean
}

const PROBE_TIMEOUT_MS = 8000

/** A failed check with a message fit to show the user. */
export class ServerCheckError extends Error {}

/**
 * Asks a lyrics server what it can do (the keys themselves never leave the server). `base` '' = same origin.
 * A 503 is a healthy answer from a server whose key is missing, so JSON is read whatever the status.
 */
export async function probeLyricsServer(base: string, signal?: AbortSignal): Promise<LyricsBackend> {
  let url: string
  try {
    url = base ? `${base}/api/spicy/health` : backendUrl('/api/spicy/health')
  } catch {
    throw new ServerCheckError('No lyrics server is configured. Enter one above.')
  }
  const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS)
  let r: Response
  try {
    r = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, headers: { accept: 'application/json' } })
  } catch {
    if (signal?.aborted) throw new ServerCheckError('Cancelled')
    throw new ServerCheckError(
      timeout.aborted
        ? 'The server did not answer in time.'
        : "Couldn't reach the server. Check the address and your connection, and that it allows this app's origin.",
    )
  }
  const notOurs = new ServerCheckError(
    r.ok || r.status === 503 ? 'That address answered, but it is not an Auralis lyrics server.' : `The server answered with HTTP ${r.status}.`,
  )
  if (!r.headers.get('content-type')?.includes('json')) throw notOurs
  const j = (await r.json().catch(() => null)) as Partial<Record<keyof LyricsBackend, unknown>> | null
  if (!j || typeof j.enabled !== 'boolean') throw notOurs
  return { enabled: j.enabled, matching: j.matching === true }
}

/** The configured server's capabilities. Once per session per server address; idle when remote lookup is switched off. */
export function useLyricsBackend() {
  const on = useSettings((s) => s.lyricsServerEnabled && s.hydrated)
  const url = useSettings((s) => s.lyricsServerUrl)
  return useQuery({
    queryKey: ['lyrics-backend', url],
    enabled: on,
    staleTime: Infinity,
    retry: false,
    queryFn: ({ signal }) => probeLyricsServer(backendBase(), signal),
  })
}
