import { contrast, hexToRgb, hslToHex, luminance, rgbToHsl, withContrast } from '../../src/lib/color'
import { derivePalette, PALETTE_KEYS, parsePalette } from '../../src/lib/palette'

const solid = (r: number, g: number, b: number, n = 256, a = 255) => new Uint8ClampedArray(Array.from({ length: n }, () => [r, g, b, a]).flat())
const mix = (...parts: [Uint8ClampedArray, number][]) => {
  const out: number[] = []
  for (const [px, times] of parts) for (let i = 0; i < times; i++) out.push(...px)
  return new Uint8ClampedArray(out)
}

function expectReadable(p: ReturnType<typeof derivePalette>) {
  const v = p.vars
  for (const bg of [v['--bg'], v['--surface'], v['--hover']]) {
    for (const fg of ['--text', '--text-body', '--text-2', '--text-3', '--accent', '--accent-link'] as const) {
      expect(contrast(v[fg], bg), `${fg} ${v[fg]} on ${bg}`).toBeGreaterThanOrEqual(4.5)
    }
  }
  expect(contrast('#ffffff', v['--accent-fill']), v['--accent-fill']).toBeGreaterThanOrEqual(4.5)
  expect(luminance(v['--bg'])).toBeLessThan(0.03) // always a dark, calm ground
}

describe('color helpers', () => {
  it('round-trips and measures', () => {
    const [h, s, l] = rgbToHsl(...hexToRgb('#3366cc'))
    expect(hslToHex(h, s, l)).toBe('#3366cc')
    expect(rgbToHsl(128, 128, 128)[1]).toBe(0)
    expect(contrast(withContrast(220, 0.5, 0.2, '#000000', 7, 1), '#000000')).toBeGreaterThanOrEqual(7)
  })
})

describe('derivePalette', () => {
  it('takes the dominant hue and stays readable', () => {
    const p = derivePalette(mix([solid(220, 30, 30, 1), 100], [solid(30, 30, 220, 1), 20]))
    expect(p.hue).not.toBeNull()
    expect(Math.min(p.hue!, 360 - p.hue!)).toBeLessThan(15) // red, not blue
    expectReadable(p)
  })

  it.each([
    ['pure red', [255, 0, 0]],
    ['neon yellow', [255, 255, 0]],
    ['neon green', [0, 255, 60]],
    ['bright magenta', [255, 0, 255]],
    ['deep navy', [0, 0, 60]],
    ['pastel', [250, 200, 220]],
    ['muddy brown', [90, 60, 40]],
  ])('%s cover yields a readable, restrained palette', (_, [r, g, b]) => {
    const p = derivePalette(solid(r!, g!, b!))
    expectReadable(p)
  })

  it.each(Array.from({ length: 12 }, (_, i) => i * 30))('hue %s° is readable', (hue) => {
    const [r, g, b] = hexToRgb(hslToHex(hue, 0.9, 0.5))
    expectReadable(derivePalette(solid(r, g, b)))
  })

  it.each([
    ['black', solid(0, 0, 0)],
    ['white', solid(255, 255, 255)],
    ['mid gray', solid(120, 120, 120)],
    ['gray gradient', new Uint8ClampedArray(Array.from({ length: 256 }, (_, i) => [i, i, i, 255]).flat())],
    ['empty', new Uint8ClampedArray(0)],
    ['fully transparent', solid(255, 0, 0, 64, 0)],
    ['almost gray (1% colour)', mix([solid(120, 120, 120, 1), 99], [solid(255, 0, 0, 1), 1])],
  ])('%s falls back to a neutral palette with the default accent', (_, px) => {
    const p = derivePalette(px)
    expect(p.hue).toBeNull()
    expectReadable(p)
  })

  it('ignores transparent pixels when choosing the hue', () => {
    const p = derivePalette(mix([solid(255, 0, 0, 1, 0), 500], [solid(0, 80, 255, 1), 20]))
    expect(p.hue).toBeGreaterThan(200)
    expect(p.hue).toBeLessThan(250)
  })

  it('emits exactly the documented variables', () => {
    expect(Object.keys(derivePalette(solid(10, 200, 90)).vars).sort()).toEqual([...PALETTE_KEYS].sort())
  })
})

describe('parsePalette', () => {
  const good = derivePalette(solid(10, 200, 90))
  it('accepts what derivePalette produces', () => expect(parsePalette(JSON.parse(JSON.stringify(good)))).toEqual(good))
  it.each([
    ['null', null],
    ['a string', 'x'],
    ['missing keys', { vars: { '--bg': '#000000' }, hue: 1 }],
    ['bad hue', { vars: good.vars, hue: 'red' }],
  ])('rejects %s', (_, v) => expect(parsePalette(v)).toBeNull())
  it.each(['url(javascript:alert(1))', '#000; background: red', 'expression(alert(1))\n', '</style><script>'])('rejects hostile value %j', (bad) => {
    expect(parsePalette({ vars: { ...good.vars, '--bg': bad }, hue: 1 })).toBeNull()
  })
})
