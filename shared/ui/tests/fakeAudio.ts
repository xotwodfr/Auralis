/** Minimal stand-in for HTMLAudioElement; tests drive media events by hand. */
export class FakeAudio extends EventTarget {
  src = ''
  currentTime = 0
  duration = NaN
  volume = 1
  paused = true
  ended = false
  readyState = 0
  preload = ''
  error: { code: number } | null = null
  loads: string[] = []
  playRejection: DOMException | null = null

  play() {
    if (this.playRejection) return Promise.reject(this.playRejection)
    this.paused = false
    this.ended = false
    queueMicrotask(() => this.fire('playing'))
    return Promise.resolve()
  }
  pause() {
    if (this.paused) return
    this.paused = true
    this.fire('pause')
  }
  load() {
    if (this.src) this.loads.push(this.src)
    this.currentTime = 0
    this.fire('loadstart')
  }
  getAttribute(name: string) {
    return name === 'src' && this.src ? this.src : null
  }
  removeAttribute() {
    this.src = ''
  }

  fire(type: string) {
    this.dispatchEvent(new Event(type))
  }
  /** Test helpers. */
  setDuration(d: number) {
    this.duration = d
    this.fire('durationchange')
    this.fire('loadedmetadata')
  }
  tick(t: number) {
    this.currentTime = t
    this.fire('timeupdate')
  }
  finish() {
    this.ended = true
    this.paused = true
    this.fire('ended')
  }
  fail(code: number) {
    this.error = { code }
    this.fire('error')
  }
}
