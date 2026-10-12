import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import axe from 'axe-core'
import { MemoryRouter } from 'react-router'
import { http } from 'msw'
import App from '../../src/App'
import { useTheme } from '../../src/app/theme'
import { useAuth } from '../../src/state/auth'
import { audioElement, usePlayback } from '../../src/state/playback'
import { useSettings } from '../../src/state/settings'
import type { Song } from '../../src/api/subsonic/types'
import type { FakeAudio } from '../fakeAudio'
import { BASE, PASSWORD, USER, authed, server } from '../server'

const audio = audioElement as unknown as FakeAudio
const song = (id: string, title: string): Song => ({ id, title, artist: 'Artist A', album: 'Album 0', duration: 200 })

beforeEach(() => {
  useAuth.setState({
    hydrated: true,
    session: {
      credentials: { baseUrl: BASE, username: USER, password: PASSWORD },
      server: { apiVersion: '1.16.1', type: 'navidrome', serverVersion: '0.55.0' },
      capabilities: { openSubsonic: true, extensions: [], songLyrics: true },
      remember: false,
    },
  })
  useSettings.setState({ hydrated: true, externalLookups: false })
  usePlayback.getState().reset()
  audio.loads.length = 0
  audio.paused = true
  localStorage.clear()
  useTheme.setState({ pref: 'system' })
  server.use(http.get(`${BASE}/rest/getLyricsBySongId`, authed({ lyricsList: { structuredLyrics: [] } })))
})

function mount(path: string) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}
const key = (target: Element | Document, k: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(target, { key: k, ...init })

describe('theme setting', () => {
  it('switches and persists the theme from Settings, with arrow-key support', async () => {
    mount('/settings')
    const dark = await screen.findByRole('radio', { name: 'Dark' })
    fireEvent.click(dark)
    expect(dark).toHaveAttribute('aria-checked', 'true')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(localStorage.getItem('auralis-theme')).toBe('dark')

    key(dark, 'ArrowLeft')
    expect(screen.getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'true')
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('documents the shortcuts in Settings', async () => {
    mount('/settings')
    const panel = (await screen.findByRole('heading', { name: 'Keyboard shortcuts' })).closest('section')!
    for (const action of ['Play / pause', 'Focus search']) expect(within(panel).getByText(action)).toBeInTheDocument()
  })
})

describe('Settings confirmations', () => {
  it('Cancel keeps the session and returns focus to the trigger', async () => {
    mount('/settings')
    const trigger = await screen.findByRole('button', { name: 'Disconnect' })
    trigger.focus()
    fireEvent.click(trigger)
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(useAuth.getState().session).not.toBeNull()
    expect(trigger).toHaveFocus()
  })

  it('confirming "Clear cached lyrics" shows a toast', async () => {
    mount('/settings')
    fireEvent.click(await screen.findByRole('button', { name: 'Clear cached lyrics' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Clear cache' }))
    expect(await screen.findByText('Cached lyrics cleared.')).toBeInTheDocument()
  })
})

describe('keyboard shortcuts', () => {
  async function playing() {
    usePlayback.getState().playTracks([song('s1', 'One'), song('s2', 'Two')])
    mount('/library/artists')
    await screen.findByRole('heading', { name: 'Artists' })
  }

  it('Space toggles playback, N/P change track, arrows seek and change volume', async () => {
    await playing()
    expect(audio.paused).toBe(false)
    key(document.body, ' ')
    expect(audio.paused).toBe(true)
    key(document.body, ' ')
    expect(audio.paused).toBe(false)

    key(document.body, 'n')
    expect(usePlayback.getState().queue.index).toBe(1)
    key(document.body, 'P') // case-insensitive
    expect(usePlayback.getState().queue.index).toBe(0)

    act(() => audio.tick(20))
    key(document.body, 'ArrowRight')
    expect(audio.currentTime).toBe(25)
    key(document.body, 'ArrowLeft')
    expect(audio.currentTime).toBe(20)

    act(() => usePlayback.getState().setVolume(0.5))
    key(document.body, 'ArrowUp')
    expect(usePlayback.getState().volume).toBeCloseTo(0.55)
    key(document.body, 'ArrowDown')
    key(document.body, 'ArrowDown')
    expect(usePlayback.getState().volume).toBeCloseTo(0.45)
  })

  it('"/" focuses search', async () => {
    await playing()
    key(document.body, '/')
    expect(screen.getByRole('searchbox', { name: 'Search library' })).toHaveFocus()
  })

  it('never fires while typing, with modifiers, on focused buttons, or inside a dialog', async () => {
    await playing()
    const before = usePlayback.getState().queue.index
    const box = screen.getByRole('searchbox', { name: 'Search library' })
    for (const k of [' ', 'n', 'p', 'ArrowRight', '/']) key(box, k)
    expect(audio.paused).toBe(false)
    expect(usePlayback.getState().queue.index).toBe(before)

    key(document.body, 'n', { ctrlKey: true })
    key(document.body, 'n', { metaKey: true })
    expect(usePlayback.getState().queue.index).toBe(before)

    key(screen.getByRole('button', { name: 'Queue' }), ' ') // the button owns Space
    expect(audio.paused).toBe(false)

    fireEvent.click(screen.getByRole('link', { name: 'Settings' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }))
    await screen.findByRole('dialog')
    key(document.body, ' ')
    key(document.body, 'n')
    expect(audio.paused).toBe(false)
    expect(usePlayback.getState().queue.index).toBe(before)
  })

  it('leaves arrows and Space to a focused scrollable list', async () => {
    await playing()
    const list = await screen.findByRole('list', { name: 'Artists' })
    const volume = usePlayback.getState().volume
    key(list, 'ArrowDown')
    key(list, ' ')
    expect(usePlayback.getState().volume).toBe(volume)
    expect(audio.paused).toBe(false)
  })
})

describe('accessibility (axe, minus colour contrast which jsdom cannot compute)', () => {
  async function violations(el: HTMLElement) {
    const result = await axe.run(el, { rules: { 'color-contrast': { enabled: false } } })
    return result.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious').map((v) => `${v.id}: ${v.nodes[0]?.html.slice(0, 120)}`)
  }

  it.each([['/library/artists', 'Artists'], ['/library/albums', 'Albums'], ['/settings', 'Settings'], ['/now-playing', 'Now Playing']])('%s has no serious violations', async (path, name) => {
    usePlayback.getState().playTracks([song('s1', 'One')])
    const { container } = mount(path)
    await screen.findByRole('heading', { level: 1, name: path === '/now-playing' ? 'One' : name })
    await screen.findAllByRole('region', { name: 'Player' })
    expect(await violations(container)).toEqual([])
  })

  it('the connect screen has no serious violations', async () => {
    useAuth.setState({ session: null })
    const { container } = mount('/connect')
    await screen.findByRole('button', { name: 'Connect' })
    expect(await violations(container)).toEqual([])
  })
})
