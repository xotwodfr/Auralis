// Deterministic mock Subsonic/OpenSubsonic server for the browser tests. No real accounts, no network.
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { crc32, deflateSync } from 'node:zlib'

const PORT = Number(process.env.MOCK_PORT ?? 4599)
export const USER = 'demo'
export const PASSWORD = 'e2e-pass'

const ARTISTS = [
  { id: 'ar1', name: 'Artist A', albumCount: 2, coverArt: 'c-red' },
  { id: 'ar2', name: 'Bee Gees', albumCount: 1, coverArt: 'c-blue' },
]
const ALBUMS = [
  { id: 'al1', name: 'First Album', artist: 'Artist A', artistId: 'ar1', coverArt: 'c-red', songCount: 3, duration: 120, year: 2020, created: '2026-03-01T10:00:00Z' },
  { id: 'al2', name: 'Second Album', artist: 'Artist A', artistId: 'ar1', coverArt: 'c-blue', songCount: 2, duration: 80, year: 2022, created: '2026-04-01T10:00:00Z' },
  { id: 'al3', name: 'Stayin Alive', artist: 'Bee Gees', artistId: 'ar2', coverArt: 'c-blue', songCount: 2, duration: 80, year: 1977, created: '2026-02-01T10:00:00Z' },
]
const song = (id, title, albumId, track) => {
  const a = ALBUMS.find((x) => x.id === albumId)
  return { id, title, album: a.name, albumId, artist: a.artist, artistId: a.artistId, track, duration: 40, coverArt: a.coverArt }
}
const SONGS = [
  song('s1', 'Line Dancer', 'al1', 1), { ...song('s2', 'Quiet Hours', 'al1', 2), isrc: ['USQH02600001'] }, song('s3', 'Third Song', 'al1', 3),
  song('s4', 'Fourth Song', 'al2', 1), song('s5', 'Fifth Song', 'al2', 2), song('s6', 'Stayin Alive', 'al3', 1),
  song('s7', `A very long song title that keeps going ${'Supercalifragilisticexpialidocious'.repeat(2)} and then some more words`, 'al3', 2),
]
// Social: another account is playing a track now, a third one reported a track long ago; the chat room starts with one message.
const OTHERS_PLAYING = [
  { username: 'alex', minutesAgo: 0, playerName: 'Feishin', id: 's6' },
  { username: 'sam', minutesAgo: 95, playerName: 'Substreamer', id: 's4' },
]
const chatSeed = () => [{ username: 'alex', time: Date.now() - 5 * 60_000, message: 'Anyone else on a Bee Gees kick?' }]
let chat = chatSeed()
let chatGone = false // true = behave like Navidrome (410)
/** Who announced what with `scrobble submission=false`: the caller shows up in `getNowPlaying` only after that. */
let announced = null
const PLAYLISTS = [{ id: 'pl1', name: 'Road trip', songCount: 2, duration: 80, owner: USER, songs: ['s1', 's4'] }]
const LYRICS = { s1: [[2000, 'Line one'], [6000, 'Line two'], [10000, 'Line three']] }
const COVERS = { 'c-red': [220, 40, 40], 'c-blue': [40, 80, 220] }

// Stand-in for api.spicylyrics.org (the Auralis backend is pointed here via SPICY_LYRICS_API_BASE). Requires the fake key.
export const SPICY_FAKE_KEY = 'e2e-fake-secret'
export const SPICY_ID = 'AAAAAAAAAAAAAAAAAAAAAA'
const spicySyl = (Text, StartTime, EndTime, IsPartOfWord = false) => ({ Text, IsPartOfWord, StartTime, EndTime })
const SPICY_BODY = {
  Body: {
    Type: 'Syllable',
    source: 'spicy_lyrics',
    id: SPICY_ID,
    UploadAttribution: { Uploader: { id: '1', username: 'Una', url: 'https://spicylyrics.org/uid/1' }, Maker: { id: '2', username: 'Mo', url: 'https://spicylyrics.org/uid/2' } },
    Content: [
      { Type: 'Vocal', OppositeAligned: false, Lead: { Syllables: [spicySyl('Hello', 1, 2), spicySyl('wonderful', 2, 3), spicySyl('world', 3, 12)], StartTime: 1, EndTime: 12 } },
      { Type: 'Vocal', OppositeAligned: false, Lead: { Syllables: [spicySyl('Second', 13, 14), spicySyl('line', 14, 30)], StartTime: 13, EndTime: 30 } },
    ],
  },
}

