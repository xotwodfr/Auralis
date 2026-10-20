// @vitest-environment node
import { HttpResponse, http } from 'msw'
import { createSpicyHandler, spicyHandlerFromEnv } from '../spicy.mjs'
import { createSpotifySearch } from '../spotify.mjs'
import { server } from './msw'

const CLIENT_ID = 'test-client-id'
const CLIENT_SECRET = 'test-client-secret-not-real'
const TOKEN = 'https://accounts.spotify.com/api/token'
const SEARCH = 'https://api.spotify.com/v1/search'
const ID = '4cOdK2wGLETKBW3PvgPWqT'

const item = (over: object = {}) => ({
  id: ID,
  name: 'Song A',
  artists: [{ name: 'Artist A', id: 'x' }],
  album: { name: 'Album 0', album_type: 'album', images: [{ url: 'https://i.scdn.co/x' }] },
  duration_ms: 200_000,
  explicit: false,
  external_ids: { isrc: 'usabc1234567' },
  popularity: 50,
  ...over,
})

let tokenCalls: { auth: string | null; body: string }[]
let searches: { q: string; auth: string | null; url: URL }[]
let searchReply: (q: string) => Response

function upstream() {
  server.use(
    http.post(TOKEN, async ({ request }) => {
      tokenCalls.push({ auth: request.headers.get('authorization'), body: await request.text() })
      return HttpResponse.json({ access_token: `tok${tokenCalls.length}`, token_type: 'Bearer', expires_in: 3600 })
    }),
    http.get(SEARCH, ({ request }) => {
      const url = new URL(request.url)
      const q = url.searchParams.get('q') ?? ''
      searches.push({ q, auth: request.headers.get('authorization'), url })
      return searchReply(q)
    }),
  )
}

beforeEach(() => {
  tokenCalls = []
  searches = []
  searchReply = () => HttpResponse.json({ tracks: { items: [item()] } })
  upstream()
})

const spotify = (o: Parameters<typeof createSpotifySearch>[0] = {}) => createSpotifySearch({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, ...o })

