import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, delay, http } from 'msw'
import { MemoryRouter } from 'react-router'
import { clearLyricsCache } from '../../src/api/lyrics/cache'
import { resetLrclibBackoff } from '../../src/api/lyrics/providers/lrclib'
import { spicyProvider } from '../../src/api/lyrics/providers/spicy'
import { lookupLyrics } from '../../src/api/lyrics/registry'
import { LyricsError, type LyricsTrack } from '../../src/api/lyrics/types'
import type { Song } from '../../src/api/subsonic/types'
import App from '../../src/App'
import { useAuth } from '../../src/state/auth'
import { audioElement, usePlayback } from '../../src/state/playback'
import { useSettings } from '../../src/state/settings'
import { linkKey, useSpotifyLinks } from '../../src/state/spotifyLinks'
import type { FakeAudio } from '../fakeAudio'
import { BASE, PASSWORD, USER, authed, server } from '../server'

const audio = audioElement as unknown as FakeAudio
const APP = 'http://app.test'
const ID = '4cOdK2wGLETKBW3PvgPWqT'
const ID2 = '1QV6tiMFM6fSOKOGLMHYYg'
const LRCLIB = 'https://lrclib.net/api'
const track: LyricsTrack = { id: 'a', title: 'Song A', artist: 'Artist A', album: 'Album 0', duration: 200 }
const A: Song = { ...track, duration: 200 }
const B: Song = { ...A, id: 'b', title: 'Song B' }

// jsdom's fetch (Node's) needs absolute URLs; the app calls its own origin with relative ones.
let realFetch: typeof fetch
beforeAll(() => {
  realFetch = globalThis.fetch // captured after MSW has patched it (tests/setup.ts)
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => realFetch(typeof input === 'string' && input.startsWith('/') ? APP + input : input, init)) as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
})

const syl = (Text: string, StartTime: number, EndTime: number) => ({ Text, IsPartOfWord: false, StartTime, EndTime })
const spicyBody = (over: object = {}) => ({
  Body: {
    Type: 'Syllable',
    source: 'spicy_lyrics',
    UploadAttribution: { Uploader: { username: 'Una', url: 'https://spicylyrics.org/uid/1' }, Maker: { username: 'Mo', url: 'https://spicylyrics.org/uid/2' } },
    Content: [
      { Type: 'Vocal', Lead: { Syllables: [syl('Hello', 2, 2.5), syl('there', 2.5, 3), syl('friend', 3, 4)], StartTime: 2, EndTime: 4 } },
      { Type: 'Vocal', Lead: { Syllables: [syl('Second', 6, 6.5), syl('line', 6.5, 7)], StartTime: 6, EndTime: 7 } },
    ],
    ...over,
  },
})
const route = (handler: Parameters<typeof http.get>[1]) => http.get(`${APP}/api/spicy/lyrics/:id`, handler)
// A backend with the Spicy Lyrics key but no Spotify credentials: manual links only (automatic matching: spotify-auto.test.tsx).
const health = (matching = false) => http.get(`${APP}/api/spicy/health`, () => HttpResponse.json({ enabled: true, matching }))
const serverEmpty = http.get(`${BASE}/rest/getLyricsBySongId`, authed({ lyricsList: { structuredLyrics: [] } }))
const noLrclib = [http.get(`${LRCLIB}/get`, () => new HttpResponse(null, { status: 404 })), http.get(`${LRCLIB}/search`, () => HttpResponse.json([]))]
const signal = () => new AbortController().signal

beforeEach(async () => {
  useAuth.setState({
    hydrated: true,
    session: { credentials: { baseUrl: BASE, username: USER, password: PASSWORD }, server: { apiVersion: '1.16.1' }, capabilities: { openSubsonic: true, extensions: [], songLyrics: true }, remember: false },
  })
  useSettings.setState({ hydrated: true, externalLookups: true })
  useSpotifyLinks.setState({ links: {} })
  usePlayback.getState().reset()
  server.use(health())
  audio.loads.length = 0
  resetLrclibBackoff()
  await clearLyricsCache()
})

const linkFor = (id: string, spotify = ID) => useSpotifyLinks.setState((s) => ({ links: { ...s.links, [linkKey({ baseUrl: BASE, username: USER }, id)]: spotify } }))

