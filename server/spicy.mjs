// Server-side bridge to the Spicy Lyrics API (https://developers.spicylyrics.org/docs).
// The secret key lives only in this process. The browser talks to /api/spicy/* on our own origin.
//
// Deliberately NOT a general proxy: three fixed GET routes, a validated 22-char track id, a fixed upstream
// path, no pass-through of client headers, same-origin only, and a per-client rate limit. The optional match route
// (Spotify search, server/spotify.mjs) takes only length-limited title/artist/ISRC fields and builds the query itself.
// Dependency-free so it can run under Vite (dev/preview) and the production server alike.

import { createSpotifySearch } from './spotify.mjs'

export const TRACK_ID = /^[A-Za-z0-9]{22}$/ // "a track id is 22 base62 characters" (API error message)
const DEFAULT_BASE = 'https://api.spicylyrics.org'
const MAX_BODY_BYTES = 2 * 1024 * 1024
const UPSTREAM_TIMEOUT_MS = 8000
// The API terms allow caching "for your own application" but require refetching within 30 days and forbid
// mirrors/archives: in-memory only, short TTL, bounded.
const CACHE_TTL_MS = 6 * 60 * 60 * 1000
const CACHE_MAX = 500
const NEGATIVE_TTL_MS = 10 * 60 * 1000
const RATE_WINDOW_MS = 60 * 1000
// Spotify ids don't change, but catalogues do: remember answers for a day, "nothing found" for an hour.
const MATCH_TTL_MS = 24 * 60 * 60 * 1000
const MATCH_NEGATIVE_TTL_MS = 60 * 60 * 1000
const MATCH_FIELDS = { title: 200, artist: 200, isrc: 12 }

/**
 * @param {{
 *   secretKey?: string, apiBase?: string, allowedOrigins?: string[], ratePerMinute?: number,
 *   trustProxy?: boolean, fetchImpl?: typeof fetch, now?: () => number, log?: (msg: string) => void,
 *   spotify?: { enabled: boolean, search: (t: { title: string, artist: string, isrc?: string }) => Promise<{ status: number, body: string, retryAfter?: number }> }
 * }} options
 */
