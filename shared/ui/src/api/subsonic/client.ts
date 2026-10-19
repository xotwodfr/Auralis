import { buildUrl, type Params } from './auth'
import { errorFromCode, SubsonicError } from './errors'
import type { ResponseBody, SubsonicResponse } from './types'

export interface RequestOptions {
  auth?: { username: string; password: string }
  params?: Params
  signal?: AbortSignal
}

/** Calls a Subsonic endpoint and returns the unwrapped `subsonic-response` body. */
export async function request<T extends object = object>(
  baseUrl: string,
  endpoint: string,
  { auth, params, signal }: RequestOptions = {},
): Promise<ResponseBody & T> {
  const aborted = () => new SubsonicError('aborted', 'Request cancelled')
  // Error messages never include the URL: it carries the auth token.
  let res: Response
  try {
    res = await fetch(buildUrl(baseUrl, endpoint, auth, params), { signal })
  } catch (e) {
    if (import.meta.env.DEV && !signal?.aborted) console.debug(`[subsonic] ${endpoint}: network error (${String(e)})`)
    throw signal?.aborted ? aborted() : new SubsonicError('network', 'Could not reach the server')
  }
  if (!res.ok) {
    if (import.meta.env.DEV) console.debug(`[subsonic] ${endpoint}: HTTP ${res.status}`)
    throw new SubsonicError('http', `Server responded with HTTP ${res.status}`, undefined, res.status)
  }

  let body: Partial<SubsonicResponse<T>> | null
  try {
    body = await res.json()
  } catch (e) {
    if (import.meta.env.DEV) console.debug(`[subsonic] ${endpoint}: response is not JSON (${String(e)})`)
    throw signal?.aborted ? aborted() : new SubsonicError('invalid-response', 'Response was not valid JSON')
  }
  const inner = body?.['subsonic-response']
  if (!inner || (inner.status !== 'ok' && inner.status !== 'failed')) {
    throw new SubsonicError('invalid-response', 'Not a Subsonic response')
  }
  if (inner.status === 'failed') throw errorFromCode(inner.error?.code ?? 0, inner.error?.message)
  return inner
}
