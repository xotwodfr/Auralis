import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import App from '../../src/App'
import { initArtworkTheme, setPixelLoader, usePalette } from '../../src/app/artworkTheme'
import { THEME_OPTIONS, readPref, useTheme } from '../../src/app/theme'
import { derivePalette } from '../../src/lib/palette'
import { useAuth } from '../../src/state/auth'
import { usePlayback } from '../../src/state/playback'
import { useSettings } from '../../src/state/settings'
import { BASE, PASSWORD, USER } from '../server'

beforeAll(() => initArtworkTheme())

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
  useSettings.setState({ hydrated: true, externalLookups: false })
  usePlayback.getState().reset()
  usePalette.setState({ palette: null })
  localStorage.clear()
  useTheme.setState({ pref: 'system' })
})
afterEach(() => setPixelLoader())

const open = () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={['/settings']}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return screen.findByRole('radiogroup', { name: 'Theme' })
}

describe('theme picker', () => {
  it('offers System, Light, Dark and the new presets, labelled light/dark', async () => {
    const group = await open()
    const names = within(group).getAllByRole('radio').map((r) => r.getAttribute('aria-label'))
    expect(names).toEqual(THEME_OPTIONS.map((o) => o.label))
    expect(names).toEqual(expect.arrayContaining(['System', 'Light', 'Dark', 'Midnight', 'OLED Black', 'Nord', 'Sunset', 'Sakura', 'Forest', 'Album Artwork']))
    const sakura = within(group).getByRole('radio', { name: 'Sakura' })
    expect(sakura).toHaveTextContent('Light')
    expect(within(group).getByRole('radio', { name: 'Nord' })).toHaveTextContent('Dark')
    expect(within(group).getByRole('radio', { name: 'System' })).toHaveTextContent('Follows your OS')
    expect(within(group).getByRole('radio', { name: 'System' })).toHaveAttribute('aria-checked', 'true')
  })

  it('selects, applies and persists a preset, including from the keyboard', async () => {
    const group = await open()
    fireEvent.click(within(group).getByRole('radio', { name: 'Nord' }))
    expect(document.documentElement.dataset.theme).toBe('nord')
    expect(localStorage.getItem('auralis-theme')).toBe('nord')
    expect(readPref()).toBe('nord')
    expect(within(group).getByRole('radio', { name: 'Nord' })).toHaveAttribute('aria-checked', 'true')

    fireEvent.keyDown(within(group).getByRole('radio', { name: 'Nord' }), { key: 'ArrowRight' })
    expect(document.documentElement.dataset.theme).toBe('sunset')
    expect(within(group).getByRole('radio', { name: 'Sunset' })).toHaveFocus()
  })

  it('every swatch is painted by its own theme', async () => {
    const group = await open()
    const themes = [...group.querySelectorAll('.swatch[data-theme]')].map((el) => el.getAttribute('data-theme'))
    expect(themes).toEqual(expect.arrayContaining(['light', 'dark', 'midnight', 'oled', 'nord', 'sunset', 'sakura', 'forest', 'artwork']))
  })

  it('System still means light/dark from the OS', async () => {
    const group = await open()
    fireEvent.click(within(group).getByRole('radio', { name: 'Dark' }))
    fireEvent.click(within(group).getByRole('radio', { name: 'System' }))
    expect(localStorage.getItem('auralis-theme')).toBeNull()
    expect(['light', 'dark']).toContain(document.documentElement.dataset.theme)
  })

  it('reads saved values from earlier builds and ignores unknown ones', () => {
    for (const v of ['system', 'light', 'dark']) {
      localStorage.setItem('auralis-theme', v)
      expect(readPref()).toBe(v)
    }
    localStorage.setItem('auralis-theme', 'neon-vomit')
    expect(readPref()).toBe('system')
  })

  it('previews the live Album Artwork palette on its swatch', async () => {
    const palette = derivePalette(new Uint8ClampedArray(Array.from({ length: 64 }, () => [230, 30, 30, 255]).flat()))
    const group = await open()
    act(() => usePalette.setState({ palette }))
    const swatch = within(group).getByRole('radio', { name: 'Album Artwork' }).querySelector<HTMLElement>('.swatch')!
    expect(swatch.style.getPropertyValue('--accent')).toBe(palette.vars['--accent'])

    fireEvent.click(within(group).getByRole('radio', { name: 'Album Artwork' }))
    expect(screen.getByText(/Colours follow the cover/)).toBeInTheDocument()
  })

  it('keeps the artwork palette while navigating between pages', async () => {
    const palette = derivePalette(new Uint8ClampedArray(Array.from({ length: 64 }, () => [30, 60, 230, 255]).flat()))
    usePalette.setState({ palette })
    const group = await open()
    fireEvent.click(within(group).getByRole('radio', { name: 'Album Artwork' }))
    const accent = document.documentElement.style.getPropertyValue('--accent')
    expect(accent).toBe(palette.vars['--accent'])

    fireEvent.click(screen.getByRole('link', { name: 'Albums' }))
    await screen.findByRole('heading', { name: 'Albums' })
    fireEvent.click(screen.getByRole('link', { name: 'Settings' }))
    await screen.findByRole('radiogroup', { name: 'Theme' })
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe(accent)
    expect(document.documentElement.dataset.theme).toBe('artwork')
  })
})
