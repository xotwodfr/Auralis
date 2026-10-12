import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { HttpResponse, http } from 'msw'
import { MemoryRouter } from 'react-router'
import { clearLyricsCache } from '../../src/api/lyrics/cache'
import { resetLrclibBackoff } from '../../src/api/lyrics/providers/lrclib'
import { clearSpotifyMatches, resetSpotifyMatchMemory } from '../../src/api/lyrics/resolve'
import App from '../../src/App'
import { backendBase, backendUrl, checkServerUrl } from '../../src/lib/backend'
import { kvGet } from '../../src/lib/storage'
import { useAuth } from '../../src/state/auth'
import { usePlayback } from '../../src/state/playback'
import { useSettings } from '../../src/state/settings'
import { useSpotifyLinks } from '../../src/state/spotifyLinks'
import { BASE, PASSWORD, USER, server } from '../server'

const A = 'https://a.test'
const B = 'https://b.test'
const health = (origin: string, body: object, status = 200) => http.get(`${origin}/api/spicy/health`, () => HttpResponse.json(body, { status }))

beforeEach(async () => {
  useAuth.setState({
    hydrated: true,
    session: { credentials: { baseUrl: BASE, username: USER, password: PASSWORD }, server: { apiVersion: '1.16.1' }, capabilities: { openSubsonic: true, extensions: [], songLyrics: true }, remember: false },
  })
  useSettings.setState({ hydrated: true, lyricsServerEnabled: true, lyricsServerUrl: '' })
  useSpotifyLinks.getState().clear()
  usePlayback.getState().reset()
  resetLrclibBackoff()
  resetSpotifyMatchMemory()
  await clearLyricsCache()
  await clearSpotifyMatches()
})

function open() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/settings']}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return screen.findByRole('textbox', { name: 'Auralis backend URL' }) as Promise<HTMLInputElement>
}
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }))
const type = (el: HTMLElement, v: string) => fireEvent.change(el, { target: { value: v } })

describe('default configuration', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('is the hosted backend in production builds and same origin in dev', async () => {
    vi.stubEnv('PROD', true)
    vi.resetModules()
    expect((await import('../../src/lib/backend')).DEFAULT_LYRICS_SERVER).toBe('https://lyrics.folk3s.com')
    vi.stubEnv('PROD', false)
    vi.resetModules()
    expect((await import('../../src/lib/backend')).DEFAULT_LYRICS_SERVER).toBe('')
  })

  it('is used when nothing is saved, and a saved URL wins', () => {
    expect(backendBase()).toBe('')
    useSettings.setState({ lyricsServerUrl: A })
    expect(backendBase()).toBe(A)
    expect(backendUrl('/api/spicy/match')).toBe(`${A}/api/spicy/match`)
  })
})

describe('URL validation', () => {
  it.each([
    ['not a url', /full address/],
    ['ftp://x.com', /must start with https/],
    ['http://lyrics.example.com', /only allowed for localhost/],
    ['https://u:p@x.com', /Remove the username/],
  ])('explains why %s is rejected', (input, msg) => {
    const r = checkServerUrl(input)
    expect('error' in r && r.error).toMatch(msg)
  })
})

describe('Settings → Lyrics → Auralis backend URL', () => {
  it('shows the saved URL when Settings opens', async () => {
    useSettings.setState({ lyricsServerUrl: A })
    expect((await open()).value).toBe(A)
  })

  it('saves a normalized URL, persists it, and survives a restart', async () => {
    const input = await open()
    type(input, `  ${A}///  `)
    click('Save')
    expect(useSettings.getState().lyricsServerUrl).toBe(A)
    expect(input.value).toBe(A)
    await waitFor(async () => expect(await kvGet('settings')).toMatchObject({ lyricsServerUrl: A }))

    useSettings.setState({ lyricsServerUrl: '', hydrated: false }) // fresh launch
    await useSettings.getState().restore()
    expect(useSettings.getState().lyricsServerUrl).toBe(A)
  })

  it('refuses an invalid URL with a useful message and keeps the old one', async () => {
    useSettings.setState({ lyricsServerUrl: A })
    const input = await open()
    type(input, 'http://lyrics.example.com')
    click('Save')
    expect(await screen.findByRole('alert')).toHaveTextContent('only allowed for localhost')
    expect(useSettings.getState().lyricsServerUrl).toBe(A)
  })

  it('allows http on localhost', async () => {
    const input = await open()
    type(input, 'http://localhost:8787/')
    click('Save')
    expect(useSettings.getState().lyricsServerUrl).toBe('http://localhost:8787')
  })

  it('resets to the default', async () => {
    useSettings.setState({ lyricsServerUrl: A })
    await open()
    click('Reset to default')
    expect(useSettings.getState().lyricsServerUrl).toBe('')
    await waitFor(async () => expect(await kvGet('settings')).toMatchObject({ lyricsServerUrl: '' }))
  })

  it('tests the typed address without saving it, and reports success', async () => {
    server.use(health(B, { enabled: true, matching: true }))
    const input = await open()
    type(input, B)
    click('Test connection')
    expect(await screen.findByText('Connected. Word-synced lyrics and automatic Spotify matching are available.')).toBeInTheDocument()
    expect(useSettings.getState().lyricsServerUrl).toBe('')
  })

  it.each([
    ['unreachable', http.get(`${B}/api/spicy/health`, () => HttpResponse.error()), /Couldn't reach the server/],
    ['an HTTP error', http.get(`${B}/api/spicy/health`, () => new HttpResponse(null, { status: 500 })), /HTTP 500/],
    ['invalid JSON', http.get(`${B}/api/spicy/health`, () => new HttpResponse('{oops', { headers: { 'content-type': 'application/json' } })), /not an Auralis lyrics server/],
    ['an unsupported response', http.get(`${B}/api/spicy/health`, () => HttpResponse.json({ status: 'ok' })), /not an Auralis lyrics server/],
  ])('reports failure when the backend is %s', async (_n, handler, msg) => {
    server.use(handler)
    const input = await open()
    type(input, B)
    click('Test connection')
    expect(await screen.findByRole('alert')).toHaveTextContent(msg)
  })
})

describe('backend switching', () => {
  it('re-checks the new backend as soon as it is saved, without a reload', async () => {
    let calls = 0
    server.use(health(A, { enabled: false, matching: false }, 503), http.get(`${B}/api/spicy/health`, () => (calls++, HttpResponse.json({ enabled: true, matching: true }))))
    useSettings.setState({ lyricsServerUrl: A })
    const input = await open()
    expect(await screen.findByText('Backend running, but SPICY_LYRICS_SECRET_KEY is not set')).toBeInTheDocument()
    type(input, B)
    click('Save')
    expect(await screen.findByText('Ready')).toBeInTheDocument()
    expect(calls).toBe(1)
  })

  it('shows the real error when the backend is down instead of claiming matching works', async () => {
    server.use(http.get(`${A}/api/spicy/health`, () => HttpResponse.error()))
    useSettings.setState({ lyricsServerUrl: A })
    await open()
    expect(await screen.findAllByText(/Couldn't reach the server/)).not.toHaveLength(0)
    expect(screen.queryByText('On (Spotify search)')).toBeNull()
  })
})
