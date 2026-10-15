// Impulse responses for the reverb, synthesised: exponentially decaying noise that darkens as it decays, the way air and
// walls absorb high frequencies first. Seeded, so a room always sounds the same (and tests are deterministic).

import { ROOMS, type Room } from './effects'

interface Shape {
  /** RT60: seconds to fall 60 dB. */
  seconds: number
  preDelay: number
  /** One-pole lowpass coefficient at the start and end of the tail (1 = unfiltered). */
  brightStart: number
  brightEnd: number
}

export const ROOM_SHAPES: Record<Room, Shape> = {
  room: { seconds: 0.8, preDelay: 0.004, brightStart: 0.4, brightEnd: 0.1 },
  hall: { seconds: 2.8, preDelay: 0.022, brightStart: 0.35, brightEnd: 0.05 },
  plate: { seconds: 1.6, preDelay: 0, brightStart: 0.95, brightEnd: 0.7 },
}

/** mulberry32 */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Two decorrelated channels (stereo spread), each with unit energy so the wet signal is about as loud as the dry one. */
export function impulseResponse(room: Room, sampleRate: number): [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>] {
  const s = ROOM_SHAPES[room]
  const start = Math.round(s.preDelay * sampleRate)
  const length = start + Math.round(s.seconds * sampleRate)
  const decay = Math.log(1000) / (s.seconds * sampleRate) // amplitude 1/1000 = -60 dB at RT60
  const channel = (seed: number) => {
    const next = random(seed)
    const out = new Float32Array(length)
    let y = 0
    let energy = 0
    for (let i = start; i < length; i++) {
      const n = i - start
      y += (s.brightStart + ((s.brightEnd - s.brightStart) * n) / (length - start)) * (next() * 2 - 1 - y)
      const v = y * Math.exp(-decay * n)
      out[i] = v
      energy += v * v
    }
    const g = 1 / Math.sqrt(energy)
    for (let i = start; i < length; i++) out[i]! *= g
    return out
  }
  const seed = ROOMS.indexOf(room) * 2 + 1
  return [channel(seed), channel(seed + 1)]
}
