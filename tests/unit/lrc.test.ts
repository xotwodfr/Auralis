import { activeLine, parseLrc } from '../../src/api/lyrics/lrc'

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
    expect(lines).toEqual([{ time: 1.5, text: 'Hello' }])
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
