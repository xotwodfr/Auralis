import { activeLine, fillTimes, parseLrc, withGaps } from '../../src/api/lyrics/lrc'

describe('parseLrc', () => {
  it('parses timestamps with 0-3 fraction digits, either separator, and sorts by time', () => {
    const { synced, lines } = parseLrc('[00:10.5]c\n[00:01]a\n[01:02.250]d\n[00:05:50]b')
    expect(synced).toBe(true)
    expect(lines).toEqual([
      { time: 1, text: 'a' },
      { time: 5.5, text: 'b' },
      { time: 10.5, text: 'c' },
      { time: 62.25, text: 'd' },
    ])
  })

  it('expands multiple timestamps on one line', () => {
    const { lines } = parseLrc('[00:10.00][00:30.00]Chorus line')
    expect(lines).toEqual([{ time: 10, text: 'Chorus line' }, { time: 30, text: 'Chorus line' }])
  })

  it('skips metadata tags, applies offset (positive = sooner), and strips word-level tags', () => {
    const { lines } = parseLrc('[ar:Someone]\n[ti:Song]\n[offset:500]\n[00:02.00]<00:02.00>Hel<00:02.40>lo\n')
    expect(lines).toMatchObject([{ time: 1.5, text: 'Hello' }])
  })

  it('keeps empty-text timestamps (line ends) and tolerates CRLF and a BOM', () => {
    const { lines } = parseLrc('﻿[00:01.00]one\r\n[00:03.00]\r\n[00:05.00]two')
    expect(lines.map((l) => l.text)).toEqual(['one', '', 'two'])
  })

  it('skips malformed timestamps without throwing', () => {
    const { synced, lines } = parseLrc('[00:99.00]bad seconds\n[1:2]worse\n[xx:yy]nope\n[00:04.00]good')
    expect(synced).toBe(true)
    expect(lines).toEqual([{ time: 4, text: 'good' }])
  })

  it('treats text without any valid timestamp as plain, not synced', () => {
    const { synced, lines } = parseLrc('[Chorus]\nHello there\n\n\n\nSecond verse\n[ar:X]\n')
    expect(synced).toBe(false)
    expect(lines).toEqual([
      { time: null, text: '[Chorus]' },
      { time: null, text: 'Hello there' },
      { time: null, text: '' },
      { time: null, text: 'Second verse' },
    ])
  })

  it('returns no lines for empty or timestamp-only-invalid input', () => {
    expect(parseLrc('')).toEqual({ synced: false, lines: [] })
    expect(parseLrc('\n  \n')).toEqual({ synced: false, lines: [] })
  })
})

describe('activeLine', () => {
  const lines = [{ time: 2, text: 'a' }, { time: 5, text: 'b' }, { time: 9, text: 'c' }]
  it.each([
    [0, -1],
    [1.99, -1],
    [2, 0], // boundary is inclusive
    [4.99, 0],
    [5, 1],
    [8.5, 1],
    [9, 2],
    [999, 2], // after the last line it stays on the last
  ])('position %s -> %s', (pos, idx) => expect(activeLine(lines, pos)).toBe(idx))
  it('handles an empty list', () => expect(activeLine([], 5)).toBe(-1))
})

describe('enhanced LRC word timing', () => {
  it('reads <mm:ss.xx> word tags into timed words, joining syllables without a space', () => {
    const { lines } = parseLrc('[00:10.00]<00:10.00>Hel<00:10.40>lo <00:11.00>world<00:12.00>\n[00:15.00]next')
    expect(lines[0]).toEqual({
      time: 10,
      text: 'Hello world',
      words: [
        { text: 'Hel', start: 10, end: 10.4, joinNext: true },
        { text: 'lo', start: 10.4, end: 11 },
        { text: 'world', start: 11, end: 12 },
      ],
    })
    expect(lines[1]).toEqual({ time: 15, text: 'next' })
  })

  it('ends an unclosed last word at the next line, and applies the offset to words', () => {
    const { lines } = parseLrc('[offset:1000]\n[00:10.00]<00:10.00>a <00:11.00>b\n[00:13.00]c')
    expect(lines[0]!.words).toEqual([
      { text: 'a', start: 9, end: 10 },
      { text: 'b', start: 10, end: 12 },
    ])
  })

  it('falls back to line timing when tags go backwards or a line has several timestamps', () => {
    expect(parseLrc('[00:10.00]<00:11.00>a <00:10.50>b').lines[0]!.words).toBeUndefined()
    expect(parseLrc('[00:10.00][00:20.00]<00:10.00>a <00:11.00>b').lines.every((l) => !l.words)).toBe(true)
  })
})

describe('fillTimes', () => {
  it('borrows missing times from neighbours and never lets a word end before it starts', () => {
    const w = fillTimes(
      [
        { text: 'a', start: 1, end: 2 },
        { text: 'b', start: NaN, end: NaN },
        { text: 'c', start: 3, end: 2.5 },
      ],
      1,
      4,
    )
    expect(w.map((x) => [x.start, x.end])).toEqual([[1, 2], [2, 3], [3, 3]])
  })

  it('returns nothing when no time anchors the line', () => {
    expect(fillTimes([{ text: 'a', start: NaN, end: NaN }], NaN, NaN)).toEqual([])
  })
})

describe('withGaps', () => {
  const timed = (time: number, end: number, text = 'x') => ({ time, text, words: [{ text, start: time, end }] })

  it('adds timed dots for a long intro and for a pause after a word-timed line', () => {
    const out = withGaps([timed(6, 7), timed(20, 21)])
    expect(out.map((l) => l.text)).toEqual(['', 'x', '', 'x'])
    const gap = out[2]!
    expect(gap.time).toBe(7)
    expect(gap.words).toHaveLength(3)
    expect(gap.words![2]!.end).toBe(19.5) // done just before the next line comes in
  })

  it('times existing LRC gaps, and adds nothing where the end of a line is unknown', () => {
    const out = withGaps([{ time: 1, text: 'a' }, { time: 3, text: '' }, { time: 30, text: 'b' }])
    expect(out).toHaveLength(3)
    expect(out[1]!.words![0]!.start).toBe(3)
    expect(out[1]!.words![2]!.end).toBe(29.5)
  })
})
