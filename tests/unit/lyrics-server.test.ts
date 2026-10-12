import { HttpResponse, http } from 'msw'
import { parseServerUrl } from '../../src/lib/backend'
import { ServerCheckError, probeLyricsServer } from '../../src/features/lyrics/useLyricsBackend'
import { server } from '../server'

describe('parseServerUrl', () => {
  it.each([
    ['https://lyrics.folk3s.com', 'https://lyrics.folk3s.com'],
    ['  https://lyrics.folk3s.com/// ', 'https://lyrics.folk3s.com'],
    ['http://192.168.1.5:8787/', 'http://192.168.1.5:8787'],
    ['https://example.com/lyrics/', 'https://example.com/lyrics'],
  ])('normalizes %s', (input, out) => expect(parseServerUrl(input)).toBe(out))

  it.each(['', 'lyrics.folk3s.com', 'ftp://x.com', 'file:///etc/passwd', 'javascript:alert(1)', 'tauri://localhost', 'https://u:p@x.com', 'https://x.com/?a=1', 'https://x.com/#f'])(
    'rejects %j',
    (input) => expect(parseServerUrl(input)).toBeNull(),
  )
})

describe('probeLyricsServer', () => {
  const BASE = 'https://lyrics.test'
  const probe = () => probeLyricsServer(BASE)

  it('reads capabilities, including from a 503 (key missing)', async () => {
    server.use(http.get(`${BASE}/api/spicy/health`, () => HttpResponse.json({ enabled: false, matching: false }, { status: 503 })))
    expect(await probe()).toEqual({ enabled: false, matching: false })
  })

  it('does not mistake an HTML 200 (asset handler / static host) for a server', async () => {
    server.use(http.get(`${BASE}/api/spicy/health`, () => new HttpResponse('<!doctype html>', { headers: { 'content-type': 'text/html' } })))
    await expect(probe()).rejects.toThrow(/not an Auralis lyrics server/)
  })

  it('rejects JSON of the wrong shape', async () => {
    server.use(http.get(`${BASE}/api/spicy/health`, () => HttpResponse.json({ ok: true })))
    await expect(probe()).rejects.toThrow(/not an Auralis lyrics server/)
  })

  it('reports HTTP errors and unreachable servers distinctly', async () => {
    server.use(http.get(`${BASE}/api/spicy/health`, () => new HttpResponse(null, { status: 403 })))
    await expect(probe()).rejects.toThrow('HTTP 403')
    server.use(http.get(`${BASE}/api/spicy/health`, () => HttpResponse.error()))
    await expect(probe()).rejects.toBeInstanceOf(ServerCheckError)
    await expect(probe()).rejects.toThrow(/Couldn't reach/)
  })
})
