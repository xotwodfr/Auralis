// Framework-free wrapper around HTMLAudioElement. Playback lives here, outside React, so route
// changes and re-renders can never interrupt it.

export type PlayStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'buffering' | 'ended' | 'error'

/** `blocked`: the browser refused to start playback without a user gesture. */
export type EngineErrorKind = 'network' | 'decode' | 'unsupported' | 'blocked' | 'unknown'

export type EngineEvent =
  | { type: 'status'; status: PlayStatus }
  | { type: 'time'; position: number; duration: number }
  | { type: 'ended' }
  | { type: 'error'; kind: EngineErrorKind }

type Listener = (event: EngineEvent) => void

// MediaError codes 2-4. Code 1 (aborted) is a deliberate source change, not a failure.
const KIND_BY_MEDIA_ERROR: Record<number, EngineErrorKind> = { 2: 'network', 3: 'decode', 4: 'unsupported' }

export class AudioEngine {
  readonly element: HTMLAudioElement
  private listeners = new Set<Listener>()
  private stopListening: () => void
  /** True from a source change until `loadstart`; stray `pause` events in between are not real pauses. */
  private switching = false
  private startAt = 0

  constructor(element: HTMLAudioElement = new Audio()) {
    this.element = element
    element.preload = 'auto'
    const el = element
    const handlers: Record<string, () => void> = {
      loadstart: () => {
        this.switching = false
        this.emit({ type: 'status', status: 'loading' })
      },
      loadedmetadata: () => {
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
        this.emit({ type: 'status', status: 'error' })
        this.emit({ type: 'error', kind })
      },
    }
    for (const [type, fn] of Object.entries(handlers)) el.addEventListener(type, fn)
    this.stopListening = () => {
      for (const [type, fn] of Object.entries(handlers)) el.removeEventListener(type, fn)
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Replaces the source. `position` (seconds) is applied once metadata is available. */
  load(url: string, { autoplay = false, position = 0 } = {}): void {
    const el = this.element
    this.switching = !el.paused
    this.startAt = position
    el.pause()
    el.src = url
    el.load()
    if (autoplay) void this.play()
  }

  async play(): Promise<void> {
    try {
      await this.element.play()
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return // superseded by a newer load/pause
      this.emit({ type: 'status', status: 'paused' })
      this.emit({ type: 'error', kind: e instanceof DOMException && e.name === 'NotAllowedError' ? 'blocked' : 'unknown' })
    }
  }

  pause(): void {
    this.element.pause()
  }

  seek(seconds: number): void {
    const { duration } = this.element
    this.element.currentTime = Math.max(0, Number.isFinite(duration) ? Math.min(seconds, duration) : seconds)
    this.emitTime()
  }

  setVolume(volume: number): void {
    this.element.volume = Math.min(1, Math.max(0, volume))
  }

  /** Unload the source and go idle. */
  stop(): void {
    const el = this.element
    this.switching = !el.paused
    el.pause()
    el.removeAttribute('src')
    el.load()
    this.emit({ type: 'status', status: 'idle' })
  }

  destroy(): void {
    this.stopListening()
    this.listeners.clear()
    this.stop()
  }

  private emitTime() {
    const { currentTime, duration } = this.element
    this.emit({ type: 'time', position: currentTime, duration: Number.isFinite(duration) ? duration : 0 })
  }

  private emit(event: EngineEvent) {
    for (const l of this.listeners) l(event)
  }
}
