import { create } from 'zustand'
import { kvGet, kvSet } from '../lib/storage'

const KEY = 'settings'

/** Streaming quality: the bitrate ceiling asked of the server (kbps); `high` streams the original file. */
export type StreamQuality = 'low' | 'normal' | 'high'
export const STREAM_BITRATE: Record<StreamQuality, number | undefined> = { low: 96, normal: 192, high: undefined }
export type LyricSize = 'small' | 'medium' | 'large'
export const EQ_BANDS = 10
export const FLAT_EQ: number[] = Array<number>(EQ_BANDS).fill(0)
export const EQ_PRESETS: { name: string; gains: number[] }[] = [
  { name: 'Flat', gains: FLAT_EQ },
  { name: 'Bass boost', gains: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0] },
  { name: 'Treble boost', gains: [0, 0, 0, 0, 0, 1, 2, 4, 5, 6] },
  { name: 'Vocal', gains: [-2, -2, -1, 0, 2, 4, 4, 2, 0, -1] },
  { name: 'Loudness', gains: [5, 4, 1, 0, -1, -1, 0, 2, 4, 5] },
]
export const MAX_CROSSFADE_S = 12
const isGains = (v: unknown): v is number[] => Array.isArray(v) && v.length === EQ_BANDS && v.every((n) => typeof n === 'number' && Number.isFinite(n))
const isQuality = (v: unknown): v is StreamQuality => v === 'low' || v === 'normal' || v === 'high'
const isSize = (v: unknown): v is LyricSize => v === 'small' || v === 'medium' || v === 'large'

interface SettingsState {
  /** Allow lookups on third-party services (LRCLIB). Server lyrics are always used. */
  externalLookups: boolean
  /** Tell your own server what you play, so its play counts and "recently played" lists stay accurate. */
  reportPlays: boolean
  /** Ask the Auralis lyrics server for word-synced (Spicy) lyrics and automatic Spotify matching. */
  lyricsServerEnabled: boolean
  /** The user's own lyrics server (validated, no trailing slash). Empty = the built-in default. */
  lyricsServerUrl: string
  streamQuality: StreamQuality
  /** Tint the phone UI with the playing cover's colours (gradients and the blurred backdrop). */
  adaptiveColors: boolean
  /** Highlight lyrics word by word when the lyrics carry word timing; off = whole lines only. */
  lyricsWordSync: boolean
  lyricSize: LyricSize
  /** Seconds the end of a track overlaps the start of the next; 0 = off. */
  crossfadeSeconds: number
  eqEnabled: boolean
  /** Equaliser band gains in dB, low to high (`EQ_FREQS` in audio/dsp). */
  eqGains: number[]
  /** False until stored settings have been read. */
  hydrated: boolean
  setExternalLookups: (on: boolean) => void
  setReportPlays: (on: boolean) => void
  setLyricsServerEnabled: (on: boolean) => void
  setLyricsServerUrl: (url: string) => void
  setStreamQuality: (q: StreamQuality) => void
  setAdaptiveColors: (on: boolean) => void
  setLyricsWordSync: (on: boolean) => void
  setLyricSize: (size: LyricSize) => void
  setCrossfadeSeconds: (s: number) => void
  setEqEnabled: (on: boolean) => void
  setEqGains: (gains: number[]) => void
  restore: () => Promise<void>
}

const persist = (s: SettingsState) =>
  kvSet(KEY, {
    externalLookups: s.externalLookups,
    reportPlays: s.reportPlays,
    lyricsServerEnabled: s.lyricsServerEnabled,
    lyricsServerUrl: s.lyricsServerUrl,
    streamQuality: s.streamQuality,
    adaptiveColors: s.adaptiveColors,
    lyricsWordSync: s.lyricsWordSync,
    lyricSize: s.lyricSize,
    crossfadeSeconds: s.crossfadeSeconds,
    eqEnabled: s.eqEnabled,
    eqGains: s.eqGains,
  }).catch(() => undefined)

export const useSettings = create<SettingsState>()((set, get) => ({
  externalLookups: true,
  reportPlays: true,
  lyricsServerEnabled: true,
  lyricsServerUrl: '',
  streamQuality: 'high',
  adaptiveColors: true,
  lyricsWordSync: true,
  lyricSize: 'medium',
  crossfadeSeconds: 0,
  eqEnabled: false,
  eqGains: FLAT_EQ,
  hydrated: false,
  setExternalLookups(on) {
    set({ externalLookups: on })
    void persist(get())
  },
  setReportPlays(on) {
    set({ reportPlays: on })
    void persist(get())
  },
  setLyricsServerEnabled(on) {
    set({ lyricsServerEnabled: on })
    void persist(get())
  },
  setLyricsServerUrl(url) {
    set({ lyricsServerUrl: url })
    void persist(get())
  },
  setStreamQuality(q) {
    set({ streamQuality: q })
    void persist(get())
  },
  setAdaptiveColors(on) {
    set({ adaptiveColors: on })
    void persist(get())
  },
  setLyricsWordSync(on) {
    set({ lyricsWordSync: on })
    void persist(get())
  },
  setLyricSize(size) {
    set({ lyricSize: size })
    void persist(get())
  },
  setCrossfadeSeconds(n) {
    set({ crossfadeSeconds: Math.min(MAX_CROSSFADE_S, Math.max(0, Math.round(n))) })
    void persist(get())
  },
  setEqEnabled(on) {
    set({ eqEnabled: on })
    void persist(get())
  },
  setEqGains(gains) {
    set({ eqGains: gains })
    void persist(get())
  },
  async restore() {
    const saved = await kvGet<Record<string, unknown>>(KEY).catch(() => undefined)
    if (!get().hydrated) {
      if (typeof saved?.externalLookups === 'boolean') set({ externalLookups: saved.externalLookups })
      if (typeof saved?.reportPlays === 'boolean') set({ reportPlays: saved.reportPlays })
      if (typeof saved?.lyricsServerEnabled === 'boolean') set({ lyricsServerEnabled: saved.lyricsServerEnabled })
      if (typeof saved?.lyricsServerUrl === 'string') set({ lyricsServerUrl: saved.lyricsServerUrl })
      if (isQuality(saved?.streamQuality)) set({ streamQuality: saved.streamQuality })
      if (typeof saved?.adaptiveColors === 'boolean') set({ adaptiveColors: saved.adaptiveColors })
      if (typeof saved?.lyricsWordSync === 'boolean') set({ lyricsWordSync: saved.lyricsWordSync })
      if (isSize(saved?.lyricSize)) set({ lyricSize: saved.lyricSize })
      if (typeof saved?.crossfadeSeconds === 'number') set({ crossfadeSeconds: Math.min(MAX_CROSSFADE_S, Math.max(0, saved.crossfadeSeconds)) })
      if (typeof saved?.eqEnabled === 'boolean') set({ eqEnabled: saved.eqEnabled })
      if (isGains(saved?.eqGains)) set({ eqGains: saved.eqGains })
    }
    set({ hydrated: true })
  },
}))
