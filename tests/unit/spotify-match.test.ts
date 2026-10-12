import { parseTitle, resolveMatch, scoreCandidate, type SpotifyCandidate } from '../../src/api/lyrics/spotifyMatch'
import type { LyricsTrack } from '../../src/api/lyrics/types'

const track = (over: Partial<LyricsTrack> = {}): LyricsTrack => ({ id: 't', title: 'Midnight City', artist: 'M83', album: "Hurry Up, We're Dreaming", duration: 244, ...over })
let n = 0
const cand = (over: Partial<SpotifyCandidate> = {}): SpotifyCandidate => ({
  id: `id${String(n++).padStart(20, '0')}`,
  name: 'Midnight City',
  artists: ['M83'],
  album: "Hurry Up, We're Dreaming",
  durationMs: 243_960,
  explicit: false,
  isrc: '',
  ...over,
})
const matched = (t: LyricsTrack, cs: SpotifyCandidate[]) => {
  const r = resolveMatch(t, cs)
  return r.status === 'matched' ? r.id : r.status
}

describe('title parsing', () => {
  it('separates versions and featuring credits from meaningful qualifiers', () => {
    expect(parseTitle('Song (feat. Someone) [Live at Wembley]')).toMatchObject({ base: 'song', full: 'song', material: new Set(['live']) })
    expect(parseTitle('Song - 2011 Remaster')).toMatchObject({ base: 'song', soft: new Set(['remaster']), material: new Set() })
    expect(parseTitle('(I Can’t Get No) Satisfaction').full).toBe('satisfaction i cant get no')
    expect(parseTitle('Live Forever').material.size).toBe(0) // "live" in the title itself is not a version
    expect(parseTitle('Song ft. Other').base).toBe('song')
  })
})

