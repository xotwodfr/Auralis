import { describe, expect, it } from 'vitest'
import { DEFAULT_SEED, schemeCss, schemeVars, seedFromHue } from '../frontend/mobile/scheme'

const channel = (hex: string, i: number) => {
  const c = parseInt(hex.slice(i, i + 2), 16) / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
const luminance = (hex: string) => 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5)
const contrast = (a = '', b = '') => {
  const [la, lb] = [luminance(a), luminance(b)]
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

describe('M3 colour scheme', () => {
  const pairs = [
    ['on-surface', 'surface'],
    ['on-surface-variant', 'surface'],
    ['on-surface-variant', 'surface-container-high'],
    ['on-primary', 'primary'],
    ['on-primary-container', 'primary-container'],
    ['on-secondary-container', 'secondary-container'],
    ['on-error', 'error'],
    ['inverse-on-surface', 'inverse-surface'],
  ]
  const seeds = [DEFAULT_SEED, ...[0, 60, 120, 200, 280, 330].map(seedFromHue)]

  it.each(seeds.flatMap((seed) => [true, false].map((dark) => [seed, dark] as const)))('keeps text AA for seed %i (dark: %s)', (seed, dark) => {
    const v = schemeVars(seed, dark)
    for (const [fg, bg] of pairs) expect(contrast(v[`--md-sys-color-${fg}`], v[`--md-sys-color-${bg}`]), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5)
  })

  it('emits every role for both modes, dark behind the media query', () => {
    const css = schemeCss(DEFAULT_SEED)
    expect(css).toMatch(/^:root\{--md-sys-color-[a-z-]+:#[0-9a-f]{6}/)
    expect(css).toContain('@media (prefers-color-scheme: dark){:root{')
    expect(Object.keys(schemeVars(DEFAULT_SEED, true))).toEqual(expect.arrayContaining(['--md-sys-color-surface-container-highest', '--md-sys-color-on-primary-container', '--md-sys-color-outline-variant']))
  })
})