describe('Spotify search (server/spotify.mjs)', () => {
  it('gets a client-credentials token once, then searches with it and returns only matching fields', async () => {
    const s = spotify()
    const r = await s.search({ title: 'Song A', artist: 'Artist A' })
    expect(r.status).toBe(200)
    expect(JSON.parse(r.body)).toEqual({
      candidates: [{ id: ID, name: 'Song A', artists: ['Artist A'], album: 'Album 0', albumType: 'album', durationMs: 200_000, explicit: false, isrc: 'USABC1234567' }],
    })
    expect(tokenCalls).toEqual([{ auth: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`, body: 'grant_type=client_credentials' }])
    expect(searches[0]!.auth).toBe('Bearer tok1')
    expect(searches[0]!.url.searchParams.get('type')).toBe('track')
    expect(searches[0]!.url.searchParams.get('limit')).toBe('10')
    await s.search({ title: 'Other', artist: 'Artist A' })
    expect(tokenCalls).toHaveLength(1) // token reused until it expires
  })

  it('refreshes the token when it expires', async () => {
    let t = 0
    const s = spotify({ now: () => t })
    await s.search({ title: 'Song A', artist: 'Artist A' })
    t += 3600_000
    await s.search({ title: 'Song A', artist: 'Artist A' })
    expect(tokenCalls).toHaveLength(2)
  })

  it('searches by ISRC first and stops there when it finds the recording', async () => {
    await spotify().search({ title: 'Song A', artist: 'Artist A', isrc: 'USABC1234567' })
    expect(searches.map((x) => x.q)).toEqual(['isrc:USABC1234567'])
  })

  it('falls back from ISRC to fielded, then free-text queries, and ignores a malformed ISRC', async () => {
    searchReply = () => HttpResponse.json({ tracks: { items: [] } })
    await spotify().search({ title: 'Song A', artist: 'Artist A', isrc: 'USABC1234567' })
    expect(searches.map((x) => x.q)).toEqual(['isrc:USABC1234567', 'track:Song A artist:Artist A', 'Song A Artist A'])
    searches = []
    await spotify().search({ title: 'Song A', artist: 'Artist A', isrc: 'bad"isrc' })
    expect(searches[0]!.q).toBe('track:Song A artist:Artist A')
  })

  it('strips query syntax from user text so it cannot add filters', async () => {
    await spotify().search({ title: 'Hey" year:1999 "', artist: 'A:B' })
    expect(searches[0]!.q).toBe('track:Hey year 1999 artist:A B')
  })

  it('drops malformed items and ids that are not Spotify track ids', async () => {
    searchReply = () => HttpResponse.json({ tracks: { items: [null, { id: '../x', name: 'n' }, item({ id: 'short' }), item()] } })
    const r = await spotify().search({ title: 'Song A', artist: 'Artist A' })
    expect(JSON.parse(r.body).candidates.map((c: { id: string }) => c.id)).toEqual([ID])
  })

  it('maps 429 to a retry-after and stops calling Spotify until it has passed', async () => {
    let t = 0
    searchReply = () => new HttpResponse(null, { status: 429, headers: { 'retry-after': '20' } })
    const s = spotify({ now: () => t })
    expect(await s.search({ title: 'Song A', artist: 'Artist A' })).toMatchObject({ status: 429, retryAfter: 20 })
    const calls = searches.length
    t += 10_000
    expect(await s.search({ title: 'Song A', artist: 'Artist A' })).toMatchObject({ status: 429, retryAfter: 10 })
    expect(searches.length).toBe(calls)
  })

  it('maps a rejected token, Premium-required 403 and outages to 502, and warns once without secrets', async () => {
    const log = vi.fn()
    server.use(http.post(TOKEN, () => new HttpResponse(null, { status: 400 })))
    const s = spotify({ log })
    expect((await s.search({ title: 'a', artist: 'b' })).status).toBe(502)
    expect((await s.search({ title: 'a', artist: 'b' })).status).toBe(502)
    expect(log).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(log.mock.calls)).not.toContain(CLIENT_SECRET)

    upstream()
    searchReply = () => new HttpResponse(null, { status: 403 })
    const log2 = vi.fn()
    expect((await spotify({ log: log2 }).search({ title: 'a', artist: 'b' })).status).toBe(502)
    expect(log2.mock.calls[0]![0]).toMatch(/Premium/)

    searchReply = () => HttpResponse.error()
    expect((await spotify().search({ title: 'a', artist: 'b' })).status).toBe(502)
  })

  it('retries once with a new token after a 401', async () => {
    let first = true
    searchReply = () => (first ? ((first = false), new HttpResponse(null, { status: 401 })) : HttpResponse.json({ tracks: { items: [item()] } }))
    expect((await spotify().search({ title: 'a', artist: 'b' })).status).toBe(200)
    expect(tokenCalls).toHaveLength(2)
  })
})

async function call(handler: ReturnType<typeof createSpicyHandler>, path: string, headers: Record<string, string> = {}) {
  let status = 0
  let sent: Record<string, string> = {}
  let raw = ''
  const req = { method: 'GET', url: path, headers: { host: 'app.test', ...headers }, socket: { remoteAddress: '203.0.113.9' } }
  const res = { writeHead: (s: number, h: Record<string, string>) => ((status = s), (sent = h)), end: (b?: string) => (raw = b ?? '') }
  await handler(req as never, res as never)
  return { status, headers: sent, json: raw ? JSON.parse(raw) : undefined, raw }
}

const handler = (o: Parameters<typeof createSpicyHandler>[0] = {}) =>
  createSpicyHandler({ secretKey: 'sl_sk_test', log: () => undefined, spotify: spotify(), ...o })

describe('/api/spicy/match', () => {
  it('health reports matching only when both keys are configured', async () => {
    expect((await call(handler(), '/api/spicy/health')).json).toEqual({ enabled: true, matching: true })
    expect((await call(handler({ secretKey: '' }), '/api/spicy/health')).json).toEqual({ enabled: false, matching: false })
    expect((await call(handler({ spotify: createSpotifySearch({}) }), '/api/spicy/health')).json).toEqual({ enabled: true, matching: false })
    expect(spicyHandlerFromEnv({ SPICY_LYRICS_SECRET_KEY: 'k', SPOTIFY_CLIENT_ID: 'i', SPOTIFY_CLIENT_SECRET: 's' }).matching).toBe(true)
    expect(spicyHandlerFromEnv({ SPICY_LYRICS_SECRET_KEY: 'k', SPOTIFY_CLIENT_ID: 'i' }).matching).toBe(false)
  })

  it('returns candidates and never the client secret or token', async () => {
    const r = await call(handler(), '/api/spicy/match?title=Song%20A&artist=Artist%20A&isrc=usabc1234567')
    expect(r.status).toBe(200)
    expect(r.json.candidates[0].id).toBe(ID)
    expect(r.raw).not.toContain(CLIENT_SECRET)
    expect(r.raw).not.toContain('tok1')
    expect(searches[0]!.q).toBe('isrc:USABC1234567')
  })

  it.each([
    ['no title', '/api/spicy/match?artist=x'],
    ['unknown field', '/api/spicy/match?title=x&q=anything'],
    ['inherited name', '/api/spicy/match?title=x&constructor=y'],
    ['repeated field', '/api/spicy/match?title=x&title=y'],
    ['oversized field', `/api/spicy/match?title=${'x'.repeat(201)}`],
  ])('refuses %s without calling Spotify', async (_, path) => {
    expect((await call(handler(), path)).status).toBe(400)
    expect(searches).toEqual([])
  })

  it('is 503 when not configured, and refuses other sites', async () => {
    expect((await call(handler({ spotify: createSpotifySearch({}) }), '/api/spicy/match?title=x')).status).toBe(503)
    expect((await call(handler(), '/api/spicy/match?title=x', { origin: 'https://evil.test' })).status).toBe(403)
    expect(searches).toEqual([])
  })

  it('caches answers and coalesces concurrent identical lookups', async () => {
    const h = handler()
    await Promise.all([call(h, '/api/spicy/match?title=Song%20A&artist=Artist%20A'), call(h, '/api/spicy/match?title=Song%20A&artist=Artist%20A')])
    await call(h, '/api/spicy/match?title=Song%20A&artist=Artist%20A')
    expect(searches).toHaveLength(1)
  })

  it('passes Spotify rate limits through with retry-after', async () => {
    const h = handler()
    searchReply = () => new HttpResponse(null, { status: 429, headers: { 'retry-after': '7' } })
    const r = await call(h, '/api/spicy/match?title=x&artist=y')
    expect(r.status).toBe(429)
    expect(r.headers['retry-after']).toBe('7')
  })

  it('shares the per-client rate limit', async () => {
    const h = handler({ ratePerMinute: 2 })
    expect((await call(h, '/api/spicy/match?title=a')).status).toBe(200)
    expect((await call(h, '/api/spicy/match?title=b')).status).toBe(200)
    expect((await call(h, '/api/spicy/match?title=c')).status).toBe(429)
  })
})

describe('configurable upstream', () => {
  it('keeps a path prefix on the API base', async () => {
    const seen: string[] = []
    server.use(http.get('https://proxy.test/spotify/v1/search', ({ request }) => (seen.push(new URL(request.url).pathname), HttpResponse.json({ tracks: { items: [] } }))))
    await spotify({ apiBase: 'https://proxy.test/spotify/' }).search({ title: 'a', artist: 'b' })
    expect(seen[0]).toBe('/spotify/v1/search')
  })
})
