import { describe, expect, it } from 'vitest'
import { DEFAULT_EFFECTS, eqHeadroom, isAudible, needsGraph, NEUTRAL_FX, normalizeEffects, resolveFx, reverbGains } from '../../src/audio/effects'
import { FRAME, LATENCY, PitchShifter } from '../../src/audio/pitchShifter'
import { impulseResponse, ROOM_SHAPES } from '../../src/audio/reverb'

const RATE = 48000

const sine = (hz: number, seconds: number, amp = 0.5) => Float32Array.from({ length: Math.round(seconds * RATE) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / RATE))
const rms = (a: Float32Array) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length)

/** The strongest frequency in `a`, by scanning a DFT at 1 Hz resolution between `lo` and `hi`. */
function peakHz(a: Float32Array, lo = 50, hi = 2000): number {
  let best = 0
  let bestHz = 0
  for (let hz = lo; hz <= hi; hz++) {
    let re = 0
    let im = 0
    const w = (2 * Math.PI * hz) / RATE
    for (let i = 0; i < a.length; i++) {
      re += a[i]! * Math.cos(w * i)
      im += a[i]! * Math.sin(w * i)
    }
    const p = re * re + im * im
    if (p > best) [best, bestHz] = [p, hz]
  }
  return bestHz
}

/** Runs the shifter in 128-sample blocks, as the AudioWorklet does, and drops the warm-up. */
function shift(input: Float32Array, semitones: number): Float32Array {
  const s = new PitchShifter()
  const out = new Float32Array(input.length)
  for (let i = 0; i < input.length; i += 128) s.process(input.subarray(i, i + 128), out.subarray(i, i + 128), 2 ** (semitones / 12))
  return out.subarray(LATENCY + FRAME)
}

describe('effects model', () => {
  it('defaults are neutral and normalisation clamps, snaps and rejects junk', () => {
    expect(normalizeEffects(undefined)).toEqual(DEFAULT_EFFECTS)
    expect(normalizeEffects({ speed: 9, pitch: -40, reverbMix: 3, room: 'cave', bypass: 'yes' })).toEqual({ ...DEFAULT_EFFECTS, speed: 2, pitch: -12, reverbMix: 1 })
    expect(normalizeEffects({ speed: 0.1, pitch: 2.6, reverbMix: -1 })).toMatchObject({ speed: 0.5, pitch: 3, reverbMix: 0 })
    expect(normalizeEffects({ speed: 1.149 }).speed).toBe(1.15)
    expect(normalizeEffects({ speed: Number.NaN, pitch: Infinity }).speed).toBe(1)
    expect(normalizeEffects({ room: 'plate', reverb: true }).room).toBe('plate')
  })

  it('bypass resolves to neutral but keeps nothing of the settings in the applied chain', () => {
    const e = { ...DEFAULT_EFFECTS, speed: 1.5, pitch: 4, reverb: true, reverbMix: 0.5, room: 'hall' as const }
    expect(resolveFx(e, true, [3, 0, 0, 0, 0, 0, 0, 0, 0, 0])).toEqual({ speed: 1.5, pitch: 4, reverb: { mix: 0.5, room: 'hall' }, eq: [3, 0, 0, 0, 0, 0, 0, 0, 0, 0] })
    expect(resolveFx({ ...e, bypass: true }, true, [3])).toBe(NEUTRAL_FX)
    expect(resolveFx({ ...e, reverb: false }, false, []).reverb).toBeNull()
    expect(resolveFx({ ...e, reverbMix: 0 }, false, []).reverb).toBeNull()
  })

  it('speed alone needs no Web Audio graph; pitch, reverb and EQ do', () => {
    expect(needsGraph({ ...NEUTRAL_FX, speed: 1.5 })).toBe(false)
    expect(needsGraph({ ...NEUTRAL_FX, pitch: -1 })).toBe(true)
    expect(needsGraph({ ...NEUTRAL_FX, reverb: { mix: 0.2, room: 'room' } })).toBe(true)
    expect(needsGraph({ ...NEUTRAL_FX, eq: [0] })).toBe(true)
    expect(isAudible({ ...NEUTRAL_FX, eq: [0, 0] })).toBe(false)
    expect(isAudible({ ...NEUTRAL_FX, eq: [0, -2] })).toBe(true)
  })

  it('EQ headroom takes back the largest boost; cuts need none', () => {
    expect(eqHeadroom(null)).toBe(1)
    expect(eqHeadroom([-6, -3])).toBe(1)
    expect(eqHeadroom([6, 2, -4])).toBeCloseTo(0.501, 3)
  })

  it('reverb mix is equal power', () => {
    for (const mix of [0, 0.3, 0.7, 1]) {
      const { dry, wet } = reverbGains(mix)
      expect(dry ** 2 + wet ** 2).toBeCloseTo(1, 9)
    }
    expect(reverbGains(0)).toEqual({ dry: 1, wet: 0 })
  })
})

