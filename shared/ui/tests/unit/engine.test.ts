import { AudioEngine, type EngineEvent } from '../../src/audio/engine'
import { NEUTRAL_FX, type AppliedFx } from '../../src/audio/effects'
import { FakeAudio } from '../fakeAudio'
import { FakeAudioContext, settle, stubWebAudio, type FakeNode, type FakeParam, type FakeWorkletNode } from '../fakeWebAudio'

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

  describe('crossfade', () => {
    afterEach(() => vi.useRealTimers())

    it('the new track takes over, the old one fades out, and its end is not reported', async () => {
      vi.useFakeTimers()
      const { audio, engine, events } = setup()
      engine.load('a', { autoplay: true })
      await Promise.resolve()
      engine.load('b', { autoplay: true, fade: 4 })
      const next = engine.element
      expect(next).not.toBe(audio)
      expect(next.volume).toBe(0)
      vi.advanceTimersByTime(2000)
      expect(next.volume).toBeGreaterThan(0.5)
      expect(audio.volume).toBeLessThan(0.9)
      audio.finish()
      expect(events.some((e) => e.type === 'ended')).toBe(false)
      vi.advanceTimersByTime(2500)
      expect(audio.getAttribute('src')).toBeNull()
      expect(next.volume).toBe(1)
    })

    it('loads normally when nothing is playing', () => {
      const { audio, engine } = setup()
      engine.load('a', { fade: 4 })
      expect(engine.element).toBe(audio)
      expect(audio.src).toBe('a')
    })
  })

  describe('karaoke', () => {
    const karaoke = (events: EngineEvent[]) => events.flatMap((e) => (e.type === 'karaoke' ? [e.state] : []))
    afterEach(() => vi.unstubAllGlobals())

    it('reports unavailable where Web Audio does not exist', () => {
      const { engine, events } = setup()
      engine.setKaraoke(true)
      expect(karaoke(events)).toEqual(['unavailable'])
    })

    it('first enable reloads the stream with CORS, and a CORS refusal falls back to plain playback', async () => {
      stubWebAudio()
      const { audio, engine, events } = setup()
      engine.load('https://x/stream', { autoplay: true })
      await Promise.resolve()
      engine.setKaraoke(true)
      expect((audio as unknown as HTMLAudioElement).crossOrigin).toBe('anonymous')
      audio.fail(4)
      expect(karaoke(events).at(0)).toBe('on')
      expect(karaoke(events).at(-1)).toBe('unavailable')
      expect((audio as unknown as HTMLAudioElement).crossOrigin).toBeNull()
      expect(events.some((e) => e.type === 'error')).toBe(false)
    })

    it('turning it off before it was ever on just reports off', () => {
      const { engine, events } = setup()
      engine.setKaraoke(false)
      expect(karaoke(events)).toEqual(['off'])
    })
  })

  describe('effects', () => {
    beforeEach(stubWebAudio)
    afterEach(() => vi.unstubAllGlobals())

    const el = (a: FakeAudio) => a as unknown as HTMLAudioElement & { preservesPitch: boolean }
    const fx = (patch: Partial<AppliedFx>): AppliedFx => ({ ...NEUTRAL_FX, ...patch })
    const gain = (n: FakeNode) => (n as unknown as { gain: FakeParam }).gain.value
    async function playing() {
      const s = setup()
      s.engine.load('https://x/stream', { autoplay: true })
      await Promise.resolve()
      return s
    }
    /** Simulates the CORS reload completing, which routes the element into the graph. */
    function routed(audio: FakeAudio) {
      audio.setDuration(100)
      return FakeAudioContext.instances[0]!
    }

    it('speed sets the media element’s own rate with pitch preserved, and needs no graph or reload', async () => {
      const { audio, engine } = await playing()
      engine.setEffects(fx({ speed: 1.5 }))
      expect(el(audio).playbackRate).toBe(1.5)
      expect(el(audio).defaultPlaybackRate).toBe(1.5) // survives the next track's load
      expect(el(audio).preservesPitch).toBe(true)
      expect(audio.loads).toHaveLength(1)
      expect(FakeAudioContext.instances).toHaveLength(0)
    })

    it('the crossfade element gets the same speed', async () => {
      const { audio, engine } = await playing()
      engine.setEffects(fx({ speed: 0.75 }))
      engine.load('b', { autoplay: true, fade: 2 })
      expect(engine.element).not.toBe(audio)
      expect(engine.element.playbackRate).toBe(0.75)
    })

    it('pitch builds the graph once, in the same call (user gesture), reloads with CORS once and shifts through the worklet', async () => {
      const { audio, engine } = await playing()
      engine.setEffects(fx({ pitch: 3 }))
      expect(FakeAudioContext.instances).toHaveLength(1) // created inside the slider's event, so WebKit lets it start
      expect(el(audio).crossOrigin).toBe('anonymous')
      expect(audio.loads).toHaveLength(2)
      const ctx = routed(audio)
      await settle()
      expect(ctx.sources).toEqual([audio])
      expect(ctx.audioWorklet.addModule).toHaveBeenCalledTimes(1)
      const [node] = ctx.of<FakeWorkletNode>('worklet')
      expect(node!.name).toBe('auralis-pitch')
      expect(node!.parameters.get('semitones')!.value).toBe(3)
      expect(ctx.reachable(node!).has(ctx.destination)).toBe(true)

      // Further changes reuse everything: no new context, worklet, source or reload.
      const nodes = ctx.nodes.length
      engine.setEffects(fx({ pitch: -5 }))
      engine.setEffects(fx({ pitch: 7, speed: 1.25 }))
      expect(node!.parameters.get('semitones')!.value).toBe(7)
      expect(ctx.nodes).toHaveLength(nodes)
      expect(FakeAudioContext.instances).toHaveLength(1)
      expect(audio.loads).toHaveLength(2)
      expect(ctx.duplicateEdges).toEqual([])
    })

    it('pitch back to 0 crossfades to the dry path and lets the shifter idle only after the fade', async () => {
      const { audio, engine } = await playing()
      engine.setEffects(fx({ pitch: 4 }))
      const ctx = routed(audio)
      await settle()
      const param = ctx.of<FakeWorkletNode>('worklet')[0]!.parameters.get('semitones')!
      engine.setEffects(fx({ pitch: 0 }))
      expect(param.value).toBe(4) // still shifting while the wet path fades out
      expect(param.pending).toEqual([{ value: 0, time: 0.5 }])
      engine.setEffects(fx({ pitch: 2 }))
      expect(param.pending).toEqual([]) // a new shift cancels the pending idle
      expect(param.value).toBe(2)
    })

    it('reverb makes one convolver per room on first use; switching rooms and bypassing reuse them', async () => {
      const { audio, engine } = await playing()
      engine.setEffects(fx({ reverb: { mix: 0.5, room: 'hall' } }))
      const ctx = routed(audio)
      const convolvers = () => ctx.of<FakeNode & { buffer: { length: number }; normalize: boolean }>('convolver')
      expect(convolvers()).toHaveLength(1)
      expect(convolvers()[0]!.normalize).toBe(false)
      expect(convolvers()[0]!.buffer.length).toBe(Math.round(0.022 * 48000) + Math.round(2.8 * 48000))
      engine.setEffects(fx({ reverb: { mix: 0.5, room: 'plate' } }))
      engine.setEffects(fx({ reverb: { mix: 0.8, room: 'hall' } }))
      engine.setEffects(NEUTRAL_FX)
      engine.setEffects(fx({ reverb: { mix: 0.2, room: 'plate' } }))
      expect(convolvers()).toHaveLength(2)
      expect(ctx.duplicateEdges).toEqual([])
      for (const c of convolvers()) expect(ctx.reachable(c).has(ctx.destination)).toBe(true)
    })

    it('bypass (neutral) returns every stage to dry without tearing the graph down', async () => {
      const { audio, engine } = await playing()
      engine.setEffects(fx({ speed: 1.5, reverb: { mix: 1, room: 'room' }, eq: [6, 0, 0, 0, 0, 0, 0, 0, 0, -3] }))
      const ctx = routed(audio)
      const sends = () => ctx.of('gain').filter((g) => [...g.outputs].some((o) => o.kind === 'convolver'))
      const bands = ctx.of<FakeNode & { gain: FakeParam }>('biquad').slice(0, 10)
      expect(sends().map(gain)).toEqual([1])
      expect(bands[0]!.gain.value).toBe(6)
      const nodes = ctx.nodes.length
      engine.setEffects(NEUTRAL_FX)
      expect(el(audio).playbackRate).toBe(1)
      expect(sends().map(gain)).toEqual([0])
      expect(bands.every((b) => b.gain.value === 0)).toBe(true)
      expect(ctx.nodes).toHaveLength(nodes)
    })

    it('EQ boosts are taken back by the output trim, so they cannot clip', async () => {
      const { audio, engine } = await playing()
      engine.setEffects(fx({ eq: [6, 0, 0, 0, 0, 0, 0, 0, 0, 0] }))
      const ctx = routed(audio)
      const trim = [...ctx.nodes].find((n) => n.outputs.has(ctx.destination))!
      expect(gain(trim)).toBeCloseTo(10 ** (-6 / 20), 6)
      engine.setEffects(fx({ eq: [-6, 0, 0, 0, 0, 0, 0, 0, 0, 0] }))
      expect(gain(trim)).toBe(1)
    })

    it('a server without CORS: one fallback reload, then effects are unavailable without reloading again', async () => {
      const { audio, engine, events } = await playing()
      engine.setEffects(fx({ pitch: 2 }))
      audio.fail(2)
      expect(el(audio).crossOrigin).toBeNull()
      expect(audio.loads).toHaveLength(3) // original, CORS attempt, plain again
      expect(events.filter((e) => e.type === 'effects-unavailable')).toHaveLength(1)
      expect(events.some((e) => e.type === 'error')).toBe(false)
      engine.setEffects(fx({ pitch: 3, reverb: { mix: 0.3, room: 'room' } }))
      engine.setEffects(fx({ speed: 1.5, pitch: 3 }))
      expect(audio.loads).toHaveLength(3)
      expect(el(audio).playbackRate).toBe(1.5) // speed still works
      engine.setKaraoke(true)
      expect(events.at(-2)).toEqual({ type: 'karaoke', state: 'unavailable' })

      engine.resetEffectsSupport() // a new account: try once more
      engine.setEffects(fx({ pitch: 1 }))
      expect(el(audio).crossOrigin).toBe('anonymous')
    })

    it('a worklet that will not load reports pitch unavailable and keeps the dry path', async () => {
      FakeAudioContext.workletLoad = () => Promise.reject(new Error('blocked'))
      const { audio, engine, events } = await playing()
      engine.setEffects(fx({ pitch: 5 }))
      const ctx = routed(audio)
      await settle()
      expect(events).toContainEqual({ type: 'pitch-unavailable' })
      expect(ctx.of('worklet')).toHaveLength(0)
      engine.setEffects(fx({ pitch: 6 }))
      await settle()
      expect(ctx.audioWorklet.addModule).toHaveBeenCalledTimes(1) // no retry loop
    })

    it('play resumes a context that started suspended', async () => {
      const { audio, engine } = await playing()
      engine.setEffects(fx({ eq: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0] }))
      const ctx = routed(audio)
      ctx.state = 'suspended'
      await engine.play()
      expect(ctx.resume).toHaveBeenCalled()
      expect(ctx.state).toBe('running')
    })
  })
})
