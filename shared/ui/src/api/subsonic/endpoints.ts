import { buildUrl } from './auth'
import { request } from './client'
import { SubsonicError } from './errors'
import type { Album, Artist, ChatMessage, Credentials, NowPlayingEntry, OpenSubsonicExtension, Playlist, SearchResults, Song, StructuredLyrics } from './types'

const auth = ({ username, password }: Credentials) => ({ username, password })

export const ping = (c: Credentials, signal?: AbortSignal) =>
  request(c.baseUrl, 'ping', { auth: auth(c), signal })

export const getLicense = (c: Credentials, signal?: AbortSignal) =>
  request<{ license: { valid: boolean; email?: string } }>(c.baseUrl, 'getLicense', { auth: auth(c), signal })

/** Public endpoint: no credentials needed. */
export const getOpenSubsonicExtensions = (baseUrl: string, signal?: AbortSignal) =>
  request<{ openSubsonicExtensions?: OpenSubsonicExtension[] }>(baseUrl, 'getOpenSubsonicExtensions', { signal })

// ── Library (M2) ────────────────────────────────────────────────────────────

type Id = string | number
interface RawArtist { id: Id; name?: string; albumCount?: number; coverArt?: Id; starred?: unknown }
interface RawAlbum { id: Id; name?: string; title?: string; artist?: string; artistId?: Id; coverArt?: Id; songCount?: number; duration?: number; year?: number; created?: string; starred?: unknown }
interface RawSong { id: Id; title?: string; album?: string; albumId?: Id; artist?: string; artistId?: Id; track?: number; discNumber?: number; duration?: number; coverArt?: Id; isrc?: unknown; explicitStatus?: unknown; starred?: unknown }
interface RawPlaylist { id: Id; name?: string; songCount?: number; duration?: number; coverArt?: Id; owner?: string }
interface RawSearch { artist?: RawArtist[]; album?: RawAlbum[]; song?: RawSong[] }

const str = (v?: Id) => (v === undefined ? undefined : String(v))
// Servers (and proxies) occasionally send odd shapes; a malformed list degrades to "empty" instead of throwing.
const list = <T>(v?: T[]): T[] => (Array.isArray(v) ? v.filter((x) => typeof x === 'object' && x !== null) : [])
const need = <T>(v: T | undefined): T => {
  if (v === undefined) throw new SubsonicError('invalid-response', 'Response is missing expected data')
  return v
}

// Subsonic sends `starred` as the ISO time the user starred it; its presence is the flag.
const star = (v: unknown) => (typeof v === 'string' && v !== '' ? { starred: true } : {})

export const mapArtist = (a: RawArtist): Artist => ({
  id: String(a.id), name: a.name ?? '', albumCount: a.albumCount ?? 0, coverArt: str(a.coverArt), ...star(a.starred),
})
export const mapAlbum = (a: RawAlbum): Album => ({
  id: String(a.id), name: a.name ?? a.title ?? '', artist: a.artist ?? '', artistId: str(a.artistId),
  coverArt: str(a.coverArt), songCount: a.songCount ?? 0, duration: a.duration ?? 0, year: a.year, created: a.created,
  ...star(a.starred),
})
// OpenSubsonic `isrc` is a list; keep only well-formed codes.
const isrcs = (v: unknown) => {
  const list = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && /^[A-Za-z]{2}[A-Za-z0-9]{3}\d{7}$/.test(x)).map((x) => x.toUpperCase()) : []
  return list.length ? { isrc: list } : {}
}
export const mapSong = (s: RawSong): Song => ({
  id: String(s.id), title: s.title ?? '', album: s.album ?? '', albumId: str(s.albumId), artist: s.artist ?? '',
  artistId: str(s.artistId), track: s.track, discNumber: s.discNumber, duration: s.duration ?? 0, coverArt: str(s.coverArt),
  ...isrcs(s.isrc),
  ...star(s.starred),
  ...(s.explicitStatus === 'explicit' ? { explicit: true } : s.explicitStatus === 'clean' ? { explicit: false } : {}),
})
export const mapPlaylist = (p: RawPlaylist): Playlist => ({
  id: String(p.id), name: p.name ?? '', songCount: p.songCount ?? 0, duration: p.duration ?? 0,
  coverArt: str(p.coverArt), owner: p.owner,
})
const mapSearch = (r: RawSearch = {}): SearchResults => ({
  artists: list(r.artist).map(mapArtist), albums: list(r.album).map(mapAlbum), songs: list(r.song).map(mapSong),
})

export async function getArtists(c: Credentials, signal?: AbortSignal): Promise<Artist[]> {
  const r = await request<{ artists?: { index?: { artist?: RawArtist[] }[] } }>(c.baseUrl, 'getArtists', { auth: auth(c), signal })
  return list(r.artists?.index).flatMap((i) => list(i.artist)).map(mapArtist)
}

