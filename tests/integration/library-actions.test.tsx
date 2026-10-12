import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { MemoryRouter } from 'react-router'
import App from '../../src/App'
import { useAuth } from '../../src/state/auth'
import { audioElement, usePlayback } from '../../src/state/playback'
import { useSettings } from '../../src/state/settings'
import type { FakeAudio } from '../fakeAudio'
import { BASE, PASSWORD, SONGS, USER, authed, resetWrites, server, writes } from '../server'

const audio = audioElement as unknown as FakeAudio

function renderAt(path: string) {
  useAuth.setState({
    hydrated: true,
    session: {
      credentials: { baseUrl: BASE, username: USER, password: PASSWORD },
      server: { apiVersion: '1.16.1' },
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

const sent = (endpoint: string) => writes.filter((w) => w.endpoint === endpoint)

beforeEach(() => resetWrites())

describe('favorites', () => {
  it('shows the server state on a track and sends star/unstar on click', async () => {
    renderAt('/library/albums/al0')
    const tracks = await screen.findByRole('list', { name: 'Tracks' })
    // getStarred2 reports s1 ("First Song") as starred.
    const starred = await within(tracks).findByRole('button', { name: 'Remove First Song from favorites' })
    const plain = within(tracks).getByRole('button', { name: 'Add Second Song to favorites' })
    expect(starred).toHaveAttribute('aria-pressed', 'true')
    expect(plain).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(plain)
    // Optimistic: the heart flips before the server answers.
    expect(await within(tracks).findByRole('button', { name: 'Remove Second Song from favorites' })).toBeInTheDocument()
    await waitFor(() => expect(sent('star')).toHaveLength(1))
    expect(sent('star')[0]!.params).toEqual({ id: ['s2'] })

    fireEvent.click(starred)
    await waitFor(() => expect(sent('unstar')).toHaveLength(1))
    expect(sent('unstar')[0]!.params).toEqual({ id: ['s1'] })
  })

  it('stars an album with albumId, not id', async () => {
    renderAt('/library/albums/al0')
    fireEvent.click(await screen.findByRole('button', { name: 'Add Album 0 to favorites' }))
    await waitFor(() => expect(sent('star')).toHaveLength(1))
    expect(sent('star')[0]!.params).toEqual({ albumId: ['al0'] })
  })

  it('stars an artist with artistId', async () => {
    renderAt('/library/artists')
    const list = await screen.findByRole('list', { name: 'Artists' })
    fireEvent.click(await within(list).findByRole('button', { name: 'Add Artist A to favorites' }))
    await waitFor(() => expect(sent('star')).toHaveLength(1))
    expect(sent('star')[0]!.params).toEqual({ artistId: ['ar1'] })
  })

  it('a track starred on the album page shows up on Favorites', async () => {
    renderAt('/library/albums/al0')
    const tracks = await screen.findByRole('list', { name: 'Tracks' })
    fireEvent.click(await within(tracks).findByRole('button', { name: 'Add Second Song to favorites' }))
    await waitFor(() => expect(sent('star')).toHaveLength(1))

    fireEvent.click(screen.getByRole('link', { name: 'Favorites' }))
    const favorites = await screen.findByRole('list', { name: 'Favorite tracks' })
    expect(await within(favorites).findByText('Second Song')).toBeInTheDocument()
  })

  it('rolls the heart back and warns when the server refuses', async () => {
    server.use(http.get(`${BASE}/rest/star`, () => HttpResponse.json({ 'subsonic-response': { status: 'failed', version: '1.16.1', error: { code: 50 } } })))
    renderAt('/library/albums/al0')
    const tracks = await screen.findByRole('list', { name: 'Tracks' })
    fireEvent.click(await within(tracks).findByRole('button', { name: 'Add Second Song to favorites' }))
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't add to favorites.")
    await waitFor(() => expect(within(tracks).getByRole('button', { name: 'Add Second Song to favorites' })).toBeInTheDocument())
  })
})

describe('track actions', () => {
  const openMenu = async (title: string) => {
    const tracks = await screen.findByRole('list', { name: 'Tracks' })
    fireEvent.click(within(tracks).getByRole('button', { name: `More actions for ${title}` }))
    return within(await screen.findByRole('dialog'))
  }

  it('adds a track to an existing playlist', async () => {
    renderAt('/library/albums/al0')
    const menu = await openMenu('Second Song')
    fireEvent.click(menu.getByRole('button', { name: 'Add to playlist…' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Road trip' }))
    await waitFor(() => expect(sent('updatePlaylist')).toHaveLength(1))
    expect(sent('updatePlaylist')[0]!.params).toEqual({ playlistId: ['pl1'], songIdToAdd: ['s2'] })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

  it('creates a playlist from a track', async () => {
    renderAt('/library/albums/al0')
    const menu = await openMenu('First Song')
    fireEvent.click(menu.getByRole('button', { name: 'Add to playlist…' }))
    fireEvent.change(await screen.findByLabelText('New playlist'), { target: { value: '  Late night  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await waitFor(() => expect(sent('createPlaylist')).toHaveLength(1))
    expect(sent('createPlaylist')[0]!.params).toEqual({ name: ['Late night'], songId: ['s1'] })
  })

  it('removes a track from the playlist it is shown in, by position', async () => {
    renderAt('/library/playlists/pl1')
    const tracks = await screen.findByRole('list', { name: 'Tracks' })
    fireEvent.click(within(tracks).getByRole('button', { name: 'More actions for Second Song' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove from this playlist' }))
    await waitFor(() => expect(sent('updatePlaylist')).toHaveLength(1))
    expect(sent('updatePlaylist')[0]!.params).toEqual({ playlistId: ['pl1'], songIndexToRemove: ['1'] })
  })

  it('offers "Remove from this playlist" only inside a playlist', async () => {
    renderAt('/library/albums/al0')
    const menu = await openMenu('First Song')
    expect(menu.queryByRole('button', { name: 'Remove from this playlist' })).not.toBeInTheDocument()
    expect(menu.getByRole('button', { name: 'Go to album' })).toBeInTheDocument()
    expect(menu.getByRole('button', { name: 'Go to artist' })).toBeInTheDocument()
  })

  it('navigates to the artist from the menu', async () => {
    renderAt('/library/albums/al0')
    const menu = await openMenu('First Song')
    fireEvent.click(menu.getByRole('button', { name: 'Go to artist' }))
    expect(await screen.findByRole('heading', { name: 'Artist A', level: 1 })).toBeInTheDocument()
  })

  it('surfaces a playlist failure instead of silently doing nothing', async () => {
    server.use(http.get(`${BASE}/rest/updatePlaylist`, authed(() => ({})), { once: false }))
    server.use(http.get(`${BASE}/rest/getPlaylists`, () => HttpResponse.error()))
    renderAt('/library/albums/al0')
    const menu = await openMenu('First Song')
    fireEvent.click(menu.getByRole('button', { name: 'Add to playlist…' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not|couldn’t|check/i)
  })
})

describe('play reporting', () => {
  it('announces the track, then submits it once past half, and never twice', async () => {
    renderAt('/library/albums/al0')
    const tracks = await screen.findByRole('list', { name: 'Tracks' })
    fireEvent.click(within(tracks).getByRole('button', { name: 'Play First Song' }))

    audio.setDuration(SONGS[0]!.duration)
    audio.tick(1)
    await waitFor(() => expect(sent('scrobble')).toHaveLength(1))
    expect(sent('scrobble')[0]!.params).toEqual({ id: ['s1'], submission: ['false'] })

    audio.tick(SONGS[0]!.duration / 2)
    await waitFor(() => expect(sent('scrobble')).toHaveLength(2))
    expect(sent('scrobble')[1]!.params).toEqual({ id: ['s1'], submission: ['true'] })

    audio.tick(SONGS[0]!.duration - 1)
    audio.tick(SONGS[0]!.duration - 0.5)
    await new Promise((r) => setTimeout(r, 20))
    expect(sent('scrobble')).toHaveLength(2)
    usePlayback.getState().reset()
  })

  it('reports nothing when the preference is off', async () => {
    useSettings.setState({ reportPlays: false })
    renderAt('/library/albums/al0')
    const tracks = await screen.findByRole('list', { name: 'Tracks' })
    fireEvent.click(within(tracks).getByRole('button', { name: 'Play First Song' }))

    audio.setDuration(SONGS[0]!.duration)
    audio.tick(SONGS[0]!.duration / 2)
    await new Promise((r) => setTimeout(r, 20))
    expect(sent('scrobble')).toHaveLength(0)
    useSettings.setState({ reportPlays: true })
    usePlayback.getState().reset()
  })
})
