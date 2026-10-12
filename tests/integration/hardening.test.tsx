import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { HttpResponse, delay, http } from 'msw'
import { MemoryRouter } from 'react-router'
import { clearLyricsCache, readCached, writeCached } from '../../src/api/lyrics/cache'
import { coverArtUrl, getArtist, getArtists } from '../../src/api/subsonic/endpoints'
import type { Session, Song } from '../../src/api/subsonic/types'
import App from '../../src/App'
import { kvDelete, kvGet, kvSet } from '../../src/lib/storage'
import { useAuth } from '../../src/state/auth'
import { audioElement, parseSaved, usePlayback } from '../../src/state/playback'
import type { FakeAudio } from '../fakeAudio'
import { BASE, PASSWORD, USER, authed, failed, server } from '../server'

const audio = audioElement as unknown as FakeAudio
const creds = { baseUrl: BASE, username: USER, password: PASSWORD }
const session = (over: Partial<Session['credentials']> = {}): Session => ({
  credentials: { ...creds, ...over },
  server: { apiVersion: '1.16.1' },
  capabilities: { openSubsonic: true, extensions: [], songLyrics: false },
  remember: false,
})
const song = (id: string): Song => ({ id, title: `Song ${id}`, artist: 'A', album: 'B', duration: 100 })
const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)))

beforeEach(async () => {
  useAuth.setState({ hydrated: true, session: session() })
  usePlayback.getState().reset()
  audio.loads.length = 0
  audio.error = null
  await kvDelete('playback')
  await kvDelete('session')
})

const good = () => {
  usePlayback.getState().playTracks([song('a'), song('b')])
  return JSON.parse(JSON.stringify({ scope: `${BASE}|${USER}`, queue: usePlayback.getState().queue, position: 12, volume: 0.4 }))
}

describe('stored playback state is validated', () => {
  it('accepts what we wrote, and clamps position and volume', () => {
    const saved = good()
    expect(parseSaved(saved)).toMatchObject({ position: 12, volume: 0.4 })
    expect(parseSaved({ ...saved, volume: 7, position: -3 })).toMatchObject({ volume: 1, position: 0 })
  })

  it.each<[string, (s: ReturnType<typeof good>) => unknown]>([
    ['not an object', () => 'x'],
    ['no scope', (s) => ({ ...s, scope: undefined })],
    ['index out of range', (s) => ({ ...s, queue: { ...s.queue, index: 9 } })],
    ['fractional index', (s) => ({ ...s, queue: { ...s.queue, index: 0.5 } })],
    ['unknown repeat mode', (s) => ({ ...s, queue: { ...s.queue, repeat: 'sometimes' } })],
    ['items not an array', (s) => ({ ...s, queue: { ...s.queue, items: {} } })],
    ['an item without a track id', (s) => ({ ...s, queue: { ...s.queue, items: [{ key: 1, track: { title: 'x' } }] } })],
    ['a null item', (s) => ({ ...s, queue: { ...s.queue, items: [null] } })],
    ['duplicate/overlapping keys', (s) => ({ ...s, queue: { ...s.queue, nextKey: 1 } })],
    ['NaN volume', (s) => ({ ...s, volume: NaN })],
    ['bad shuffle', (s) => ({ ...s, queue: { ...s.queue, shuffle: 'yes' } })],
  ])('rejects %s', (_, corrupt) => {
    expect(parseSaved(corrupt(good()))).toBeNull()
  })

  it('restore() ignores corrupt data instead of crashing or half-applying it', async () => {
    const saved = good()
    usePlayback.getState().reset()
    await kvSet('playback', { ...saved, queue: { ...saved.queue, items: [{ key: 1, track: null }] } })
    await usePlayback.getState().restore()
    expect(usePlayback.getState().queue.items).toEqual([])
    expect(usePlayback.getState().queue.index).toBe(-1)
  })

  it('ignores state saved for another account', async () => {
    const saved = good()
    usePlayback.getState().reset()
    await kvSet('playback', { ...saved, scope: `${BASE}|someone-else` })
    await usePlayback.getState().restore()
    expect(usePlayback.getState().queue.items).toEqual([])
  })

  it('a cleared queue is removed from storage, so a reload cannot bring it back', async () => {
    usePlayback.getState().playTracks([song('a')])
    await waitFor(async () => expect(await kvGet('playback')).toBeDefined(), { timeout: 2000 })
    act(() => usePlayback.getState().clearQueue())
    await waitFor(async () => expect(await kvGet('playback')).toBeUndefined(), { timeout: 2000 })
  })
})