// A denser word-timed fixture (Quiet Hours, matched automatically): short and long lines, a line that wraps,
// syllables of one word, backing vocals and a duet line, over the 40 s mock audio.
export const QUIET_ID = 'QQQQQQQQQQQQQQQQQQQQQQ'
const words = (text, start, end) => {
  const parts = text.split(' ')
  const step = (end - start) / parts.length
  return parts.map((w, i) => spicySyl(w, +(start + i * step).toFixed(2), +(start + (i + 1) * step).toFixed(2)))
}
const vocal = (text, start, end, extra = {}) => ({ Type: 'Vocal', OppositeAligned: false, Lead: { Syllables: words(text, start, end), StartTime: start, EndTime: end }, ...extra })
const QUIET_BODY = {
  Body: {
    Type: 'Syllable',
    source: 'apple_music',
    id: QUIET_ID,
    Content: [
      vocal('The city hums below the window', 1.2, 4.4),
      vocal('I count the lights', 4.8, 6.6),
      { Type: 'Vocal', OppositeAligned: false, Lead: { Syllables: [spicySyl('Mid', 7, 7.4, true), spicySyl('night', 7.4, 8), spicySyl('is', 8.1, 8.4), spicySyl('a', 8.4, 8.6), spicySyl('slow', 8.6, 9.4), spicySyl('river', 9.4, 10.6)], StartTime: 7, EndTime: 10.6 }, Background: [{ Syllables: words('(slow river)', 10.6, 12) }] },
      vocal('And every quiet hour carries something I forgot to say before the morning took it all away', 12.4, 19.6),
      vocal('Stay', 20.4, 22),
      vocal('Stay a little longer', 22.2, 24.6, { OppositeAligned: true }),
      vocal('We are the static between stations', 25.6, 29.2),
      vocal('Humming in the dark', 29.6, 32),
      vocal('Until the radio goes quiet', 33, 37.5),
    ],
  },
}

// Stand-in for the Spotify Web API (token + search), so the backend's automatic matching runs without the internet.
export const SPOTIFY_FAKE_ID = 'e2e-spotify-client'
export const SPOTIFY_FAKE_SECRET = 'e2e-spotify-secret'
const SPOTIFY_TOKEN = 'e2e-spotify-access-token'
const sp = (id, name, album, ms, isrc) => ({ id, name, artists: [{ name: 'Artist A' }], album: { name: album, album_type: 'album' }, duration_ms: ms, explicit: false, external_ids: { isrc } })
function spotifySearch(q) {
  if (/isrc:USQH02600001|Quiet Hours/i.test(q)) return [sp(QUIET_ID, 'Quiet Hours', 'First Album', 40_000, 'USQH02600001')]
  // Two different recordings that fit equally well: the app must ask.
  if (/Fourth Song/i.test(q)) return [sp('FFFFFFFFFFFFFFFFFFFFFF', 'Fourth Song', 'Greatest Hits', 39_000, 'USFS02600001'), sp('GGGGGGGGGGGGGGGGGGGGGG', 'Fourth Song', 'The Collection', 41_000, 'USFS02600002')]
  return []
}

const md5 = (s) => createHash('md5').update(s).digest('hex')
const stats = {}
const failNext = {}
let bulkArtists = 0 // /__bulk?artists=N makes getArtists return N artists (large-library tests)
/** Favourites and playlist edits are kept, so a refetch after a write shows the change (like a real server). */
let starred = new Set()
let playlists = structuredClone(PLAYLISTS)
let nextPlaylistId = 2

function png([r, g, b]) {
  const size = 8
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat())])
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data])
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 40 s of 8 kHz mono 8-bit silence. */
function wav(seconds = 40, rate = 8000) {
  const data = Buffer.alloc(seconds * rate, 128)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + data.length, 4)
  h.write('WAVEfmt ', 8)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate, 28)
  h.writeUInt16LE(1, 32)
  h.writeUInt16LE(8, 34)
  h.write('data', 36)
  h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}
