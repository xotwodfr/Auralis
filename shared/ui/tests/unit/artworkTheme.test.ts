import { act } from '@testing-library/react'
import { clearPaletteCache, initArtworkTheme, paletteCacheSize, paletteFor, setPixelLoader, usePalette } from '../../src/app/artworkTheme'
import { useTheme } from '../../src/app/theme'
import type { Song } from '../../src/api/subsonic/types'
import { useAuth } from '../../src/state/auth'
import { audioElement, usePlayback } from '../../src/state/playback'
import type { FakeAudio } from '../fakeAudio'
import { BASE, PASSWORD, USER } from '../server'

const audio = audioElement as unknown as FakeAudio
const creds = { baseUrl: BASE, username: USER, password: PASSWORD }
const solid = (r: number, g: number, b: number) => new Uint8ClampedArray(Array.from({ length: 64 }, () => [r, g, b, 255]).flat())
const RED = solid(230, 30, 30)
const BLUE = solid(30, 60, 230)
const song = (id: string, coverArt?: string): Song => ({ id, title: id, artist: 'x', album: 'y', duration: 100, coverArt })
const root = document.documentElement
const accent = () => root.style.getPropertyValue('--accent')

let loads: string[]
let pixels: Record<string, Uint8ClampedArray | Promise<Uint8ClampedArray> | Error>
const idOf = (url: string) => new URL(url).searchParams.get('id')!

beforeAll(() => {
  setPixelLoader(async (url) => {
    loads.push(idOf(url))
    const p = pixels[idOf(url)]
    if (p instanceof Error) throw p
    return p ?? RED
  })
  initArtworkTheme() // module-level subscriptions: wire once for the file
})
afterAll(() => setPixelLoader())

beforeEach(() => {
  useTheme.setState({ pref: 'dark' }) // first, so leftovers from the previous test can't trigger a load
  loads = []
  pixels = {}
  clearPaletteCache()
  localStorage.clear()
  useAuth.setState({ hydrated: true, session: { credentials: creds, server: { apiVersion: '1' }, capabilities: { openSubsonic: false, extensions: [], songLyrics: false }, remember: false } })
  usePlayback.getState().reset()
  usePalette.setState({ palette: null })
  root.removeAttribute('style')
})

const settle = () => act(() => new Promise((r) => setTimeout(r, 0)))

describe('artwork theme', () => {
  it('applies the cover palette when the theme is on, and removes it when switched away', async () => {
    useTheme.setState({ pref: 'artwork' })
    usePlayback.getState().playTracks([song('a', 'cov-red')])
    await settle()
    expect(accent()).toMatch(/^#/)
    expect(usePalette.getState().palette?.hue).toBeLessThan(20)

    useTheme.setState({ pref: 'midnight' })
    expect(accent()).toBe('') // presets are never contaminated by a previous cover
    expect(usePalette.getState().palette).not.toBeNull() // …but the palette is remembered
    useTheme.setState({ pref: 'artwork' })
    expect(accent()).toMatch(/^#/) // re-applied immediately
  })

  it('does not extract anything for other themes', async () => {
    usePlayback.getState().playTracks([song('a', 'cov-red')])
    await settle()
    expect(loads).toEqual([])
    expect(accent()).toBe('')
  })

  it('follows track changes and caches by cover, so the same album art is read once', async () => {
    useTheme.setState({ pref: 'artwork' })
    pixels = { 'cov-red': RED, 'cov-blue': BLUE }
    usePlayback.getState().playTracks([song('a', 'cov-red'), song('b', 'cov-red'), song('c', 'cov-blue')])
    await settle()
    const red = accent()
    act(() => usePlayback.getState().jump(1))
    await settle()
    expect(accent()).toBe(red)
    act(() => usePlayback.getState().jump(2))
    await settle()
    expect(accent()).not.toBe(red)
    act(() => usePlayback.getState().jump(0))
    await settle()
    expect(accent()).toBe(red)
    expect(loads).toEqual(['cov-red', 'cov-blue'])
  })

  it('does nothing on playhead updates', async () => {
    useTheme.setState({ pref: 'artwork' })
    usePlayback.getState().playTracks([song('a', 'cov-red')])
    await settle()
    for (let t = 1; t <= 20; t++) act(() => audio.tick(t))
    await settle()
    expect(loads).toEqual(['cov-red'])
  })

  it('ignores a slow result for a previous track', async () => {
    useTheme.setState({ pref: 'artwork' })
    let releaseRed!: (p: Uint8ClampedArray) => void
    pixels = { 'cov-red': new Promise((r) => (releaseRed = r)), 'cov-blue': BLUE }
    usePlayback.getState().playTracks([song('a', 'cov-red'), song('b', 'cov-blue')])
    await settle()
    act(() => usePlayback.getState().jump(1))
    await settle()
    const blue = accent()
    expect(usePalette.getState().palette?.hue).toBeGreaterThan(200)

    releaseRed(RED) // the first track's extraction finishes last
    await settle()
    expect(accent()).toBe(blue)
    expect(usePalette.getState().palette?.hue).toBeGreaterThan(200)
  })

  it('keeps the last palette when art is missing, extraction fails, or playback stops — and does not retry failures', async () => {
    useTheme.setState({ pref: 'artwork' })
    pixels = { 'cov-red': RED, broken: new Error('tainted canvas') }
    usePlayback.getState().playTracks([song('a', 'cov-red'), song('b'), song('c', 'broken')])
    await settle()
    const red = accent()

    act(() => usePlayback.getState().jump(1)) // no artwork
    await settle()
    expect(accent()).toBe(red)

    act(() => usePlayback.getState().jump(2)) // unreadable artwork
    await settle()
    expect(accent()).toBe(red)
    act(() => usePlayback.getState().jump(0))
    act(() => usePlayback.getState().jump(2))
    await settle()
    expect(loads.filter((l) => l === 'broken')).toHaveLength(1)

    act(() => usePlayback.getState().clearQueue())
    await settle()
    expect(accent()).toBe(red)
  })

  it('bounds the cache and coalesces concurrent requests', async () => {
    await Promise.all(Array.from({ length: 5 }, () => paletteFor(creds, 'same')))
    expect(loads).toEqual(['same'])
    for (let i = 0; i < 80; i++) await paletteFor(creds, `c${i}`)
    expect(paletteCacheSize()).toBeLessThanOrEqual(64)
  })

  it('stores the palette for the next load and eases colours only when motion is allowed', async () => {
    useTheme.setState({ pref: 'artwork' })
    usePlayback.getState().playTracks([song('a', 'cov-red')])
    await settle()
    expect(JSON.parse(localStorage.getItem('auralis-palette')!).vars['--accent']).toBe(accent())
    expect(root.classList.contains('theme-changing')).toBe(true)

    root.classList.remove('theme-changing')
    const original = window.matchMedia
    window.matchMedia = ((q: string) => ({ matches: q.includes('reduce'), addEventListener: () => undefined })) as never
    act(() => usePlayback.getState().playTracks([song('b', 'cov-blue')]))
    await settle()
    expect(root.classList.contains('theme-changing')).toBe(false)
    window.matchMedia = original
  })
})
