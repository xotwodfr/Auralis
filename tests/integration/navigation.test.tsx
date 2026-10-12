import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import App from '../../src/App'
import { useAuth } from '../../src/state/auth'
import { BASE, PASSWORD, USER } from '../server'

beforeEach(() => {
  useAuth.setState({
    hydrated: true,
    session: {
      credentials: { baseUrl: BASE, username: USER, password: PASSWORD },
      server: { apiVersion: '1.16.1' },
      capabilities: { openSubsonic: true, extensions: [], songLyrics: true },
      remember: false,
    },
  })
})

describe('navigation', () => {
  it('lists Now Playing in the sidebar and routes it to /now-playing', async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={['/library/artists']}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    const nav = await screen.findByRole('navigation', { name: 'Main' })
    const link = within(nav).getByRole('link', { name: 'Now Playing' })
    expect(link).toHaveAttribute('href', '/now-playing')
    expect(within(nav).getAllByRole('link').map((l) => l.textContent)).toContain('Now Playing')

    // The player bar has its own always-visible shortcut.
    const bar = screen.getByRole('region', { name: 'Player' })
    expect(within(bar).getByRole('link', { name: 'Lyrics' })).toHaveAttribute('href', '/now-playing')
  })
})
