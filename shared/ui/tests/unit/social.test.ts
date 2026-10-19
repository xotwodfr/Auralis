import { HttpResponse, http } from 'msw'
import { getChatMessages, getNowPlaying } from '../../src/api/subsonic/endpoints'
import { SubsonicError } from '../../src/api/subsonic/errors'
import type { NowPlayingEntry, Song } from '../../src/api/subsonic/types'
import { formatAgo, isLive, people, statusText } from '../../src/features/social/data'
import { isUnsupported, unreadCount } from '../../src/state/social'
import { BASE, PASSWORD, USER, authed, server } from '../server'

const c = { baseUrl: BASE, username: USER, password: PASSWORD }
const song: Song = { id: 's1', title: 'Song', album: 'Album', albumId: 'al1', artist: 'Artist', duration: 240 }
const entry = (over: Partial<NowPlayingEntry> = {}): NowPlayingEntry => ({ username: 'alex', minutesAgo: 0, paused: false, song, ...over })

describe('getNowPlaying', () => {
  it('maps entries and drops ones without a user or a track id', async () => {
    server.use(
      http.get(`${BASE}/rest/getNowPlaying`, authed({
        nowPlaying: {
          entry: [
            { id: 's1', title: 'Song', username: 'alex', minutesAgo: 2, playerId: 3, playerName: 'Feishin' },
            { id: 's2', title: 'Paused one', username: 'sam', minutesAgo: 'soon', state: 'paused' },
            { id: 's3', title: 'Nobody' },
            { title: 'No id', username: 'kim' },
            'junk',
          ],
        },
      })),
    )
    const list = await getNowPlaying(c)
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ username: 'alex', minutesAgo: 2, playerName: 'Feishin', paused: false, song: { id: 's1', title: 'Song' } })
    expect(list[1]).toMatchObject({ username: 'sam', minutesAgo: 0, paused: true, playerName: undefined })
  })

  it('treats a missing list as nobody playing', async () => {
    expect(await getNowPlaying(c)).toEqual([]) // the default handler answers `nowPlaying: {}`
  })
})

describe('getChatMessages', () => {
  it('keeps well-formed messages, oldest first, and passes `since`', async () => {
    let since: string | null = null
    server.use(
      http.get(`${BASE}/rest/getChatMessages`, authed((q) => {
        since = q.get('since')
        return { chatMessages: { chatMessage: [
          { username: 'b', time: 20, message: 'second' },
          { username: 'a', time: 10, message: 'first' },
          { username: 'c', time: '30', message: 'bad time' },
          { username: 'd', time: 40 },
        ] } }
      })),
    )
    expect(await getChatMessages(c, 5)).toEqual([
      { username: 'a', time: 10, message: 'first' },
      { username: 'b', time: 20, message: 'second' },
    ])
    expect(since).toBe('5')
  })

  it("Navidrome's 410 is an HTTP error the store reads as 'no chat on this server'", async () => {
    const err = await getChatMessages(c).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SubsonicError)
    expect(isUnsupported(err)).toBe(true)
  })

  it('a non-Subsonic page (SPA fallback) also means unsupported; a network failure or generic error does not', async () => {
    server.use(http.get(`${BASE}/rest/getChatMessages`, () => HttpResponse.text('<html></html>')))
    expect(isUnsupported(await getChatMessages(c).catch((e: unknown) => e))).toBe(true)
    expect(isUnsupported(new SubsonicError('network', 'x'))).toBe(false)
    expect(isUnsupported(new SubsonicError('unknown', 'x', 0))).toBe(false)
    expect(isUnsupported(new SubsonicError('not-found', 'x', 70))).toBe(true)
    expect(isUnsupported(new SubsonicError('http', 'x', undefined, 500))).toBe(false)
  })
})

describe('listening status', () => {
  it('is live only while the report is fresh and not paused; older reports show their age', () => {
    expect(isLive(entry({ minutesAgo: 3 }))).toBe(true) // within a 4-minute track
    expect(isLive(entry({ minutesAgo: 6 }))).toBe(false) // longer ago than the track lasts
    expect(isLive(entry({ paused: true }))).toBe(false)
    expect(isLive(entry({ song: { ...song, duration: 0 }, minutesAgo: 9 }))).toBe(true) // unknown length: 10 minutes
    expect(statusText(entry({ playerName: 'Feishin' }))).toBe('Listening now · Feishin')
    expect(statusText(entry({ minutesAgo: 95 }))).toBe('Played 2 h ago')
    expect(statusText(entry({ paused: true }))).toBe('Paused')
  })

  it('formats ages', () => {
    expect([0.4, 12, 125, 60 * 49].map(formatAgo)).toEqual(['just now', '12 min ago', '2 h ago', '2 d ago'])
  })
})

describe('people', () => {
  it('merges now-playing and chat authors, leaves out the signed-in user, lists live listeners first', () => {
    const list = people(
      [entry({ username: 'zoe', minutesAgo: 1 }), entry({ username: 'Alice', minutesAgo: 0 }), entry({ username: 'sam', minutesAgo: 90 }), entry({ username: 'zoe', minutesAgo: 30 })],
      [{ username: 'bo', time: 1, message: 'hi' }, { username: 'sam', time: 2, message: 'yo' }, { username: 'alice', time: 3, message: 'me' }],
      'alice',
    )
    expect(list.map((p) => p.name)).toEqual(['zoe', 'sam', 'bo'])
    expect(list[0]!.entry!.minutesAgo).toBe(1) // the freshest report wins
    expect(list[1]!.lastMessage!.message).toBe('yo')
  })
})

describe('unreadCount', () => {
  const messages = [
    { username: 'alex', time: 10, message: 'old' },
    { username: 'alice', time: 20, message: 'mine' },
    { username: 'alex', time: 30, message: 'new' },
  ]
  it("counts others' messages after the last one read, never the user's own", () => {
    expect(unreadCount({ messages, lastRead: 10 }, 'Alice')).toBe(1)
    expect(unreadCount({ messages, lastRead: 30 }, 'alice')).toBe(0)
    expect(unreadCount({ messages, lastRead: undefined }, 'alice')).toBe(0) // not loaded yet
  })
})
