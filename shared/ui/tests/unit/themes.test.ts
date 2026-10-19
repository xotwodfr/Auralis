/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { contrast, hexToRgb, rgbToHex } from '../../src/lib/color'

const css = readFileSync('src/styles/tokens.css', 'utf8')
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
  selectors: m[1]!.split(',').map((s) => s.trim().replace(/^\/\*[\s\S]*?\*\/\s*/, '')),
  decls: Object.fromEntries([...m[2]!.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((d) => [d[1]!, d[2]!.trim()])),
}))

/** Tokens as the browser resolves them: :root first, then every rule naming the theme, in source order. */
function tokens(theme: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const r of rules) {
    if (r.selectors.includes(':root') || r.selectors.includes(`[data-theme='${theme}']`)) Object.assign(out, r.decls)
  }
  return out
}

const PRESETS = ['light', 'dark', 'midnight', 'oled', 'nord', 'sunset', 'sakura', 'forest', 'artwork']

describe.each(PRESETS)('theme %s', (name) => {
  const t = tokens(name)
  const pairs: [string, string, number][] = [
    ['--text', '--bg', 4.5], ['--text', '--surface', 4.5],
    ['--text-body', '--surface', 4.5],
    ['--text-2', '--bg', 4.5], ['--text-2', '--surface', 4.5], ['--text-2', '--hover', 4.5],
    ['--text-3', '--bg', 4.5], ['--text-3', '--surface', 4.5],
    ['--accent', '--surface', 4.5], ['--accent-link', '--surface', 4.5],
    ['--danger-text', '--surface', 4.5],
  ]
  it.each(pairs)('%s on %s is at least %s:1', (fg, bg, min) => {
    expect(contrast(t[fg]!, t[bg]!), `${fg} ${t[fg]} on ${bg} ${t[bg]}`).toBeGreaterThanOrEqual(min)
  })
  it('dimmed (inactive) lyric lines stay at 3:1, enough for their large bold text', () => {
    const [fg, bg] = [hexToRgb(t['--text']!), hexToRgb(t['--bg']!)]
    const a = Number(t['--lyric-dim'])
    const blended = rgbToHex(...(fg.map((v, i) => v * a + bg[i]! * (1 - a)) as [number, number, number]))
    expect(contrast(blended, t['--bg']!), `${name}: ${blended} on ${t['--bg']}`).toBeGreaterThanOrEqual(3)
  })
  it('white text on --accent-fill is readable', () => {
    expect(contrast('#ffffff', t['--accent-fill']!), t['--accent-fill']).toBeGreaterThanOrEqual(4.5)
  })
})

it('the contrast helper is sane', () => {
  expect(contrast('#000000', '#ffffff')).toBeCloseTo(21)
  expect(contrast('#777777', '#808080')).toBeLessThan(1.3)
})
