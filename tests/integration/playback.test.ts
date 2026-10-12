import { http } from 'msw'
import type { Song } from '../../src/api/subsonic/types'
import { initialQueue } from '../../src/audio/queue'
import { kvGet, kvSet } from '../../src/lib/storage'
import { useAuth } from '../../src/state/auth'
import { audioElement, usePlayback } from '../../src/state/playback'
import type { FakeAudio } from '../fakeAudio'
import { BASE, PASSWORD, USER, failed, server } from '../server'

const audio = audioElement as unknown as FakeAudio
const song = (id: string, duration = 200): Song => ({ id, title: `Song ${id}`, album: 'Album', artist: 'Artist', duration })
const A = song('a')
const B = song('b')
const C = song('c')
const state = () => usePlayback.getState()
const nowPlaying = () => state().queue.items[state().queue.index]?.track.id
const session = {
  credentials: { baseUrl: BASE, username: USER, password: PASSWORD },
  server: { apiVersion: '1.16.1' },
  capabilities: { openSubsonic: true, extensions: [], songLyrics: false },
  remember: false,
}
/** Let the fake `playing` microtask run. */
const settle = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  useAuth.setState({ session, hydrated: true })
  state().reset()
  audio.loads.length = 0
  audio.error = null
  audio.playRejection = null
  audio.currentTime = 0
  audio.paused = true
})

describe('starting playback', () => {
  it('streams the current track with token auth only, then reports playing', async () => {
    state().playTracks([A, B], 1)
    await settle()
    expect(nowPlaying()).toBe('b')
    expect(state().status).toBe('playing')
    expect(audio.loads).toHaveLength(1)
    const url = new URL(audio.loads[0]!)
    expect(url.pathname).toBe('/rest/stream')
    expect(url.searchParams.get('id')).toBe('b')
    expect(url.searchParams.has('t') && url.searchParams.has('s')).toBe(true)
    expect(url.searchParams.has('p')).toBe(false)
    expect(audio.loads[0]).not.toContain(PASSWORD)
  })

  it('duration comes from the track until metadata arrives, then from the stream', async () => {
    state().playTracks([A])
    expect(state().duration).toBe(200)
    audio.setDuration(199.5)
    expect(state().duration).toBe(199.5)
  })

  it('play/pause toggles and seek moves the playhead', async () => {
    state().playTracks([A])
    await settle()
    state().togglePlay()
    expect(state().status).toBe('paused')
    state().togglePlay()
    await settle()
    expect(state().status).toBe('playing')
    audio.setDuration(200)
    state().seek(90)
    expect([audio.currentTime, state().position]).toEqual([90, 90])
  })

  it('shows buffering and recovers', async () => {
    state().playTracks([A])
    await settle()
    audio.fire('waiting')
    expect(state().status).toBe('buffering')
    audio.fire('playing')
    expect(state().status).toBe('playing')
  })
})

describe('switching tracks', () => {
  it('next/previous move through the queue; previous restarts after 3s', async () => {
    state().playTracks([A, B, C])
    state().next()
    expect(nowPlaying()).toBe('b')
    audio.tick(10)
    state().previous()
    expect([nowPlaying(), audio.currentTime]).toEqual(['b', 0])
    state().previous()
    expect(nowPlaying()).toBe('a')
    expect(audio.loads).toHaveLength(3)
  })

  it('next at the end of the queue (repeat off) does nothing', () => {
    state().playTracks([A], 0)
    state().next()
    expect(audio.loads).toHaveLength(1)
  })

  it('an empty queue ignores transport controls', () => {
    state().togglePlay()
    state().next()
    state().previous()
    expect([state().status, audio.loads.length]).toEqual(['idle', 0])
  })
})

describe('end of track', () => {
  it('advances automatically', async () => {
    state().playTracks([A, B])
    audio.finish()
    expect(nowPlaying()).toBe('b')
    expect(audio.loads).toHaveLength(2)
  })

  it('stops on the last track when repeat is off', async () => {
    state().playTracks([A])
    audio.finish()
    expect([state().status, state().autoplay, nowPlaying()]).toEqual(['ended', false, 'a'])
  })

  it('repeat-all wraps to the start', () => {
    state().playTracks([A, B], 1)
    state().cycleRepeat()
    audio.finish()
    expect(nowPlaying()).toBe('a')
  })

  it('repeat-one replays the same stream without reloading', async () => {
    state().playTracks([A, B])
    state().cycleRepeat()
    state().cycleRepeat()
    expect(state().queue.repeat).toBe('one')
    audio.tick(150)
    audio.finish()
    await settle()
    expect([nowPlaying(), audio.loads.length, audio.currentTime]).toEqual(['a', 1, 0])
  })
})

