// Vocal remover on the Web Audio graph, as a mid/side matrix. Lead vocals sit in the mid (L+R)/2; the side (L-R)/2
// holds the wide instruments and reverb. Output is L = mid' + side, R = mid' - side, where mid' keeps the bass
// (below BASS_HZ) untouched and scales the rest by (1 - amount), with an extra dip across the vocal band. So at
// amount 0 it is the original, at 1 it is plain L-R cancellation, and in between kick and bass survive.
// The original path stays connected and is crossfaded, so toggling never clicks or interrupts playback.
// The graph also holds the other effects, so all of them share one routed audio source:
//   element → EQ → vocal remover → pitch (worklet, or the dry bypass) → reverb (convolver sends + dry) → trim → output

import { eqHeadroom, reverbGains, type AppliedFx, type Room } from './effects'
import pitchWorkletUrl from './pitchWorklet.ts?worker&url'
import { impulseResponse } from './reverb'

export type KaraokeState = 'off' | 'on' | 'mono' | 'unavailable'
export type GraphEvent = { type: 'karaoke'; state: KaraokeState } | { type: 'pitch-unavailable' }

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
/** After pitch returns to 0 the shifter keeps running until the crossfade to the dry path is inaudible, then idles. */
const PITCH_IDLE_S = 0.5

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
  /** AudioWorklet exists only in secure contexts (HTTPS or localhost). */
  static get pitchSupported() {
    return typeof AudioWorkletNode !== 'undefined'
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
  private voice = this.ctx.createGain()
  private pitchDry = this.ctx.createGain()
  private pitchWet = this.ctx.createGain()
  private pitchNode: AudioWorkletNode | null = null
  private pitchState: 'idle' | 'loading' | 'ready' | 'failed' = 'idle'
  private pitch = 0
  private verbIn = this.ctx.createGain()
  private verbDry = this.ctx.createGain()
  /** One convolver per room, made on first use; switching rooms crossfades and lets the old tail ring out. */
  private sends = new Map<Room, GainNode>()
  private trim = this.ctx.createGain()

  constructor(
    amount: number,
    private emit: (event: GraphEvent) => void,
  ) {
    const c = this.ctx
    const pre = c.createGain()
    let tail: AudioNode = this.input
    for (const b of this.eq) tail = tail.connect(b)
    tail.connect(pre)
    this.matrix = buildMatrix(c, pre, this.wet)
    this.matrix.side.connect(this.side)
    this.wet.gain.value = 0
    pre.connect(this.dry).connect(this.voice)
    pre.connect(this.mid)
    this.wet.connect(this.voice)
    this.pitchWet.gain.value = 0
    this.voice.connect(this.pitchDry).connect(this.verbIn)
    this.pitchWet.connect(this.verbIn)
    this.verbIn.connect(this.verbDry).connect(this.trim).connect(c.destination)
    this.setAmount(amount)
  }

  /** Routes an element through the graph. Throws if it is already routed, or is cross-origin without CORS. */
  attach(element: HTMLMediaElement): void {
    this.ctx.createMediaElementSource(element).connect(this.input)
  }

  /** Everything but speed (that is the media element's). Smoothed, so dragging a slider does not zipper. */
  setEffects(fx: AppliedFx): void {
    this.setEq(fx.eq ?? [])
    this.setPitch(fx.pitch)
    this.setReverb(fx.reverb)
    this.trim.gain.setTargetAtTime(eqHeadroom(fx.eq), this.ctx.currentTime, RAMP_S)
  }

  /** Band gains in dB, one per `EQ_FREQS`; all zero is flat. */
  private setEq(gains: readonly number[]): void {
    this.eq.forEach((b, i) => {
      const g = Math.min(EQ_RANGE_DB, Math.max(-EQ_RANGE_DB, gains[i] ?? 0))
      b.gain.setTargetAtTime(g, this.ctx.currentTime, RAMP_S)
    })
  }

  private setPitch(semitones: number) {
    this.pitch = semitones
    if (semitones !== 0) this.loadPitch()
    const t = this.ctx.currentTime
    const on = semitones !== 0 && this.pitchNode !== null
    this.pitchWet.gain.setTargetAtTime(on ? 1 : 0, t, RAMP_S)
    this.pitchDry.gain.setTargetAtTime(on ? 0 : 1, t, RAMP_S)
    const param = this.pitchNode?.parameters.get('semitones')
    if (!param) return
    param.cancelScheduledValues(t)
    // Back to 0: keep shifting while the crossfade to the dry path finishes, or the wet path would cut off mid-fade.
    if (semitones !== 0) param.setValueAtTime(semitones, t)
    else param.setValueAtTime(0, t + PITCH_IDLE_S)
  }

  /** The worklet module loads once, on first use, so playback never waits for it. */
  private loadPitch() {
    if (this.pitchState !== 'idle') return
    this.pitchState = 'loading'
    const c = this.ctx
    Promise.resolve()
      .then(() => c.audioWorklet.addModule(pitchWorkletUrl))
      .then(() => {
        const node = new AudioWorkletNode(c, 'auralis-pitch', { outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' })
        this.voice.connect(node).connect(this.pitchWet)
        this.pitchNode = node
        this.pitchState = 'ready'
        this.setPitch(this.pitch)
      })
      .catch(() => {
        this.pitchState = 'failed'
        this.emit({ type: 'pitch-unavailable' })
      })
  }

  private setReverb(reverb: AppliedFx['reverb']) {
    const t = this.ctx.currentTime
    const { dry, wet } = reverbGains(reverb?.mix ?? 0)
    this.verbDry.gain.setTargetAtTime(dry, t, RAMP_S)
    if (reverb) this.send(reverb.room)
    for (const [room, send] of this.sends) send.gain.setTargetAtTime(room === reverb?.room ? wet : 0, t, RAMP_S)
  }

  // The send gain sits before the convolver: at 0 the convolver gets silence, which browsers skip processing.
  private send(room: Room) {
    if (this.sends.has(room)) return
    const c = this.ctx
    const send = c.createGain()
    send.gain.value = 0
    const convolver = c.createConvolver()
    convolver.normalize = false // the impulse responses are already at unit energy
    const channels = impulseResponse(room, c.sampleRate)
    const buffer = c.createBuffer(2, channels[0].length, c.sampleRate)
    channels.forEach((ch, i) => buffer.copyToChannel(ch, i))
    convolver.buffer = buffer
    this.verbIn.connect(send).connect(convolver).connect(this.trim)
    this.sends.set(room, send)
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
    this.emit({ type: 'karaoke', state: on ? 'on' : 'off' })
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
      this.emit({ type: 'karaoke', state: 'mono' })
    } else if (this.mono && !isMono) {
      this.mono = false
      this.apply()
      this.emit({ type: 'karaoke', state: 'on' })
    }
  }
}
