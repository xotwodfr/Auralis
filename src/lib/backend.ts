import { useSettings } from '../state/settings'

// Where the Auralis lyrics backend lives. Resolved at call time so the Settings page can change it without a rebuild.
// Precedence: the user's saved URL, then VITE_AURALIS_BACKEND_URL (build-time default), then the hosted server for
// production builds, then same origin (`npm run dev`, `npm start`). All of these are public addresses, never secrets.
export const DEFAULT_LYRICS_SERVER: string = import.meta.env.VITE_AURALIS_BACKEND_URL?.replace(/\/+$/, '') ?? (import.meta.env.PROD ? 'https://lyrics.folk3s.com' : '')

/** A normalized http(s) origin + optional path prefix, or null. Rejects other protocols, credentials, queries and fragments. */
export function parseServerUrl(input: string): string | null {
  let u: URL
  try {
    u = new URL(input.trim())
  } catch {
    return null
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || u.search || u.hash) return null
  return `${u.origin}${u.pathname}`.replace(/\/+$/, '')
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