describe('scoring and resolution', () => {
  it('accepts an exact title + artist + duration match', () => {
    const c = cand()
    expect(matched(track(), [c])).toBe(c.id)
    expect(scoreCandidate(track(), c).signals.map((s) => s.name)).toEqual(['title', 'artist', 'duration', 'album'])
  })

  it('normalizes case, punctuation, diacritics, quotes, & and featuring credits', () => {
    const c = cand({ name: 'Don’t Stop Me Now', artists: ['Beyoncé', 'JAY-Z'], album: 'X' })
    const t = track({ title: "don't stop me now (feat. Jay-Z)", artist: 'Beyonce & Jay Z', album: 'Y', duration: 244 })
    expect(matched(t, [c])).toBe(c.id)
  })

  it('matches multi-artist credits whole or by the primary artist, and rejects other artists', () => {
    expect(matched(track({ artist: 'Simon & Garfunkel' }), [cand({ artists: ['Simon & Garfunkel'] })])).not.toBe('none')
    expect(matched(track({ artist: 'Calvin Harris, Dua Lipa' }), [cand({ artists: ['Calvin Harris', 'Dua Lipa'] })])).not.toBe('none')
    expect(scoreCandidate(track({ artist: 'Someone Else' }), cand()).rejected).toBe('artist differs')
  })

  it('uses duration as a gate and album as a tie-breaker', () => {
    expect(scoreCandidate(track(), cand({ durationMs: 260_000 })).rejected).toMatch(/duration/)
    const single = cand({ album: 'Midnight City (Single)', durationMs: 244_100 })
    const onAlbum = cand({ durationMs: 244_100 })
    // Same recording on two releases: not ambiguous, and the album the library has wins.
    expect(matched(track(), [single, onAlbum])).toBe(onAlbum.id)
    // A compilation album name doesn't stop a match.
    expect(matched(track({ album: 'Now 80' }), [cand()])).not.toBe('none')
  })

  it('never takes a live, remix, acoustic or re-recorded version for the studio track (or vice versa)', () => {
    for (const name of ['Midnight City - Live', 'Midnight City (Eric Prydz Remix)', 'Midnight City (Acoustic)', "Midnight City (Taylor's Version)", 'Midnight City - Radio Edit']) {
      expect(scoreCandidate(track(), cand({ name })).rejected).toMatch(/different version/)
    }
    expect(scoreCandidate(track(), cand({ album: 'Live at Brixton' })).rejected).toMatch(/live/)
    expect(scoreCandidate(track({ title: 'Midnight City (Live)' }), cand()).rejected).toMatch(/live/)
    const live = cand({ name: 'Midnight City - Live at Brixton' })
    expect(matched(track({ title: 'Midnight City (Live)' }), [cand(), live])).toBe(live.id)
  })

  it('prefers the matching master but accepts a remaster when it is all there is', () => {
    const original = cand()
    const remaster = cand({ name: 'Midnight City - 2021 Remaster' })
    expect(matched(track(), [remaster, original])).toBe(original.id)
    expect(matched(track(), [remaster])).toBe(remaster.id)
  })

  it('distinguishes clean and explicit releases when the library says which it has', () => {
    const explicit = cand({ explicit: true, isrc: 'USAAA0000001' })
    const clean = cand({ explicit: false, isrc: 'USAAA0000002' })
    expect(matched(track({ explicit: false }), [explicit, clean])).toBe(clean.id)
    expect(matched(track({ explicit: true }), [clean, explicit])).toBe(explicit.id)
    // Unknown: the explicit (original) release, not a question.
    expect(matched(track(), [clean, explicit])).toBe(explicit.id)
  })

  it('trusts a matching ISRC over spelling differences', () => {
    const c = cand({ name: '真夜中の街', artists: ['エムエイティースリー'], isrc: 'FR6V81100121' })
    expect(matched(track({ isrc: ['FR6V81100121'] }), [c])).toBe(c.id)
    expect(scoreCandidate(track({ isrc: ['FR6V81100121'] }), c).signals[0]!.name).toBe('isrc')
    // …but not when the duration says it is another recording.
    expect(matched(track({ isrc: ['FR6V81100121'], duration: 300 }), [c])).toBe('none')
  })

  it('asks instead of guessing when two different recordings fit equally', () => {
    // Same title by the same artist on two albums, both close in length: different recordings, no ISRC to tell.
    const a = cand({ album: 'First', durationMs: 240_500, isrc: 'GBAAA0000001' })
    const b = cand({ album: 'Second', durationMs: 246_000, isrc: 'GBAAA0000002' })
    const r = resolveMatch(track({ album: 'Greatest Hits' }), [a, b])
    expect(r.status).toBe('ambiguous')
    expect(r.status === 'ambiguous' && r.candidates.map((c) => c.id)).toEqual([b.id, a.id]) // closer duration first
  })

  it('handles duplicate titles by different artists', () => {
    const wrong = cand({ artists: ['Other Band'] })
    const right = cand({ album: 'Elsewhere' })
    expect(matched(track(), [wrong, right])).toBe(right.id)
  })

  it('does not auto-accept without the artist or the duration', () => {
    expect(resolveMatch(track({ artist: '' }), [cand()]).status).toBe('ambiguous')
    expect(resolveMatch(track({ artist: 'Various Artists' }), [cand()]).status).toBe('ambiguous')
    expect(resolveMatch(track({ duration: 0 }), [cand()]).status).toBe('ambiguous')
    expect(matched(track({ artist: '', isrc: ['FR6V81100121'] }), [cand({ isrc: 'FR6V81100121' })])).not.toBe('ambiguous')
  })

  it('rejects low-confidence candidates outright', () => {
    expect(resolveMatch(track(), [cand({ name: 'Midnight Town' }), cand({ durationMs: 400_000 })])).toEqual({ status: 'none' })
    expect(resolveMatch(track(), [])).toEqual({ status: 'none' })
    // Title only loosely matches and the length is off by 6 s: offered, not taken.
    expect(resolveMatch(track(), [cand({ name: 'Midnight City (Bonus)', album: 'X', durationMs: 250_000 })]).status).toBe('ambiguous')
  })

  it('explains every score with signals that add up', () => {
    const s = scoreCandidate(track({ explicit: true }), cand({ name: 'Midnight City - Remastered' }))
    expect(s.signals.map((x) => x.name)).toEqual(['title', 'artist', 'duration', 'album', 'version', 'explicit'])
    expect(s.score).toBeCloseTo(s.signals.reduce((a, x) => a + x.value, 0))
  })
})
