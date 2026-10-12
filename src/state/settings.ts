import { create } from 'zustand'
import { kvGet, kvSet } from '../lib/storage'

const KEY = 'settings'

interface SettingsState {
  /** Allow lookups on third-party services (LRCLIB). Server lyrics are always used. */
  externalLookups: boolean
  /** Tell your own server what you play, so its play counts and "recently played" lists stay accurate. */
  reportPlays: boolean
  /** Ask the Auralis lyrics server for word-synced (Spicy) lyrics and automatic Spotify matching. */
  lyricsServerEnabled: boolean
  /** The user's own lyrics server (validated, no trailing slash). Empty = the built-in default. */
  lyricsServerUrl: string
  /** False until stored settings have been read. */
  hydrated: boolean
  setExternalLookups: (on: boolean) => void
  setReportPlays: (on: boolean) => void
  setLyricsServerEnabled: (on: boolean) => void
  setLyricsServerUrl: (url: string) => void
  restore: () => Promise<void>
}

const persist = (s: SettingsState) =>
  kvSet(KEY, {
    externalLookups: s.externalLookups,
    reportPlays: s.reportPlays,
    lyricsServerEnabled: s.lyricsServerEnabled,
    lyricsServerUrl: s.lyricsServerUrl,
  }).catch(() => undefined)

export const useSettings = create<SettingsState>()((set, get) => ({
  externalLookups: true,
  reportPlays: true,
  lyricsServerEnabled: true,
  lyricsServerUrl: '',
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
  async restore() {
    const saved = await kvGet<Record<string, unknown>>(KEY).catch(() => undefined)
    if (!get().hydrated) {
      if (typeof saved?.externalLookups === 'boolean') set({ externalLookups: saved.externalLookups })
      if (typeof saved?.reportPlays === 'boolean') set({ reportPlays: saved.reportPlays })
      if (typeof saved?.lyricsServerEnabled === 'boolean') set({ lyricsServerEnabled: saved.lyricsServerEnabled })
      if (typeof saved?.lyricsServerUrl === 'string') set({ lyricsServerUrl: saved.lyricsServerUrl })
    }
    set({ hydrated: true })
  },
}))
