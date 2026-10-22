import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { MemoryRouter } from 'react-router'
import App from '../../src/App'
import { useAuth } from '../../src/state/auth'
import { audioElement, usePlayback } from '../../src/state/playback'
import { useSettings } from '../../src/state/settings'
import type { FakeAudio } from '../fakeAudio'
import { BASE, PASSWORD, SONGS, USER, authed, failed, server } from '../server'

const audio = audioElement as unknown as FakeAudio

function renderAt(path: string) {
  useAuth.setState({
    hydrated: true,
    session: {
      credentials: { baseUrl: BASE, username: USER, password: PASSWORD },
      server: { apiVersion: '1.16.1', type: 'navidrome' },
      capabilities: { openSubsonic: true, extensions: [], songLyrics: false },
      remember: false,
    },
  })
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

// Someone else is playing Second Song right now; "sam" reported First Song long ago; the signed-in user is also listed.
const nowPlaying = authed({
  nowPlaying: {
    entry: [
      { ...SONGS[1], username: 'alex', minutesAgo: 1, playerName: 'Feishin' },
      { ...SONGS[0], username: 'sam', minutesAgo: 400 },
      { ...SONGS[0], username: USER, minutesAgo: 0 },
    ],
  },
})

beforeEach(() => {
  useSettings.setState({ shareListening: false })
  server.use(http.get(`${BASE}/rest/getNowPlaying`, nowPlaying))
})
afterEach(() => usePlayback.getState().reset())

describe('Social navigation', () => {
  it('is the first destination in the sidebar (its top-left corner) and opens the real Social page', async () => {
    renderAt('/library/artists')
    const nav = screen.getByRole('navigation', { name: 'Main' })
    const links = within(nav).getAllByRole('link')
    expect(links[0]).toHaveAccessibleName('Social')
    fireEvent.click(links[0]!)
    expect(await screen.findByRole('heading', { name: 'Social', level: 1 })).toBeInTheDocument()
    expect(links[0]).toHaveAttribute('aria-current', 'page')
    expect(within(screen.getByRole('navigation', { name: 'Social' })).getByRole('link', { name: 'Activity' })).toHaveAttribute('aria-current', 'page')
  })

  it('never interrupts playback: the queue, the stream and play state survive moving around Social', async () => {
    renderAt('/library/albums/al0')
    fireEvent.click(within(await screen.findByRole('list', { name: 'Tracks' })).getByRole('button', { name: 'Play First Song' }))
    await waitFor(() => expect(audio.paused).toBe(false))
    const loads = audio.loads.length
    const queue = usePlayback.getState().queue

    fireEvent.click(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', { name: 'Social' }))
    await screen.findByText('alex')
    fireEvent.click(screen.getByRole('link', { name: 'People' }))
    fireEvent.click(await screen.findByRole('link', { name: /alex/ }))
    await screen.findByRole('heading', { name: 'alex', level: 2 })

    expect(audio.loads).toHaveLength(loads)
    expect(audio.paused).toBe(false)
    expect(usePlayback.getState().queue).toBe(queue)
  })
})

describe('Activity', () => {
  it("lists other people's tracks, tells live from stale, and plays a track from it", async () => {
    renderAt('/social')
    const list = await screen.findByRole('list', { name: 'Listening activity' })
    const items = within(list).getAllByRole('listitem')
    expect(items).toHaveLength(2) // the signed-in user is not in their own feed
    expect(items[0]).toHaveTextContent('alex')
    expect(items[0]).toHaveTextContent('Listening now · Feishin')
    expect(items[0]).toHaveTextContent('Second Song')
    expect(items[1]).toHaveTextContent('sam')
    expect(items[1]).toHaveTextContent('Played 7 h ago')
    expect(within(items[0]!).getByRole('link', { name: 'Album 0' })).toHaveAttribute('href', '/library/albums/al0')

    fireEvent.click(within(items[0]!).getByRole('button', { name: 'Play Second Song' }))
    await waitFor(() => expect(audio.src).toContain('id=s2'))
  })

  it('has the sharing switch, off by default, and it drives the setting', async () => {
    renderAt('/social')
    const toggle = await screen.findByRole('checkbox', { name: 'Share what I’m playing' })
    expect(toggle).not.toBeChecked()
    expect(screen.getByText(/doesn’t tell music.test what you’re playing/)).toBeInTheDocument()
    fireEvent.click(toggle)
    expect(useSettings.getState().shareListening).toBe(true)
    expect(screen.getByText(/everyone signed in there can see it/)).toBeInTheDocument()
  })

  it('says when nobody else is playing', async () => {
    server.use(http.get(`${BASE}/rest/getNowPlaying`, authed({ nowPlaying: { entry: [{ ...SONGS[0], username: USER, minutesAgo: 0 }] } })))
    renderAt('/social')
    expect(await screen.findByText('Nobody else is playing anything right now')).toBeInTheDocument()
  })

  it('offline: says so and retries', async () => {
    server.use(http.get(`${BASE}/rest/getNowPlaying`, () => HttpResponse.error(), { once: true }))
    renderAt('/social')
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('alex')).toBeInTheDocument()
  })

  it('a rejected session offers to sign in again', async () => {
    server.use(http.get(`${BASE}/rest/getNowPlaying`, () => failed(40, 'Wrong username or password')))
    renderAt('/social')
    expect(await screen.findByRole('button', { name: 'Sign in again' })).toBeInTheDocument()
  })
})

describe('People and profiles', () => {
  it('lists people the server reports, filters them, and opens a profile with real data only', async () => {
    renderAt('/social/people')
    const list = await screen.findByRole('list', { name: 'People' })
    expect(within(list).getAllByRole('link').map((l) => l.textContent)).toEqual([
      expect.stringContaining('alex'),
      expect.stringContaining('sam'),
    ])
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search people' }), { target: { value: 'zzz' } })
    expect(screen.getByText('No one matching “zzz”')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search people' }), { target: { value: 'AL' } })
    fireEvent.click(screen.getByRole('link', { name: /alex/ }))

    expect(await screen.findByRole('heading', { name: 'alex', level: 2 })).toBeInTheDocument()
    expect(screen.getByText('Listening now · Feishin', { selector: '.profile__lines p' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument()
  })

  it('spells out the friends limitation', async () => {
    renderAt('/social/people/alex')
    expect(await screen.findByText('Listening now · Feishin', { selector: '.profile__lines p' })).toBeInTheDocument()
    expect(screen.getByText(/Friend requests would need a social service/)).toBeInTheDocument()
  })
})
