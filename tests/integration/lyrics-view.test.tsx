import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, delay, http } from 'msw'
import { MemoryRouter } from 'react-router'
import { clearLyricsCache, resetLyricsCacheMemory } from '../../src/api/lyrics/cache'
import { resetLrclibBackoff } from '../../src/api/lyrics/providers/lrclib'
import type { Song } from '../../src/api/subsonic/types'
import App from '../../src/App'
import { useAuth } from '../../src/state/auth'
import { audioElement, usePlayback } from '../../src/state/playback'
import { useSettings } from '../../src/state/settings'
import type { FakeAudio } from '../fakeAudio'
import { BASE, PASSWORD, USER, authed, server } from '../server'

const audio = audioElement as unknown as FakeAudio
const LRCLIB = 'https://lrclib.net/api'
const song = (id: string, title: string): Song => ({ id, title, artist: 'Artist A', album: 'Album 0', duration: 200 })
const A = song('a', 'Song A')
const B = song('b', 'Song B')

const structured = (list: object[]) => authed({ lyricsList: { structuredLyrics: list } })
const synced = (...lines: [number, string][]) => [{ synced: true, line: lines.map(([start, value]) => ({ start, value })) }]
const serverLyrics = (handler: Parameters<typeof http.get>[1]) => http.get(`${BASE}/rest/getLyricsBySongId`, handler)
const noLrclib = [
  http.get(`${LRCLIB}/get`, () => new HttpResponse(null, { status: 404 })),
  http.get(`${LRCLIB}/search`, () => HttpResponse.json([])),
]

