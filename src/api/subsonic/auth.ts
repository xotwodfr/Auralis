import { md5 } from '../../lib/md5'
import { SubsonicError } from './errors'

/** Query parameters; an array value is sent as a repeated key. */
export type Params = Record<string, string | number | boolean | string[] | undefined>

export const API_VERSION = '1.16.1'
export const CLIENT_NAME = 'Auralis'

/** 16 hex chars from Web Crypto; a fresh one per request. */
export function generateSalt(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Accepts `host:port` (assumes https), trims trailing slashes, drops query/hash. */
export function normalizeBaseUrl(input: string): string {
  const raw = input.trim()
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    throw new SubsonicError('invalid-url', 'Invalid server address')
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !raw || url.username || url.password) {
    throw new SubsonicError('invalid-url', 'Invalid server address')
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

/** Token auth only (`t`/`s`); the password itself is never sent. */
export function buildUrl(
  baseUrl: string,
  endpoint: string,
  auth?: { username: string; password: string },
  params: Params = {},
  salt = generateSalt(),
): string {
  const url = new URL(`${baseUrl}/rest/${endpoint}`)
  const q = url.searchParams
  // Subsonic repeats a key for list parameters (`songId=a&songId=b`), so arrays append.
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) for (const item of v) q.append(k, String(item))
    else if (v !== undefined) q.set(k, String(v))
  }
  if (auth) {
    q.set('u', auth.username)
    q.set('t', md5(auth.password + salt))
    q.set('s', salt)
  }
  q.set('v', API_VERSION)
  q.set('c', CLIENT_NAME)
  q.set('f', 'json')
  return url.toString()
}
