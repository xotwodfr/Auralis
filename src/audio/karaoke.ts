// Vocal remover: centre-channel cancellation on the Web Audio graph. Lead vocals are mixed dead centre, so
// (L - R) / 2 drops them and keeps the wide instruments. Cancelling the centre also takes the kick and bass,
// so a low-passed copy of the original is mixed back in. The original path stays connected and is crossfaded,
// so toggling never clicks or interrupts playback.

export type KaraokeState = 'off' | 'on' | 'mono' | 'unavailable'

const RAMP_S = 0.08 // time constant of the dry/wet crossfade
const BASS_HZ = 120
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

export class VocalRemover {
  static get supported() {
    return typeof AudioContext !== 'undefined'
  }

  private ctx = new AudioContext()
  private dry = this.ctx.createGain()
  private wet = this.ctx.createGain()
  private mid = this.ctx.createAnalyser()
  private side = this.ctx.createAnalyser()
  private buf = new Float32Array(new ArrayBuffer(this.mid.fftSize * 4))
  private active = false
  private mono = false
  private quiet = 0
  private timer: ReturnType<typeof setInterval> | undefined

  /** Throws if the element cannot be routed (already attached, or cross-origin without CORS). */
  constructor(
    element: HTMLMediaElement,
    private onState: (state: KaraokeState) => void,
  ) {
    const c = this.ctx
    const src = c.createMediaElementSource(element)
    const split = c.createChannelSplitter(2)
    const invert = c.createGain()
    invert.gain.value = -1
    const sideSum = c.createGain()
    sideSum.gain.value = 0.5
    sideSum.channelCount = 1
    sideSum.channelCountMode = 'explicit'
    const bass = c.createBiquadFilter()
    bass.type = 'lowpass'
    bass.frequency.value = BASS_HZ
    this.wet.gain.value = 0

    src.connect(this.dry).connect(c.destination)
    src.connect(split)
    split.connect(sideSum, 0)
    split.connect(invert, 1).connect(sideSum)
    sideSum.connect(this.wet)
    sideSum.connect(this.side)
    src.connect(bass).connect(this.wet)
    src.connect(this.mid)
    this.wet.connect(c.destination)
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
