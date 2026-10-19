import { applyTheme, initTheme, readPref, resolveTheme, useTheme } from '../../src/app/theme'

let dark = false
let onChange: (() => void) | undefined

beforeEach(() => {
  dark = false
  onChange = undefined
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q.includes('prefers-color-scheme') ? dark : false,
    addEventListener: (_: string, fn: () => void) => (onChange = fn),
    removeEventListener: () => undefined,
  }))
  localStorage.clear()
  delete document.documentElement.dataset.theme
  useTheme.setState({ pref: 'system' })
})
afterEach(() => vi.unstubAllGlobals())

describe('theme', () => {
  it('defaults to system and resolves it from the OS preference', () => {
    expect(readPref()).toBe('system')
    expect(resolveTheme('system')).toBe('light')
    dark = true
    expect(resolveTheme('system')).toBe('dark')
    expect(resolveTheme('light')).toBe('light')
  })

  it('persists an explicit choice, applies it, and clears the key for system', () => {
    useTheme.getState().setPref('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(localStorage.getItem('auralis-theme')).toBe('dark')
    expect(readPref()).toBe('dark')

    useTheme.getState().setPref('system')
    expect(localStorage.getItem('auralis-theme')).toBeNull()
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('follows OS changes only while the preference is system', () => {
    initTheme()
    expect(document.documentElement.dataset.theme).toBe('light')
    dark = true
    onChange?.()
    expect(document.documentElement.dataset.theme).toBe('dark')

    useTheme.setState({ pref: 'light' })
    onChange?.()
    expect(document.documentElement.dataset.theme).toBe('dark') // unchanged: explicit choice wins (nothing re-applied)
  })

  it('only eases colours when motion is allowed', () => {
    vi.useFakeTimers()
    applyTheme('dark', true)
    expect(document.documentElement.classList.contains('theme-changing')).toBe(true)
    vi.advanceTimersByTime(300)
    expect(document.documentElement.classList.contains('theme-changing')).toBe(false)
    vi.useRealTimers()

    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('reduce'), addEventListener: () => undefined }))
    applyTheme('light', true)
    expect(document.documentElement.classList.contains('theme-changing')).toBe(false)
  })
})
