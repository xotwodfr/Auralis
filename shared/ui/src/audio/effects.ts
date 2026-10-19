// The user's audio effects and what the engine is asked to apply. Pure: no Web Audio, so it is tested on its own.
// Speed is the media element's own time-stretch (pitch kept); pitch, reverb and the equaliser run on the Web Audio graph.

export type Room = 'room' | 'hall' | 'plate'
export const ROOMS: readonly Room[] = ['room', 'hall', 'plate']

export interface Effects {
  /** Master bypass: plays the original sound and keeps every setting below. */
  bypass: boolean
  speed: number
  /** Semitones, independent of speed. */
  pitch: number
  reverb: boolean
  /** Wet/dry balance, 0 (dry) to 1 (only the reverb). */
  reverbMix: number
  room: Room
}

export const SPEED_MIN = 0.5
export const SPEED_MAX = 2
export const SPEED_STEP = 0.05
export const PITCH_RANGE = 12
export const DEFAULT_EFFECTS: Effects = { bypass: false, speed: 1, pitch: 0, reverb: false, reverbMix: 0.3, room: 'room' }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback)

/** Untrusted input (storage, UI) to valid settings: missing or bad fields take the default, numbers are clamped and snapped. */
export function normalizeEffects(raw: unknown): Effects {
  const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const d = DEFAULT_EFFECTS
  return {
    bypass: bool(r.bypass, d.bypass),
    speed: Number((Math.round(clamp(num(r.speed, d.speed), SPEED_MIN, SPEED_MAX) / SPEED_STEP) * SPEED_STEP).toFixed(2)),
    pitch: Math.round(clamp(num(r.pitch, d.pitch), -PITCH_RANGE, PITCH_RANGE)),
    reverb: bool(r.reverb, d.reverb),
    reverbMix: clamp(num(r.reverbMix, d.reverbMix), 0, 1),
    room: ROOMS.includes(r.room as Room) ? (r.room as Room) : d.room,
  }
}

/** What the engine applies; `null` means that stage is off. */
export interface AppliedFx {
  speed: number
  pitch: number
  reverb: { mix: number; room: Room } | null
  eq: readonly number[] | null
}

export const NEUTRAL_FX: AppliedFx = { speed: 1, pitch: 0, reverb: null, eq: null }

/** Bypass wins over everything, so switching it off restores the exact settings the user had. */
export function resolveFx(e: Effects, eqEnabled: boolean, eqGains: readonly number[]): AppliedFx {
  if (e.bypass) return NEUTRAL_FX
  return { speed: e.speed, pitch: e.pitch, reverb: e.reverb && e.reverbMix > 0 ? { mix: e.reverbMix, room: e.room } : null, eq: eqEnabled ? eqGains : null }
}

export const needsGraph = (fx: AppliedFx) => fx.pitch !== 0 || fx.reverb !== null || fx.eq !== null

/** Something would actually change the sound (an enabled but flat equaliser does not). */
export const isAudible = (fx: AppliedFx) => fx.speed !== 1 || fx.pitch !== 0 || fx.reverb !== null || (fx.eq?.some((g) => g !== 0) ?? false)

/** Output trim that takes back the largest EQ boost, so boosting bands cannot push a loud master into clipping. */
export const eqHeadroom = (eq: readonly number[] | null) => 10 ** (-Math.max(0, ...(eq ?? [])) / 20)

/** Equal-power wet/dry, so loudness stays about level as the mix moves (the impulse responses have unit energy). */
export const reverbGains = (mix: number) => ({ dry: Math.cos((mix * Math.PI) / 2), wet: Math.sin((mix * Math.PI) / 2) })
