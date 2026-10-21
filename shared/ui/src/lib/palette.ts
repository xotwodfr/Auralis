import { hslToHex, rgbToHsl, withContrast } from './color'

/** CSS custom properties to overlay on the dark base; values are plain colours/gradients, never markup. */
export type PaletteVars = Record<(typeof PALETTE_KEYS)[number], string>

export const PALETTE_KEYS = [
  '--bg', '--surface', '--hover', '--faint', '--track', '--hairline', '--text', '--text-body', '--text-2', '--text-3',
  '--accent', '--accent-link', '--accent-fill', '--slider-fill', '--grad-blue',
] as const

export interface Palette {
  vars: PaletteVars
  /** Dominant hue in degrees, or null for grayscale / near-grayscale art. */
  hue: number | null
}

const BUCKETS = 12
const MIN_CHROMATIC_SHARE = 0.04
const NEUTRAL_HUE = 222
// Caps keep neon covers from producing a neon interface: only hue (and a bounded saturation) is borrowed.
const SAT_MIN = 0.4
const SAT_MAX = 0.72
const MIN_TEXT_CONTRAST = 4.5

/**
 * Builds an always-dark palette from RGBA pixels. Lightness is fixed by us (not taken from the art), so
 * bright, dark and washed-out covers all yield the same readable structure; every text colour is
 * nudged until it reaches AA contrast against the surfaces it sits on.
 */
export function derivePalette(pixels: Uint8ClampedArray | number[]): Palette {
  const buckets = Array.from({ length: BUCKETS }, () => ({ w: 0, x: 0, y: 0, s: 0 }))
  let counted = 0
  let chromatic = 0
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if (pixels[i + 3]! < 128) continue
    counted++
    const [h, s, l] = rgbToHsl(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!)
    if (s < 0.15 || l < 0.12 || l > 0.88) continue // gray, near-black or near-white pixels carry no usable hue
    chromatic++
    const w = s * (1 - Math.abs(2 * l - 1)) // vivid, mid-lightness pixels count most
    const b = buckets[Math.floor(h / (360 / BUCKETS)) % BUCKETS]!
    b.w += w
    b.x += Math.cos((h * Math.PI) / 180) * w
    b.y += Math.sin((h * Math.PI) / 180) * w
    b.s += s * w
  }

  const top = buckets.reduce((a, b) => (b.w > a.w ? b : a))
  const hasHue = counted > 0 && chromatic / counted >= MIN_CHROMATIC_SHARE && top.w > 0
  const hue = hasHue ? ((Math.atan2(top.y, top.x) * 180) / Math.PI + 360) % 360 : null
  const h = hue ?? NEUTRAL_HUE
  const sat = hasHue ? Math.min(SAT_MAX, Math.max(SAT_MIN, top.s / top.w)) : 0.85 // neutral art: a calm default blue accent
  const tint = hasHue ? Math.min(sat * 0.45, 0.3) : 0.04

  const bg = hslToHex(h, tint, 0.08)
  const surface = hslToHex(h, tint, 0.12)
  const hover = hslToHex(h, tint, 0.16) // the lightest background text can sit on, so contrast is measured against it
  const accent = withContrast(h, sat, 0.66, hover, MIN_TEXT_CONTRAST, 1)
  const accentLink = withContrast(h, sat, 0.74, hover, MIN_TEXT_CONTRAST, 1)
  // White text on this must be readable, so darken until it is.
  const accentFill = withContrast(h, sat, 0.5, '#ffffff', MIN_TEXT_CONTRAST, -1)

  return {
    hue,
    vars: {
      '--bg': bg,
      '--surface': surface,
      '--hover': hover,
      '--faint': hslToHex(h, tint, 0.28),
      '--track': hslToHex(h, tint, 0.22),
      '--hairline': 'rgba(255, 255, 255, 0.09)',
      '--text': hslToHex(h, 0.12, 0.96),
      '--text-body': withContrast(h, 0.1, 0.86, hover, MIN_TEXT_CONTRAST, 1),
      '--text-2': withContrast(h, 0.1, 0.72, hover, MIN_TEXT_CONTRAST, 1),
      '--text-3': withContrast(h, 0.08, 0.64, hover, MIN_TEXT_CONTRAST, 1),
      '--accent': accent,
      '--accent-link': accentLink,
      '--accent-fill': accentFill,
      '--slider-fill': accent,
      '--grad-blue': `linear-gradient(135deg, ${hslToHex(h, sat, 0.45)} 0%, ${hslToHex((h + 40) % 360, sat, 0.32)} 100%)`,
    },
  }
}

const HEX = '#[0-9a-f]{6}'
// Exactly the shapes derivePalette emits: a hex colour, an rgba(), or the two-stop placeholder gradient.
const SAFE_VALUE = new RegExp(`^(${HEX}|rgba\\(\\d{1,3}, \\d{1,3}, \\d{1,3}, [\\d.]+\\)|linear-gradient\\(135deg, ${HEX} 0%, ${HEX} 100%\\))$`, 'i')

/** Validates stored/untrusted palette data: right keys, only colour-ish characters. */
export function parsePalette(v: unknown): Palette | null {
  if (typeof v !== 'object' || v === null) return null
  const { vars, hue } = v as { vars?: Record<string, unknown>; hue?: unknown }
  if (!vars || (hue !== null && typeof hue !== 'number')) return null
  const out: Record<string, string> = {}
  for (const k of PALETTE_KEYS) {
    const val = vars[k]
    if (typeof val !== 'string' || !SAFE_VALUE.test(val)) return null
    out[k] = val
  }
  return { vars: out as PaletteVars, hue: hue as number | null }
}
