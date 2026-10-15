import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { MemoryRouter } from 'react-router'
import App from '../../src/App'
import type { ChatMessage } from '../../src/api/subsonic/types'
import { kvDelete, kvGet } from '../../src/lib/storage'
import { useAuth } from '../../src/state/auth'
import { audioElement, usePlayback } from '../../src/state/playback'
import { useSettings } from '../../src/state/settings'
import { useSocial } from '../../src/state/social'
import type { FakeAudio } from '../fakeAudio'
import { BASE, PASSWORD, SONGS, USER, authed, failed, server } from '../server'

const audio = audioElement as unknown as FakeAudio
const READ_KEY = `social:lastRead:${BASE}|${USER}`

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

/** A server with a chat room (like Airsonic). */
let room: ChatMessage[]
let posted: string[]
function withChat() {
  server.use(
    http.get(`${BASE}/rest/getChatMessages`, authed((q) => ({ chatMessages: { chatMessage: room.filter((m) => m.time > Number(q.get('since') ?? 0)) } }))),
    http.get(`${BASE}/rest/addChatMessage`, authed((q) => {
      posted.push(q.get('message') ?? '')
      room.push({ username: USER, time: (room.at(-1)?.time ?? 0) + 1000, message: q.get('message') ?? '' })
      return {}
    })),
  )
}

beforeEach(async () => {
  room = [{ username: 'alex', time: 1_000_000, message: 'Anyone else on a Bee Gees kick?' }]
  posted = []
  useSocial.getState().reset()
  useSettings.setState({ shareListening: false })
  await kvDelete(READ_KEY)
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
    fireEvent.click(screen.getByRole('link', { name: 'Chat' }))
    await screen.findByText('Chat isn’t available on this server')
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

describe('Chat', () => {
  it("is honest on a server without chat (Navidrome's 410): no room, no composer", async () => {
    renderAt('/social/chat')
    expect(await screen.findByText('Chat isn’t available on this server')).toBeInTheDocument()
    expect(screen.getByText(/Navidrome doesn’t provide the Subsonic chat room/)).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument()
  })

  it('shows the room, sends a trimmed message, and shows it only once the server has it', async () => {
    withChat()
    renderAt('/social/chat')
    const log = await screen.findByRole('log', { name: 'Messages' })
    expect(log).toHaveTextContent('Anyone else on a Bee Gees kick?')
    expect(screen.getByRole('link', { name: /Everyone on music.test/ })).toHaveAttribute('aria-current', 'page')

    const field = screen.getByRole('textbox', { name: 'Message everyone on this server' })
    const send = screen.getByRole('button', { name: 'Send' })
    fireEvent.change(field, { target: { value: '   ' } })
    expect(send).toBeDisabled() // whitespace only
    fireEvent.change(field, { target: { value: '  Hi <b>all</b> & https://example.com/very/long  ' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    await waitFor(() => expect(posted).toEqual(['Hi <b>all</b> & https://example.com/very/long']))
    const mine = await within(log).findByText('Hi <b>all</b> & https://example.com/very/long') // as text, never as markup
    expect(mine.closest('li')).toHaveTextContent('You')
    expect(field).toHaveValue('')
  })

  it('Shift+Enter is a newline, not a send', async () => {
    withChat()
    renderAt('/social/chat/server')
    const field = await screen.findByRole('textbox', { name: 'Message everyone on this server' })
    fireEvent.change(field, { target: { value: 'line one' } })
    fireEvent.keyDown(field, { key: 'Enter', shiftKey: true })
    await new Promise((r) => setTimeout(r, 20))
    expect(posted).toEqual([])
  })

  it('a failed send says so and keeps the draft; nothing is shown as sent', async () => {
    withChat()
    server.use(http.get(`${BASE}/rest/addChatMessage`, () => HttpResponse.error(), { once: true }))
    renderAt('/social/chat/server')
    const field = await screen.findByRole('textbox', { name: 'Message everyone on this server' })
    fireEvent.change(field, { target: { value: 'Is this thing on?' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t reach the server. Your message wasn’t sent.')
    expect(field).toHaveValue('Is this thing on?')
    expect(screen.getByRole('log', { name: 'Messages' })).not.toHaveTextContent('Is this thing on?')
  })

  it('unread: an old backlog is not unread; a new message badges Social; reading the room clears it', async () => {
    withChat()
    renderAt('/library/artists')
    const social = () => within(screen.getByRole('navigation', { name: 'Main' })).getAllByRole('link')[0]!
    await waitFor(() => expect(useSocial.getState().chat).toBe('ready'))
    expect(social()).toHaveAccessibleName('Social') // the message from before this account first looked is not "new"
    expect(await kvGet(READ_KEY)).toBe(1_000_000)

    room.push({ username: 'alex', time: 2_000_000, message: 'Hello?' }, { username: 'sam', time: 3_000_000, message: 'Here!' })
    await act(() => useSocial.getState().refreshChat()) // what the background poll does every minute
    expect(social()).toHaveAccessibleName('Social, 2 unread')

    fireEvent.click(social())
    expect(await screen.findByRole('link', { name: 'Chat, 2 unread' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('link', { name: 'Chat, 2 unread' }))
    expect(await screen.findByText('Here!')).toBeInTheDocument()
    await waitFor(() => expect(social()).toHaveAccessibleName('Social'))
    expect(await kvGet(READ_KEY)).toBe(3_000_000)
  })

  it('a failed refresh keeps the messages on screen and offers a retry', async () => {
    withChat()
    renderAt('/social/chat/server')
    await screen.findByRole('log', { name: 'Messages' })
    server.use(http.get(`${BASE}/rest/getChatMessages`, () => HttpResponse.error(), { once: true }))
    await act(() => useSocial.getState().refreshChat())
    expect(screen.getByText('Couldn’t check for new messages.')).toBeInTheDocument()
    expect(screen.getByRole('log', { name: 'Messages' })).toHaveTextContent('Anyone else on a Bee Gees kick?')
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.queryByText('Couldn’t check for new messages.')).not.toBeInTheDocument())
  })

  it('messages belong to the account: switching account drops them', async () => {
    withChat()
    renderAt('/social/chat/server')
    await screen.findByRole('log', { name: 'Messages' })
    act(() => useAuth.setState((s) => ({ session: { ...s.session!, credentials: { ...s.session!.credentials, username: 'bob' } } })))
    expect(useSocial.getState().messages).toEqual([])
  })
})

describe('People and profiles', () => {
  it('lists people the server reports, filters them, and opens a profile with real data only', async () => {
    withChat()
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
    expect(screen.getByRole('region', { name: 'Recent messages' })).toHaveTextContent('Anyone else on a Bee Gees kick?')
    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Mention in server chat' }))
    expect(await screen.findByRole('textbox', { name: 'Message everyone on this server' })).toHaveValue('@alex ')
  })

  it('without chat there is no mention action, and the friends limitation is spelled out', async () => {
    renderAt('/social/people/alex')
    expect(await screen.findByText('Listening now · Feishin', { selector: '.profile__lines p' })).toBeInTheDocument()
    await waitFor(() => expect(useSocial.getState().chat).toBe('unsupported'))
    expect(screen.queryByRole('button', { name: 'Mention in server chat' })).not.toBeInTheDocument()
    expect(screen.getByText(/Direct messages and friend requests would need a social service/)).toBeInTheDocument()
  })
})
