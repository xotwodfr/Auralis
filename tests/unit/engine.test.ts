import { AudioEngine, type EngineEvent } from '../../src/audio/engine'
import { FakeAudio } from '../fakeAudio'

function setup() {
  const audio = new FakeAudio()
  const engine = new AudioEngine(audio as unknown as HTMLAudioElement)
  const events: EngineEvent[] = []
  engine.subscribe((e) => events.push(e))
  const statuses = () => events.flatMap((e) => (e.type === 'status' ? [e.status] : []))
  return { audio, engine, events, statuses }
}

describe('AudioEngine', () => {
  it('load → loading → playing, and applies the start position once metadata arrives', async () => {
    const { audio, engine, statuses } = setup()
    engine.load('https://x/stream', { autoplay: true, position: 42 })
    await Promise.resolve()
    expect(statuses()).toEqual(['loading', 'playing'])
    audio.setDuration(200)
    expect(audio.currentTime).toBe(42)
  })

  it('a source change while playing is not reported as a pause', async () => {
    const { engine, statuses } = setup()
    engine.load('a', { autoplay: true })
    await Promise.resolve()
    engine.load('b', { autoplay: true })
    await Promise.resolve()
    expect(statuses()).toEqual(['loading', 'playing', 'loading', 'playing'])
  })

  it('reports buffering only while playing, and pause/ended', async () => {
    const { audio, engine, statuses, events } = setup()
    audio.fire('waiting')
    expect(statuses()).toEqual([])
    engine.load('a', { autoplay: true })
    await Promise.resolve()
    audio.fire('waiting')
    engine.pause()
    audio.finish()
    expect(statuses().slice(2)).toEqual(['buffering', 'paused', 'ended'])
    expect(events.some((e) => e.type === 'ended')).toBe(true)
  })

  it('seek clamps to the duration and emits time', () => {
    const { audio, engine, events } = setup()
    audio.duration = 100
    engine.seek(500)
    expect(audio.currentTime).toBe(100)
    expect(events.at(-1)).toEqual({ type: 'time', position: 100, duration: 100 })
    engine.seek(-5)
    expect(audio.currentTime).toBe(0)
  })

  it.each([[2, 'network'], [3, 'decode'], [4, 'unsupported']])('media error %s → %s', (code, kind) => {
    const { audio, engine, events } = setup()
    engine.load('a')
    audio.fail(code)
    expect(events.at(-1)).toEqual({ type: 'error', kind })
  })

  it('ignores errors with no source (after stop) and aborted loads', () => {
    const { audio, engine, events } = setup()
    engine.load('a')
    audio.fail(1)
    engine.stop()
    audio.fail(4)
    expect(events.some((e) => e.type === 'error')).toBe(false)
  })

  it('autoplay blocked → paused + blocked error; superseded play() is silent', async () => {
    const { audio, engine, events } = setup()
    audio.playRejection = new DOMException('no', 'NotAllowedError')
    await engine.play()
    expect(events.at(-1)).toEqual({ type: 'error', kind: 'blocked' })
    events.length = 0
    audio.playRejection = new DOMException('x', 'AbortError')
    await engine.play()
    expect(events).toEqual([])
  })

  it('clamps volume and stops listening after destroy', () => {
    const { audio, engine, events } = setup()
    engine.setVolume(3)
    expect(audio.volume).toBe(1)
    engine.destroy()
    events.length = 0
    audio.tick(5)
    expect(events).toEqual([])
  })
})
