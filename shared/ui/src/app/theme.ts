import { create } from 'zustand'

export const THEME_PRESETS = ['light', 'dark', 'midnight', 'oled', 'nord', 'sunset', 'sakura', 'forest', 'artwork'] as const
export type ThemePref = 'system' | (typeof THEME_PRESETS)[number]

export interface ThemeOption {
  value: ThemePref
  label: string
  scheme: 'Light' | 'Dark' | 'Auto'
}

/** Order = display order in Settings. `scheme` is the badge text; the colours live in tokens.css. */
export const THEME_OPTIONS: ThemeOption[] = [
  { value: 'system', label: 'System', scheme: 'Auto' },
  { value: 'light', label: 'Light', scheme: 'Light' },
  { value: 'dark', label: 'Dark', scheme: 'Dark' },
  { value: 'midnight', label: 'Midnight', scheme: 'Dark' },
  { value: 'oled', label: 'OLED Black', scheme: 'Dark' },
  { value: 'nord', label: 'Nord', scheme: 'Dark' },
  { value: 'sunset', label: 'Sunset', scheme: 'Dark' },
  { value: 'forest', label: 'Forest', scheme: 'Dark' },
  { value: 'sakura', label: 'Sakura', scheme: 'Light' },
  { value: 'artwork', label: 'Album Artwork', scheme: 'Dark' },
]

// localStorage rather than IndexedDB: it is synchronous, so index.html can apply the theme before first paint.
// Values written by older builds (system/light/dark) stay valid; anything unknown falls back to system.
const KEY = 'auralis-theme'

export function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY)
    return (THEME_PRESETS as readonly string[]).includes(v ?? '') ? (v as ThemePref) : 'system'
  } catch {
    return 'system'
  }
}

const media = (q: string) => window.matchMedia?.(q)

/** The `data-theme` value for a preference: presets map to themselves, `system` to light/dark. */
export const resolveTheme = (p: ThemePref): Exclude<ThemePref, 'system'> =>
  p === 'system' ? (media('(prefers-color-scheme: dark)')?.matches ? 'dark' : 'light') : p

/** Ease colours for ~200ms (skipped under reduced motion). Glass surfaces are excluded in CSS. */
export function easeColors() {
  if (media('(prefers-reduced-motion: reduce)')?.matches) return
  const root = document.documentElement
  root.classList.add('theme-changing')
  setTimeout(() => root.classList.remove('theme-changing'), 250)
}

export function applyTheme(pref: ThemePref, animate = false) {
  if (animate) easeColors()
  document.documentElement.dataset.theme = resolveTheme(pref)
}

export const useTheme = create<{ pref: ThemePref; setPref: (p: ThemePref) => void }>()((set) => ({
  pref: readPref(),
  setPref(pref) {
    try {
      if (pref === 'system') localStorage.removeItem(KEY)
      else localStorage.setItem(KEY, pref)
    } catch {
      // Private mode: the choice just won't persist.
    }
    set({ pref })
    applyTheme(pref, true)
  },
}))

/** Apply the saved theme and follow OS changes while the preference is "system". */
export function initTheme() {
  applyTheme(useTheme.getState().pref)
  media('(prefers-color-scheme: dark)')?.addEventListener('change', () => {
    if (useTheme.getState().pref === 'system') applyTheme('system', true)
  })
}
