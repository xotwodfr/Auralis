import { HttpResponse, delay, http } from 'msw'
import { request } from '../../src/api/subsonic/client'
import { getLicense, getOpenSubsonicExtensions, ping } from '../../src/api/subsonic/endpoints'
import { SubsonicError } from '../../src/api/subsonic/errors'
import { BASE, PASSWORD, USER, failed, server } from '../server'

const creds = { baseUrl: BASE, username: USER, password: PASSWORD }
const kindOf = (p: Promise<unknown>) => p.then(() => 'resolved', (e: SubsonicError) => `${e.kind}:${e.code ?? ''}`)

describe('endpoints', () => {
  it('ping, getLicense and getOpenSubsonicExtensions parse ok responses', async () => {
    expect((await ping(creds)).serverVersion).toBe('0.55.0')
    expect((await getLicense(creds)).license.valid).toBe(true)
    expect((await getOpenSubsonicExtensions(BASE)).openSubsonicExtensions).toEqual([{ name: 'songLyrics', versions: [1] }])
  })
})

describe('error mapping', () => {
  it('maps documented codes and preserves unknown ones', async () => {
    const cases: [number, string][] = [
      [10, 'missing-param'],
      [40, 'auth'],
      [41, 'auth'],
      [50, 'not-authorized'],
      [60, 'trial-expired'],
      [70, 'not-found'],
      [99, 'unknown'],
    ]
    for (const [code, kind] of cases) {
      server.use(http.get(`${BASE}/rest/ping`, () => failed(code)))
      expect(await kindOf(ping(creds))).toBe(`${kind}:${code}`)
    }
  })

  it('reports wrong credentials from the server', async () => {
    expect(await kindOf(ping({ ...creds, password: 'nope' }))).toBe('auth:40')
  })

  it('maps HTTP errors, network errors and non-Subsonic bodies', async () => {
    server.use(http.get(`${BASE}/rest/ping`, () => new HttpResponse(null, { status: 502 })))
    expect(await kindOf(ping(creds))).toBe('http:')
    server.use(http.get(`${BASE}/rest/ping`, () => HttpResponse.error()))
    expect(await kindOf(ping(creds))).toBe('network:')
    server.use(http.get(`${BASE}/rest/ping`, () => HttpResponse.json({ hello: 'world' })))
    expect(await kindOf(ping(creds))).toBe('invalid-response:')
    server.use(http.get(`${BASE}/rest/ping`, () => new HttpResponse('<html>', { status: 200 })))
    expect(await kindOf(ping(creds))).toBe('invalid-response:')
  })

  it('never leaks the auth token in error messages', async () => {
    server.use(http.get(`${BASE}/rest/ping`, () => HttpResponse.error()))
    const err = await ping(creds).catch((e: SubsonicError) => e)
    expect(String((err as Error).message)).not.toMatch(/token|t=|s=|sesame/)
  })
})

describe('abort', () => {
  it('rejects with kind aborted when the signal fires mid-request', async () => {
    server.use(http.get(`${BASE}/rest/ping`, async () => (await delay('infinite'), HttpResponse.json({}))))
    const controller = new AbortController()
    const pending = kindOf(request(BASE, 'ping', { signal: controller.signal }))
    controller.abort()
    expect(await pending).toBe('aborted:')
  })

  it('rejects immediately when already aborted', async () => {
    expect(await kindOf(ping(creds, AbortSignal.abort()))).toBe('aborted:')
  })
})

describe('connection diagnostics', () => {
  it('logs the endpoint and cause of a network failure in dev without leaking credentials', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    server.use(http.get(`${BASE}/rest/ping`, () => HttpResponse.error()))
    await ping(creds).catch(() => {})
    const logged = debug.mock.calls.flat().join(' ')
    debug.mockRestore()
    expect(logged).toContain('ping')
    expect(logged).toContain('network error')
    expect(logged).not.toContain(PASSWORD)
    expect(logged).not.toMatch(/[?&](t|s|u)=/)
  })
})
