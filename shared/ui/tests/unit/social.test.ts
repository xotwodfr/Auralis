import { http } from 'msw'
import { getNowPlaying } from '../../src/api/subsonic/endpoints'
import type { NowPlayingEntry, Song } from '../../src/api/subsonic/types'
import { formatAgo, isLive, people, statusText } from '../../src/features/social/data'
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
  it('leaves out the signed-in user, keeps each person\'s freshest report, lists live listeners first', () => {
    const list = people(
      [entry({ username: 'zoe', minutesAgo: 1 }), entry({ username: 'Alice', minutesAgo: 0 }), entry({ username: 'sam', minutesAgo: 90 }), entry({ username: 'zoe', minutesAgo: 30 })],
      'alice',
    )
    expect(list.map((p) => p.name)).toEqual(['zoe', 'sam'])
    expect(list[0]!.entry!.minutesAgo).toBe(1)
  })
})
