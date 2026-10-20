// Pitch shifting that keeps the tempo: a phase vocoder with peak locking (Laroche & Dolson, 1999). Each frame is analysed
// into spectral peaks with their true frequencies; every peak moves, with the bins around it, to ratio × its frequency,
// and the bins of a peak keep their phase relationship, which avoids most of the "phasey" sound of a plain vocoder.
// Runs inside the AudioWorklet (pitchWorklet.ts); free of Web Audio so it can be tested on plain arrays.

export const FRAME = 2048
const OVERSAMPLE = 4
export const HOP = FRAME / OVERSAMPLE
/** Delay between input and output, in samples (~43 ms at 48 kHz). */
export const LATENCY = FRAME
const HALF = FRAME / 2
const BINS = FRAME / 2 + 1
const TWO_PI = 2 * Math.PI
// Hann analysis and synthesis windows overlap-added at 4x sum to 1.5, and a one-sided spectrum gives back half a frame.
const GAIN = 2 / (FRAME * 1.5)

const WINDOW = Float64Array.from({ length: FRAME }, (_, i) => 0.5 - 0.5 * Math.cos((TWO_PI * i) / FRAME))
const COS = Float64Array.from({ length: FRAME / 2 }, (_, i) => Math.cos((TWO_PI * i) / FRAME))
const SIN = Float64Array.from({ length: FRAME / 2 }, (_, i) => Math.sin((TWO_PI * i) / FRAME))
const REVERSED = Uint32Array.from({ length: FRAME }, (_, i) => {
  let r = 0
  for (let b = 1, v = i; b < FRAME; b <<= 1, v >>= 1) r = (r << 1) | (v & 1)
  return r
})

/** In-place radix-2 FFT; `inverse` is unscaled. */
function fft(re: Float64Array, im: Float64Array, inverse: boolean) {
  for (let i = 0; i < FRAME; i++) {
    const j = REVERSED[i]!
    if (j > i) {
      const r = re[i]!
      re[i] = re[j]!
      re[j] = r
      const m = im[i]!
      im[i] = im[j]!
      im[j] = m
    }
  }
  const sign = inverse ? 1 : -1
  for (let size = 2; size <= FRAME; size *= 2) {
    const half = size / 2
    const stride = FRAME / size
    for (let start = 0; start < FRAME; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = COS[k * stride]!
        const wi = sign * SIN[k * stride]!
        const a = start + k
        const b = a + half
        const tr = re[b]! * wr - im[b]! * wi
        const ti = re[b]! * wi + im[b]! * wr
        re[b] = re[a]! - tr
        im[b] = im[a]! - ti
        re[a] = re[a]! + tr
        im[a] = im[a]! + ti
      }
    }
  }
}

export class PitchShifter {
  // Preallocated: this runs on the audio thread, where garbage collection pauses would be audible.
  private input = new Float64Array(FRAME)
  private output = new Float64Array(HOP)
  private accum = new Float64Array(FRAME)
  private re = new Float64Array(FRAME)
  private im = new Float64Array(FRAME)
  private magnitude = new Float64Array(BINS)
  private phase = new Float64Array(BINS)
  private lastPhase = new Float64Array(BINS)
  private frequency = new Float64Array(BINS)
  private synthPhase = new Float64Array(BINS)
  private peaks = new Int32Array(BINS)
  private rover = FRAME - HOP
  private fresh = true

  reset(): void {
    for (const a of [this.input, this.output, this.accum, this.lastPhase, this.synthPhase]) a.fill(0)
    this.rover = FRAME - HOP
    this.fresh = true
  }

  /** Shifts `input` by `ratio` (2 = one octave up) into `output`, which has the same length. Keeps state across calls. */
  process(input: Float32Array, output: Float32Array, ratio: number): void {
    for (let i = 0; i < input.length; i++) {
      this.input[this.rover] = input[i]!
      output[i] = this.output[this.rover - (FRAME - HOP)]!
      if (++this.rover === FRAME) {
        this.rover = FRAME - HOP
        this.frame(ratio)
      }
    }
  }

  private frame(ratio: number) {
    const { re, im, magnitude, phase, lastPhase, frequency, synthPhase, peaks } = this
    // Zero-phase window (frame centre at index 0): bins around a peak then share its phase, so a peak drifting to the
    // neighbouring bin between frames does not flip the phase it continues from.
    for (let k = 0; k < FRAME; k++) {
      re[(k + HALF) % FRAME] = this.input[k]! * WINDOW[k]!
      im[k] = 0
    }
    fft(re, im, false)

    // Each bin's true frequency (in bins) from how far its phase moved beyond what the bin centre predicts.
    for (let k = 0; k < BINS; k++) {
      const p = Math.atan2(im[k]!, re[k]!)
      let d = p - lastPhase[k]! - (k * TWO_PI) / OVERSAMPLE
      d -= TWO_PI * Math.round(d / TWO_PI)
      lastPhase[k] = phase[k] = p
      magnitude[k] = Math.sqrt(re[k]! * re[k]! + im[k]! * im[k]!)
      frequency[k] = k + (d * OVERSAMPLE) / TWO_PI
    }

    let count = 0
    for (let k = 2; k < BINS - 2; k++) {
      const m = magnitude[k]!
      if (m > magnitude[k - 1]! && m > magnitude[k - 2]! && m >= magnitude[k + 1]! && m >= magnitude[k + 2]!) peaks[count++] = k
    }

    // Move each peak's region (half-way to the neighbouring peaks) by whole bins; the phase carries the exact frequency.
    re.fill(0)
    im.fill(0)
    for (let i = 0; i < count; i++) {
      const p = peaks[i]!
      const lo = i === 0 ? 0 : ((peaks[i - 1]! + p) >> 1) + 1
      const hi = i === count - 1 ? BINS - 1 : (p + peaks[i + 1]!) >> 1
      const target = frequency[p]! * ratio
      // Relative to the peak's own bin, so side lobes (whose measured frequency is the main partial's) keep their place.
      const shift = Math.round(target - frequency[p]!)
      if (p + shift < 0 || p + shift >= BINS) continue // shifted past Nyquist: dropped
      const peakPhase = this.fresh ? phase[p]! : synthPhase[p + shift]! + (TWO_PI * target) / OVERSAMPLE
      const rotate = peakPhase - phase[p]!
      for (let k = Math.max(lo, -shift), end = Math.min(hi, BINS - 1 - shift); k <= end; k++) {
        const ph = phase[k]! + rotate
        re[k + shift] = re[k + shift]! + magnitude[k]! * Math.cos(ph)
        im[k + shift] = im[k + shift]! + magnitude[k]! * Math.sin(ph)
      }
    }
    this.fresh = false
    for (let k = 0; k < BINS; k++) synthPhase[k] = Math.atan2(im[k]!, re[k]!)
    fft(re, im, true)

    for (let k = 0; k < FRAME; k++) this.accum[k] = this.accum[k]! + WINDOW[k]! * re[(k + HALF) % FRAME]! * GAIN
    this.output.set(this.accum.subarray(0, HOP))
    this.accum.copyWithin(0, HOP)
    this.accum.fill(0, FRAME - HOP)
    this.input.copyWithin(0, HOP)
  }
}