const WAV = wav()
/** 40 s of a 440 Hz sine, 16-bit, for the effects test to measure what the audio graph does to a known signal. */
function toneWav(seconds = 40, rate = 22050, hz = 440) {
  const data = Buffer.alloc(seconds * rate * 2)
  for (let i = 0; i < seconds * rate; i++) data.writeInt16LE(Math.round(0.5 * 32767 * Math.sin((2 * Math.PI * hz * i) / rate)), i * 2)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + data.length, 4)
  h.write('WAVEfmt ', 8)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(rate, 24)
  h.writeUInt32LE(rate * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}
const TONE = toneWav()
const TONE_SONG = 's5'
const STARRED_AT = '2026-01-01T00:00:00Z'

const ok = (body = {}) => ({ 'subsonic-response': { status: 'ok', version: '1.16.1', type: 'navidrome', serverVersion: '0.55.0', openSubsonic: true, ...body } })
const failed = (code, message) => ({ 'subsonic-response': { status: 'failed', version: '1.16.1', error: { code, message } } })
const page = (list, q, key, defSize) => {
  const off = Number(q.get(`${key}Offset`) ?? q.get('offset') ?? 0)
  const size = Number(q.get(`${key}Count`) ?? q.get('size') ?? defSize)
  return list.slice(off, off + size)
}