export async function getArtist(c: Credentials, id: string, signal?: AbortSignal) {
  const r = await request<{ artist?: RawArtist & { album?: RawAlbum[] } }>(c.baseUrl, 'getArtist', { auth: auth(c), params: { id }, signal })
  const a = need(r.artist)
  return { artist: mapArtist(a), albums: list(a.album).map(mapAlbum) }
}

export async function getAlbum(c: Credentials, id: string, signal?: AbortSignal) {
  const r = await request<{ album?: RawAlbum & { song?: RawSong[] } }>(c.baseUrl, 'getAlbum', { auth: auth(c), params: { id }, signal })
  const a = need(r.album)
  return { album: mapAlbum(a), songs: list(a.song).map(mapSong) }
}

export async function getSong(c: Credentials, id: string, signal?: AbortSignal): Promise<Song> {
  const r = await request<{ song?: RawSong }>(c.baseUrl, 'getSong', { auth: auth(c), params: { id }, signal })
  return mapSong(need(r.song))
}

export type AlbumListType = 'newest' | 'recent' | 'frequent' | 'random' | 'alphabeticalByName' | 'alphabeticalByArtist'

export async function getAlbumList2(
  c: Credentials,
  params: { type: AlbumListType; size?: number; offset?: number },
  signal?: AbortSignal,
): Promise<Album[]> {
  const r = await request<{ albumList2?: { album?: RawAlbum[] } }>(c.baseUrl, 'getAlbumList2', { auth: auth(c), params, signal })
  return list(r.albumList2?.album).map(mapAlbum)
}

export async function getStarred2(c: Credentials, signal?: AbortSignal): Promise<SearchResults> {
  const r = await request<{ starred2?: RawSearch }>(c.baseUrl, 'getStarred2', { auth: auth(c), signal })
  return mapSearch(r.starred2)
}

export async function getRandomSongs(c: Credentials, size = 50, signal?: AbortSignal): Promise<Song[]> {
  const r = await request<{ randomSongs?: { song?: RawSong[] } }>(c.baseUrl, 'getRandomSongs', { auth: auth(c), params: { size }, signal })
  return list(r.randomSongs?.song).map(mapSong)
}

export async function getPlaylists(c: Credentials, signal?: AbortSignal): Promise<Playlist[]> {
  const r = await request<{ playlists?: { playlist?: RawPlaylist[] } }>(c.baseUrl, 'getPlaylists', { auth: auth(c), signal })
  return list(r.playlists?.playlist).map(mapPlaylist)
}

export async function getPlaylist(c: Credentials, id: string, signal?: AbortSignal) {
  const r = await request<{ playlist?: RawPlaylist & { entry?: RawSong[] } }>(c.baseUrl, 'getPlaylist', { auth: auth(c), params: { id }, signal })
  const p = need(r.playlist)
  return { playlist: mapPlaylist(p), songs: list(p.entry).map(mapSong) }
}

export interface SearchParams {
  query: string
  artistCount?: number
  artistOffset?: number
  albumCount?: number
  albumOffset?: number
  songCount?: number
  songOffset?: number
}

/** An empty `query` returns everything (OpenSubsonic requires servers to support it); used to page all tracks. */
export async function search3(c: Credentials, params: SearchParams, signal?: AbortSignal): Promise<SearchResults> {
  const r = await request<{ searchResult3?: RawSearch }>(c.baseUrl, 'search3', { auth: auth(c), params: { ...params }, signal })
  return mapSearch(r.searchResult3)
}

// ── Social: who is playing what on this server, and its chat room ───────────

interface RawNowPlaying extends RawSong { username?: unknown; minutesAgo?: unknown; playerName?: unknown; state?: unknown }
interface RawChatMessage { username?: unknown; time?: unknown; message?: unknown }

/** Everyone's current track on this server, the caller's own included (Subsonic has no per-user privacy here). */
export async function getNowPlaying(c: Credentials, signal?: AbortSignal): Promise<NowPlayingEntry[]> {
  const r = await request<{ nowPlaying?: { entry?: RawNowPlaying[] } }>(c.baseUrl, 'getNowPlaying', { auth: auth(c), signal })
  return list(r.nowPlaying?.entry)
    .filter((e) => typeof e.username === 'string' && e.username !== '' && e.id !== undefined)
    .map((e) => ({
      username: e.username as string,
      minutesAgo: typeof e.minutesAgo === 'number' && e.minutesAgo >= 0 ? e.minutesAgo : 0,
      playerName: typeof e.playerName === 'string' && e.playerName ? e.playerName : undefined,
      paused: e.state === 'paused',
      song: mapSong(e),
    }))
}

