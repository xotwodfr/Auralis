// Chat server address policy (CHAT.md §10.3). Separate from lib/backend.ts: the lyrics backend stays https-only.
// https:// is always fine. http:// is fine on this machine, and on private networks (LAN, link-local, *.local, Tailscale's
// 100.64/10) only after the user explicitly allows an unencrypted connection, and never from an https page, where the
// browser would block it as mixed content anyway.

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

function isPrivateHost(host: string): boolean {
  if (host.endsWith('.local')) return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)
  }
  // IPv6 link-local (fe80::/10) and unique local (fc00::/7), written in brackets by URL.
  return /^\[(fe[89ab][0-9a-f]|f[cd][0-9a-f]{2}):/i.test(host)
}

export type ChatUrl = { url: string; encrypted: boolean }
export type ChatUrlError = { error: string; needsInsecure?: boolean }

export function checkChatUrl(input: string, opts: { allowInsecure: boolean; pageIsHttps: boolean }): ChatUrl | ChatUrlError {
  let u: URL
  try {
    u = new URL(input.trim())
  } catch {
    return { error: 'Enter a full address such as https://chat.example.com or http://192.168.1.20:8790.' }
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: 'The address must start with https:// (or http:// on your own network).' }
  if (u.username || u.password || u.search || u.hash) return { error: 'Remove the username, password, query and fragment from the address.' }
  const url = `${u.origin}${u.pathname}`.replace(/\/+$/, '')
  if (u.protocol === 'https:') return { url, encrypted: true }
  if (LOOPBACK.has(u.hostname)) return { url, encrypted: false }
  if (!isPrivateHost(u.hostname)) return { error: 'Plain http:// is only allowed on your own network. Use https:// for this server.' }
  if (opts.pageIsHttps) return { error: 'This app is loaded over https://, so the browser blocks unencrypted http:// servers. Use the server’s https:// address (for example its Tailscale name).' }
  if (!opts.allowInsecure) return { error: 'This is an unencrypted address. Tick “Allow unencrypted connection” to use it on a network you trust.', needsInsecure: true }
  return { url, encrypted: false }
}

export const pageIsHttps = () => globalThis.location?.protocol === 'https:'

/** The WebSocket endpoint for a base URL: same host and path prefix, ws(s) scheme. The token is never put in it. */
export const socketUrl = (base: string) => `${base.replace(/^http/, 'ws')}/api/v1/ws`