function json(q, name) {
  switch (name) {
    case 'ping': case 'getLicense': return ok(name === 'getLicense' ? { license: { valid: true } } : {})
    case 'getOpenSubsonicExtensions': return ok({ openSubsonicExtensions: [{ name: 'songLyrics', versions: [1] }] })
    case 'getArtists': {
      const list = bulkArtists
        ? Array.from({ length: bulkArtists }, (_, i) => ({ id: `bulk${i}`, name: `Bulk Artist ${String(i).padStart(5, '0')}`, albumCount: 1 + (i % 5) }))
        : ARTISTS
      return ok({ artists: { index: [{ name: 'A', artist: list }] } })
    }
    case 'getArtist': {
      const a = ARTISTS.find((x) => x.id === q.get('id'))
      return a ? ok({ artist: { ...a, album: ALBUMS.filter((x) => x.artistId === a.id) } }) : failed(70, 'not found')
    }
    case 'getAlbum': {
      const a = ALBUMS.find((x) => x.id === q.get('id'))
      return a ? ok({ album: { ...a, song: SONGS.filter((s) => s.albumId === a.id) } }) : failed(70, 'not found')
    }
    case 'getSong': {
      const s = SONGS.find((x) => x.id === q.get('id'))
      return s ? ok({ song: s }) : failed(70, 'not found')
    }
    case 'getAlbumList2': {
      const sorted = q.get('type') === 'newest' ? [...ALBUMS].sort((a, b) => b.created.localeCompare(a.created)) : ALBUMS
      return ok({ albumList2: { album: page(sorted, q, 'album', 10) } })
    }
    case 'getStarred2': return ok({ starred2: {
      artist: ARTISTS.filter((a) => starred.has(a.id)).map((a) => ({ ...a, starred: STARRED_AT })),
      album: ALBUMS.filter((a) => starred.has(a.id)).map((a) => ({ ...a, starred: STARRED_AT })),
      song: SONGS.filter((x) => starred.has(x.id)).map((x) => ({ ...x, starred: STARRED_AT })),
    } })
    case 'star': case 'unstar': {
      const ids = [...q.getAll('id'), ...q.getAll('albumId'), ...q.getAll('artistId')]
      for (const id of ids) if (name === 'star') starred.add(id); else starred.delete(id)
      return ok()
    }
    case 'createPlaylist': {
      const songs = q.getAll('songId')
      playlists.push({ id: `pl${nextPlaylistId++}`, name: q.get('name') ?? '', songCount: songs.length, duration: 0, owner: USER, songs })
      return ok()
    }
    case 'updatePlaylist': {
      const p = playlists.find((x) => x.id === q.get('playlistId'))
      if (!p) return failed(70, 'not found')
      for (const i of q.getAll('songIndexToRemove').map(Number).sort((a, b) => b - a)) p.songs.splice(i, 1)
      p.songs.push(...q.getAll('songIdToAdd'))
      p.songCount = p.songs.length
      return ok()
    }
    case 'getPlaylists': return ok({ playlists: { playlist: playlists.map((p) => ({ id: p.id, name: p.name, songCount: p.songCount, duration: p.duration, owner: p.owner })) } })
    case 'getPlaylist': {
      const p = playlists.find((x) => x.id === q.get('id'))
      return p ? ok({ playlist: { id: p.id, name: p.name, songCount: p.songCount, duration: p.duration, owner: p.owner, entry: p.songs.map((id) => SONGS.find((s) => s.id === id)).filter(Boolean) } }) : failed(70, 'not found')
    }
    case 'search3': {
      const t = (q.get('query') ?? '').toLowerCase()
      const hit = (s) => s.toLowerCase().includes(t)
      return ok({ searchResult3: {
        artist: ARTISTS.filter((a) => hit(a.name)),
        album: ALBUMS.filter((a) => hit(a.name) || hit(a.artist)),
        song: SONGS.filter((s) => hit(s.title) || hit(s.artist)),
      } })
    }
    case 'getLyricsBySongId': {
      const lines = LYRICS[q.get('id')]
      return ok({ lyricsList: { structuredLyrics: lines ? [{ lang: 'en', synced: true, line: lines.map(([start, value]) => ({ start, value })) }] : [] } })
    }
    case 'scrobble':
      if (q.get('submission') === 'false') announced = q.get('id')
      return ok()
    case 'savePlayQueue': return ok()
    case 'getNowPlaying': {
      const entries = [...OTHERS_PLAYING, ...(announced ? [{ username: USER, minutesAgo: 0, playerName: 'Auralis', id: announced }] : [])]
      return ok({ nowPlaying: { entry: entries.map(({ id, ...who }) => ({ ...SONGS.find((s) => s.id === id), ...who, playerId: 1 })) } })
    }
    case 'getChatMessages': {
      const since = Number(q.get('since') ?? 0)
      return ok({ chatMessages: { chatMessage: chat.filter((m) => m.time > since) } })
    }
    case 'addChatMessage': {
      const message = q.get('message') ?? ''
      if (!message.trim()) return failed(10, 'Required parameter is missing: message')
      chat.push({ username: USER, time: Math.max(Date.now(), (chat.at(-1)?.time ?? 0) + 1), message })
      return ok()
    }
    default: return failed(0, `unsupported: ${name}`)
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': 'Content-Range, Accept-Ranges' }
  if (req.method === 'OPTIONS') return void res.writeHead(204, cors).end()

  if (url.pathname === '/health') return void res.writeHead(200, cors).end('ok')
  if (url.pathname === '/__stats') return void res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify(stats))
  if (url.pathname === '/__reset') {
    for (const k of Object.keys(stats)) delete stats[k]
    for (const k of Object.keys(failNext)) delete failNext[k]
    bulkArtists = 0
    starred = new Set()
    playlists = structuredClone(PLAYLISTS)
    nextPlaylistId = 2
    chat = chatSeed()
    chatGone = false
    announced = null
    return void res.writeHead(204, cors).end()
  }
  if (url.pathname === '/__chat') {
    // `?gone=1`: no chat (Navidrome); `?say=text&as=user`: someone else posts.
    if (url.searchParams.has('gone')) chatGone = url.searchParams.get('gone') === '1'
    if (url.searchParams.has('say')) chat.push({ username: url.searchParams.get('as') ?? 'alex', time: Date.now(), message: url.searchParams.get('say') })
    return void res.writeHead(204, cors).end()
  }
  if (url.pathname === '/__bulk') {
    bulkArtists = Number(url.searchParams.get('artists') ?? 0)
    return void res.writeHead(204, cors).end()
  }
  if (url.pathname === '/__fail') {
    failNext[url.searchParams.get('endpoint')] = Number(url.searchParams.get('times') ?? 1)
    return void res.writeHead(204, cors).end()
  }

  const spicy = /^\/spicy-upstream\/v1\/lyrics\/([^/]+)$/.exec(url.pathname)
  if (spicy) {
    const good = req.headers.authorization === `Bearer ${SPICY_FAKE_KEY}`
    stats[good ? 'spicy-upstream' : 'spicy-upstream-unauthorized'] = (stats[good ? 'spicy-upstream' : 'spicy-upstream-unauthorized'] ?? 0) + 1
    if (!good) return void res.writeHead(401, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify({ Body: { error: 'invalid_key' }, Status: 401 }))
    if (spicy[1] === QUIET_ID || spicy[1] === 'FFFFFFFFFFFFFFFFFFFFFF') {
      return void res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify({ ...QUIET_BODY, Status: 200, Type: 'object' }))
    }
    if (spicy[1] !== SPICY_ID) return void res.writeHead(404, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify({ Body: { error: 'lyrics_not_found' }, Status: 404 }))
    return void res.writeHead(200, { ...cors, 'content-type': 'application/json', 'ratelimit-limit': '60' }).end(JSON.stringify({ ...SPICY_BODY, Status: 200, Type: 'object' }))
  }

  if (url.pathname === '/spotify-upstream/token' && req.method === 'POST') {
    const good = req.headers.authorization === `Basic ${Buffer.from(`${SPOTIFY_FAKE_ID}:${SPOTIFY_FAKE_SECRET}`).toString('base64')}`
    stats[good ? 'spotify-token' : 'spotify-token-unauthorized'] = (stats[good ? 'spotify-token' : 'spotify-token-unauthorized'] ?? 0) + 1
    return void res.writeHead(good ? 200 : 400, { 'content-type': 'application/json' }).end(JSON.stringify(good ? { access_token: SPOTIFY_TOKEN, token_type: 'Bearer', expires_in: 3600 } : { error: 'invalid_client' }))
  }
  if (url.pathname === '/spotify-upstream/v1/search') {
    if (req.headers.authorization !== `Bearer ${SPOTIFY_TOKEN}`) return void res.writeHead(401).end()
    stats['spotify-search'] = (stats['spotify-search'] ?? 0) + 1
    return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ tracks: { items: spotifySearch(url.searchParams.get('q') ?? '') } }))
  }

  const name = url.pathname.replace(/^\/rest\//, '').replace(/\.view$/, '')
  stats[name] = (stats[name] ?? 0) + 1
  const q = url.searchParams
  if (failNext[name] > 0) {
    failNext[name]--
    return void res.writeHead(503, cors).end('unavailable')
  }

  const authed = q.get('u') === USER && q.get('t') === md5(PASSWORD + (q.get('s') ?? '')) && !q.has('p')
  const binary = name === 'stream' || name === 'getCoverArt'
  if (name !== 'getOpenSubsonicExtensions' && !authed) {
    return void (binary
      ? res.writeHead(401, cors).end()
      : res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify(failed(40, 'Wrong username or password'))))
  }

  if (chatGone && (name === 'getChatMessages' || name === 'addChatMessage')) return void res.writeHead(410, cors).end('Gone')
  if (name === 'getCoverArt') {
    const color = COVERS[q.get('id')]
    return void (color ? res.writeHead(200, { ...cors, 'content-type': 'image/png', 'cache-control': 'max-age=60' }).end(png(color)) : res.writeHead(404, cors).end())
  }
  if (name === 'stream') {
    if (!SONGS.some((s) => s.id === q.get('id'))) return void res.writeHead(404, cors).end()
    const body = q.get('id') === TONE_SONG ? TONE : WAV
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '')
    const start = range ? Number(range[1]) : 0
    const end = range?.[2] ? Number(range[2]) : body.length - 1
    const head = { ...cors, 'content-type': 'audio/wav', 'accept-ranges': 'bytes', 'content-length': end - start + 1 }
    if (range) head['content-range'] = `bytes ${start}-${end}/${body.length}`
    return void res.writeHead(range ? 206 : 200, head).end(body.subarray(start, end + 1))
  }
  res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify(json(q, name)))
})

server.listen(PORT, '127.0.0.1', () => console.log(`mock subsonic on :${PORT}`))