describe('stored session is validated', () => {
  it('discards a malformed session and deletes it', async () => {
    useAuth.setState({ session: null, hydrated: false })
    await kvSet('session', { credentials: { baseUrl: BASE } })
    await useAuth.getState().restore()
    expect(useAuth.getState()).toMatchObject({ session: null, hydrated: true })
    await waitFor(async () => expect(await kvGet('session')).toBeUndefined())
  })

  it('restores a complete one', async () => {
    useAuth.setState({ session: null, hydrated: false })
    await kvSet('session', { ...session(), remember: true })
    await useAuth.getState().restore()
    expect(useAuth.getState().session?.credentials.username).toBe(USER)
  })
})

describe('account boundaries', () => {
  it('switching to another user drops the previous account’s queue and stream', () => {
    usePlayback.getState().playTracks([song('a'), song('b')])
    expect(audio.src).toContain('id=a')
    act(() => useAuth.setState({ session: session({ username: 'someone-else' }) }))
    expect(usePlayback.getState().queue.items).toEqual([])
    expect(audio.src).toBe('')
  })

  it('refreshing the same account keeps playing', () => {
    usePlayback.getState().playTracks([song('a')])
    act(() => useAuth.setState({ session: session() }))
    expect(usePlayback.getState().queue.items).toHaveLength(1)
  })

  it('disconnect clears signed URLs and cached lyrics', async () => {
    const before = coverArtUrl(creds, 'x', 64)
    expect(coverArtUrl(creds, 'x', 64)).toBe(before)
    const key = ['lyrics', BASE, USER, 't1', 'x', true]
    await writeCached(key, { synced: false, source: 'server', lines: [{ time: null, text: 'hi' }] })

    await useAuth.getState().disconnect()
    await waitFor(async () => expect(await readCached(key)).toBeUndefined())
    expect(coverArtUrl(creds, 'x', 64)).not.toBe(before) // regenerated with a fresh salt
    await clearLyricsCache()
  })

  it('the signed-URL cache is bounded', () => {
    const first = coverArtUrl(creds, 'first', 1)
    for (let i = 0; i < 2100; i++) coverArtUrl(creds, `fill${i}`, 1)
    expect(coverArtUrl(creds, 'first', 1)).not.toBe(first) // evicted, so rebuilt
  })
})

describe('playback races', () => {
  it('rapid skipping leaves the last track loaded', () => {
    usePlayback.getState().playTracks(['a', 'b', 'c', 'd', 'e'].map(song))
    for (const i of [1, 2, 3, 4, 3, 2, 1, 4]) act(() => usePlayback.getState().jump(i))
    expect(usePlayback.getState().queue.index).toBe(4)
    expect(audio.src).toContain('id=e')
    expect(usePlayback.getState().error).toBeNull()
  })

  it('a slow failure diagnosis for a skipped track cannot put an error on the current one', async () => {
    server.use(http.get(`${BASE}/rest/ping`, async () => (await delay(100), failed(40))))
    usePlayback.getState().playTracks([song('a'), song('b')])
    act(() => audio.fail(4)) // track a fails; the app asks the server why (slowly)
    act(() => usePlayback.getState().jump(1))
    await wait(250)
    expect(usePlayback.getState().queue.index).toBe(1)
    expect(usePlayback.getState().error).toBeNull()
  })
})

describe('malformed server data', () => {
  it('degrades odd list shapes to empty lists', async () => {
    server.use(
      http.get(`${BASE}/rest/getArtists`, authed({ artists: { index: 'oops' } })),
      http.get(`${BASE}/rest/getArtist`, authed({ artist: { id: 'ar1', name: 'A', album: [null, 5, 'x', { id: 'al1', name: 'Ok' }] } })),
    )
    expect(await getArtists(creds)).toEqual([])
    const r = await getArtist(creds, 'ar1')
    expect(r.albums.map((a) => a.id)).toEqual(['al1'])
  })
})

describe('expired authentication while browsing', () => {
  it('offers to sign in again instead of retrying forever, and signing in again returns to Connect', async () => {
    server.use(http.get(`${BASE}/rest/getArtists`, () => failed(40)))
    let calls = 0
    server.events.on('request:start', ({ request }) => request.url.includes('getArtists') && calls++)
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/library/artists']}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(await screen.findByRole('alert')).toHaveTextContent('Your session was rejected by the server.')
    await wait(100)
    expect(calls).toBe(1) // no retry loop
    fireEvent.click(screen.getByRole('button', { name: 'Sign in again' }))
    expect(await screen.findByRole('button', { name: 'Connect' })).toBeInTheDocument()
    server.events.removeAllListeners()
  })

  it('a network failure still offers Try again (not sign in)', async () => {
    server.use(http.get(`${BASE}/rest/getArtists`, () => HttpResponse.error()))
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/library/artists']}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sign in again' })).not.toBeInTheDocument()
  })
})
