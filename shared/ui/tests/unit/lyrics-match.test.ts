import { isMatch, normalize } from '../../src/api/lyrics/match'

const track = { id: '1', title: 'Hello', artist: 'Adele', album: '25', duration: 295 }
const cand = { trackName: 'Hello', artistName: 'Adele', albumName: '25', duration: 295 }

describe('normalize', () => {
  it('ignores case, punctuation, whitespace, feat. suffixes and bracketed qualifiers', () => {
    expect(normalize('  Hello,  World! (Remastered 2011) ')).toBe('hello world')
    expect(normalize('Song feat. Someone')).toBe('song')
    expect(normalize('Song [Live]')).toBe('song')
  })
})

describe('isMatch', () => {
  it('accepts exact title + artist within the duration tolerance', () => {
    expect(isMatch(track, cand)).toBe(true)
    expect(isMatch(track, { ...cand, duration: 297 })).toBe(true)
    expect(isMatch(track, { ...cand, duration: 300 })).toBe(true) // exact title relaxes to 5s
  })
  it('rejects a duration off by more than the tolerance (live/extended guard)', () => {
    expect(isMatch(track, { ...cand, duration: 301 })).toBe(false)
    expect(isMatch({ ...track, title: 'Hello (Remastered)' }, { ...cand, duration: 299 })).toBe(false) // not exact → 3s
  })
  it('rejects a candidate that introduces a version token the track lacks, and vice versa', () => {
    expect(isMatch(track, { ...cand, trackName: 'Hello (Live)' })).toBe(false)
    expect(isMatch(track, { ...cand, trackName: 'Hello (Remix)' })).toBe(false)
    expect(isMatch({ ...track, title: 'Hello (Live)' }, cand)).toBe(false)
    expect(isMatch({ ...track, title: 'Hello (Live)' }, { ...cand, trackName: 'Hello (live)' })).toBe(true)
  })
  it('accepts a live album as sharing the token', () => {
    expect(isMatch({ ...track, title: 'Hello (Live)' }, { ...cand, albumName: 'Live at Home' })).toBe(true)
  })
  it('requires title and artist to match after normalization', () => {
    expect(isMatch({ ...track, title: 'Hello feat. X' }, cand)).toBe(true)
    expect(isMatch(track, { ...cand, artistName: 'Someone Else' })).toBe(false)
    expect(isMatch(track, { ...cand, trackName: 'Goodbye' })).toBe(false)
  })
  it('rejects candidates with no duration', () => {
    expect(isMatch(track, { ...cand, duration: undefined })).toBe(false)
  })
})
