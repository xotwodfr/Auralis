import { HttpResponse, http } from 'msw'
import { setupServer } from 'msw/node'
import { md5 } from '../src/lib/md5'

export const BASE = 'https://music.test'
export const USER = 'alice'
export const PASSWORD = 'sesame'

const envelope = (body: object) =>
  HttpResponse.json({
    'subsonic-response': { status: 'ok', version: '1.16.1', type: 'navidrome', serverVersion: '0.55.0', openSubsonic: true, ...body },
  })

export const failed = (code: number, message = 'failed') =>
  HttpResponse.json({ 'subsonic-response': { status: 'failed', version: '1.16.1', error: { code, message } } })

/** Behaves like a Subsonic server: verifies token auth and rejects plaintext `p`. */
export function authed(body: object | ((q: URLSearchParams) => object)) {
  return ({ request }: { request: Request }) => {
    const q = new URL(request.url).searchParams
    if (q.has('p')) return failed(0, 'plaintext password sent')
    const ok = q.get('u') === USER && q.get('t') === md5(PASSWORD + (q.get('s') ?? ''))
    return ok ? envelope(typeof body === 'function' ? body(q) : body) : failed(40, 'Wrong username or password')
  }
}

// Library fixtures. IDs are deliberately mixed string/number-like to exercise "opaque string" handling.
export const ALBUMS = Array.from({ length: 130 }, (_, i) => ({
  id: `al${i}`, name: `Album ${i}`, artist: 'Artist A', artistId: 'ar1', coverArt: `al-${i}`, songCount: 2, duration: 400, year: 2000 + (i % 20),
  created: new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString(),
}))
export const SONGS = [
  { id: 's1', title: 'First Song', album: 'Album 0', albumId: 'al0', artist: 'Artist A', artistId: 'ar1', track: 1, duration: 200, coverArt: 'al-0' },
  { id: 's2', title: 'Second Song', album: 'Album 0', albumId: 'al0', artist: 'Artist A', artistId: 'ar1', track: 2, duration: 3725, coverArt: 'al-0' },
]
export const ARTISTS = [
  { id: 'ar1', name: 'Artist A', albumCount: 130 },
  { id: 'ar2', name: 'Bee Gees', albumCount: 1 },
]

/** Every write the app sends, so tests can assert what reached the server. */
export const writes: { endpoint: string; params: Record<string, string[]> }[] = []
/** Starred state the server actually holds, so a refetch after `star` reflects the change. */
export const starredIds = new Set<string>(['s1'])
export function resetWrites() {
  writes.splice(0, writes.length)
  starredIds.clear()
  starredIds.add('s1')
}

const recorded = (endpoint: string, apply?: (q: URLSearchParams) => void) =>
  authed((q) => {
    const params: Record<string, string[]> = {}
    for (const [k, v] of q.entries()) if (!['u', 't', 's', 'v', 'c', 'f'].includes(k)) (params[k] ??= []).push(v)
    writes.push({ endpoint, params })
    apply?.(q)
    return {}
  })

export const server = setupServer(
  http.get(`${BASE}/rest/ping`, authed({})),
  http.get(`${BASE}/rest/getLicense`, authed({ license: { valid: true } })),
  http.get(`${BASE}/rest/getArtists`, authed({ artists: { index: [{ name: 'A', artist: [ARTISTS[0]] }, { name: 'B', artist: [ARTISTS[1]] }] } })),
  http.get(`${BASE}/rest/getArtist`, authed({ artist: { ...ARTISTS[0], album: ALBUMS.slice(0, 3) } })),
  http.get(`${BASE}/rest/getAlbum`, authed({ album: { ...ALBUMS[0], song: SONGS } })),
  http.get(`${BASE}/rest/getAlbumList2`, authed((q) => {
    const offset = Number(q.get('offset') ?? 0)
    // `newest` is by date added, descending; other types keep fixture order.
    const all = q.get('type') === 'newest' ? [...ALBUMS].reverse() : ALBUMS
    return { albumList2: { album: all.slice(offset, offset + Number(q.get('size') ?? 10)) } }
  })),
  http.get(`${BASE}/rest/getStarred2`, authed(() => ({
    starred2: {
      song: SONGS.filter((x) => starredIds.has(x.id)),
      album: ALBUMS.filter((x) => starredIds.has(x.id)),
      artist: ARTISTS.filter((x) => starredIds.has(x.id)),
    },
  }))),
  http.get(`${BASE}/rest/getPlaylists`, authed({ playlists: { playlist: [{ id: 'pl1', name: 'Road trip', songCount: 2, duration: 3925, owner: USER }] } })),
  http.get(`${BASE}/rest/getPlaylist`, authed({ playlist: { id: 'pl1', name: 'Road trip', songCount: 2, duration: 3925, entry: SONGS } })),
  http.get(`${BASE}/rest/search3`, authed((q) => {
    const term = q.get('query') ?? ''
    if (term === 'nothing') return { searchResult3: {} }
    return { searchResult3: { artist: [ARTISTS[1]], album: ALBUMS.slice(0, 1), song: SONGS } }
  })),
  http.get(`${BASE}/rest/star`, recorded('star', (q) => q.getAll('id').concat(q.getAll('albumId'), q.getAll('artistId')).forEach((id) => starredIds.add(id)))),
  http.get(`${BASE}/rest/unstar`, recorded('unstar', (q) => q.getAll('id').concat(q.getAll('albumId'), q.getAll('artistId')).forEach((id) => starredIds.delete(id)))),
  http.get(`${BASE}/rest/scrobble`, recorded('scrobble')),
  http.get(`${BASE}/rest/createPlaylist`, recorded('createPlaylist')),
  http.get(`${BASE}/rest/updatePlaylist`, recorded('updatePlaylist')),
  // Like Navidrome: nobody else playing.
  http.get(`${BASE}/rest/getNowPlaying`, authed({ nowPlaying: {} })),
  http.get(`${BASE}/rest/getOpenSubsonicExtensions`, () =>
    envelope({ openSubsonicExtensions: [{ name: 'songLyrics', versions: [1] }] }),
  ),
)

export { envelope }
