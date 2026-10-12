import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { MemoryRouter } from 'react-router'
import App from '../../src/App'
import { useAuth } from '../../src/state/auth'
import { ALBUMS, BASE, PASSWORD, USER, authed, server } from '../server'

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

describe('browse', () => {
  it('artist → album → tracks, with mapped data', async () => {
    renderAt('/library/artists')
    fireEvent.click(await screen.findByRole('link', { name: /Artist A/ }))
    expect(await screen.findByRole('heading', { name: 'Artist A' })).toBeInTheDocument()

    fireEvent.click(await screen.findByRole('link', { name: /Album 0/ }))
    expect(await screen.findByRole('heading', { name: 'Album 0' })).toBeInTheDocument()
    const tracks = await screen.findByRole('list', { name: 'Tracks' })
    expect(within(tracks).getByText('First Song')).toBeInTheDocument()
    expect(within(tracks).getByText('1:02:05')).toBeInTheDocument()
  })

  it('pages albums with Load more until the last (short) page', async () => {
    renderAt('/library/albums')
    expect(await screen.findAllByRole('link', { name: /Album \d+/ })).toHaveLength(60)
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await screen.findByText('Album 119')
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await screen.findByText('Album 129')
    expect(screen.queryByRole('button', { name: /Load more/ })).not.toBeInTheDocument()
  })

  it('Recently Added requests newest-first albums, shows date added, and pages', async () => {
    const types: (string | null)[] = []
    server.use(
      http.get(`${BASE}/rest/getAlbumList2`, (info) => {
        types.push(new URL(info.request.url).searchParams.get('type'))
        return authed((q) => {
          const offset = Number(q.get('offset'))
          return { albumList2: { album: [...ALBUMS].reverse().slice(offset, offset + Number(q.get('size'))) } }
        })(info)
      }),
    )
    renderAt('/library/recently-added')
    const links = await screen.findAllByRole('link', { name: /Album \d+/ })
    expect(links).toHaveLength(60)
    expect(links[0]).toHaveTextContent('Album 129') // newest first
    expect(links[0]).toHaveTextContent(/Added .*2026/)
    expect(types).toEqual(['newest'])

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await screen.findByText('Album 69')
    expect(types).toEqual(['newest', 'newest'])
  })

  it('navigation has Recently Added and no Tracks; Recent still requests played albums', async () => {
    renderAt('/library/recent')
    const nav = await screen.findByRole('navigation', { name: 'Main' })
    expect(within(nav).getByRole('link', { name: 'Recently Added' })).toHaveAttribute('href', '/library/recently-added')
    expect(within(nav).queryByRole('link', { name: 'Tracks' })).not.toBeInTheDocument()
    expect(within(nav).getByRole('link', { name: 'Recent' })).toHaveAttribute('aria-current', 'page')
  })

  it('shows playlist and favorites content', async () => {
    renderAt('/library/playlists')
    fireEvent.click(await screen.findByRole('link', { name: /Road trip/ }))
    expect(await screen.findByText('First Song')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('link', { name: 'Favorites' }))
    expect(await screen.findByRole('list', { name: 'Favorite tracks' })).toBeInTheDocument()
  })

  it('shows an empty state with a direction', async () => {
    server.use(http.get(`${BASE}/rest/getPlaylists`, authed({ playlists: {} })))
    renderAt('/library/playlists')
    expect(await screen.findByText('No playlists yet')).toBeInTheDocument()
  })

  it('shows a typed error and recovers via Try again', async () => {
    server.use(http.get(`${BASE}/rest/getArtists`, () => HttpResponse.error()))
    renderAt('/library/artists')
    expect(await screen.findByRole('alert')).toHaveTextContent(/Couldn't reach the server/)

    server.resetHandlers()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('link', { name: /Bee Gees/ })).toBeInTheDocument()
  })
})

describe('search', () => {
  it('debounces typing into a single grouped request', async () => {
    const queries: string[] = []
    server.use(
      http.get(`${BASE}/rest/search3`, (info) => {
        queries.push(new URL(info.request.url).searchParams.get('query') ?? '')
        return authed({ searchResult3: { artist: [{ id: 'ar2', name: 'Bee Gees' }], song: [{ id: 's1', title: 'First Song', duration: 10 }] } })(info)
      }),
    )
    renderAt('/library/albums')
    const box = await screen.findByRole('searchbox', { name: 'Search library' })
    for (const v of ['b', 'be', 'bee']) fireEvent.change(box, { target: { value: v } })

    expect(await screen.findByRole('heading', { name: 'Artists' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Tracks' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Albums' })).not.toBeInTheDocument()
    expect(queries).toEqual(['bee'])
  })

  it('shows a no-results state', async () => {
    renderAt('/library/search?q=nothing')
    expect(await screen.findByText('No results for “nothing”')).toBeInTheDocument()
  })
})