describe('queue editing while playing', () => {
  it('removing the current track plays the next; removing the last one empties playback', async () => {
    state().playTracks([A, B])
    await settle()
    state().removeAt(0)
    expect(nowPlaying()).toBe('b')
    expect(audio.loads).toHaveLength(2)
    state().removeAt(0)
    expect([state().status, nowPlaying(), audio.src]).toEqual(['idle', undefined, ''])
  })

  it('removing or reordering other tracks does not interrupt the current stream', async () => {
    state().playTracks([A, B, C])
    state().reorder(2, 1)
    state().removeAt(2)
    state().addNext([song('x')])
    state().addToQueue([song('y')])
    expect(audio.loads).toHaveLength(1)
    expect(state().queue.items.map((e) => e.track.id).join('')).toBe('axcy')
  })

  it('clear stops playback', async () => {
    state().playTracks([A, B])
    await settle()
    state().clearQueue()
    expect([state().status, state().queue.items.length, audio.src]).toEqual(['idle', 0, ''])
  })
})

describe('failures', () => {
  it('an unsupported stream shows a clear message, and retry reloads at the same position', async () => {
    state().playTracks([A])
    audio.tick(30)
    audio.fail(4)
    expect(state().status).toBe('error')
    expect(state().error?.kind).toBe('unsupported')
    state().retry()
    expect([state().status, audio.loads.length]).toEqual(['loading', 2])
    audio.setDuration(200)
    expect(audio.currentTime).toBe(30)
  })

  it('a rejected session is diagnosed as an auth error', async () => {
    server.use(http.get(`${BASE}/rest/ping`, () => failed(40)))
    state().playTracks([A])
    audio.fail(4)
    await vi.waitFor(() => expect(state().error?.kind).toBe('auth'))
  })

  it('a dead network is diagnosed as a network error', async () => {
    server.use(http.get(`${BASE}/rest/ping`, () => Response.error()))
    state().playTracks([A])
    audio.fail(4)
    await vi.waitFor(() => expect(state().error?.kind).toBe('network'))
  })

  it('error text never contains credentials, tokens or URLs', async () => {
    state().playTracks([A])
    audio.fail(2)
    await settle()
    const text = JSON.stringify(state().error)
    expect(text).not.toMatch(new RegExp(`${PASSWORD}|https?:|[?&]t=|[?&]s=`))
  })

  it('playing with no session reports auth instead of throwing', () => {
    useAuth.setState({ session: null })
    state().playTracks([A])
    expect([state().status, state().error?.kind]).toEqual(['error', 'auth'])
  })

  it('autoplay refused by the browser asks for a click', async () => {
    audio.playRejection = new DOMException('no', 'NotAllowedError')
    state().playTracks([A])
    await settle()
    expect([state().status, state().error?.kind]).toEqual(['paused', 'blocked'])
  })
})

describe('persistence', () => {
  it('saves the queue, restores it paused, and only loads audio on first play', async () => {
    state().playTracks([A, B], 1)
    audio.setDuration(200)
    audio.tick(50)
    state().setVolume(0.4)
    await vi.waitFor(async () => expect(await kvGet('playback')).toMatchObject({ position: 50, volume: 0.4 }), { timeout: 2000 })
    const saved = await kvGet('playback')

    state().reset()
    audio.loads.length = 0
    await kvSet('playback', saved)
    await state().restore()
    expect([nowPlaying(), state().status, state().position, state().volume, audio.loads.length]).toEqual(['b', 'paused', 50, 0.4, 0])

    state().togglePlay()
    audio.setDuration(200)
    expect([audio.loads.length, audio.currentTime, state().autoplay]).toEqual([1, 50, true])
  })

  it('ignores a queue saved for another server or user', async () => {
    await kvSet('playback', { scope: 'https://other|bob', queue: { ...initialQueue<Song>(), items: [{ key: 1, track: A }], index: 0 }, position: 5, volume: 1 })
    await state().restore()
    expect(state().queue.items).toHaveLength(0)
  })

  it('disconnecting clears the queue and the stored copy', async () => {
    state().playTracks([A])
    await vi.waitFor(async () => expect(await kvGet('playback')).toBeDefined(), { timeout: 2000 })
    useAuth.setState({ session: null })
    expect([state().queue.items.length, state().status]).toEqual([0, 'idle'])
    await vi.waitFor(async () => expect(await kvGet('playback')).toBeUndefined())
  })
})
