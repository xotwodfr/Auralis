import { joinWords, parseSpicy } from '../../src/api/lyrics/providers/spicy'
import { parseSpotifyTrackId } from '../../src/state/spotifyLinks'

const syl = (Text: string, StartTime: number, EndTime: number, IsPartOfWord = false) => ({ Text, IsPartOfWord, StartTime, EndTime })
// Shape observed from the live API (Type "Syllable", times in seconds).
const lead = (...s: ReturnType<typeof syl>[]) => ({ Syllables: s, StartTime: s[0]!.StartTime, EndTime: s[s.length - 1]!.EndTime })
const body = (over: object = {}) => ({
  Type: 'Syllable',
  StartTime: 19.8,
  EndTime: 30,
  source: 'apple_music',
  Content: [
    { Type: 'Vocal', OppositeAligned: false, Lead: lead(syl("We're", 19.794, 20.046), syl('no', 20.046, 20.336), syl('strangers', 20.336, 20.87)) },
    { Type: 'Vocal', OppositeAligned: true, Lead: lead(syl('Ooh-', 24, 24.5, true), syl('ooh', 24.5, 25)), Background: [lead(syl('(hey)', 24.2, 24.8))] },
  ],
  ...over,
})

describe('parseSpicy', () => {
  it('turns syllable data into word-timed lines', () => {
    const l = parseSpicy(body(), 212)!
    expect(l).toMatchObject({ synced: true, source: 'spicy' })
    expect(l.lines[0]).toMatchObject({ time: 19.794, text: "We're no strangers" })
    expect(l.lines[0]!.words).toEqual([
      { text: "We're", start: 19.794, end: 20.046 },
      { text: 'no', start: 20.046, end: 20.336 },
      { text: 'strangers', start: 20.336, end: 20.87 },
    ])
  })

  it('joins syllables of one word without a space, and keeps backing vocals and duet side', () => {
    const second = parseSpicy(body(), 212)!.lines[1]!
    expect(second.text).toBe('Ooh-ooh')
    expect(second.opposite).toBe(true)
    expect(second.background).toEqual([{ text: '(hey)', words: [{ text: '(hey)', start: 24.2, end: 24.8 }] }])
    expect(joinWords([{ text: 'a', start: 0, end: 1, joinNext: true }, { text: 'b', start: 1, end: 2 }, { text: 'c', start: 2, end: 3 }])).toBe('ab c')
  })

  it('sorts by time and skips non-vocal, empty and malformed items', () => {
    const b = body({
      Content: [
        { Type: 'Vocal', Lead: lead(syl('late', 50, 51)) },
        { Type: 'Interlude', Lead: lead(syl('x', 1, 2)) },
        { Type: 'Vocal', Lead: { Syllables: [syl('  ', 1, 2)] } },
        { Type: 'Vocal', Lead: { Syllables: [{ Text: 'nan', StartTime: 'x', EndTime: 2 }] } },
        null,
        'oops',
        { Type: 'Vocal', Lead: lead(syl('early', 5, 6)) },
      ],
    })
    expect(parseSpicy(b, 100)!.lines.map((l) => l.text)).toEqual(['early', 'late'])
  })

  it.each([
    ['not an object', null],
    ['no content', { Type: 'Syllable' }],
    ['content not an array', { Type: 'Syllable', Content: {} }],
    ['empty content', { Type: 'Syllable', Content: [] }],
    ['unknown type', { Type: 'Hologram', Content: [{ Type: 'Vocal', Lead: lead(syl('x', 1, 2)) }] }],
  ])('returns null for %s', (_, b) => expect(parseSpicy(b, 100)).toBeNull())

  it('keeps a syllable that lacks timing, timed from its neighbours', () => {
    const b = body({ Content: [{ Type: 'Vocal', Lead: { StartTime: 1, EndTime: 3, Syllables: [syl('a', 1, 2), { Text: 'b' }] } }] })
    expect(parseSpicy(b, 100)!.lines[0]).toMatchObject({ text: 'a b', words: [{ text: 'a', start: 1, end: 2 }, { text: 'b', start: 2, end: 3 }] })
  })

  it('rejects lyrics that run past the track (wrong recording), with a small tolerance', () => {
    const b = body({ Content: [{ Type: 'Vocal', Lead: lead(syl('x', 10, 205)) }] })
    expect(parseSpicy(b, 200)).not.toBeNull() // 5 s over: fine
    expect(parseSpicy(b, 190)).toBeNull() // 15 s over: a longer/different version
    expect(parseSpicy(b, 0)).not.toBeNull() // unknown duration: cannot judge
  })

  it('rejects negative timestamps', () => {
    expect(parseSpicy(body({ Content: [{ Type: 'Vocal', Lead: lead(syl('x', -1, 2)) }] }), 100)).toBeNull()
  })

  describe('attribution', () => {
    it('names the provider that answered; community syncs also credit uploader and maker', () => {
      const community = parseSpicy(
        body({
          source: 'spicy_lyrics',
          UploadAttribution: {
            Uploader: { id: '1', username: 'Una', url: 'https://spicylyrics.org/uid/1' },
            Maker: { id: '2', username: 'Mo', url: 'javascript:alert(1)' },
          },
        }),
        212,
      )!
      expect(community.attribution).toEqual({
        provider: 'Spicy Lyrics',
        credits: [
          { role: 'Uploader', name: 'Una', url: 'https://spicylyrics.org/uid/1' },
          { role: 'Maker', name: 'Mo' }, // non-http(s) links are dropped, the name is kept
        ],
      })
    })

    it.each([['apple_music', 'Apple Music'], ['spotify', 'Spotify']])('%s: provider only', (source, provider) => {
      const a = parseSpicy(body({ source, UploadAttribution: { Uploader: { username: 'ignored' } } }), 212)!.attribution
      expect(a).toEqual({ provider, credits: [] })
    })

    it('says the source is unknown rather than attributing it to anyone', () => {
      expect(parseSpicy(body({ source: undefined }), 212)!.attribution).toEqual({ provider: 'an unknown source', credits: [] })
      expect(parseSpicy(body({ source: 'brand_new' }), 212)!.attribution?.provider).toBe('an unknown source')
    })
  })

  it('handles line-level and static shapes (inferred), failing closed otherwise', () => {
    const line = parseSpicy({ Type: 'Line', Content: [{ Text: 'b', StartTime: 5, EndTime: 6 }, { Text: 'a', StartTime: 1, EndTime: 2 }] }, 100)!
    expect(line.lines.map((l) => [l.time, l.text])).toEqual([[1, 'a'], [5, 'b']])
    const stat = parseSpicy({ Type: 'Static', Content: [{ Text: 'x' }, { Text: 'y' }] }, 100)!
    expect(stat).toMatchObject({ synced: false, lines: [{ time: null, text: 'x' }, { time: null, text: 'y' }] })
  })
})


describe('parseSpotifyTrackId', () => {
  const id = '4cOdK2wGLETKBW3PvgPWqT'
  it.each([
    id,
    `  ${id} `,
    `spotify:track:${id}`,
    `https://open.spotify.com/track/${id}`,
    `https://open.spotify.com/track/${id}?si=abc123`,
    `https://open.spotify.com/intl-de/track/${id}`,
  ])('accepts %s', (input) => expect(parseSpotifyTrackId(input)).toBe(id))

  it.each([
    '',
    'abc',
    `${id}x`,
    `https://evil.test/track/${id}`,
    `http://open.spotify.com/track/${id}`,
    `https://open.spotify.com/album/${id}`,
    `https://open.spotify.com.evil.test/track/${id}`,
    `spotify:album:${id}`,
    'javascript:alert(1)',
  ])('rejects %j', (input) => expect(parseSpotifyTrackId(input)).toBeNull())
})