describe('spicy provider (calls our backend only)', () => {
  const kind = (p: Promise<unknown>) => p.then(() => 'resolved', (e: LyricsError) => e.kind)

  it('requests the same-origin endpoint with the id and no credentials of any kind', async () => {
    let seen: Request | undefined
    server.use(route(({ request }) => ((seen = request), HttpResponse.json(spicyBody()))))
    const l = await spicyProvider(ID).fetch(track, signal())
    expect(l?.source).toBe('spicy')
    expect(new URL(seen!.url).pathname).toBe(`/api/spicy/lyrics/${ID}`)
    expect(seen!.headers.get('authorization')).toBeNull()
    expect(seen!.url).not.toMatch(/key|secret|token/i)
  })

  it.each([
    ['404 (no lyrics for this id)', 404],
    ['400', 400],
    ['503 (backend has no key)', 503],
  ])('treats %s as "none" so the next provider runs', async (_, status) => {
    server.use(route(() => new HttpResponse(JSON.stringify({ error: 'x' }), { status, headers: { 'content-type': 'application/json' } })))
    expect(await spicyProvider(ID).fetch(track, signal())).toBeNull()
  })

  it('maps rate limits, outages and network failures; a host without the backend is silently skipped', async () => {
    server.use(route(() => new HttpResponse(null, { status: 429 })))
    expect(await kind(spicyProvider(ID).fetch(track, signal()))).toBe('rate-limited')
    server.use(route(() => new HttpResponse(null, { status: 502 })))
    expect(await kind(spicyProvider(ID).fetch(track, signal()))).toBe('unavailable')
    server.use(route(() => HttpResponse.error()))
    expect(await kind(spicyProvider(ID).fetch(track, signal()))).toBe('network')
    server.use(route(() => new HttpResponse('<html>app shell</html>', { headers: { 'content-type': 'text/html' } })))
    expect(await spicyProvider(ID).fetch(track, signal())).toBeNull()
  })

  it('rejects lyrics for a different recording (longer than the track)', async () => {
    server.use(route(() => HttpResponse.json(spicyBody())))
    expect(await spicyProvider(ID).fetch({ ...track, duration: 1 }, signal())).toBeNull()
  })

  it('aborts in flight', async () => {
    server.use(route(async () => (await delay('infinite'), HttpResponse.json({}))))
    const ctl = new AbortController()
    const pending = kind(spicyProvider(ID).fetch(track, ctl.signal))
    setTimeout(() => ctl.abort(), 20)
    expect(await pending).toBe('aborted')
  })

  it('is tried before the server and falls back to it, then to LRCLIB, in that order', async () => {
    const order: string[] = []
    server.use(
      route(() => (order.push('spicy'), new HttpResponse(null, { status: 404 }))),
      http.get(`${BASE}/rest/getLyricsBySongId`, (info) => (order.push('server'), authed({ lyricsList: { structuredLyrics: [] } })(info))),
      http.get(`${LRCLIB}/get`, () => (order.push('lrclib'), HttpResponse.json({ trackName: 'Song A', artistName: 'Artist A', duration: 200, plainLyrics: 'p', syncedLyrics: null }))),
    )
    const { serverProvider } = await import('../../src/api/lyrics/providers/server')
    const { lrclibProvider } = await import('../../src/api/lyrics/providers/lrclib')
    const found = await lookupLyrics([spicyProvider(ID), serverProvider({ baseUrl: BASE, username: USER, password: PASSWORD }, true), lrclibProvider], track, signal())
    expect(order).toEqual(['spicy', 'server', 'lrclib'])
    expect(found?.source).toBe('lrclib')
  })
})

