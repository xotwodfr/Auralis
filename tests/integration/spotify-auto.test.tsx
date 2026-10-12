import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, delay, http } from 'msw'
import { MemoryRouter } from 'react-router'
import { clearLyricsCache } from '../../src/api/lyrics/cache'
import { resetLrclibBackoff } from '../../src/api/lyrics/providers/lrclib'
import { clearSpotifyMatches, matchKey, resetSpotifyMatchMemory, resolveSpotifyTrack } from '../../src/api/lyrics/resolve'
import type { SpotifyCandidate } from '../../src/api/lyrics/spotifyMatch'
import type { LyricsTrack } from '../../src/api/lyrics/types'
import type { Song } from '../../src/api/subsonic/types'
import App from '../../src/App'
import { useAuth } from '../../src/state/auth'
import { usePlayback } from '../../src/state/playback'
import { useSettings } from '../../src/state/settings'
import { NO_SPOTIFY, linkKey, useSpotifyLinks } from '../../src/state/spotifyLinks'
import { BASE, PASSWORD, USER, authed, server } from '../server'

const APP = 'http://app.test'
const LRCLIB = 'https://lrclib.net/api'
const ID = '4cOdK2wGLETKBW3PvgPWqT'
const ID2 = '1QV6tiMFM6fSOKOGLMHYYg'
const A: Song = { id: 'a', title: 'Song A', artist: 'Artist A', album: 'Album 0', duration: 200 }
const B: Song = { ...A, id: 'b', title: 'Song B' }
const scope = { baseUrl: BASE, username: USER }

let realFetch: typeof fetch
beforeAll(() => {
  realFetch = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => realFetch(typeof input === 'string' && input.startsWith('/') ? APP + input : input, init)) as typeof fetch
})
afterAll(() => {
  globalThis.fetch = realFetch
})

const cand = (over: Partial<SpotifyCandidate> = {}): SpotifyCandidate => ({ id: ID, name: 'Song A', artists: ['Artist A'], album: 'Album 0', durationMs: 200_000, explicit: false, isrc: '', ...over })
const syl = (Text: string, StartTime: number, EndTime: number) => ({ Text, IsPartOfWord: false, StartTime, EndTime })
const spicyBody = (word: string) => ({ Body: { Type: 'Syllable', source: 'apple_music', Content: [{ Type: 'Vocal', Lead: { Syllables: [syl(word, 1, 2)], StartTime: 1, EndTime: 2 } }] } })

let matchCalls: URLSearchParams[]
let spicyCalls: string[]
let candidates: (params: URLSearchParams) => SpotifyCandidate[] | Response
const handlers = () => [
  http.get(`${APP}/api/spicy/health`, () => HttpResponse.json({ enabled: true, matching: true })),
  http.get(`${APP}/api/spicy/match`, ({ request }) => {
    const p = new URL(request.url).searchParams
    matchCalls.push(p)
    const r = candidates(p)
    return r instanceof Response ? r : HttpResponse.json({ candidates: r })
  }),
  http.get(`${APP}/api/spicy/lyrics/:id`, ({ params }) => {
    spicyCalls.push(String(params.id))
    return params.id === ID2 ? new HttpResponse(null, { status: 404 }) : HttpResponse.json(spicyBody(params.id === ID ? 'spicy-one' : 'spicy-other'))
  }),
  http.get(`${BASE}/rest/getLyricsBySongId`, authed({ lyricsList: { structuredLyrics: [{ synced: true, line: [{ start: 1000, value: 'from the server' }] }] } })),
  http.get(`${LRCLIB}/get`, () => new HttpResponse(null, { status: 404 })),
  http.get(`${LRCLIB}/search`, () => HttpResponse.json([])),
]

