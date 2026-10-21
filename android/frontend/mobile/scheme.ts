import { Hct, MaterialDynamicColors, SchemeTonalSpot, argbFromHex, hexFromArgb } from '@material/material-color-utilities'

/** The app's own seed when no cover drives the colours. */
export const DEFAULT_SEED = argbFromHex('#1ed760')

const ROLES = new MaterialDynamicColors().allColors

/** Every M3 colour role for one seed and mode, as `--md-sys-color-*` custom properties (2025 / Expressive spec). */
export function schemeVars(seed: number, dark: boolean): Record<string, string> {
  const scheme = new SchemeTonalSpot(Hct.fromInt(seed), dark, 0, '2025')
  const vars: Record<string, string> = {}
  for (const role of ROLES) {
    if (role.name.endsWith('palette_key_color')) continue
    vars[`--md-sys-color-${role.name.replace(/_/g, '-')}`] = hexFromArgb(role.getArgb(scheme))
  }
  return vars
}

/** A cover's dominant hue as a seed: chroma and tone are fixed so every cover gives a usable scheme. */
export const seedFromHue = (hue: number) => Hct.from(hue, 48, 50).toInt()

const block = (vars: Record<string, string>) => Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(';')

/** Light and dark schemes in one stylesheet, so the system setting picks between them without JS. */
export function schemeCss(seed: number): string {
  return `:root{${block(schemeVars(seed, false))}}@media (prefers-color-scheme: dark){:root{${block(schemeVars(seed, true))}}}`
}

let applied: number | null = null
export function applyScheme(seed: number) {
  if (seed === applied) return
  applied = seed
  let el = document.getElementById('md-scheme') as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = 'md-scheme'
    document.head.appendChild(el)
  }
  el.textContent = schemeCss(seed)
}
