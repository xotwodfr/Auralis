import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { clearLyricsCache, readCached, resetLyricsCacheMemory, writeCached } from '../../src/api/lyrics/cache'
import App from '../../src/App'
import { kvGet } from '../../src/lib/storage'
import { useAuth } from '../../src/state/auth'
import { useSettings } from '../../src/state/settings'
import { BASE, PASSWORD, USER } from '../server'

const key = ['lyrics', BASE, USER, 't1', 'x|y|10', true]
const lyrics = { synced: false, source: 'server' as const, lines: [{ time: null, text: 'hi' }] }

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
  await clearLyricsCache()
})

describe('lyrics cache', () => {
  it('round-trips, keeps keys distinct, and expires remembered "not found" after a day', async () => {
    await writeCached(key, lyrics)
    resetLyricsCacheMemory()
    expect(await readCached(key)).toEqual(lyrics)
    expect(await readCached([...key.slice(0, 3), 't2', ...key.slice(4)])).toBeUndefined()
    expect(await readCached([...key.slice(0, 5), false])).toBeUndefined()

    await writeCached(key, null)
    expect(await readCached(key)).toBeNull()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 25 * 3600_000)
    expect(await readCached(key)).toBeUndefined()
    vi.useRealTimers()
  })

  it('stays bounded', async () => {
    for (let i = 0; i < 305; i++) await writeCached(['k', i], lyrics)
    expect(await readCached(['k', 0])).toBeUndefined()
    expect(await readCached(['k', 304])).toEqual(lyrics)
  })
})

describe('lyrics cache lifetime (Spicy Lyrics terms: refetch or discard within 30 days)', () => {
  it('found lyrics expire after 7 days and are pruned from storage when loaded', async () => {
    await writeCached(key, lyrics)
    const day = 24 * 3600_000
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 6 * day)
    expect(await readCached(key)).toEqual(lyrics)
    vi.setSystemTime(Date.now() + 2 * day)
    expect(await readCached(key)).toBeUndefined()

    resetLyricsCacheMemory() // a fresh load drops the stale entry from IndexedDB too
    expect(await readCached(key)).toBeUndefined()
    vi.useRealTimers()
    await waitFor(async () => expect(Object.keys((await kvGet<Record<string, unknown>>('lyrics-cache')) ?? {})).toEqual([]))
  })

  it('a different linked Spotify id is a different cache identity', async () => {
    const { lyricsKey } = await import('../../src/api/lyrics/cache')
    const c = { baseUrl: BASE, username: USER }
    const t = { id: 't', title: 'x', artist: 'y', album: 'z', duration: 10 }
    expect(lyricsKey(c, t, true, 'A'.repeat(22))).not.toEqual(lyricsKey(c, t, true, 'B'.repeat(22)))
    expect(lyricsKey(c, t, true)).not.toEqual(lyricsKey(c, t, true, 'A'.repeat(22)))
  })
})

describe('lyrics settings', () => {
  const open = () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={['/settings']}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    return screen.findByRole('checkbox', { name: 'External lookups' })
  }

  it('toggles and persists External lookups', async () => {
    const box = await open()
    expect(box).toBeChecked()
    fireEvent.click(box)
    expect(useSettings.getState().externalLookups).toBe(false)
    await waitFor(async () => expect(await kvGet('settings')).toEqual({ externalLookups: false, reportPlays: true, lyricsServerEnabled: true, lyricsServerUrl: '', streamQuality: 'high', adaptiveColors: true, lyricsWordSync: true, lyricSize: 'medium', showLyricSource: true, crossfadeSeconds: 0, eqEnabled: false, eqGains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] }))
  })

  it('clears cached lyrics', async () => {
    await writeCached(key, lyrics)
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Clear cached lyrics' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Clear cache' }))
    expect(await screen.findByText('Cached lyrics cleared.')).toBeInTheDocument()
    resetLyricsCacheMemory()
    expect(await readCached(key)).toBeUndefined()
  })
})
