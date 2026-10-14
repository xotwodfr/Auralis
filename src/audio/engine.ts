// Framework-free wrapper around HTMLAudioElement. Playback lives here, outside React, so route
// changes and re-renders can never interrupt it. A second element exists only while crossfading.

import { AudioGraph, DEFAULT_AMOUNT, type KaraokeState } from './dsp'

export type PlayStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'buffering' | 'ended' | 'error'

/** `blocked`: the browser refused to start playback without a user gesture. */
export type EngineErrorKind = 'network' | 'decode' | 'unsupported' | 'blocked' | 'unknown'

export type EngineEvent =
  | { type: 'status'; status: PlayStatus }
  | { type: 'time'; position: number; duration: number }
  | { type: 'ended' }
  | { type: 'error'; kind: EngineErrorKind }
  | { type: 'karaoke'; state: KaraokeState }
  /** The equaliser could not be set up (this server blocks cross-origin audio, or there is no Web Audio). */
  | { type: 'eq-unavailable' }

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
  private eqOn = false
  private eqGains: readonly number[] = []
  /** Web Audio only gets samples from a cross-origin stream that was fetched with CORS, so that is requested lazily. */
  private cors = false

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
        if (this.cors && !this.graph) {
          // The server refused a CORS fetch: play normally and tell the user the effects cannot work here.
          this.cors = false
          if (this.wantKaraoke) this.emit({ type: 'karaoke', state: 'unavailable' })
          if (this.eqOn) this.emit({ type: 'eq-unavailable' })
          this.wantKaraoke = false
          this.eqOn = false
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
    if (!AudioGraph.supported) return this.emit({ type: 'karaoke', state: 'unavailable' })
    if (this.graph) return this.graph.setActive(true)
    this.emit({ type: 'karaoke', state: 'on' })
    this.needGraph()
  }

  setKaraokeAmount(amount: number): void {
    this.karaokeAmount = amount
    this.graph?.setAmount(amount)
  }

  /** `gains`: dB per band. Flat when off, so switching off never leaves a stale curve. */
  setEq(on: boolean, gains: readonly number[]): void {
    this.eqOn = on
    this.eqGains = gains
    if (this.graph) return this.graph.setEq(on ? gains : [])
    if (!on) return
    if (!AudioGraph.supported) return this.emit({ type: 'eq-unavailable' })
    this.needGraph()
  }

  private needGraph() {
    if (this.cors) return
    this.cors = true
    this.reload()
  }

  private reload() {
    const el = this.current
    const url = el.getAttribute('src')
    if (url) this.load(url, { autoplay: !el.paused, position: el.currentTime })
  }

  /** Routes `el` through the effects graph, creating it on first use. */
  private route(el: HTMLAudioElement) {
    try {
      if (!this.graph) {
        this.graph = new AudioGraph(this.karaokeAmount, (state) => this.emit({ type: 'karaoke', state }))
        this.graph.setEq(this.eqOn ? this.eqGains : [])
        this.graph.setActive(this.wantKaraoke)
      }
      if (!this.routed.has(el)) {
        this.graph.attach(el)
        this.routed.add(el)
      }
    } catch {
      this.cors = false
      if (this.wantKaraoke) this.emit({ type: 'karaoke', state: 'unavailable' })
      if (this.eqOn) this.emit({ type: 'eq-unavailable' })
      this.wantKaraoke = false
      this.eqOn = false
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
