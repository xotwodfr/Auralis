import { HttpResponse, delay, http } from 'msw'
import { lrclibProvider, resetLrclibBackoff } from '../../src/api/lyrics/providers/lrclib'
import { serverProvider } from '../../src/api/lyrics/providers/server'
import { lookupLyrics } from '../../src/api/lyrics/registry'
import { LyricsError, type LyricsTrack } from '../../src/api/lyrics/types'
import { BASE, PASSWORD, USER, authed, failed, server } from '../server'

const creds = { baseUrl: BASE, username: USER, password: PASSWORD }
const track: LyricsTrack = { id: 't1', title: 'Hello', artist: 'Adele', album: '25', duration: 295 }
const LRCLIB = 'https://lrclib.net/api'
const signal = () => new AbortController().signal
const record = (o: object = {}) => ({ id: 1, trackName: 'Hello', artistName: 'Adele', albumName: '25', duration: 295, instrumental: false, plainLyrics: 'plain', syncedLyrics: '[00:01.00]synced', ...o })
const kind = (p: Promise<unknown>) => p.then(() => 'resolved', (e: LyricsError) => e.kind)

beforeEach(() => resetLrclibBackoff())

describe('server provider', () => {
  const structured = (list: object[]) => http.get(`${BASE}/rest/getLyricsBySongId`, authed({ lyricsList: { structuredLyrics: list } }))

  it('prefers synced lyrics, converts ms to seconds and applies the offset', async () => {
    server.use(structured([
      { synced: false, line: [{ value: 'plain' }] },
      { synced: true, offset: 500, line: [{ start: 1000, value: 'one' }, { start: 4000, value: 'two' }] },
    ]))
    const l = await serverProvider(creds, true).fetch(track, signal())
    expect(l).toEqual({ synced: true, source: 'server', lines: [{ time: 0.5, text: 'one' }, { time: 3.5, text: 'two' }] })
  })

  it('treats lines without start times as plain text', async () => {
    server.use(structured([{ synced: true, line: [{ value: 'a' }, { value: 'b' }] }]))
    const l = await serverProvider(creds, true).fetch(track, signal())
    expect(l).toMatchObject({ synced: false, lines: [{ time: null, text: 'a' }, { time: null, text: 'b' }] })
  })

  it('returns null for empty lists, blank lyrics and not-found', async () => {
    server.use(structured([]))
    expect(await serverProvider(creds, true).fetch(track, signal())).toBeNull()
    server.use(structured([{ synced: false, line: [{ value: '  ' }] }]))
    expect(await serverProvider(creds, true).fetch(track, signal())).toBeNull()
    server.use(http.get(`${BASE}/rest/getLyricsBySongId`, () => failed(70)))
    expect(await serverProvider(creds, true).fetch(track, signal())).toBeNull()
  })

  it('uses legacy getLyrics (artist/title) without the extension', async () => {
    let params: URLSearchParams | undefined
    server.use(http.get(`${BASE}/rest/getLyrics`, (info) => {
      params = new URL(info.request.url).searchParams
      return authed({ lyrics: { value: 'line one\nline two' } })(info)
    }))
    const l = await serverProvider(creds, false).fetch(track, signal())
    expect(l).toMatchObject({ synced: false, source: 'server' })
    expect(l?.lines.map((x) => x.text)).toEqual(['line one', 'line two'])
    expect([params?.get('artist'), params?.get('title'), params?.has('p')]).toEqual(['Adele', 'Hello', false])
  })

  it('propagates other server errors', async () => {
    server.use(http.get(`${BASE}/rest/getLyricsBySongId`, () => failed(40)))
    await expect(serverProvider(creds, true).fetch(track, signal())).rejects.toMatchObject({ kind: 'auth' })
  })
})

