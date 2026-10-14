const PREVIEW_KEY = 'auralis:mobile-preview'

/** `?mobile=1` / `?mobile=0` toggles a browser preview of the phone UI (sticky across reloads). */
function preview(): boolean {
  try {
    const flag = new URLSearchParams(location.search).get('mobile')
    if (flag !== null) {
      if (flag === '1') localStorage.setItem(PREVIEW_KEY, '1')
      else localStorage.removeItem(PREVIEW_KEY)
    }
    return localStorage.getItem(PREVIEW_KEY) === '1'
  } catch {
    return false
  }
}

/** The Android app gets the Spotify-style phone UI; the web app keeps its own layout at every width. */
export const IS_MOBILE_APP =
  typeof window !== 'undefined' && (('__TAURI_INTERNALS__' in window && /Android/i.test(navigator.userAgent)) || preview())
