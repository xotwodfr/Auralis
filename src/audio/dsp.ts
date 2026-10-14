// Vocal remover on the Web Audio graph, as a mid/side matrix. Lead vocals sit in the mid (L+R)/2; the side (L-R)/2
// holds the wide instruments and reverb. Output is L = mid' + side, R = mid' - side, where mid' keeps the bass
// (below BASS_HZ) untouched and scales the rest by (1 - amount), with an extra dip across the vocal band. So at
// amount 0 it is the original, at 1 it is plain L-R cancellation, and in between kick and bass survive.
// The original path stays connected and is crossfaded, so toggling never clicks or interrupts playback.
// The graph also holds the equaliser, which runs before the vocal remover, so both share one routed audio source.

export type KaraokeState = 'off' | 'on' | 'mono' | 'unavailable'

const RAMP_S = 0.08 // time constant of the dry/wet crossfade
const BASS_HZ = 150
const VOCAL_HZ = 2200 // centre of the 1-3.5 kHz vocal presence band
const VOCAL_Q = 0.6
const VOCAL_DIP_DB = 12 // extra cut at the centre of the band at full amount
export const DEFAULT_AMOUNT = 0.6
export const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
export const EQ_RANGE_DB = 12
const POLL_MS = 500
const MIN_LEVEL = 0.005 // below this the track is silent, so there is nothing to judge
const MONO_RATIO = 0.003 // side/mid energy under this (about -50 dB) means L == R
const MONO_POLLS = 6 // consecutive polls, so a quiet intro or a mono intro or breakdown does not flip the mode

function rms(a: AnalyserNode, buf: Float32Array<ArrayBuffer>): number {
  a.getFloatTimeDomainData(buf)
  let sum = 0
  for (const v of buf) sum += v * v
  return Math.sqrt(sum / buf.length)
}

/** The mid/side matrix between `src` (stereo) and `out`. `side` is a tap for mono detection. Exported for tests. */
export function buildMatrix(c: BaseAudioContext, src: AudioNode, out: AudioNode) {
  const rest = c.createGain()
  const dip = c.createBiquadFilter()
  const sideProbe = c.createGain()
  const mono = (gain: number) => {
    const g = c.createGain()
    g.gain.value = gain
    g.channelCount = 1
    g.channelCountMode = 'explicit'
    return g
  }
  const split = c.createChannelSplitter(2)
  const merge = c.createChannelMerger(2)

  // mid = (L + R) / 2: the 1-channel input downmixes the stereo source. Bass passes whole; the rest is mid - bass.
  const mid = mono(1)
  const bass = c.createBiquadFilter()
  bass.type = 'lowpass'
  bass.frequency.value = BASS_HZ
  const restSum = mono(1)
  const minusBass = mono(-1)
  dip.type = 'peaking'
  dip.frequency.value = VOCAL_HZ
  dip.Q.value = VOCAL_Q
  src.connect(mid)
  mid.connect(bass)
  mid.connect(restSum)
  bass.connect(minusBass).connect(restSum)
  restSum.connect(dip).connect(rest)
  for (const ch of [0, 1]) {
    bass.connect(merge, 0, ch)
    rest.connect(merge, 0, ch)
  }

  // side = (L - R) / 2, with opposite signs on the two outputs.
  const side = mono(0.5)
  const minusR = mono(-1)
  const minusSide = mono(-1)
  src.connect(split)
  split.connect(side, 0)
  split.connect(minusR, 1).connect(side)
  side.connect(merge, 0, 0)
  side.connect(minusSide).connect(merge, 0, 1)
  side.connect(sideProbe)

  merge.connect(out)
  return { rest, dip, side: sideProbe }
}

