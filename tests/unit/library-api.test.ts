import { coverArtUrl, mapAlbum, mapSong, streamUrl } from '../../src/api/subsonic/endpoints'
import { formatDuration } from '../../src/lib/format'

describe('mappers', () => {
  it('stringifies ids and fills defaults', () => {
    expect(mapSong({ id: 42, albumId: 7 })).toMatchObject({ id: '42', albumId: '7', title: '', duration: 0, artistId: undefined })
  })
  it('falls back to title when an album has no name', () => {
    expect(mapAlbum({ id: 'a', title: 'T' }).name).toBe('T')
  })
})

describe('coverArtUrl', () => {
  const c = { baseUrl: 'https://m.test', username: 'u', password: 'p' }
  it('is stable per id+size (so the HTTP cache works) and never contains the password', () => {
    const url = coverArtUrl(c, 'x1', 300)
    expect(coverArtUrl(c, 'x1', 300)).toBe(url)
    expect(coverArtUrl(c, 'x1', 96)).not.toBe(url)
    const q = new URL(url).searchParams
    expect([q.get('id'), q.get('size'), q.has('p')]).toEqual(['x1', '300', false])
  })
})

describe('streamUrl', () => {
  const c = { baseUrl: 'https://m.test', username: 'u', password: 'p' }
  it('asks for a bitrate ceiling only when one is given', () => {
    expect(new URL(streamUrl(c, 's1')).searchParams.has('maxBitRate')).toBe(false)
    expect(new URL(streamUrl(c, 's1', 192)).searchParams.get('maxBitRate')).toBe('192')
  })
})

describe('mapAlbum created', () => {
  it('keeps the date-added timestamp', () => expect(mapAlbum({ id: 'a', created: '2026-03-01T10:00:00Z' }).created).toBe('2026-03-01T10:00:00Z'))
})

describe('formatDuration', () => {
  it.each([[0, '0:00'], [65, '1:05'], [3725, '1:02:05'], [-3, '0:00']])('%s -> %s', (s, out) => expect(formatDuration(s)).toBe(out))
})

describe('OpenSubsonic recording metadata', () => {
  it('keeps well-formed ISRCs and the explicit flag, and ignores junk', () => {
    expect(mapSong({ id: 1, isrc: ['usabc1234567', 'bad', 5], explicitStatus: 'explicit' })).toMatchObject({ isrc: ['USABC1234567'], explicit: true })
    expect(mapSong({ id: 1, explicitStatus: 'clean' }).explicit).toBe(false)
    const plain = mapSong({ id: 1, isrc: 'USABC1234567', explicitStatus: '' })
    expect('isrc' in plain || 'explicit' in plain).toBe(false)
  })
})
