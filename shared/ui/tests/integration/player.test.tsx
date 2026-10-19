import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import App from '../../src/App'
import { useAuth } from '../../src/state/auth'
import { audioElement, usePlayback } from '../../src/state/playback'
import type { FakeAudio } from '../fakeAudio'
import { BASE, PASSWORD, USER } from '../server'

const audio = audioElement as unknown as FakeAudio
// The page's "Play" button; the player bar has its own transport "Play".
const albumPlay = async () => within(await screen.findByRole('main')).findByRole('button', { name: 'Play' })

beforeEach(() => {
  useAuth.setState({
    hydrated: true,
    session: {
      credentials: { baseUrl: BASE, username: USER, password: PASSWORD },
      server: { apiVersion: '1.16.1' },
      capabilities: { openSubsonic: true, extensions: [], songLyrics: false },
      remember: false,
    },
  })
  usePlayback.getState().reset()
  audio.loads.length = 0
  audio.paused = true
  audio.error = null
})

function renderAt(path: string) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return screen.findByRole('region', { name: 'Player' })
}

describe('player bar', () => {
  it('starts empty and accessible', async () => {
    const bar = within(await renderAt('/library/artists'))
    expect(bar.getByText('Nothing playing')).toBeInTheDocument()
    expect(bar.getByRole('button', { name: 'Play' })).toBeInTheDocument()
    expect(bar.getByRole('slider', { name: 'Seek' })).toBeDisabled()
    expect(bar.getByRole('slider', { name: 'Volume' })).toBeEnabled()
    for (const name of ['Shuffle', 'Previous track', 'Next track', 'Repeat off', 'Queue']) {
      expect(bar.getByRole('button', { name })).toBeInTheDocument()
    }
  })

  it('plays a track from an album, shows it, and keeps playing across route changes', async () => {
    const bar = within(await renderAt('/library/albums/al0'))
    const tracks = await screen.findByRole('list', { name: 'Tracks' })
    fireEvent.click(within(tracks).getByRole('button', { name: 'Play Second Song' }))

    expect(await bar.findByText('Second Song')).toBeInTheDocument()
    expect(audio.loads).toHaveLength(1)
    expect(await bar.findByRole('button', { name: 'Pause' })).toBeInTheDocument()
    expect(within(tracks).getByRole('button', { name: 'Play Second Song' })).toHaveAttribute('aria-current', 'true')

    fireEvent.click(screen.getByRole('link', { name: 'Artists' }))
    await screen.findByRole('link', { name: /Bee Gees/ })
    fireEvent.click(screen.getByRole('link', { name: 'Settings' }))
    await screen.findByRole('heading', { name: 'Settings' })

    expect(bar.getByText('Second Song')).toBeInTheDocument()
    expect(audio.loads).toHaveLength(1) // never reloaded
    expect(audio.paused).toBe(false)
  })

  it('album Play starts the whole album and Shuffle turns shuffle on', async () => {
    const bar = within(await renderAt('/library/albums/al0'))
    fireEvent.click(await albumPlay())
    expect(await bar.findByText('First Song')).toBeInTheDocument()
    expect(usePlayback.getState().queue.items).toHaveLength(2)

    fireEvent.click(within(screen.getByRole('main')).getByRole('button', { name: 'Shuffle' }))
    expect(usePlayback.getState().queue.shuffle).toBe(true)
  })

  it('seeks from the slider and shows elapsed / total time', async () => {
    const bar = within(await renderAt('/library/albums/al0'))
    fireEvent.click(await albumPlay())
    await bar.findByText('First Song')
    audio.setDuration(200)
    audio.tick(65)
    expect(await bar.findByText('1:05')).toBeInTheDocument()
    expect(bar.getByText('3:20')).toBeInTheDocument()
    expect(bar.getByRole('slider', { name: 'Seek' })).toHaveAttribute('aria-valuetext', '1:05 of 3:20')

    fireEvent.change(bar.getByRole('slider', { name: 'Seek' }), { target: { value: '120' } })
    expect(audio.currentTime).toBe(120)
  })

  it('volume changes apply to the audio element', async () => {
    const bar = within(await renderAt('/library/artists'))
    fireEvent.change(bar.getByRole('slider', { name: 'Volume' }), { target: { value: '0.25' } })
    expect(audio.volume).toBe(0.25)
  })

  it('shows loading/buffering text and a stream error with Retry', async () => {
    const bar = within(await renderAt('/library/albums/al0'))
    fireEvent.click(await albumPlay())
    expect(await bar.findByText('Loading…')).toBeInTheDocument()
    audio.fire('waiting')
    expect(await bar.findByText('Buffering…')).toBeInTheDocument()

    audio.fail(4)
    expect(await bar.findByRole('alert')).toHaveTextContent(/format isn't supported|session was rejected|Network problem/)
    fireEvent.click(bar.getByRole('button', { name: 'Retry' }))
    expect(audio.loads).toHaveLength(2)
  })
})

describe('queue panel', () => {
  async function openQueue() {
    const bar = within(await renderAt('/library/albums/al0'))
    fireEvent.click(await albumPlay())
    await bar.findByText('First Song')
    fireEvent.click(bar.getByRole('button', { name: 'Queue' }))
    return within(await screen.findByRole('complementary', { name: 'Queue' }))
  }

  it('marks the current track, reorders, removes, clears, and closes with Escape', async () => {
    const queue = await openQueue()
    const list = within(queue.getByRole('list', { name: 'Queue' }))
    expect(list.getAllByRole('listitem')).toHaveLength(2)
    expect(queue.getByText(/Now playing/)).toBeInTheDocument()
    expect(queue.getByText(/1 up next/)).toBeInTheDocument()

    fireEvent.click(list.getByRole('button', { name: 'Move Second Song up' }))
    expect(usePlayback.getState().queue.items.map((e) => e.track.id)).toEqual(['s2', 's1'])
    expect(audio.loads).toHaveLength(1) // reordering never interrupts the stream

    fireEvent.click(list.getByRole('button', { name: 'Remove Second Song from queue' }))
    expect(list.getAllByRole('listitem')).toHaveLength(1)

    fireEvent.click(queue.getByRole('button', { name: 'Clear queue' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Clear queue' }))
    expect(await queue.findByText('The queue is empty')).toBeInTheDocument()
    expect(audio.src).toBe('')

    fireEvent.keyDown(queue.getByRole('heading', { name: /Queue/ }), { key: 'Escape' })
    expect(screen.queryByRole('complementary', { name: 'Queue' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Queue' })).toHaveFocus()
  })

  it('"Add to queue" and "Play next" in a track\u2019s actions feed the queue without starting playback', async () => {
    const bar = within(await renderAt('/library/albums/al0'))
    const tracks = await screen.findByRole('list', { name: 'Tracks' })

    fireEvent.click(within(tracks).getByRole('button', { name: 'More actions for Second Song' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Add to queue' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    fireEvent.click(within(tracks).getByRole('button', { name: 'More actions for First Song' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Play next' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())

    expect(usePlayback.getState().queue.items.map((e) => e.track.id)).toEqual(['s1', 's2'])
    expect(audio.loads).toHaveLength(0)
    expect(bar.getByText('Nothing playing')).toBeInTheDocument()
  })
})
