// Spotify Web API track search (https://developer.spotify.com/documentation/web-api/reference/search), used only to
// find the Spotify track id that Spicy Lyrics is addressed by. Client Credentials flow: the client secret lives only in
// this process. Not a general proxy: callers pass structured track metadata, the query is built here, and only the
// fields needed for matching are returned.
//
// Access (verified 2026-10): Development Mode apps need the app owner to hold Spotify Premium; search `limit` is 0-10.

const TOKEN_URL = 'https://accounts.spotify.com/api/token'
const DEFAULT_API = 'https://api.spotify.com'
const LIMIT = 10 // the documented maximum
const TIMEOUT_MS = 6000
const ISRC = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/

/** Spotify's query syntax uses quotes and `field:` prefixes; strip them so input text is only ever text. */
const clean = (s) => s.replace(/[":]/g, ' ').replace(/\s+/g, ' ').trim()

/**
 * @param {{ clientId?: string, clientSecret?: string, market?: string, apiBase?: string, tokenUrl?: string,
 *   fetchImpl?: typeof fetch, now?: () => number, log?: (msg: string) => void }} options
 */
export function createSpotifySearch(options = {}) {
  const { clientId = '', clientSecret = '', market = '', apiBase = DEFAULT_API, tokenUrl = TOKEN_URL, fetchImpl = fetch, now = Date.now, log = () => {} } = options
  const enabled = clientId.length > 0 && clientSecret.length > 0
  /** @type {{ value: string, until: number } | undefined} */
  let token
  /** @type {Promise<string> | undefined} */
  let tokenPending
  let blockedUntil = 0
  let warned = false

  const warnOnce = (msg) => { if (!warned) { warned = true; log(msg) } }

  async function getToken() {
    if (token && now() < token.until) return token.value
    tokenPending ??= (async () => {
      try {
        const res = await fetchImpl(tokenUrl, {
          method: 'POST',
          headers: { authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
          body: 'grant_type=client_credentials',
          signal: AbortSignal.timeout(TIMEOUT_MS),
          redirect: 'error',
        })
        if (!res.ok) {
          if (res.status === 400 || res.status === 401) warnOnce(`token request rejected (HTTP ${res.status}); check SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET`)
          throw new Error('token')
        }
        const j = await res.json()
        if (typeof j?.access_token !== 'string') throw new Error('token')
        const ttl = Number(j.expires_in) > 120 ? Number(j.expires_in) : 3600
        token = { value: j.access_token, until: now() + (ttl - 60) * 1000 }
        return token.value
      } finally {
        tokenPending = undefined
      }
    })()
    return tokenPending
  }

  /** One search request; returns Spotify track objects, or a {status} failure. */
  async function query(q, retried = false) {
    let access
    try {
      access = await getToken()
    } catch {
      return { status: 502 }
    }
    const url = new URL(`${apiBase.replace(/\/+$/, '')}/v1/search`)
    url.searchParams.set('q', q)
    url.searchParams.set('type', 'track')
    url.searchParams.set('limit', String(LIMIT))
    if (market) url.searchParams.set('market', market)
    let res
    try {
      res = await fetchImpl(url, { headers: { authorization: `Bearer ${access}`, accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' })
    } catch (e) {
      return { status: e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 504 : 502 }
    }
    if (res.status === 401 && !retried) {
      token = undefined // expired early or revoked: one fresh token, then give up
      return query(q, true)
    }
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after'))
      const s = Number.isFinite(wait) && wait > 0 ? Math.min(wait, 3600) : 30
      blockedUntil = now() + s * 1000
      return { status: 429, retryAfter: s }
    }
    if (res.status === 403) {
      // Development Mode apps stop working when the owner's Premium subscription lapses.
      warnOnce('Spotify refused the search (HTTP 403); the app owner may need an active Spotify Premium subscription')
      return { status: 502 }
    }
    if (!res.ok) return { status: 502 }
    try {
      const items = (await res.json())?.tracks?.items
      return { items: Array.isArray(items) ? items : [] }
    } catch {
      return { status: 502 }
    }
  }

  /** Only what matching needs; everything else from Spotify is dropped. */
  function candidate(t) {
    if (!t || typeof t.id !== 'string' || !/^[A-Za-z0-9]{22}$/.test(t.id) || typeof t.name !== 'string') return []
    const artists = Array.isArray(t.artists) ? t.artists.map((a) => a?.name).filter((n) => typeof n === 'string') : []
    return [{
      id: t.id,
      name: t.name,
      artists,
      album: typeof t.album?.name === 'string' ? t.album.name : '',
      albumType: typeof t.album?.album_type === 'string' ? t.album.album_type : '',
      durationMs: Number.isFinite(t.duration_ms) ? t.duration_ms : 0,
      explicit: t.explicit === true,
      isrc: typeof t.external_ids?.isrc === 'string' ? t.external_ids.isrc.toUpperCase() : '',
    }]
  }

  /**
   * Candidates for one track, from the most to the least precise query, stopping at the first that finds anything:
   * the ISRC (when the library has one), fielded title + artist, then free text. At most three upstream requests.
   * @param {{ title: string, artist: string, isrc?: string }} t
   * @returns {Promise<{ status: number, body: string, retryAfter?: number }>}
   */
  async function search(t) {
    if (now() < blockedUntil) return { status: 429, body: JSON.stringify({ error: 'rate_limited' }), retryAfter: Math.ceil((blockedUntil - now()) / 1000) }
    const title = clean(t.title)
    const artist = clean(t.artist)
    const queries = [
      ...(t.isrc && ISRC.test(t.isrc) ? [`isrc:${t.isrc}`] : []),
      artist ? `track:${title} artist:${artist}` : `track:${title}`,
      `${title} ${artist}`.trim(),
    ]
    for (const q of queries) {
      const r = await query(q)
      if (!r.items) return { status: r.status, body: JSON.stringify({ error: r.status === 429 ? 'rate_limited' : 'upstream_unavailable' }), ...(r.retryAfter && { retryAfter: r.retryAfter }) }
      const candidates = r.items.flatMap(candidate)
      if (candidates.length) return { status: 200, body: JSON.stringify({ candidates }) }
    }
    return { status: 200, body: JSON.stringify({ candidates: [] }) }
  }

  return { enabled, search }
}
