// Framework-free wrapper around HTMLAudioElement. Playback lives here, outside React, so route
// changes and re-renders can never interrupt it. A second element exists only while crossfading.

import { AudioGraph, DEFAULT_AMOUNT, type KaraokeState } from './dsp'
import { needsGraph, NEUTRAL_FX, type AppliedFx } from './effects'

export type PlayStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'buffering' | 'ended' | 'error'

/** `blocked`: the browser refused to start playback without a user gesture. */
export type EngineErrorKind = 'network' | 'decode' | 'unsupported' | 'blocked' | 'unknown'

export type EngineEvent =
  | { type: 'status'; status: PlayStatus }
  | { type: 'time'; position: number; duration: number }
  | { type: 'ended' }
  | { type: 'error'; kind: EngineErrorKind }
  | { type: 'karaoke'; state: KaraokeState }
  /** The effects graph can't run here (this server blocks cross-origin audio, or there is no Web Audio). Speed still works. */
  | { type: 'effects-unavailable' }
  /** The pitch shifter's AudioWorklet can't load (insecure context, or an old browser). */
  | { type: 'pitch-unavailable' }

type Listener = (event: EngineEvent) => void

// MediaError codes 2-4. Code 1 (aborted) is a deliberate source change, not a failure.
const FADE_TICK_MS = 50
const KIND_BY_MEDIA_ERROR: Record<number, EngineErrorKind> = { 2: 'network', 3: 'decode', 4: 'unsupported' }

export class AudioEngine {
  private primary: HTMLAudioElement
  private secondary: HTMLAudioElement | null = null
  /** The element whose events and clock the rest of the app sees. */
  private current: HTMLAudioElement
  /** The element fading out during a crossfade. */
  private fading: HTMLAudioElement | null = null
  private fadeTimer: ReturnType<typeof setInterval> | undefined
  private volumeNow = 1
  private listeners = new Set<Listener>()
  private stopListening: (() => void)[] = []
  /** True from a source change until `loadstart`; stray `pause` events in between are not real pauses. */
  private switching = false
  private startAt = 0
  private graph: AudioGraph | null = null
  private routed = new WeakSet<HTMLAudioElement>()
  private wantKaraoke = false
  private karaokeAmount = DEFAULT_AMOUNT
  private fx: AppliedFx = NEUTRAL_FX
  /** Web Audio only gets samples from a cross-origin stream that was fetched with CORS, so that is requested lazily. */
  private cors = false
  /** The graph failed once for this server or browser; don't reload the stream to try again on every slider move. */
  private graphFailed = false

  constructor(element: HTMLAudioElement = new Audio()) {
    this.primary = this.current = element
    this.volumeNow = element.volume
    this.listen(element)
  }

  get element(): HTMLAudioElement {
    return this.current
  }