describe('LRCLIB provider', () => {
  it('uses /get with title, artist, album and rounded duration, preferring synced lyrics', async () => {
    let q: URLSearchParams | undefined
    server.use(http.get(`${LRCLIB}/get`, ({ request }) => ((q = new URL(request.url).searchParams), HttpResponse.json(record()))))
    const l = await lrclibProvider.fetch(track, signal())
    expect(l).toMatchObject({ synced: true, source: 'lrclib', lines: [{ time: 1, text: 'synced' }] })
    expect(Object.fromEntries(q!)).toEqual({ track_name: 'Hello', artist_name: 'Adele', album_name: '25', duration: '295' })
  })

  it('falls back to plain lyrics', async () => {
    server.use(http.get(`${LRCLIB}/get`, () => HttpResponse.json(record({ syncedLyrics: null }))))
    expect(await lrclibProvider.fetch(track, signal())).toMatchObject({ synced: false, lines: [{ text: 'plain' }] })
  })

  it('on 404 searches, and only accepts a candidate that passes the match guards', async () => {
    server.use(
      http.get(`${LRCLIB}/get`, () => new HttpResponse(null, { status: 404 })),
      http.get(`${LRCLIB}/search`, () => HttpResponse.json([
        record({ id: 1, trackName: 'Hello (Live)', syncedLyrics: '[00:01.00]live' }),
        record({ id: 2, duration: 400, syncedLyrics: '[00:01.00]long' }),
        record({ id: 3, syncedLyrics: null, plainLyrics: 'the plain one' }),
        record({ id: 4, syncedLyrics: '[00:01.00]right one', duration: 296 }),
      ])),
    )
    expect(await lrclibProvider.fetch(track, signal())).toMatchObject({ synced: true, lines: [{ text: 'right one' }] })
  })

  it('also searches when /get returns a mismatching record', async () => {
    server.use(
      http.get(`${LRCLIB}/get`, () => HttpResponse.json(record({ duration: 500 }))),
      http.get(`${LRCLIB}/search`, () => HttpResponse.json([])),
    )
    expect(await lrclibProvider.fetch(track, signal())).toBeNull()
  })

  it('returns null when nothing matches at all', async () => {
    server.use(
      http.get(`${LRCLIB}/get`, () => new HttpResponse(null, { status: 404 })),
      http.get(`${LRCLIB}/search`, () => HttpResponse.json([record({ artistName: 'Nope' })])),
    )
    expect(await lrclibProvider.fetch(track, signal())).toBeNull()
  })

  it('reports instrumental tracks without searching further', async () => {
    let searched = false
    server.use(
      http.get(`${LRCLIB}/get`, () => HttpResponse.json(record({ instrumental: true, plainLyrics: null, syncedLyrics: null }))),
      http.get(`${LRCLIB}/search`, () => ((searched = true), HttpResponse.json([]))),
    )
    expect(await lrclibProvider.fetch(track, signal())).toMatchObject({ instrumental: true, lines: [] })
    expect(searched).toBe(false)
  })

  it('maps 429 to rate-limited and then backs off without another request', async () => {
    let calls = 0
    server.use(http.get(`${LRCLIB}/get`, () => (calls++, new HttpResponse(null, { status: 429, headers: { 'retry-after': '30' } }))))
    expect(await kind(lrclibProvider.fetch(track, signal()))).toBe('rate-limited')
    expect(await kind(lrclibProvider.fetch(track, signal()))).toBe('rate-limited')
    expect(calls).toBe(1)
  })

  it('maps 5xx and network failures', async () => {
    server.use(http.get(`${LRCLIB}/get`, () => new HttpResponse(null, { status: 503 })))
    expect(await kind(lrclibProvider.fetch(track, signal()))).toBe('unavailable')
    server.use(http.get(`${LRCLIB}/get`, () => HttpResponse.error()))
    expect(await kind(lrclibProvider.fetch(track, signal()))).toBe('network')
  })
})

describe('registry', () => {
  const hit = { synced: false, source: 'server' as const, lines: [{ time: null, text: 'x' }] }
  const provider = (id: 'server' | 'lrclib', fn: () => Promise<typeof hit | null>) => ({ id, fetch: fn })

  it('stops at the first provider with lyrics', async () => {
    const second = vi.fn(async () => null)
    const found = await lookupLyrics([provider('server', async () => hit), provider('lrclib', second)], track, signal())
    expect(found).toBe(hit)
    expect(second).not.toHaveBeenCalled()
  })

  it('falls through on null and on failure, returning null only if every provider said none', async () => {
    expect(await lookupLyrics([provider('server', async () => null), provider('lrclib', async () => null)], track, signal())).toBeNull()
    const failing = provider('server', async () => { throw new LyricsError('network', 'x') })
    expect(await lookupLyrics([failing, provider('lrclib', async () => hit)], track, signal())).toBe(hit)
  })

  it('throws the failure when nothing was found and a provider failed', async () => {
    const failing = provider('lrclib', async () => { throw new LyricsError('unavailable', 'x') })
    await expect(lookupLyrics([provider('server', async () => null), failing], track, signal())).rejects.toMatchObject({ kind: 'unavailable' })
  })

  it('times out a slow provider and moves on', async () => {
    server.use(http.get(`${BASE}/rest/getLyricsBySongId`, async () => (await delay('infinite'), HttpResponse.json({}))))
    const slow = serverProvider(creds, true)
    await expect(lookupLyrics([slow], track, signal(), 50)).rejects.toMatchObject({ kind: 'timeout' })
    expect(await lookupLyrics([slow, provider('lrclib', async () => hit)], track, signal(), 50)).toBe(hit)
  })

  it('aborts in-flight work when the caller aborts', async () => {
    server.use(http.get(`${BASE}/rest/getLyricsBySongId`, async () => (await delay('infinite'), HttpResponse.json({}))))
    const ctl = new AbortController()
    const pending = kind(lookupLyrics([serverProvider(creds, true)], track, ctl.signal))
    setTimeout(() => ctl.abort(), 20)
    expect(await pending).toBe('aborted')
    expect(await kind(lookupLyrics([provider('server', async () => hit)], track, ctl.signal))).toBe('aborted')
  })
})