beforeEach(async () => {
  useAuth.setState({
    hydrated: true,
    session: { credentials: { baseUrl: BASE, username: USER, password: PASSWORD }, server: { apiVersion: '1.16.1' }, capabilities: { openSubsonic: true, extensions: [], songLyrics: true }, remember: false },
  })
  useSettings.setState({ hydrated: true, externalLookups: true })
  useSpotifyLinks.getState().clear() // also on disk: App restores saved links on mount
  usePlayback.getState().reset()
  resetLrclibBackoff()
  resetSpotifyMatchMemory()
  await clearLyricsCache()
  await clearSpotifyMatches()
  matchCalls = []
  spicyCalls = []
  candidates = () => [cand()]
  server.use(...handlers())
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
const summary = () => screen.getByText(/Word-synced lyrics/)

describe('automatic Spotify matching on Now Playing', () => {
  it('matches an ordinary track with no user action and shows Spicy Lyrics for it', async () => {
    usePlayback.getState().playTracks([{ ...A, isrc: ['USABC1234567'] }])
    mount()
    expect(await screen.findByRole('button', { name: 'spicy-one' })).toBeInTheDocument()
    expect(spicyCalls).toEqual([ID])
    // Only bounded track metadata goes to our backend; the ISRC from the library is used.
    expect(Object.fromEntries(matchCalls[0]!)).toEqual({ title: 'Song A', artist: 'Artist A', isrc: 'USABC1234567' })
    expect(summary()).toHaveTextContent('· matched automatically')
    expect(screen.getByText(/Lyrics from Apple Music \(via Spicy Lyrics\)/)).toBeInTheDocument()
    expect(useSpotifyLinks.getState().links).toEqual({}) // an automatic match is not a user link
  })

  it('offers a choice when recordings are ambiguous, falls back meanwhile, and remembers the choice', async () => {
    candidates = () => [cand({ album: 'One', durationMs: 199_000, isrc: 'GBAAA0000001' }), cand({ id: ID2, album: 'Two', durationMs: 201_000, isrc: 'GBAAA0000002' })]
    usePlayback.getState().playTracks([A])
    mount()
    expect(await screen.findByRole('button', { name: 'from the server' })).toBeInTheDocument()
    expect(spicyCalls).toEqual([]) // never guesses
    const chooser = screen.getByRole('group', { name: 'Which recording is this?' })
    expect(summary()).toHaveTextContent('· choose a recording')
    const options = within(chooser).getAllByRole('button').filter((b) => b.classList.contains('choice'))
    expect(options.map((o) => o.textContent)).toEqual(['Song A — Artist AOne · 3:19', 'Song A — Artist ATwo · 3:21'])

    fireEvent.click(options[0]!)
    expect(await screen.findByRole('button', { name: 'spicy-one' })).toBeInTheDocument()
    expect(useSpotifyLinks.getState().links).toEqual({ [linkKey(scope, 'a')]: ID })
    expect(summary()).toHaveTextContent('· linked')
  })

  it('"None of these" turns Spicy Lyrics off for the track', async () => {
    candidates = () => [cand({ album: 'One', isrc: 'GBAAA0000001', durationMs: 199_000 }), cand({ id: ID2, album: 'Two', isrc: 'GBAAA0000002', durationMs: 201_000 })]
    usePlayback.getState().playTracks([A])
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'None of these' }))
    expect(useSpotifyLinks.getState().links).toEqual({ [linkKey(scope, 'a')]: NO_SPOTIFY })
    expect(summary()).toHaveTextContent('· off for this track')
    expect(await screen.findByRole('button', { name: 'from the server' })).toBeInTheDocument()
  })

  it('sends the title without a bracketed featuring credit and only the primary artist, keeping version qualifiers', async () => {
    usePlayback.getState().playTracks([{ ...A, title: 'Song A (feat. Guest) (Club Remix)', artist: 'Artist A feat. Guest' }])
    mount()
    await waitFor(() => expect(matchCalls).toHaveLength(1))
    expect(Object.fromEntries(matchCalls[0]!)).toEqual({ title: 'Song A (Club Remix)', artist: 'Artist A' })
  })

  it('says the backend is missing (desktop build without one) instead of going quiet, and still shows server lyrics', async () => {
    // What a Tauri build without VITE_AURALIS_BACKEND_URL gets: its own asset handler answers, not JSON.
    server.use(http.get(`${APP}/api/spicy/health`, () => new HttpResponse('<!doctype html>', { headers: { 'content-type': 'text/html' } })))
    usePlayback.getState().playTracks([A])
    mount()
    expect(await screen.findByRole('button', { name: 'from the server' })).toBeInTheDocument()
    expect(matchCalls).toEqual([])
    expect(summary()).toHaveTextContent('· no lyrics backend, so no automatic Spotify match')
  })

  it('tells a failed Spotify lookup apart from "no match"', async () => {
    candidates = () => new HttpResponse(null, { status: 502 })
    usePlayback.getState().playTracks([A])
    mount()
    expect(await screen.findByRole('button', { name: 'from the server' })).toBeInTheDocument()
    expect(summary()).toHaveTextContent('· Spotify lookup failed, try Refresh')
    expect(summary()).not.toHaveTextContent('no Spotify match')
  })

  it('falls back silently when nothing on Spotify matches, and never fabricates an id', async () => {
    candidates = () => [cand({ name: 'Completely Different' }), cand({ artists: ['Someone Else'] })]
    usePlayback.getState().playTracks([A])
    mount()
    expect(await screen.findByRole('button', { name: 'from the server' })).toBeInTheDocument()
    expect(spicyCalls).toEqual([])
    expect(summary()).toHaveTextContent('· no Spotify match')
    expect(screen.queryByRole('group', { name: 'Which recording is this?' })).not.toBeInTheDocument()
  })

  it('says so when the match is right but Spicy Lyrics has nothing for it', async () => {
    candidates = () => [cand({ id: ID2 })]
    usePlayback.getState().playTracks([A])
    mount()
    expect(await screen.findByRole('button', { name: 'from the server' })).toBeInTheDocument()
    expect(spicyCalls).toEqual([ID2])
    expect(summary()).toHaveTextContent('· matched automatically · none for this recording')
    expect(screen.getByText(/Lyrics from your server/)).toBeInTheDocument()
  })

  it('a wrong automatic match can be rejected, and automatic matching restored', async () => {
    usePlayback.getState().playTracks([A])
    mount()
    await screen.findByRole('button', { name: 'spicy-one' })
    fireEvent.click(summary())
    expect(screen.getByText(/Matched automatically to “Song A” by Artist A \(Album 0 · 3:20\)/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Wrong recording' }))
    expect(await screen.findByRole('button', { name: 'from the server' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Match automatically again' }))
    expect(await screen.findByRole('button', { name: 'spicy-one' })).toBeInTheDocument()
    expect(matchCalls).toHaveLength(1) // the match itself was cached
  })

  it('a manual link overrides matching entirely', async () => {
    useSpotifyLinks.getState().link(linkKey(scope, 'a'), 'B'.repeat(22))
    usePlayback.getState().playTracks([A])
    mount()
    expect(await screen.findByRole('button', { name: 'spicy-other' })).toBeInTheDocument()
    expect(matchCalls).toEqual([])
  })

  it('does not match when external lookups are off, or the backend cannot search', async () => {
    useSettings.setState({ externalLookups: false })
    usePlayback.getState().playTracks([A])
    mount()
    expect(await screen.findByRole('button', { name: 'from the server' })).toBeInTheDocument()
    expect(matchCalls).toEqual([])
  })

  it('falls back when the backend has no Spotify credentials', async () => {
    server.use(http.get(`${APP}/api/spicy/health`, () => HttpResponse.json({ enabled: true, matching: false })))
    usePlayback.getState().playTracks([A])
    mount()
    expect(await screen.findByRole('button', { name: 'from the server' })).toBeInTheDocument()
    expect(matchCalls).toEqual([])
  })

  it('falls back when matching fails, and does not remember the failure', async () => {
    candidates = () => new HttpResponse(null, { status: 502 })
    usePlayback.getState().playTracks([A])
    mount()
    expect(await screen.findByRole('button', { name: 'from the server' })).toBeInTheDocument()
    expect(await resolveSpotifyTrack(scope, A, new AbortController().signal)).toEqual({ status: 'unavailable' })
    candidates = () => [cand()]
    expect(await resolveSpotifyTrack(scope, A, new AbortController().signal)).toMatchObject({ status: 'matched', id: ID })
  })

  it('skipping quickly through tracks only looks up the one that stays', async () => {
    usePlayback.getState().playTracks([A, B, { ...A, id: 'c', title: 'Song C' }])
    mount()
    act(() => usePlayback.getState().jump(1))
    act(() => usePlayback.getState().jump(2))
    await screen.findByRole('heading', { level: 1, name: 'Song C' })
    await waitFor(() => expect(matchCalls.map((p) => p.get('title'))).toEqual(['Song C']))
  })

  it('discards a slow match for the previous track', async () => {
    candidates = (p) => [cand({ name: p.get('title')!, id: p.get('title') === 'Song A' ? ID : 'B'.repeat(22) })]
    server.use(http.get(`${APP}/api/spicy/match`, async ({ request }) => {
      const p = new URL(request.url).searchParams
      matchCalls.push(p)
      if (p.get('title') === 'Song A') await delay(400)
      return HttpResponse.json({ candidates: candidates(p) })
    }))
    usePlayback.getState().playTracks([A, B])
    mount()
    await waitFor(() => expect(matchCalls).toHaveLength(1)) // A's lookup is in flight
    act(() => usePlayback.getState().jump(1))
    expect(await screen.findByRole('button', { name: 'spicy-other' })).toBeInTheDocument()
    await act(() => new Promise((r) => setTimeout(r, 500)))
    expect(spicyCalls).toEqual(['B'.repeat(22)])
    expect(screen.queryByRole('button', { name: 'spicy-one' })).not.toBeInTheDocument()
  })
})

describe('resolveSpotifyTrack', () => {
  const t: LyricsTrack = { id: 'a', title: 'Song A', artist: 'Artist A', album: 'Album 0', duration: 200 }
  const signal = () => new AbortController().signal

  it('shares one request between concurrent callers', async () => {
    const [x, y] = await Promise.all([resolveSpotifyTrack(scope, t, signal()), resolveSpotifyTrack(scope, t, signal())])
    expect(x).toEqual(y)
    expect(matchCalls).toHaveLength(1)
  })

  it('keeps the shared request alive while any caller still wants it, and cancels it when none do', async () => {
    const one = new AbortController()
    const p1 = resolveSpotifyTrack(scope, t, one.signal)
    const p2 = resolveSpotifyTrack(scope, t, signal())
    one.abort()
    await expect(p1).rejects.toMatchObject({ name: 'AbortError' })
    expect(await p2).toMatchObject({ status: 'matched' })

    const only = new AbortController()
    const p3 = resolveSpotifyTrack(scope, { ...t, id: 'z' }, only.signal)
    only.abort()
    await expect(p3).rejects.toMatchObject({ name: 'AbortError' })
    await new Promise((r) => setTimeout(r, 400))
    expect(matchCalls.map((p) => p.get('title'))).toEqual(['Song A']) // the cancelled one never reached the network
  })

  it('caches answers persistently, per server, user and track identity', async () => {
    await resolveSpotifyTrack(scope, t, signal())
    resetSpotifyMatchMemory() // a reload: IndexedDB still has it
    await resolveSpotifyTrack(scope, t, signal())
    expect(matchCalls).toHaveLength(1)

    await resolveSpotifyTrack({ ...scope, username: 'someone-else' }, t, signal())
    await resolveSpotifyTrack({ ...scope, baseUrl: 'https://other.test' }, t, signal())
    await resolveSpotifyTrack(scope, { ...t, duration: 230 }, signal()) // retagged file: a different identity
    expect(matchCalls).toHaveLength(4)
    expect(matchKey(scope, t)).not.toEqual(matchKey({ ...scope, username: 'x' }, t))
  })

  it('expires remembered "no match" after a day, and matches after 30 days', async () => {
    candidates = () => []
    expect(await resolveSpotifyTrack(scope, t, signal())).toEqual({ status: 'none' })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 25 * 3600_000)
    candidates = () => [cand()]
    expect(await resolveSpotifyTrack(scope, t, signal())).toMatchObject({ status: 'matched' })
    vi.setSystemTime(Date.now() + 29 * 24 * 3600_000)
    await resolveSpotifyTrack(scope, t, signal())
    expect(matchCalls).toHaveLength(2)
    vi.setSystemTime(Date.now() + 2 * 24 * 3600_000)
    await resolveSpotifyTrack(scope, t, signal())
    expect(matchCalls).toHaveLength(3)
    vi.useRealTimers()
  })

  it('backs off after a rate limit instead of hammering the backend', async () => {
    candidates = () => new HttpResponse(null, { status: 429, headers: { 'retry-after': '60' } })
    expect(await resolveSpotifyTrack(scope, t, signal())).toEqual({ status: 'unavailable' })
    expect(await resolveSpotifyTrack(scope, { ...t, id: 'b' }, signal())).toEqual({ status: 'unavailable' })
    expect(matchCalls).toHaveLength(1)
  })

  it('ignores malformed candidates from the backend', async () => {
    candidates = () => [{ id: '../../x', name: 'Song A' } as never, cand({ id: 'short' }), cand()]
    expect(await resolveSpotifyTrack(scope, t, signal())).toMatchObject({ status: 'matched', id: ID })
  })
})

describe('Settings', () => {
  const open = () =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={['/settings']}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    )

  it('reports whether automatic matching is configured', async () => {
    open()
    expect(await screen.findByText('On (Spotify search)')).toBeInTheDocument()
  })

  it('explains what is missing when it is not', async () => {
    server.use(http.get(`${APP}/api/spicy/health`, () => HttpResponse.json({ enabled: true, matching: false })))
    open()
    expect(await screen.findByText(/SPOTIFY_CLIENT_ID \/ SPOTIFY_CLIENT_SECRET are not set/)).toBeInTheDocument()
  })
})