export function createSpicyHandler(options = {}) {
  const {
    secretKey = '',
    apiBase = DEFAULT_BASE,
    allowedOrigins = [],
    ratePerMinute = 30,
    trustProxy = false,
    fetchImpl = fetch,
    now = Date.now,
    log = (msg) => console.warn(`[spicy] ${msg}`),
    spotify,
  } = options

  /** @type {Map<string, { at: number, status: number, body: string }>} */
  const cache = new Map()
  /** @type {Map<string, Promise<{ status: number, body: string, retryAfter?: number }>>} */
  const inflight = new Map()
  /** @type {Map<string, number[]>} */
  const hits = new Map()
  let warnedMisconfigured = false

  const enabled = secretKey.length > 0
  // Matching is only useful when lyrics can be fetched with its result.
  const matching = enabled && spotify?.enabled === true

  function send(res, status, payload, extra = {}) {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': status === 200 ? 'private, max-age=300' : 'no-store',
      'x-content-type-options': 'nosniff',
      ...extra,
    })
    res.end(body)
  }

  function clientKey(req) {
    // Callers can put anything at the *start* of X-Forwarded-For; only the entry the nearest proxy appended (the last) is
    // trustworthy. Cloudflare overwrites CF-Connecting-IP itself, so it wins when present.
    const forwarded = trustProxy
      ? String(req.headers['cf-connecting-ip'] ?? '').trim() || String(req.headers['x-forwarded-for'] ?? '').split(',').pop()?.trim()
      : ''
    return forwarded || req.socket?.remoteAddress || 'unknown'
  }

  function limited(key) {
    const t = now()
    const recent = (hits.get(key) ?? []).filter((x) => t - x < RATE_WINDOW_MS)
    if (recent.length >= ratePerMinute) {
      hits.set(key, recent)
      return Math.ceil((RATE_WINDOW_MS - (t - recent[0])) / 1000)
    }
    recent.push(t)
    hits.set(key, recent)
    if (hits.size > 5000) for (const k of hits.keys()) { hits.delete(k); if (hits.size <= 2500) break }
    return 0
  }

  /** Browsers send Sec-Fetch-Site/Origin; refuse other sites. (curl and friends can still call: see docs.) */
  function crossSite(req) {
    const origin = req.headers.origin
    const site = req.headers['sec-fetch-site']
    const own = `${req.headers['x-forwarded-proto'] ?? (req.socket?.encrypted ? 'https' : 'http')}://${req.headers.host}`
    if (origin && origin !== own && !allowedOrigins.includes(origin)) return true
    if ((site === 'cross-site' || site === 'same-site') && !(origin && allowedOrigins.includes(origin))) return !origin || origin !== own
    return false
  }

  async function fetchUpstream(id) {
    let res
    try {
      res = await fetchImpl(`${apiBase.replace(/\/+$/, '')}/v1/lyrics/${id}`, {
        headers: { authorization: `Bearer ${secretKey}`, accept: 'application/json' },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        redirect: 'error', // never follow a redirect with the key attached
      })
    } catch (e) {
      const timeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')
      return { status: timeout ? 504 : 502, body: JSON.stringify({ error: timeout ? 'upstream_timeout' : 'upstream_unavailable' }) }
    }
    if (res.status === 404) return { status: 404, body: JSON.stringify({ error: 'not_found' }) }
    if (res.status === 429) {
      const reset = Number(res.headers.get('ratelimit-reset') ?? res.headers.get('retry-after'))
      return { status: 429, body: JSON.stringify({ error: 'rate_limited' }), retryAfter: Number.isFinite(reset) && reset > 0 ? reset : 30 }
    }
    if (res.status === 401 || res.status === 403) {
      if (!warnedMisconfigured) { warnedMisconfigured = true; log(`upstream rejected the configured key (HTTP ${res.status}); check SPICY_LYRICS_SECRET_KEY`) }
      return { status: 502, body: JSON.stringify({ error: 'misconfigured' }) }
    }
    if (!res.ok) return { status: 502, body: JSON.stringify({ error: 'upstream_unavailable' }) }

    if (Number(res.headers.get('content-length')) > MAX_BODY_BYTES) return { status: 502, body: JSON.stringify({ error: 'too_large' }) }
    const text = await res.text().catch(() => '')
    if (text.length > MAX_BODY_BYTES) return { status: 502, body: JSON.stringify({ error: 'too_large' }) }
    try {
      const body = JSON.parse(text)?.Body
      if (!body || typeof body !== 'object' || !Array.isArray(body.Content) || typeof body.Type !== 'string') throw new Error('shape')
      return { status: 200, body: JSON.stringify({ Body: body }) } // re-serialised: only the documented envelope is forwarded
    } catch {
      return { status: 502, body: JSON.stringify({ error: 'invalid_upstream_response' }) }
    }
  }

  /** Memory cache + in-flight dedup shared by both upstreams. Only definite answers are cached, never failures. */
  function cached(store, key, ttl, load) {
    const t = now()
    const hit = store.get(key)
    if (hit && t - hit.at < ttl(hit)) {
      store.delete(key)
      store.set(key, hit) // LRU touch
      return Promise.resolve(hit)
    }
    let pending = inflight.get(key)
    if (!pending) {
      pending = load().then((r) => {
        if (r.status === 200 || r.status === 404) {
          store.set(key, { at: now(), status: r.status, body: r.body })
          while (store.size > CACHE_MAX) store.delete(store.keys().next().value)
        }
        inflight.delete(key)
        return r
      })
      inflight.set(key, pending)
    }
    return pending
  }

  const lookup = (id) => cached(cache, id, (h) => (h.status === 200 ? CACHE_TTL_MS : NEGATIVE_TTL_MS), () => fetchUpstream(id))

  /** @type {Map<string, { at: number, status: number, body: string }>} */
  const matches = new Map()
  const match = (t) =>
    cached(matches, `match:${JSON.stringify(t)}`, (h) => (h.body.includes('"candidates":[]') ? MATCH_NEGATIVE_TTL_MS : MATCH_TTL_MS), () => spotify.search(t))

  /** Exactly the known fields, each a bounded string; anything else is refused. */
  function matchParams(url) {
    const t = {}
    for (const [k, v] of url.searchParams) {
      if (!Object.hasOwn(MATCH_FIELDS, k) || Object.hasOwn(t, k) || v.length > MATCH_FIELDS[k]) return null
      t[k] = v.trim()
    }
    return t.title ? { title: t.title, artist: t.artist ?? '', ...(t.isrc && { isrc: t.isrc.toUpperCase() }) } : null
  }

  /**
   * Handles /api/spicy/*. Returns true if the request was ours (and answered), false to let the caller continue.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://local')
    if (!url.pathname.startsWith('/api/spicy/')) return false

    // Desktop (Tauri) webviews run on their own origin, so an explicitly allowed origin must also be allowed to read the
    // response. Never `*`: the allow-list is the access control. Plain GETs only, so no preflight is involved.
    // `Vary: Origin` on every response, not only allowed ones: they are cacheable, and a copy cached for a same-origin
    // request (no CORS header) must not be reused for the desktop origin, or the webview rejects it.
    const origin = req.headers.origin
    const cors = typeof origin === 'string' && allowedOrigins.includes(origin) ? { 'access-control-allow-origin': origin } : {}
    const writeHead = res.writeHead.bind(res)
    res.writeHead = (status, headers = {}) => writeHead(status, { ...cors, vary: 'Origin', ...headers })

    if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed' }, { allow: 'GET' }), true
    if (crossSite(req)) return send(res, 403, { error: 'forbidden' }), true

    // 503 when the Spicy key is missing so uptime checks and the Docker healthcheck notice; the body stays readable by clients.
    if (url.pathname === '/api/spicy/health') return send(res, enabled ? 200 : 503, { enabled, matching }), true

    if (url.pathname === '/api/spicy/match') {
      if (!matching) return send(res, 503, { error: 'not_configured' }), true
      const t = matchParams(url)
      if (!t) return send(res, 400, { error: 'invalid_query' }), true
      const wait = limited(clientKey(req))
      if (wait) return send(res, 429, { error: 'rate_limited' }, { 'retry-after': String(wait) }), true
      const r = await match(t)
      send(res, r.status, r.body, r.retryAfter ? { 'retry-after': String(r.retryAfter) } : {})
      return true
    }

    const m = /^\/api\/spicy\/lyrics\/([^/]*)$/.exec(url.pathname)
    if (!m) return send(res, 404, { error: 'not_found' }), true
    if (!enabled) return send(res, 503, { error: 'not_configured' }), true
    let id
    try {
      id = decodeURIComponent(m[1])
    } catch {
      return send(res, 400, { error: 'invalid_track_id' }), true
    }
    if (!TRACK_ID.test(id)) return send(res, 400, { error: 'invalid_track_id' }), true
    if (url.search) return send(res, 400, { error: 'unexpected_query' }), true

    const wait = limited(clientKey(req))
    if (wait) return send(res, 429, { error: 'rate_limited' }, { 'retry-after': String(wait) }), true

    const r = await lookup(id)
    send(res, r.status, r.body, r.retryAfter ? { 'retry-after': String(r.retryAfter) } : {})
    return true
  }

  return Object.assign(handle, { enabled, matching })
}

/** Builds a handler from environment variables (never from the client). */
export function spicyHandlerFromEnv(env) {
  return createSpicyHandler({
    secretKey: (env.SPICY_LYRICS_SECRET_KEY ?? '').trim(),
    apiBase: env.SPICY_LYRICS_API_BASE || DEFAULT_BASE,
    allowedOrigins: (env.AURALIS_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    ratePerMinute: Number(env.SPICY_RATE_PER_MINUTE) > 0 ? Number(env.SPICY_RATE_PER_MINUTE) : 30,
    trustProxy: env.TRUST_PROXY === '1',
    spotify: createSpotifySearch({
      clientId: (env.SPOTIFY_CLIENT_ID ?? '').trim(),
      clientSecret: (env.SPOTIFY_CLIENT_SECRET ?? '').trim(),
      market: /^[A-Z]{2}$/.test(env.SPOTIFY_MARKET ?? '') ? env.SPOTIFY_MARKET : '',
      ...(env.SPOTIFY_API_BASE && { apiBase: env.SPOTIFY_API_BASE }),
      ...(env.SPOTIFY_TOKEN_URL && { tokenUrl: env.SPOTIFY_TOKEN_URL }),
      log: (msg) => console.warn(`[spotify] ${msg}`),
    }),
  })
}
