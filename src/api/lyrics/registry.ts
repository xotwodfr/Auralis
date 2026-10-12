import { SubsonicError } from '../subsonic/errors'
import { LyricsError, type Lyrics, type LyricsProvider, type LyricsTrack } from './types'

export const PROVIDER_TIMEOUT_MS = 6000

function toLyricsError(e: unknown): LyricsError {
  if (e instanceof LyricsError) return e
  if (e instanceof SubsonicError) {
    if (e.kind === 'aborted') return new LyricsError('aborted', 'Cancelled')
    if (e.kind === 'network') return new LyricsError('network', 'Could not reach the server')
    if (e.kind === 'auth') return new LyricsError('auth', 'The server rejected the session')
  }
  return new LyricsError('unavailable', 'Lyrics are temporarily unavailable')
}

/** Runs one provider with its own timeout; `signal` (track change / unmount) cancels it too. */
async function run(p: LyricsProvider, track: LyricsTrack, signal: AbortSignal, timeoutMs: number): Promise<Lyrics | null> {
  const ctl = new AbortController()
  let timedOut = false
  const abort = () => ctl.abort()
  const timer = setTimeout(() => ((timedOut = true), ctl.abort()), timeoutMs)
  signal.addEventListener('abort', abort)
  try {
    return await p.fetch(track, ctl.signal)
  } catch (e) {
    throw timedOut ? new LyricsError('timeout', 'The lyrics service took too long to respond') : toLyricsError(e)
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}

/**
 * Tries providers in order and returns the first hit. Resolves null only if every provider answered
 * "none"; if any provider failed and nothing was found, the last failure is thrown so the UI can offer a retry.
 */
export async function lookupLyrics(
  providers: LyricsProvider[],
  track: LyricsTrack,
  signal: AbortSignal,
  timeoutMs = PROVIDER_TIMEOUT_MS,
): Promise<Lyrics | null> {
  let failure: LyricsError | undefined
  for (const p of providers) {
    if (signal.aborted) throw new LyricsError('aborted', 'Cancelled')
    try {
      const found = await run(p, track, signal, timeoutMs)
      if (found) return found
    } catch (e) {
      const err = e as LyricsError
      if (err.kind === 'aborted') throw err
      failure = err
    }
  }
  if (failure) throw failure
  return null
}
