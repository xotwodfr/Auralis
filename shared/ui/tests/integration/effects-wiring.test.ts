// Settings → playback store → engine → Web Audio graph, end to end in jsdom (graph faked, see fakeWebAudio.ts).
import type { Song } from '../../src/api/subsonic/types'
import { kvSet } from '../../src/lib/storage'
import { useAuth } from '../../src/state/auth'
import { audioElement, usePlayback } from '../../src/state/playback'
import { FLAT_EQ, useSettings } from '../../src/state/settings'
import { useToasts } from '../../src/state/toast'
import type { FakeAudio } from '../fakeAudio'
import { FakeAudioContext, settle, stubWebAudio, type FakeNode, type FakeParam, type FakeWorkletNode } from '../fakeWebAudio'
import { BASE, PASSWORD, USER } from '../server'

const audio = audioElement as unknown as FakeAudio & { playbackRate: number; crossOrigin: string | null }
const track: Song = { id: 'a', title: 'Song A', album: 'Album', artist: 'Artist', duration: 200 }
const settings = () => useSettings.getState()

beforeAll(() => {
  stubWebAudio()
  usePlayback.getState().reset() // the store read Web Audio support at import, before the stub
})
afterAll(() => vi.unstubAllGlobals())

beforeEach(() => {
  useAuth.setState({
    hydrated: true,
    session: { credentials: { baseUrl: BASE, username: USER, password: PASSWORD }, server: { apiVersion: '1.16.1' }, capabilities: { openSubsonic: true, extensions: [], songLyrics: false }, remember: false },
  })
})

it('a server without CORS: plain playback continues, settings are kept, the user is told once; a new account retries', async () => {
  usePlayback.getState().playTracks([track])
  settings().setEffects({ pitch: 3 })
  expect(audio.crossOrigin).toBe('anonymous')
  audio.fail(2)
  expect(audio.crossOrigin).toBeNull()
  expect(usePlayback.getState()).toMatchObject({ effectsUnavailable: true, error: null })
  expect(settings().effects.pitch).toBe(3)
  settings().setEffects({ pitch: 4 })
  expect(useToasts.getState().toasts.filter((t) => /cross-origin/.test(t.message))).toHaveLength(1)

  usePlayback.getState().reset() // signing in elsewhere
  expect(usePlayback.getState().effectsUnavailable).toBe(false)
})

it('settings drive the graph: pitch, EQ and reverb apply; bypass returns to dry without losing settings or reloading', async () => {
  usePlayback.getState().playTracks([track])
  settings().setEffects({ pitch: 5 })
  const loads = audio.loads.length
  audio.setDuration(200) // the CORS-enabled load routes the element into the graph
  await settle()
  const ctx = FakeAudioContext.instances[0]!
  expect(ctx.sources).toContain(audio)
  const semitones = ctx.of<FakeWorkletNode>('worklet')[0]!.parameters.get('semitones')!
  expect(semitones.value).toBe(5)

  settings().setEqEnabled(true)
  settings().setEqGains([0, 0, 0, 0, 0, -6, 0, 0, 0, 0])
  const band1k = ctx.of<FakeNode & { gain: FakeParam }>('biquad')[5]!
  expect(band1k.gain.value).toBe(-6)
  settings().setEffects({ reverb: true, room: 'plate', reverbMix: 0.5 })
  expect(ctx.of('convolver')).toHaveLength(1)

  settings().setEffects({ bypass: true })
  expect(semitones.pending.at(-1)?.value).toBe(0)
  expect(band1k.gain.value).toBe(0)
  expect(settings().effects).toMatchObject({ pitch: 5, reverb: true, room: 'plate' })
  expect(settings().eqGains[5]).toBe(-6)

  settings().setEffects({ bypass: false })
  expect(semitones.value).toBe(5)
  expect(band1k.gain.value).toBe(-6)
  expect(audio.loads).toHaveLength(loads)
  expect(ctx.duplicateEdges).toEqual([])
  expect(FakeAudioContext.instances).toHaveLength(1)
})

it('stored effects are validated on restore and applied to the next track', async () => {
  await kvSet('settings', { effects: { speed: 1.26, pitch: 40, room: 'cathedral', reverb: true, reverbMix: 'loud' }, eqGains: FLAT_EQ })
  useSettings.setState({ hydrated: false })
  await settings().restore()
  expect(settings().effects).toMatchObject({ speed: 1.25, pitch: 12, room: 'room', reverb: true, reverbMix: 0.3 })
  usePlayback.getState().playTracks([{ ...track, id: 'b' }])
  expect(audio.playbackRate).toBe(1.25)
})
