import { SubsonicError } from '../../api/subsonic/errors'

const isTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

const DESKTOP_TLS_HINT =
  ' On the Linux desktop app this usually means the TLS library (glib-networking) is missing: launch it from the project nix-shell or install glib-networking.'

export function connectErrorMessage(e: unknown): string {
  if (!(e instanceof SubsonicError)) return 'Something went wrong. Try again.'
  switch (e.kind) {
    case 'invalid-url':
      return 'Enter a valid server address, like https://music.example.com.'
    case 'network':
      return "Couldn't reach the server. Check the address and your connection. If Auralis is served over HTTPS, the server must use HTTPS and allow CORS." + (isTauri() ? DESKTOP_TLS_HINT : '')
    case 'http':
      return `The server responded with HTTP ${e.status}. Check the address.`
    case 'invalid-response':
      return "That address didn't respond like a Subsonic server."
    case 'auth':
      return e.code === 41
        ? "This server doesn't support token authentication."
        : 'Wrong username or password.'
    case 'not-authorized':
      return "This account isn't allowed to use the server."
    case 'trial-expired':
      return "The server's trial period has expired."
    default:
      return e.message
  }
}