  /** Events from an element that is not the current one (a track fading out) are ignored. */
  private listen(el: HTMLAudioElement) {
    el.preload = 'auto'
    setRate(el, this.fx.speed)
    const mine = (fn: () => void) => () => el === this.current && fn()
    const handlers: Record<string, () => void> = {
      loadstart: () => {
        this.switching = false
        this.emit({ type: 'status', status: 'loading' })
      },
      loadedmetadata: () => {
        if (this.cors) this.route(el)
        if (this.startAt > 0) el.currentTime = this.startAt
        this.startAt = 0
        this.emitTime()
      },
      durationchange: () => this.emitTime(),
      timeupdate: () => this.emitTime(),
      canplay: () => {
        if (el.paused) this.emit({ type: 'status', status: 'paused' })
      },
      playing: () => this.emit({ type: 'status', status: 'playing' }),
      waiting: () => !el.paused && this.emit({ type: 'status', status: 'buffering' }),
      stalled: () => !el.paused && el.readyState < 3 && this.emit({ type: 'status', status: 'buffering' }),
      pause: () => !el.ended && !this.switching && this.emit({ type: 'status', status: 'paused' }),
      ended: () => {
        this.emit({ type: 'status', status: 'ended' })
        this.emit({ type: 'ended' })
      },
      error: () => {
        const kind = KIND_BY_MEDIA_ERROR[el.error?.code ?? 0]
        if (!kind || !el.getAttribute('src')) return
        if (this.cors && !this.routedAny()) {
          // The server refused a CORS fetch: play normally and tell the user the effects cannot work here.
          this.unavailable()
          this.reload()
          return
        }
        this.emit({ type: 'status', status: 'error' })
        this.emit({ type: 'error', kind })
      },
    }
    for (const [type, fn] of Object.entries(handlers)) {
      const guarded = mine(fn)
      el.addEventListener(type, guarded)
      this.stopListening.push(() => el.removeEventListener(type, guarded))
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Replaces the source. `position` (seconds) is applied once metadata is available. With `fade` (seconds) and
   * something playing, the new track starts on the idle element while the current one fades out.
   */
  load(url: string, { autoplay = false, position = 0, fade = 0 } = {}): void {
    if (fade > 0 && !this.current.paused && this.current.getAttribute('src')) return this.crossfade(url, fade)
    this.endFade()
    const el = this.current
    this.switching = !el.paused
    this.startAt = position
    el.pause()
    el.crossOrigin = this.cors ? 'anonymous' : null
    el.src = url
    el.load()
    if (autoplay) void this.play()
  }

  private crossfade(url: string, seconds: number) {
    this.endFade()
    const out = this.current
    const inc = out === this.primary ? this.idleElement() : this.primary
    this.fading = out
    this.current = inc
    this.switching = false
    this.startAt = 0
    inc.volume = 0
    inc.crossOrigin = this.cors ? 'anonymous' : null
    inc.src = url
    inc.load()
    void this.play()
    const started = Date.now()
    this.fadeTimer = setInterval(() => {
      const t = Math.min(1, (Date.now() - started) / (seconds * 1000))
      // Equal-power curves keep the loudness steady through the overlap.
      inc.volume = this.volumeNow * Math.sin((t * Math.PI) / 2)
      out.volume = this.volumeNow * Math.cos((t * Math.PI) / 2)
      if (t >= 1) this.endFade()
    }, FADE_TICK_MS)
  }

  private idleElement(): HTMLAudioElement {
    if (!this.secondary) {
      this.secondary = new Audio()
      this.listen(this.secondary)
    }
    return this.secondary
  }

  private endFade() {
    clearInterval(this.fadeTimer)
    const out = this.fading
    if (!out) return
    this.fading = null
    out.pause()
    out.removeAttribute('src')
    out.load()
    out.volume = this.volumeNow
    this.current.volume = this.volumeNow
  }

  /** Turns the vocal remover on or off. The first time on, the current stream is reloaded once with CORS. */
  setKaraoke(on: boolean): void {
    this.wantKaraoke = on
    if (!on) return this.graph ? this.graph.setActive(false) : this.emit({ type: 'karaoke', state: 'off' })
    if (!AudioGraph.supported || this.graphFailed) return this.unavailable()
    this.needGraph()
    this.graph?.setActive(true)
  }

  setKaraokeAmount(amount: number): void {
    this.karaokeAmount = amount
    this.graph?.setAmount(amount)
  }

  /**
   * Speed goes to the media elements (their own time-stretch keeps the pitch); the rest to the graph, which is set up on
   * first need. Called from UI events, so creating the AudioContext here happens inside a user gesture, which WebKit
   * requires for it to start.
   */
  setEffects(fx: AppliedFx): void {
    this.fx = fx
    for (const el of [this.primary, this.secondary]) if (el) setRate(el, fx.speed)
    this.graph?.setEffects(fx)
    if (!needsGraph(fx)) return
    this.needGraph()
    this.graph?.resume()
  }

  /** Forget a failure that belonged to the previous server (after switching accounts). */
  resetEffectsSupport(): void {
    this.graphFailed = false
  }

  /** The graph exists and the stream is (being) fetched with CORS so it can feed it. A no-op once true or failed. */
  private needGraph() {
    if (this.cors || this.graphFailed) return
    if (!AudioGraph.supported || !this.ensureGraph()) return this.unavailable()
    this.cors = true
    this.reload()
  }

  private ensureGraph(): AudioGraph | null {
    if (this.graph) return this.graph
    try {
      this.graph = new AudioGraph(this.karaokeAmount, (e) => this.emit(e))
      this.graph.setEffects(this.fx)
    } catch {
      // reported by the caller
    }
    return this.graph
  }

  /** No graph here: plain playback continues, and the effects that need it are reported unavailable. */
  private unavailable() {
    this.graphFailed = true
    this.cors = false
    if (this.wantKaraoke) this.emit({ type: 'karaoke', state: 'unavailable' })
    this.wantKaraoke = false
    this.emit({ type: 'effects-unavailable' })
  }

  /** Once an element feeds the graph it must keep loading with CORS, or it would play silence. */
  private routedAny() {
    return [this.primary, this.secondary].some((el) => el && this.routed.has(el))
  }

  private reload() {
    const el = this.current
    const url = el.getAttribute('src')
    if (url) this.load(url, { autoplay: !el.paused, position: el.currentTime })
  }

  /** Routes `el` through the effects graph. */
  private route(el: HTMLAudioElement) {
    if (this.routed.has(el)) return
    try {
      const graph = this.ensureGraph()
      if (!graph) throw new Error('no graph')
      graph.attach(el)
      this.routed.add(el)
    } catch {
      this.unavailable()
    }
  }

  async play(): Promise<void> {
    this.graph?.resume()
    try {
      await this.current.play()
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return // superseded by a newer load/pause
      this.emit({ type: 'status', status: 'paused' })
      this.emit({ type: 'error', kind: e instanceof DOMException && e.name === 'NotAllowedError' ? 'blocked' : 'unknown' })
    }
  }

  pause(): void {
    this.endFade()
    this.current.pause()
  }

  seek(seconds: number): void {
    const el = this.current
    el.currentTime = Math.max(0, Number.isFinite(el.duration) ? Math.min(seconds, el.duration) : seconds)
    this.emitTime()
  }

  setVolume(volume: number): void {
    this.volumeNow = Math.min(1, Math.max(0, volume))
    this.current.volume = this.volumeNow
  }

  /** Unload the source and go idle. */
  stop(): void {
    this.endFade()
    const el = this.current
    this.switching = !el.paused
    el.pause()
    el.removeAttribute('src')
    el.load()
    this.emit({ type: 'status', status: 'idle' })
  }

  destroy(): void {
    for (const off of this.stopListening) off()
    this.listeners.clear()
    this.stop()
  }

  private emitTime() {
    const { currentTime, duration } = this.current
    this.emit({ type: 'time', position: currentTime, duration: Number.isFinite(duration) ? duration : 0 })
  }

  private emit(event: EngineEvent) {
    for (const l of this.listeners) l(event)
  }
}

/** `defaultPlaybackRate` survives source changes (loading resets `playbackRate` to it). */
function setRate(el: HTMLMediaElement, rate: number) {
  el.preservesPitch = true
  el.defaultPlaybackRate = rate
  el.playbackRate = rate
}
