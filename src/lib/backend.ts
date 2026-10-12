import { useSettings } from '../state/settings'

// Where the Auralis lyrics backend lives. Resolved at call time so the Settings page can change it without a rebuild.
// Precedence: the user's saved URL, then VITE_AURALIS_BACKEND_URL (build-time default), then the hosted server for
// production builds, then same origin (`npm run dev`, `npm start`). All of these are public addresses, never secrets.
export const DEFAULT_LYRICS_SERVER: string = import.meta.env.VITE_AURALIS_BACKEND_URL?.replace(/\/+$/, '') ?? (import.meta.env.PROD ? 'https://lyrics.folk3s.com' : '')

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/** A normalized origin + optional path prefix, or a message fit to show the user. https only, except http on this machine. */
export function checkServerUrl(input: string): { url: string } | { error: string } {
  let u: URL
  try {
    u = new URL(input.trim())
  } catch {
    return { error: 'Enter a full address such as https://lyrics.example.com.' }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: 'The address must start with https:// (or http://localhost for development).' }
  if (u.protocol === 'http:' && !LOOPBACK.has(u.hostname)) return { error: 'Plain http:// is only allowed for localhost. Use https:// for any other server.' }
  if (u.username || u.password || u.search || u.hash) return { error: 'Remove the username, password, query and fragment from the address.' }
  return { url: `${u.origin}${u.pathname}`.replace(/\/+$/, '') }
}

export const parseServerUrl = (input: string): string | null => {
  const r = checkServerUrl(input)
  return 'url' in r ? r.url : null
}

/** Tauri's webview origin: relative URLs there hit the asset handler, which answers 200 for anything. */
const onAssetOrigin = () => /^(tauri:|https?:\/\/tauri\.localhost)/.test(globalThis.location?.origin ?? '')

export const backendBase = (): string => useSettings.getState().lyricsServerUrl || DEFAULT_LYRICS_SERVER

/** Throws if there is no usable server (rather than quietly asking the app's own asset handler). */
export function backendUrl(path: string): string {
  const base = backendBase()
  if (!base && onAssetOrigin()) throw new Error('No lyrics server is configured')
  return `${base}${path}`
}