describe('pitch shifter (phase vocoder)', () => {
  const input = sine(440, 1)

  it.each([
    [12, 880],
    [-12, 220],
    [7, 659],
    [-5, 330],
  ])('%i semitones moves 440 Hz to ~%i Hz', (semitones, hz) => {
    expect(Math.abs(peakHz(shift(input, semitones)) - hz)).toBeLessThanOrEqual(hz * 0.015)
  })

  it('shifts every partial of a chord, not just the loudest', () => {
    const a = sine(220, 1, 0.4)
    const b = sine(330, 1, 0.3)
    const out = shift(a.map((v, i) => v + b[i]!), 12)
    expect(Math.abs(peakHz(out, 400, 500) - 440)).toBeLessThanOrEqual(5)
    expect(Math.abs(peakHz(out, 600, 720) - 660)).toBeLessThanOrEqual(8)
    // Little of the original pitches is left.
    const level = (hz: number) => {
      let re = 0
      let im = 0
      out.forEach((v, i) => ((re += v * Math.cos((2 * Math.PI * hz * i) / RATE)), (im += v * Math.sin((2 * Math.PI * hz * i) / RATE))))
      return Math.hypot(re, im)
    }
    expect(level(220)).toBeLessThan(level(440) / 10)
    expect(level(330)).toBeLessThan(level(660) / 10)
  })

  it('keeps the duration: one second in, one second out (pitch is independent of speed)', () => {
    const s = new PitchShifter()
    const out = new Float32Array(input.length)
    s.process(input, out, 2)
    expect(out.length).toBe(input.length)
  })

  it('keeps the level within 1.5 dB', () => {
    for (const semitones of [0, 5, 12, -12]) {
      const ratio = rms(shift(input, semitones)) / rms(input.subarray(LATENCY + FRAME))
      expect(Math.abs(20 * Math.log10(ratio))).toBeLessThan(1.5)
    }
  })

  it('at ratio 1 it reproduces the input, delayed by LATENCY samples', () => {
    const s = new PitchShifter()
    const out = new Float32Array(input.length)
    s.process(input, out, 1)
    let err = 0
    for (let i = LATENCY + FRAME; i < input.length; i++) err = Math.max(err, Math.abs(out[i]! - input[i - LATENCY]!))
    expect(err).toBeLessThan(0.01)
  })

  it('reset clears its history', () => {
    const s = new PitchShifter()
    const out = new Float32Array(4096)
    s.process(sine(440, 4096 / RATE), out, 2)
    s.reset()
    s.process(new Float32Array(4096), out, 2)
    expect(rms(out)).toBe(0)
  })
})

describe('reverb impulse responses', () => {
  it.each(['room', 'hall', 'plate'] as const)('%s: length = predelay + RT60, unit energy, deterministic, decays', (room) => {
    const [l, r] = impulseResponse(room, RATE)
    const s = ROOM_SHAPES[room]
    expect(l.length).toBe(Math.round(s.preDelay * RATE) + Math.round(s.seconds * RATE))
    for (const ch of [l, r]) expect(ch.reduce((a, v) => a + v * v, 0)).toBeCloseTo(1, 4)
    expect(impulseResponse(room, RATE)[0]).toEqual(l)
    expect(l.subarray(0, Math.round(s.preDelay * RATE)).every((v) => v === 0)).toBe(true)
    const tenth = Math.floor(l.length / 10)
    expect(rms(l.subarray(-tenth))).toBeLessThan(rms(l.subarray(Math.round(s.preDelay * RATE), tenth)) / 100)
    // Decorrelated channels give the stereo spread.
    const corr = l.reduce((a, v, i) => a + v * r[i]!, 0)
    expect(Math.abs(corr)).toBeLessThan(0.1)
  })

  it('the rooms really differ: hall is longest, plate is brightest', () => {
    const brightness = (a: Float32Array) => {
      let diff = 0
      for (let i = 1; i < a.length; i++) diff += (a[i]! - a[i - 1]!) ** 2
      return diff // first-difference energy: high-frequency content of a unit-energy signal
    }
    const [room, hall, plate] = (['room', 'hall', 'plate'] as const).map((r) => impulseResponse(r, RATE)[0])
    expect(hall!.length).toBeGreaterThan(plate!.length)
    expect(plate!.length).toBeGreaterThan(room!.length)
    expect(brightness(plate!)).toBeGreaterThan(2 * brightness(room!))
    expect(brightness(plate!)).toBeGreaterThan(2 * brightness(hall!))
  })
})