/** 0 = no reduction, 1 = full mid cancellation. Smoothed, so dragging a slider does not zipper. */
export function setAmount(c: BaseAudioContext, m: { rest: GainNode; dip: BiquadFilterNode }, amount: number): void {
  const a = Math.min(1, Math.max(0, amount))
  m.rest.gain.setTargetAtTime(1 - a, c.currentTime, RAMP_S)
  m.dip.gain.setTargetAtTime(-VOCAL_DIP_DB * a, c.currentTime, RAMP_S)
}

export class AudioGraph {
  static get supported() {
    return typeof AudioContext !== 'undefined'
  }

  private ctx = new AudioContext()
  private input = this.ctx.createGain()
  private eq = EQ_FREQS.map((f, i) => {
    const b = this.ctx.createBiquadFilter()
    b.type = i === 0 ? 'lowshelf' : i === EQ_FREQS.length - 1 ? 'highshelf' : 'peaking'
    b.frequency.value = f
    b.Q.value = 1.1
    return b
  })
  private dry = this.ctx.createGain()
  private wet = this.ctx.createGain()
  private mid = this.ctx.createAnalyser()
  private side = this.ctx.createAnalyser()
  private buf = new Float32Array(new ArrayBuffer(this.mid.fftSize * 4))
  private matrix: ReturnType<typeof buildMatrix>
  private active = false
  private mono = false
  private quiet = 0
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(
    amount: number,
    private onState: (state: KaraokeState) => void,
  ) {
    const c = this.ctx
    const pre = c.createGain()
    let tail: AudioNode = this.input
    for (const b of this.eq) tail = tail.connect(b)
    tail.connect(pre)
    this.matrix = buildMatrix(c, pre, this.wet)
    this.matrix.side.connect(this.side)
    this.wet.gain.value = 0
    pre.connect(this.dry).connect(c.destination)
    pre.connect(this.mid)
    this.wet.connect(c.destination)
    this.setAmount(amount)
  }

  /** Routes an element through the graph. Throws if it is already routed, or is cross-origin without CORS. */
  attach(element: HTMLMediaElement): void {
    this.ctx.createMediaElementSource(element).connect(this.input)
  }

  /** Band gains in dB, one per `EQ_FREQS`; all zero is flat. Smoothed, so dragging does not zipper. */
  setEq(gains: readonly number[]): void {
    this.eq.forEach((b, i) => {
      const g = Math.min(EQ_RANGE_DB, Math.max(-EQ_RANGE_DB, gains[i] ?? 0))
      b.gain.setTargetAtTime(g, this.ctx.currentTime, RAMP_S)
    })
  }

  setAmount(amount: number): void {
    setAmount(this.ctx, this.matrix, amount)
  }
  /** Browsers start contexts suspended until a user gesture, and may suspend them again. */
  resume(): void {
    if (this.ctx.state !== 'running') void this.ctx.resume().catch(() => undefined)
  }

  setActive(on: boolean): void {
    this.active = on
    this.quiet = 0
    if (!on) this.mono = false
    this.apply()
    clearInterval(this.timer)
    if (on) {
      this.resume()
      this.timer = setInterval(() => this.checkMono(), POLL_MS)
    }
    this.onState(on ? 'on' : 'off')
  }

  private apply() {
    const wet = this.active && !this.mono ? 1 : 0
    const t = this.ctx.currentTime
    this.wet.gain.setTargetAtTime(wet, t, RAMP_S)
    this.dry.gain.setTargetAtTime(1 - wet, t, RAMP_S)
  }

  // L - R of a mono track is silence, which would mute the song; fall back to the original instead.
  private checkMono() {
    const mid = rms(this.mid, this.buf)
    if (mid < MIN_LEVEL) return
    const isMono = rms(this.side, this.buf) / mid < MONO_RATIO
    this.quiet = isMono ? this.quiet + 1 : 0
    if (!this.mono && this.quiet >= MONO_POLLS) {
      this.mono = true
      this.apply()
      this.onState('mono')
    } else if (this.mono && !isMono) {
      this.mono = false
      this.apply()
      this.onState('on')
    }
  }
}
