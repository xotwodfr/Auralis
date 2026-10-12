// @vitest-environment node
import { HttpResponse, http } from 'msw'
import { createSpicyHandler, spicyHandlerFromEnv, type SpicyOptions } from '../../server/spicy.mjs'
import { server } from '../server'

const KEY = 'sl_sk_test_not_a_real_key'
const ID = '4cOdK2wGLETKBW3PvgPWqT'
const UPSTREAM = 'https://api.spicylyrics.org/v1/lyrics/:id'
const body = { Body: { Type: 'Syllable', Content: [{ Type: 'Vocal', Lead: { Syllables: [], StartTime: 1, EndTime: 2 } }], source: 'apple_music', id: ID } }

interface Reply { status: number; headers: Record<string, string>; json: unknown; raw: string }

async function call(handler: ReturnType<typeof createSpicyHandler>, path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Reply & { handled: boolean }> {
  let status = 0
  let sent: Record<string, string> = {}
  let raw = ''
  const req = { method, url: path, headers: { host: 'app.test', ...headers }, socket: { remoteAddress: '203.0.113.9' } }
  const res = { writeHead: (s: number, h: Record<string, string>) => ((status = s), (sent = h)), end: (b?: string) => (raw = b ?? '') }
  const handled = await handler(req as never, res as never)
  let json: unknown
  try { json = JSON.parse(raw) } catch { json = undefined }
  return { handled, status, headers: sent, json, raw }
}

let upstreamCalls: { auth: string | null; headers: Headers }[]
const upstreamOk = () => server.use(http.get(UPSTREAM, ({ request }) => (upstreamCalls.push({ auth: request.headers.get('authorization'), headers: request.headers }), HttpResponse.json(body))))
const make = (o: SpicyOptions = {}) => createSpicyHandler({ secretKey: KEY, log: () => undefined, ...o })

beforeEach(() => {
  upstreamCalls = []
})

describe('routing and validation', () => {
  it('ignores paths that are not ours', async () => {
    expect((await call(make(), '/library/artists')).handled).toBe(false)
  })

  it('health reports whether a key is configured, without revealing it', async () => {
    const on = await call(make(), '/api/spicy/health')
    expect(on.json).toEqual({ enabled: true, matching: false })
    expect(on.raw).not.toContain(KEY)
    expect((await call(make({ secretKey: '' }), '/api/spicy/health')).json).toEqual({ enabled: false, matching: false })
  })

  it('health is 200 when ready and 503 (still JSON) when the key is missing', async () => {
    expect((await call(make(), '/api/spicy/health')).status).toBe(200)
    expect((await call(make({ secretKey: '' }), '/api/spicy/health')).status).toBe(503)
  })

  it.each(['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost'])('allows the Auralis desktop origin %s only when listed', async (origin) => {
    const h = { origin, 'sec-fetch-site': 'cross-site' }
    const listed = await call(make({ allowedOrigins: [origin] }), '/api/spicy/health', h)
    expect(listed.status).toBe(200)
    expect(listed.headers['access-control-allow-origin']).toBe(origin)
    expect(listed.headers.vary).toBe('Origin')
    expect((await call(make(), '/api/spicy/health', h)).status).toBe(403)
  })

  it.each([
    ['too short', '/api/spicy/lyrics/abc'],
    ['too long', `/api/spicy/lyrics/${ID}x`],
    ['non-base62', '/api/spicy/lyrics/4cOdK2wGLETKBW3PvgPW-_'],
    ['traversal', '/api/spicy/lyrics/..%2F..%2Fv1%2Fkeys'],
    ['empty', '/api/spicy/lyrics/'],
  ])('rejects a %s track id without calling upstream', async (_, path) => {
    upstreamOk()
    expect((await call(make(), path)).status).toBe(400)
    expect(upstreamCalls).toEqual([])
  })

  it('does not forward query strings, other routes or other methods', async () => {
    upstreamOk()
    const h = make()
    expect((await call(h, `/api/spicy/lyrics/${ID}?x=1`)).status).toBe(400)
    expect((await call(h, '/api/spicy/keys')).status).toBe(404)
    expect((await call(h, `/api/spicy/lyrics/${ID}/extra`)).status).toBe(404)
    for (const method of ['POST', 'PUT', 'DELETE']) expect((await call(h, `/api/spicy/lyrics/${ID}`, {}, method)).status).toBe(405)
    expect(upstreamCalls).toEqual([])
  })

  it('answers 503 and never calls upstream when no key is configured', async () => {
    upstreamOk()
    expect((await call(make({ secretKey: '' }), `/api/spicy/lyrics/${ID}`)).status).toBe(503)
    expect(upstreamCalls).toEqual([])
  })

  it('reads its configuration from environment variables only', () => {
    expect(spicyHandlerFromEnv({}).enabled).toBe(false)
    expect(spicyHandlerFromEnv({ SPICY_LYRICS_SECRET_KEY: '  ' }).enabled).toBe(false)
    expect(spicyHandlerFromEnv({ SPICY_LYRICS_SECRET_KEY: KEY }).enabled).toBe(true)
  })
})

describe('upstream call', () => {
  it('sends only a Bearer key, forwards the documented envelope, and sends nothing from the client', async () => {
    upstreamOk()
    const r = await call(make(), `/api/spicy/lyrics/${ID}`, { cookie: 'session=abc', authorization: 'Bearer client-supplied', 'x-forwarded-for': '1.2.3.4' })
    expect(r.status).toBe(200)
    expect(r.json).toEqual(body)
    expect(upstreamCalls).toHaveLength(1)
    expect(upstreamCalls[0]!.auth).toBe(`Bearer ${KEY}`)
    expect(upstreamCalls[0]!.headers.get('cookie')).toBeNull()
    expect(upstreamCalls[0]!.headers.get('x-forwarded-for')).toBeNull()
    expect(r.raw).not.toContain(KEY)
    expect(JSON.stringify(r.headers)).not.toContain(KEY)
  })

  it('caches successes in memory and coalesces concurrent requests', async () => {
    upstreamOk()
    const h = make()
    const [a, b] = await Promise.all([call(h, `/api/spicy/lyrics/${ID}`), call(h, `/api/spicy/lyrics/${ID}`)])
    expect([a.status, b.status]).toEqual([200, 200])
    await call(h, `/api/spicy/lyrics/${ID}`)
    expect(upstreamCalls).toHaveLength(1)
  })

  it('refetches after the cache lifetime (terms: nothing stored beyond 30 days; we keep hours)', async () => {
    upstreamOk()
    let t = 1_000_000
    const h = make({ now: () => t, ratePerMinute: 1000 })
    await call(h, `/api/spicy/lyrics/${ID}`)
    t += 5 * 60 * 60 * 1000
    await call(h, `/api/spicy/lyrics/${ID}`)
    expect(upstreamCalls).toHaveLength(1)
    t += 2 * 60 * 60 * 1000
    await call(h, `/api/spicy/lyrics/${ID}`)
    expect(upstreamCalls).toHaveLength(2)
  })

  it('bounds the cache', async () => {
    let calls = 0
    server.use(http.get(UPSTREAM, () => (calls++, HttpResponse.json(body))))
    const h = make({ ratePerMinute: 1_000_000 })
    const idOf = (i: number) => String(i).padStart(22, 'a')
    for (let i = 0; i < 520; i++) await call(h, `/api/spicy/lyrics/${idOf(i)}`)
    expect(calls).toBe(520)
    await call(h, `/api/spicy/lyrics/${idOf(0)}`) // evicted: fetched again
    expect(calls).toBe(521)
    await call(h, `/api/spicy/lyrics/${idOf(519)}`) // recent: still cached
    expect(calls).toBe(521)
  })

  it('maps upstream outcomes to safe client errors', async () => {
    const logs: string[] = []
    const h = make({ log: (m) => logs.push(m), ratePerMinute: 1000 })
    const cases: [string, () => Response, number, string][] = [
      ['404', () => new HttpResponse(JSON.stringify({ Body: { error: 'lyrics_not_found' } }), { status: 404 }), 404, 'not_found'],
      ['429', () => new HttpResponse(null, { status: 429, headers: { 'ratelimit-reset': '17' } }), 429, 'rate_limited'],
      ['401 (bad key)', () => new HttpResponse(null, { status: 401 }), 502, 'misconfigured'],
      ['500', () => new HttpResponse(null, { status: 500 }), 502, 'upstream_unavailable'],
      ['not JSON', () => new HttpResponse('<html>', { status: 200 }), 502, 'invalid_upstream_response'],
      ['wrong shape', () => HttpResponse.json({ Body: { Type: 'Syllable' } }), 502, 'invalid_upstream_response'],
    ]
    let n = 0
    for (const [name, make_, status, error] of cases) {
      server.use(http.get(UPSTREAM, () => make_()))
      const r = await call(h, `/api/spicy/lyrics/${String(++n).padStart(22, 'b')}`)
      expect([name, r.status, (r.json as { error: string }).error]).toEqual([name, status, error])
      if (status === 429) expect(r.headers['retry-after']).toBe('17')
    }
    expect(logs).toHaveLength(1) // the misconfiguration is reported once…
    expect(logs.join()).not.toContain(KEY) // …and never with the key
  })

  it('maps timeouts and network failures', async () => {
    const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' })
    expect((await call(make({ fetchImpl: () => Promise.reject(timeout) }), `/api/spicy/lyrics/${ID}`)).status).toBe(504)
    server.use(http.get(UPSTREAM, () => HttpResponse.error()))
    expect((await call(make(), `/api/spicy/lyrics/${'c'.repeat(22)}`)).status).toBe(502)
  })

  it('passes a timeout signal and refuses redirects, so the key cannot be sent elsewhere', async () => {
    let init: RequestInit | undefined
    await call(make({ fetchImpl: (async (_: unknown, i: RequestInit) => ((init = i), new Response(JSON.stringify(body)))) as never }), `/api/spicy/lyrics/${ID}`)
    expect(init?.redirect).toBe('error')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('caches "no lyrics" briefly so a missing track is not re-asked on every skip', async () => {
    let calls = 0
    server.use(http.get(UPSTREAM, () => (calls++, new HttpResponse(null, { status: 404 }))))
    const h = make()
    await call(h, `/api/spicy/lyrics/${ID}`)
    await call(h, `/api/spicy/lyrics/${ID}`)
    expect(calls).toBe(1)
  })
})

describe('abuse limits', () => {
  it('refuses other sites (browser fetches from another origin)', async () => {
    upstreamOk()
    const h = make()
    expect((await call(h, `/api/spicy/lyrics/${ID}`, { origin: 'https://evil.test' })).status).toBe(403)
    expect((await call(h, `/api/spicy/lyrics/${ID}`, { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await call(h, `/api/spicy/lyrics/${ID}`, { origin: 'http://app.test', 'sec-fetch-site': 'same-origin' })).status).toBe(200)
    expect((await call(h, `/api/spicy/lyrics/${ID}`, { 'sec-fetch-site': 'same-origin' })).status).toBe(200)
    expect(upstreamCalls.length).toBeLessThanOrEqual(1)
  })

  it('allows explicitly configured origins', async () => {
    upstreamOk()
    const h = make({ allowedOrigins: ['https://music.example.com'] })
    expect((await call(h, `/api/spicy/lyrics/${ID}`, { origin: 'https://music.example.com', 'sec-fetch-site': 'cross-site' })).status).toBe(200)
  })

  it('sends CORS headers only to configured origins', async () => {
    upstreamOk()
    const h = make({ allowedOrigins: ['http://tauri.localhost'] })
    const ok = await call(h, `/api/spicy/lyrics/${ID}`, { origin: 'http://tauri.localhost', 'sec-fetch-site': 'cross-site' })
    expect(ok.headers['access-control-allow-origin']).toBe('http://tauri.localhost')
    const denied = await call(h, `/api/spicy/lyrics/${ID}`, { origin: 'https://evil.test' })
    expect(denied.status).toBe(403)
    expect(denied.headers['access-control-allow-origin']).toBeUndefined()
    expect((await call(h, `/api/spicy/lyrics/${ID}`)).headers['access-control-allow-origin']).toBeUndefined()
  })

  it('varies every response on Origin, so a same-origin copy is never reused for the desktop origin', async () => {
    upstreamOk()
    const h = make({ allowedOrigins: ['tauri://localhost'] })
    // Regression: the same-origin response was cacheable without `Vary: Origin`; WebKit then served it to the
    // tauri:// page, which rejected it for lacking Access-Control-Allow-Origin.
    for (const path of ['/api/spicy/health', `/api/spicy/lyrics/${ID}`]) {
      const plain = await call(h, path)
      expect(plain.headers['access-control-allow-origin']).toBeUndefined()
      expect(plain.headers.vary).toBe('Origin')
      expect((await call(h, path, { origin: 'tauri://localhost', 'sec-fetch-site': 'cross-site' })).headers.vary).toBe('Origin')
    }
  })

  it('rate-limits each client and recovers', async () => {
    upstreamOk()
    let t = 0
    const h = make({ ratePerMinute: 3, now: () => t })
    const statuses: number[] = []
    for (let i = 0; i < 5; i++) statuses.push((await call(h, `/api/spicy/lyrics/${ID}`)).status)
    expect(statuses).toEqual([200, 200, 200, 429, 429])
    expect((await call(h, `/api/spicy/lyrics/${ID}`)).headers['retry-after']).toBeDefined()
    t += 61_000
    expect((await call(h, `/api/spicy/lyrics/${ID}`)).status).toBe(200)
  })

  it('ignores X-Forwarded-For unless the proxy is trusted', async () => {
    upstreamOk()
    const h = make({ ratePerMinute: 1 })
    expect((await call(h, `/api/spicy/lyrics/${ID}`, { 'x-forwarded-for': '10.0.0.1' })).status).toBe(200)
    expect((await call(h, `/api/spicy/lyrics/${ID}`, { 'x-forwarded-for': '10.0.0.2' })).status).toBe(429)
    const trusting = make({ ratePerMinute: 1, trustProxy: true })
    expect((await call(trusting, `/api/spicy/lyrics/${ID}`, { 'x-forwarded-for': '10.0.0.1' })).status).toBe(200)
    expect((await call(trusting, `/api/spicy/lyrics/${ID}`, { 'x-forwarded-for': '10.0.0.2' })).status).toBe(200)
  })

  it('cannot dodge the limit by spoofing the start of X-Forwarded-For', async () => {
    upstreamOk()
    const h = make({ ratePerMinute: 1, trustProxy: true })
    // The proxy appends the real client (9.9.9.9); the caller invented the first entry each time.
    expect((await call(h, `/api/spicy/lyrics/${ID}`, { 'x-forwarded-for': '1.1.1.1, 9.9.9.9' })).status).toBe(200)
    expect((await call(h, `/api/spicy/lyrics/${ID}`, { 'x-forwarded-for': '2.2.2.2, 9.9.9.9' })).status).toBe(429)
  })

  it('prefers CF-Connecting-IP over X-Forwarded-For when the proxy is trusted', async () => {
    upstreamOk()
    const h = make({ ratePerMinute: 1, trustProxy: true })
    expect((await call(h, `/api/spicy/lyrics/${ID}`, { 'cf-connecting-ip': '9.9.9.9', 'x-forwarded-for': '1.1.1.1' })).status).toBe(200)
    expect((await call(h, `/api/spicy/lyrics/${ID}`, { 'cf-connecting-ip': '9.9.9.9', 'x-forwarded-for': '2.2.2.2' })).status).toBe(429)
    expect((await call(h, `/api/spicy/lyrics/${ID}`, { 'cf-connecting-ip': '8.8.8.8' })).status).toBe(200)
  })
})