function mount() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/now-playing']}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('Now Playing with Spicy Lyrics', () => {
  it('shows word-by-word highlighting on the active line and attribution with uploader and maker links', async () => {
    linkFor('a')
    server.use(route(() => HttpResponse.json(spicyBody())), serverEmpty)
    usePlayback.getState().playTracks([A])
    mount()
    const line = await screen.findByRole('button', { name: 'Hello there friend' })
    const words = () => [...line.querySelectorAll<HTMLElement>('.syl')].map((w) => [w.textContent, w.className.replace('syl', '').trim(), w.style.getPropertyValue('--p')])
    // Rendered word by word from the start (no re-layout when the line becomes active), but not painted yet.
    expect(words()).toEqual([['Hello', '', ''], ['there', '', ''], ['friend', '', '']])

    act(() => audio.tick(2.6))
    // Progress comes from the real timestamps: "there" runs 2.5–3 s, so at 2.6 s it is 20 % sung.
    expect(words()).toEqual([['Hello', 'is-done', '1'], ['there', 'is-active', '0.2'], ['friend', '', '0']])
    act(() => audio.tick(3.5))
    expect(words().map((w) => w[1])).toEqual(['is-done', 'is-done', 'is-active'])
    act(() => audio.tick(2.25)) // seeking back un-sings words
    expect(words()).toEqual([['Hello', 'is-active', '0.5'], ['there', '', '0'], ['friend', '', '0']])

    expect(screen.getByText(/Lyrics from Spicy Lyrics \(via Spicy Lyrics\)/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Una' })).toHaveAttribute('href', 'https://spicylyrics.org/uid/1')
    expect(screen.getByRole('link', { name: 'Mo' })).toHaveAttribute('rel', 'noopener noreferrer')

    fireEvent.click(screen.getByRole('button', { name: 'Second line' }))
    expect(audio.currentTime).toBe(6) // click-to-seek still works on word-synced lines
  })

  it('names only the provider for commercial sources, and never invents credits', async () => {
    linkFor('a')
    server.use(route(() => HttpResponse.json(spicyBody({ source: 'apple_music', UploadAttribution: { Uploader: { username: 'Una' } } }))), serverEmpty)
    usePlayback.getState().playTracks([A])
    mount()
    expect(await screen.findByText(/Lyrics from Apple Music \(via Spicy Lyrics\)/)).toBeInTheDocument()
    expect(screen.queryByText('Una')).not.toBeInTheDocument()
  })

  it('is not used at all without a linked Spotify id, or when external lookups are off', async () => {
    let spicyCalls = 0
    server.use(route(() => (spicyCalls++, HttpResponse.json(spicyBody()))), http.get(`${BASE}/rest/getLyricsBySongId`, authed({ lyricsList: { structuredLyrics: [{ synced: false, line: [{ value: 'from server' }] }] } })))
    usePlayback.getState().playTracks([A])
    mount()
    expect(await screen.findByText('from server')).toBeInTheDocument()
    expect(spicyCalls).toBe(0)
    expect(screen.getByText(/Lyrics from your server/)).toBeInTheDocument()
  })

  it('does not call Spicy Lyrics when external lookups are off, even if the track is linked', async () => {
    linkFor('a')
    useSettings.setState({ externalLookups: false })
    let spicyCalls = 0
    server.use(route(() => (spicyCalls++, HttpResponse.json(spicyBody()))), serverEmpty)
    usePlayback.getState().playTracks([A])
    mount()
    expect(await screen.findByText('No lyrics found')).toBeInTheDocument()
    expect(spicyCalls).toBe(0)
  })

  it('falls back to the server when Spicy Lyrics has nothing or its backend is down', async () => {
    linkFor('a')
    server.use(route(() => new HttpResponse(null, { status: 502 })), http.get(`${BASE}/rest/getLyricsBySongId`, authed({ lyricsList: { structuredLyrics: [{ synced: false, line: [{ value: 'server fallback' }] }] } })))
    usePlayback.getState().playTracks([A])
    mount()
    expect(await screen.findByText('server fallback')).toBeInTheDocument()
  })

  it('links a track from a pasted Spotify URL, then refetches with that id; rejects junk; can unlink', async () => {
    const requested: string[] = []
    server.use(route(({ params }) => (requested.push(String(params.id)), HttpResponse.json(spicyBody()))), serverEmpty, ...noLrclib)
    usePlayback.getState().playTracks([A])
    mount()
    expect(await screen.findByText('No lyrics found')).toBeInTheDocument()
    expect(requested).toEqual([])

    fireEvent.click(screen.getByText(/Word-synced lyrics/)) // opens the <details>
    const input = screen.getByLabelText('Spotify track link')
    fireEvent.change(input, { target: { value: 'https://evil.test/track/' + ID } })
    fireEvent.click(screen.getByRole('button', { name: 'Link track' }))
    expect(screen.getByRole('alert')).toHaveTextContent('isn’t a Spotify track link')
    expect(useSpotifyLinks.getState().links).toEqual({})

    fireEvent.change(input, { target: { value: `https://open.spotify.com/track/${ID}?si=zzz` } })
    fireEvent.click(screen.getByRole('button', { name: 'Link track' }))
    expect(await screen.findByRole('button', { name: 'Hello there friend' })).toBeInTheDocument()
    expect(requested).toEqual([ID])
    expect(screen.getByText(/· linked/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Remove link' }))
    expect(await screen.findByText('No lyrics found')).toBeInTheDocument()
    expect(useSpotifyLinks.getState().links).toEqual({})
  })

  it('keeps links per track, so one track’s lyrics never show on another', async () => {
    linkFor('a', ID)
    linkFor('b', ID2)
    const requested: string[] = []
    server.use(
      route(({ params }) => {
        requested.push(String(params.id))
        return HttpResponse.json(spicyBody({ Content: [{ Type: 'Vocal', Lead: { Syllables: [syl(params.id === ID ? 'alpha' : 'beta', 1, 2)], StartTime: 1, EndTime: 2 } }] }))
      }),
      serverEmpty,
    )
    usePlayback.getState().playTracks([A, B])
    mount()
    expect(await screen.findByRole('button', { name: 'alpha' })).toBeInTheDocument()
    act(() => usePlayback.getState().jump(1))
    expect(await screen.findByRole('button', { name: 'beta' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'alpha' })).not.toBeInTheDocument()
    expect(requested).toEqual([ID, ID2])
  })

  it('discards a slow Spicy response for the previous track after a track change', async () => {
    linkFor('a', ID)
    linkFor('b', ID2)
    server.use(
      route(async ({ params }) => {
        if (params.id === ID) await delay(300)
        return HttpResponse.json(spicyBody({ Content: [{ Type: 'Vocal', Lead: { Syllables: [syl(params.id === ID ? 'alpha' : 'beta', 1, 2)], StartTime: 1, EndTime: 2 } }] }))
      }),
      serverEmpty,
    )
    usePlayback.getState().playTracks([A, B])
    mount()
    await screen.findByRole('heading', { level: 1, name: 'Song A' })
    act(() => usePlayback.getState().jump(1))
    expect(await screen.findByRole('button', { name: 'beta' })).toBeInTheDocument()
    await act(() => new Promise((r) => setTimeout(r, 400)))
    expect(screen.queryByRole('button', { name: 'alpha' })).not.toBeInTheDocument()
  })

  it('persists links across a reload', async () => {
    const { useSpotifyLinks: store } = await import('../../src/state/spotifyLinks')
    store.getState().link(linkKey({ baseUrl: BASE, username: USER }, 'a'), ID)
    await waitFor(async () => expect((await (await import('../../src/lib/storage')).kvGet<Record<string, string>>('spotify-links'))?.[linkKey({ baseUrl: BASE, username: USER }, 'a')]).toBe(ID))
    store.setState({ links: {} })
    await store.getState().restore()
    expect(store.getState().links[linkKey({ baseUrl: BASE, username: USER }, 'a')]).toBe(ID)
  })

  it('ignores corrupt stored links', async () => {
    const { kvSet } = await import('../../src/lib/storage')
    await kvSet('spotify-links', { good: ID, bad: 'javascript:alert(1)', worse: 5 })
    useSpotifyLinks.setState({ links: {} })
    await useSpotifyLinks.getState().restore()
    expect(useSpotifyLinks.getState().links).toEqual({ good: ID })
  })

  it('Settings reports the backend status and can remove all links', async () => {
    server.use(http.get(`${APP}/api/spicy/health`, () => HttpResponse.json({ enabled: true })))
    linkFor('a')
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={['/settings']}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(await screen.findByText('Ready')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove Spotify links' }))
    expect(useSpotifyLinks.getState().links).toEqual({})
    expect(within(screen.getByRole('region', { name: 'Notifications' })).getByText('Spotify links removed.')).toBeInTheDocument()
  })
})