/** Chat messages newer than `since` (ms), oldest first. Navidrome doesn't implement chat and answers HTTP 410. */
export async function getChatMessages(c: Credentials, since?: number, signal?: AbortSignal): Promise<ChatMessage[]> {
  const r = await request<{ chatMessages?: { chatMessage?: RawChatMessage[] } }>(c.baseUrl, 'getChatMessages', { auth: auth(c), params: { since }, signal })
  return list(r.chatMessages?.chatMessage)
    .filter((m): m is ChatMessage => typeof m.username === 'string' && typeof m.time === 'number' && typeof m.message === 'string')
    .map(({ username, time, message }) => ({ username, time, message }))
    .sort((a, b) => a.time - b.time)
}

/** Posts to the server-wide room. Subsonic only has GET here, so the text travels in the query string like every other parameter. */
export const addChatMessage = (c: Credentials, message: string, signal?: AbortSignal) =>
  request(c.baseUrl, 'addChatMessage', { auth: auth(c), params: { message }, signal })

// ── Writes: favourites, play reporting, playlist editing ────────────────────

export type StarKind = 'song' | 'album' | 'artist'
const starTarget = (kind: StarKind, id: string) => (kind === 'song' ? { id } : kind === 'album' ? { albumId: id } : { artistId: id })

/** `star` / `unstar`; ID3 ids go in `albumId`/`artistId`, song ids in `id`. */
export const setStarred = (c: Credentials, kind: StarKind, id: string, on: boolean, signal?: AbortSignal) =>
  request(c.baseUrl, on ? 'star' : 'unstar', { auth: auth(c), params: starTarget(kind, id), signal })

/**
 * Report a play. `submission: false` is the "now playing" ping; `true` records the play, which is what
 * drives the server's play counts, "recently played" lists and smart playlists.
 */
export const scrobble = (c: Credentials, id: string, submission: boolean, signal?: AbortSignal) =>
  request(c.baseUrl, 'scrobble', { auth: auth(c), params: { id, submission }, signal })

export const createPlaylist = (c: Credentials, name: string, songIds: string[], signal?: AbortSignal) =>
  request(c.baseUrl, 'createPlaylist', { auth: auth(c), params: { name, songId: songIds }, signal })

export const addToPlaylist = (c: Credentials, playlistId: string, songIds: string[], signal?: AbortSignal) =>
  request(c.baseUrl, 'updatePlaylist', { auth: auth(c), params: { playlistId, songIdToAdd: songIds }, signal })

/** Positions are the track's index in the playlist as it is now. */
export const removeFromPlaylist = (c: Credentials, playlistId: string, indexes: number[], signal?: AbortSignal) =>
  request(c.baseUrl, 'updatePlaylist', { auth: auth(c), params: { playlistId, songIndexToRemove: indexes.map(String) }, signal })

const COVER_URL_MAX = 2000
const coverUrls = new Map<string, string>()
export const clearCoverArtUrls = () => coverUrls.clear()

/**
 * Cover-art URL, stable per (server, user, id, size) so the browser HTTP cache can serve repeats —
 * a fresh token salt per render would defeat it. Bounded (oldest dropped) and cleared on sign-out.
 */
export function coverArtUrl(c: Credentials, id: string, size: number): string {
  const key = `${c.baseUrl}|${c.username}|${id}|${size}`
  let url = coverUrls.get(key)
  if (!url) {
    if (coverUrls.size >= COVER_URL_MAX) coverUrls.delete(coverUrls.keys().next().value!)
    coverUrls.set(key, (url = buildUrl(c.baseUrl, 'getCoverArt', auth(c), { id, size })))
  }
  return url
}

/**
 * Audio URL for `<audio src>`. It carries the hashed token (`t`/`s`), never the password, and a fresh salt per load.
 * `maxBitRate` (kbps) asks the server to transcode down; omit it for the original file.
 * Known limitation: the token is visible in the browser's network tools and server logs, since media elements can't send headers.
 */
export const streamUrl = (c: Credentials, id: string, maxBitRate?: number): string =>
  buildUrl(c.baseUrl, 'stream', auth(c), maxBitRate ? { id, maxBitRate } : { id })

/** OpenSubsonic `songLyrics` extension. */
export async function getLyricsBySongId(c: Credentials, id: string, signal?: AbortSignal): Promise<StructuredLyrics[]> {
  const r = await request<{ lyricsList?: { structuredLyrics?: StructuredLyrics[] } }>(c.baseUrl, 'getLyricsBySongId', { auth: auth(c), params: { id }, signal })
  return list(r.lyricsList?.structuredLyrics)
}

/** Legacy endpoint: plain text only (empty string when the server has none). */
export async function getLyrics(c: Credentials, params: { artist: string; title: string }, signal?: AbortSignal): Promise<string> {
  const r = await request<{ lyrics?: { value?: string } }>(c.baseUrl, 'getLyrics', { auth: auth(c), params, signal })
  return r.lyrics?.value ?? ''
}
