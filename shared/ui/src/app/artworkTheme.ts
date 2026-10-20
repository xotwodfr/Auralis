import { create } from 'zustand'
import { coverArtUrl } from '../api/subsonic/endpoints'
import type { Credentials } from '../api/subsonic/types'
import { currentEntry } from '../audio/queue'
import { derivePalette, PALETTE_KEYS, parsePalette, type Palette } from '../lib/palette'
import { useAuth } from '../state/auth'
import { usePlayback } from '../state/playback'
import { easeColors, useTheme } from './theme'

const SAMPLE = 32 // cover is sampled at 32×32: enough for a dominant hue, trivial to decode
const REQUEST_PX = 64
const CACHE_MAX = 64
const STORED_KEY = 'auralis-palette'

export type PixelLoader = (url: string) => Promise<Uint8ClampedArray>

/** Draws the image to a tiny canvas. Rejects if the image can't load or the canvas is tainted (no CORS). */
const canvasLoader: PixelLoader = (url) =>
  new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.decoding = 'async'
    img.onerror = () => reject(new Error('artwork failed to load'))
    img.onload = () => {
      try {
        const ctx = Object.assign(document.createElement('canvas'), { width: SAMPLE, height: SAMPLE }).getContext('2d', { willReadFrequently: true })
        if (!ctx) throw new Error('no canvas')
        ctx.drawImage(img, 0, 0, SAMPLE, SAMPLE)
        resolve(ctx.getImageData(0, 0, SAMPLE, SAMPLE).data)
      } catch (e) {
        reject(e)
      }
    }
    img.src = url
  })

let loadPixels: PixelLoader = canvasLoader
/** Test seam: swap the browser-only image decoding for deterministic pixels. */
export const setPixelLoader = (fn: PixelLoader = canvasLoader) => (loadPixels = fn)

// Insertion-ordered Map as a small LRU. Failures are cached too (as null) so a cover that can't be read isn't refetched.
const cache = new Map<string, Palette | null>()
const inflight = new Map<string, Promise<Palette | null>>()
export const clearPaletteCache = () => (cache.clear(), inflight.clear())
export const paletteCacheSize = () => cache.size

export function paletteFor(c: Credentials, coverArt: string): Promise<Palette | null> {
  const key = `${c.baseUrl}|${c.username}|${coverArt}`
  if (cache.has(key)) {
    const hit = cache.get(key)!
    cache.delete(key)
    cache.set(key, hit)
    return Promise.resolve(hit)
  }
  let pending = inflight.get(key)
  if (!pending) {
    pending = loadPixels(coverArtUrl(c, coverArt, REQUEST_PX)).then(derivePalette, () => null).then((p) => {
      cache.set(key, p)
      while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!)
      inflight.delete(key)
      return p
    })
    inflight.set(key, pending)
  }
  return pending
}

/** The last usable palette; kept when art is missing or extraction fails, and mirrored to storage for the next load. */
export const usePalette = create<{ palette: Palette | null }>()(() => ({ palette: readStored() }))

function readStored(): Palette | null {
  try {
    return parsePalette(JSON.parse(localStorage.getItem(STORED_KEY) ?? 'null'))
  } catch {
    return null
  }
}

function applyVars(palette: Palette | null) {
  const style = document.documentElement.style
  for (const k of PALETTE_KEYS) {
    if (palette) style.setProperty(k, palette.vars[k])
    else style.removeProperty(k)
  }
}

/** Colour overrides as inline style, for previews. */
export const paletteStyle = (p: Palette | null) => (p ? (p.vars as Record<string, string>) : undefined)

let wanted = ''

function requestForCurrentTrack() {
  if (useTheme.getState().pref !== 'artwork') return
  const c = useAuth.getState().session?.credentials
  const cover = currentEntry(usePlayback.getState().queue)?.track.coverArt
  if (!c || !cover) return // keep the last palette
  const key = `${c.baseUrl}|${c.username}|${cover}`
  wanted = key
  void paletteFor(c, cover).then((p) => {
    // A newer track may have been selected while this one was decoding.
    if (wanted === key && p && usePalette.getState().palette !== p) usePalette.setState({ palette: p })
  })
}

/** Wire the dynamic theme: reacts to theme choice, track changes and new palettes — never to playhead ticks. */
export function initArtworkTheme() {
  const render = () => {
    const on = useTheme.getState().pref === 'artwork'
    applyVars(on ? usePalette.getState().palette : null)
  }
  render()

  useTheme.subscribe((s, prev) => {
    if (s.pref === prev.pref) return
    render()
    requestForCurrentTrack()
  })
  usePlayback.subscribe((s, prev) => {
    if (s.queue !== prev.queue) requestForCurrentTrack()
  })
  useAuth.subscribe((s, prev) => {
    if (prev.session && !s.session) {
      clearPaletteCache() // covers belong to the account that signed out
      usePalette.setState({ palette: null })
    }
    if (s.session !== prev.session) requestForCurrentTrack()
  })
  usePalette.subscribe((s, prev) => {
    if (s.palette === prev.palette) return
    if (useTheme.getState().pref === 'artwork') {
      easeColors()
      render()
    }
    try {
      if (s.palette) localStorage.setItem(STORED_KEY, JSON.stringify(s.palette))
      else localStorage.removeItem(STORED_KEY)
    } catch {
      // Storage unavailable: palette just isn't restored next time.
    }
  })
  requestForCurrentTrack()
}