beforeEach(async () => {
  useAuth.setState({
    hydrated: true,
    session: {
      credentials: { baseUrl: BASE, username: USER, password: PASSWORD },
      server: { apiVersion: '1.16.1' },
      capabilities: { openSubsonic: true, extensions: [], songLyrics: true },
      remember: false,
    },
  })
  useSettings.setState({ hydrated: true, externalLookups: true })
  usePlayback.getState().reset()
  audio.paused = true
  audio.error = null
  audio.loads.length = 0
  resetLrclibBackoff()
  await clearLyricsCache()
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
const lyrics = () => screen.findByRole('region', { name: 'Lyrics' })

describe('Now Playing', () => {
  it('shows an empty state when nothing is playing', async () => {
    mount()
    expect(await screen.findByText('Nothing playing', { selector: '.empty__title' })).toBeInTheDocument()
  })

  it('shows track info, highlights the active line as the playhead moves, and seeks on click', async () => {
    server.use(serverLyrics(structured(synced([2000, 'first line'], [6000, 'second line'], [9000, 'third line']))))
    usePlayback.getState().playTracks([A])
    mount()
    expect(await screen.findByRole('heading', { level: 1, name: 'Song A' })).toBeInTheDocument()
    const box = await lyrics()
    const line = (name: string) => within(box).getByRole('button', { name })
    expect(box.querySelector('[aria-current]')).toBeNull() // before the first line

    act(() => audio.tick(2))
    expect(line('first line')).toHaveAttribute('aria-current', 'true')
    act(() => audio.tick(7.5))
    expect(line('second line')).toHaveAttribute('aria-current', 'true')
    expect(line('first line')).not.toHaveAttribute('aria-current')
    act(() => audio.tick(500))
    expect(line('third line')).toHaveAttribute('aria-current', 'true') // after the last line

    fireEvent.click(line('first line'))
    expect(audio.currentTime).toBe(2)
    await waitFor(() => expect(line('first line')).toHaveAttribute('aria-current', 'true'))
    expect(screen.getByText(/Lyrics from your server/)).toBeInTheDocument()
  })

  it('stops following on manual scroll and resumes via Follow playback', async () => {
    server.use(serverLyrics(structured(synced([1000, 'one'], [2000, 'two']))))
    usePlayback.getState().playTracks([A])
    mount()
    const follow = await screen.findByRole('button', { name: 'Follow playback' })
    expect(follow).toHaveAttribute('aria-pressed', 'true')
    fireEvent.wheel(await lyrics())
    expect(follow).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(follow)
    expect(follow).toHaveAttribute('aria-pressed', 'true')
  })

  it('resumes following on its own once the user leaves the lyrics alone', async () => {
    server.use(serverLyrics(structured(synced([1000, 'one'], [2000, 'two']))))
    usePlayback.getState().playTracks([A])
    mount()
    const follow = await screen.findByRole('button', { name: 'Follow playback' })
    const box = await lyrics()
    act(() => audio.tick(1.5))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      fireEvent.wheel(box)
      expect(screen.getByRole('button', { name: 'Back to current line' })).toBeInTheDocument()
      act(() => vi.advanceTimersByTime(4000))
      fireEvent.touchMove(box) // still scrolling: the wait starts over
      act(() => vi.advanceTimersByTime(4000))
      expect(follow).toHaveAttribute('aria-pressed', 'false')
      act(() => vi.advanceTimersByTime(1000))
      expect(follow).toHaveAttribute('aria-pressed', 'true')
      // Turning follow off on purpose is not a scroll: it stays off.
      fireEvent.click(follow)
      act(() => vi.advanceTimersByTime(10000))
      expect(follow).toHaveAttribute('aria-pressed', 'false')
    } finally {
      vi.useRealTimers()
    }
  })

  it('leads into the next line early, but never cuts a held word short, and marks pauses', async () => {
    server.use(
      serverLyrics(structured([])),
      http.get(`${LRCLIB}/get`, () =>
        HttpResponse.json({
          trackName: 'Song A', artistName: 'Artist A', albumName: 'Album 0', duration: 200, plainLyrics: 'x',
          syncedLyrics: '[00:02.00]<00:02.00>held <00:03.00>note<00:06.00>\n[00:05.80]next one\n[00:07.00]<00:07.00>soon<00:08.00>\n[00:08.30]after\n[00:09.00]<00:09.00>then<00:10.00>\n[00:30.00]late',
        }),
      ),
    )
    usePlayback.getState().playTracks([A])
    mount()
    const box = await lyrics()
    const line = (name: string) => within(box).getByRole('button', { name })
    act(() => audio.tick(5.6))
    expect(line('held note')).toHaveAttribute('aria-current', 'true') // 'note' is still being sung
    act(() => audio.tick(6))
    expect(line('next one')).toHaveAttribute('aria-current', 'true')
    act(() => audio.tick(8))
    expect(line('after')).toHaveAttribute('aria-current', 'true') // 0.3 s ahead of its time
    expect(box.querySelectorAll('.lyric--dots')).toHaveLength(1) // only the 20 s pause before 'late'
  })

  it('renders plain-text lyrics without seek buttons', async () => {
    server.use(serverLyrics(structured([{ synced: false, line: [{ value: 'plain one' }, { value: 'plain two' }] }])))
    usePlayback.getState().playTracks([A])
    mount()
    const box = await lyrics()
    expect(within(box).getByText('plain two')).toBeInTheDocument()
    expect(within(box).queryByRole('button')).not.toBeInTheDocument()
  })

  it('falls back to LRCLIB when the server has none, and shows attribution', async () => {
    server.use(
      serverLyrics(structured([])),
      http.get(`${LRCLIB}/get`, () => HttpResponse.json({ trackName: 'Song A', artistName: 'Artist A', albumName: 'Album 0', duration: 200, plainLyrics: 'from lrclib', syncedLyrics: null })),
    )
    usePlayback.getState().playTracks([A])
    mount()
    expect(await screen.findByText('from lrclib')).toBeInTheDocument()
    expect(screen.getByText(/Lyrics from LRCLIB/)).toBeInTheDocument()
  })

  it('never contacts LRCLIB when external lookups are off', async () => {
    useSettings.setState({ externalLookups: false })
    server.use(serverLyrics(structured([]))) // an LRCLIB request would hit the unhandled-request error
    usePlayback.getState().playTracks([A])
    mount()
    expect(await screen.findByText('No lyrics found')).toBeInTheDocument()
    expect(screen.getByText(/External lookups are off/)).toBeInTheDocument()
  })

  it('shows "No lyrics found" when nothing has lyrics, and "Instrumental" when flagged', async () => {
    server.use(serverLyrics(structured([])), ...noLrclib)
    usePlayback.getState().playTracks([A])
    mount()
    expect(await screen.findByText('No lyrics found')).toBeInTheDocument()
  })

  it('shows Instrumental from LRCLIB', async () => {
    server.use(
      serverLyrics(structured([])),
      http.get(`${LRCLIB}/get`, () => HttpResponse.json({ trackName: 'Song A', artistName: 'Artist A', duration: 200, instrumental: true })),
    )
    usePlayback.getState().playTracks([A])
    mount()
    expect(await screen.findByText('Instrumental')).toBeInTheDocument()
  })

  it('shows a recoverable error and succeeds on retry; failures are not cached', async () => {
    useSettings.setState({ externalLookups: false })
    server.use(http.get(`${BASE}/rest/getLyricsBySongId`, () => new HttpResponse(null, { status: 503 })))
    usePlayback.getState().playTracks([A])
    mount()
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load lyrics.")

    server.use(serverLyrics(structured(synced([1000, 'recovered']))))
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('button', { name: 'recovered' })).toBeInTheDocument()
  })

  it('discards a slow response for the previous track after a track change', async () => {
    server.use(
      serverLyrics((info) => {
        const id = new URL(info.request.url).searchParams.get('id')
        return id === 'a' ? delay(300).then(() => structured(synced([1000, 'lyrics for A']))(info)) : structured(synced([1000, 'lyrics for B']))(info)
      }),
    )
    usePlayback.getState().playTracks([A, B])
    mount()
    await screen.findByRole('heading', { level: 1, name: 'Song A' })
    act(() => usePlayback.getState().jump(1))
    expect(await screen.findByRole('button', { name: 'lyrics for B' })).toBeInTheDocument()
    await act(() => new Promise((r) => setTimeout(r, 400))) // A's response lands after B is shown
    expect(screen.queryByText('lyrics for A')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'lyrics for B' })).toBeInTheDocument()
  })

  it('serves repeat visits from the cache, including across a reload', async () => {
    let calls = 0
    server.use(serverLyrics((info) => (calls++, structured(synced([1000, 'cached line']))(info))))
    usePlayback.getState().playTracks([A, B])
    mount()
    await screen.findByRole('button', { name: 'cached line' })
    expect(calls).toBe(1)

    // B has the same fixture lyrics but is a different track: it must fetch on its own.
    act(() => usePlayback.getState().jump(1))
    await screen.findByRole('heading', { level: 1, name: 'Song B' })
    await waitFor(() => expect(calls).toBe(2))

    // Back to A: no new request.
    act(() => usePlayback.getState().jump(0))
    await screen.findByRole('button', { name: 'cached line' })
    expect(calls).toBe(2)

    // New query client + dropped in-memory copy = a fresh page load; IndexedDB still has it.
    screen.getByRole('main') // still mounted
    document.body.innerHTML = ''
    resetLyricsCacheMemory()
    mount()
    await screen.findByRole('button', { name: 'cached line' })
    expect(calls).toBe(2)
  })

  it('refresh bypasses the stored result', async () => {
    let calls = 0
    server.use(serverLyrics((info) => (calls++, structured(synced([1000, `v${calls}`]))(info))))
    usePlayback.getState().playTracks([A])
    mount()
    await screen.findByRole('button', { name: 'v1' })
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(await screen.findByRole('button', { name: 'v2' })).toBeInTheDocument()
  })

  it('keeps the player running while lyrics are loading or missing', async () => {
    server.use(serverLyrics(() => delay('infinite') as never))
    usePlayback.getState().playTracks([A])
    mount()
    expect(await screen.findByRole('status', { name: 'Loading' })).toBeInTheDocument()
    expect(audio.loads).toHaveLength(1)
    expect(usePlayback.getState().error).toBeNull()
  })

  it('follows the active line with instant scrolling under prefers-reduced-motion', async () => {
    const scrollTo = vi.fn()
    HTMLElement.prototype.scrollTo = scrollTo as never
    const original = window.matchMedia
    window.matchMedia = ((q: string) => ({ matches: q.includes('reduce'), addEventListener: () => undefined })) as never
    server.use(serverLyrics(structured(synced([1000, 'one'], [5000, 'two']))))
    usePlayback.getState().playTracks([A])
    mount()
    await screen.findByRole('button', { name: 'one' })
    act(() => audio.tick(6))
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'auto' })))
    window.matchMedia = original
    delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo
  })
})
