import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import App from '../../src/App'
import type { Song } from '../../src/api/subsonic/types'
import { DEFAULT_EFFECTS } from '../../src/audio/effects'
import { kvGet } from '../../src/lib/storage'
import { useAuth } from '../../src/state/auth'
import { audioElement, usePlayback } from '../../src/state/playback'
import { FLAT_EQ, useSettings } from '../../src/state/settings'
import type { FakeAudio } from '../fakeAudio'
import { BASE, PASSWORD, USER } from '../server'

const audio = audioElement as unknown as FakeAudio & { playbackRate: number; defaultPlaybackRate: number; preservesPitch: boolean }
const track: Song = { id: 'a', title: 'Song A', album: 'Album', artist: 'Artist', duration: 200 }

beforeEach(() => {
  useAuth.setState({
    hydrated: true,
    session: { credentials: { baseUrl: BASE, username: USER, password: PASSWORD }, server: { apiVersion: '1.16.1' }, capabilities: { openSubsonic: true, extensions: [], songLyrics: false }, remember: false },
  })
  useSettings.setState({ effects: DEFAULT_EFFECTS, eqEnabled: false, eqGains: FLAT_EQ, externalLookups: false, lyricsServerEnabled: false })
  usePlayback.getState().reset()
  // Speed needs no Web Audio; the graph-backed controls are tested as available unless a test says otherwise.
  usePlayback.setState({ effectsUnavailable: false, pitchUnavailable: false })
  audio.loads.length = 0
  audio.paused = true
  usePlayback.getState().playTracks([track])
})

async function openPanel() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/now-playing']}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  await screen.findByRole('heading', { level: 1, name: 'Song A' })
  const button = screen.getByRole('button', { name: 'Audio effects' })
  fireEvent.click(button)
  const panel = await screen.findByRole('complementary', { name: 'Audio Effects' })
  return { panel: within(panel), button }
}
const slide = (el: HTMLElement, value: number) => fireEvent.change(el, { target: { value: String(value) } })

describe('audio effects panel', () => {
  it('opens from Now Playing with focus on its title, and Escape closes it and returns focus', async () => {
    const { panel, button } = await openPanel()
    expect(button).toHaveAttribute('aria-expanded', 'true')
    expect(panel.getByRole('heading', { name: 'Audio Effects' })).toHaveFocus()
    fireEvent.keyDown(panel.getByRole('slider', { name: 'Playback speed' }), { key: 'Escape' })
    expect(screen.queryByRole('complementary', { name: 'Audio Effects' })).toBeNull()
    expect(button).toHaveFocus()
    // Playback was never touched.
    expect(audio.loads).toHaveLength(1)
  })

  it('shares its place with the queue: opening one closes the other, and the new one keeps focus', async () => {
    const { button } = await openPanel()
    const queueButton = screen.getByRole('button', { name: 'Queue' })
    fireEvent.click(queueButton)
    const queue = await screen.findByRole('complementary', { name: 'Queue' })
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Audio Effects' })).toBeNull())
    expect(within(queue).getByRole('heading', { name: /^Queue/ })).toHaveFocus()
    expect(button).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(button)
    expect(await screen.findByRole('complementary', { name: 'Audio Effects' })).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Queue' })).toBeNull())
    expect(screen.getByRole('heading', { name: 'Audio Effects' })).toHaveFocus()
    expect(queueButton).toHaveAttribute('aria-expanded', 'false')
  })

  it('speed changes the real element rate (pitch preserved), shows the value, persists, and marks effects as on', async () => {
    const { panel } = await openPanel()
    slide(panel.getByRole('slider', { name: 'Playback speed' }), 1.5)
    expect(audio.playbackRate).toBe(1.5)
    expect(audio.defaultPlaybackRate).toBe(1.5)
    expect(audio.preservesPitch).toBe(true)
    expect(panel.getByText('1.5×')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Audio effects (on)' })).toBeInTheDocument()
    await waitFor(async () => expect((await kvGet<{ effects: { speed: number } }>('settings'))?.effects.speed).toBe(1.5))
    // Out-of-range input is clamped at the boundary, not trusted.
    act(() => useSettings.getState().setEffects({ speed: 7 }))
    expect(audio.playbackRate).toBe(2)
  })

  it('master bypass plays the original but keeps every setting, without reloading the track', async () => {
    const { panel } = await openPanel()
    slide(panel.getByRole('slider', { name: 'Playback speed' }), 1.25)
    slide(panel.getByRole('slider', { name: 'Pitch' }), 4)
    fireEvent.click(panel.getByRole('checkbox', { name: 'Reverb' }))
    const loads = audio.loads.length

    fireEvent.click(panel.getByRole('checkbox', { name: 'Effects' }))
    expect(audio.playbackRate).toBe(1)
    expect(panel.getByText(/you hear the original sound/)).toBeInTheDocument()
    expect(panel.getByRole('slider', { name: 'Playback speed' })).toBeDisabled()
    expect(panel.getByRole('slider', { name: 'Pitch' })).toHaveValue('4')
    expect(useSettings.getState().effects).toMatchObject({ bypass: true, speed: 1.25, pitch: 4, reverb: true })
    expect(screen.getByRole('button', { name: 'Audio effects' })).toBeInTheDocument()

    fireEvent.click(panel.getByRole('checkbox', { name: 'Effects' }))
    expect(audio.playbackRate).toBe(1.25)
    expect(panel.getByRole('slider', { name: 'Playback speed' })).toBeEnabled()
    expect(audio.loads).toHaveLength(loads)
  })

  it('individual resets and Reset all return to neutral defaults', async () => {
    const { panel } = await openPanel()
    expect(panel.getByRole('button', { name: 'Reset all' })).toBeDisabled()
    expect(panel.getByRole('button', { name: 'Reset speed' })).toBeDisabled()
    slide(panel.getByRole('slider', { name: 'Playback speed' }), 0.75)
    slide(panel.getByRole('slider', { name: 'Pitch' }), -3)
    expect(panel.getByText('−3 semitones')).toBeInTheDocument()
    fireEvent.click(panel.getByRole('button', { name: 'Reset speed' }))
    expect(useSettings.getState().effects.speed).toBe(1)
    expect(useSettings.getState().effects.pitch).toBe(-3)

    fireEvent.click(panel.getByRole('checkbox', { name: 'Equalizer' }))
    fireEvent.click(panel.getByRole('button', { name: 'Bass boost' }))
    fireEvent.click(panel.getByRole('button', { name: 'Reset all' }))
    expect(useSettings.getState()).toMatchObject({ effects: DEFAULT_EFFECTS, eqEnabled: false, eqGains: FLAT_EQ })
    expect(panel.getByText('Original')).toBeInTheDocument()
  })

  it('reverb: enable, choose a space and amount; switching it off keeps them', async () => {
    const { panel } = await openPanel()
    expect(panel.queryByRole('radiogroup', { name: 'Reverb space' })).toBeNull()
    fireEvent.click(panel.getByRole('checkbox', { name: 'Reverb' }))
    fireEvent.click(panel.getByRole('radio', { name: 'Hall' }))
    slide(panel.getByRole('slider', { name: 'Reverb amount' }), 0.6)
    expect(panel.getByText('60%')).toBeInTheDocument()
    fireEvent.click(panel.getByRole('checkbox', { name: 'Reverb' }))
    expect(useSettings.getState().effects).toMatchObject({ reverb: false, room: 'hall', reverbMix: 0.6 })
  })

  it('equalizer: switch, presets, bands and flat reset share the settings page state', async () => {
    const { panel } = await openPanel()
    fireEvent.click(panel.getByRole('checkbox', { name: 'Equalizer' }))
    expect(useSettings.getState().eqEnabled).toBe(true)
    slide(panel.getByRole('slider', { name: '1k Hz' }), 4.5)
    expect(useSettings.getState().eqGains[5]).toBe(4.5)
    expect(panel.getByRole('slider', { name: '1k Hz' })).toHaveAttribute('aria-valuetext', '+4.5 dB')
    fireEvent.click(panel.getByRole('button', { name: 'Reset to flat' }))
    expect(useSettings.getState().eqGains).toEqual(FLAT_EQ)
  })

  it('says honestly when the server blocks cross-origin audio: graph effects disabled, speed still works', async () => {
    usePlayback.setState({ effectsUnavailable: true })
    const { panel } = await openPanel()
    expect(panel.getByRole('status')).toHaveTextContent(/doesn’t allow cross-origin audio/)
    expect(panel.getByRole('slider', { name: 'Pitch' })).toBeDisabled()
    expect(panel.getByRole('checkbox', { name: 'Reverb' })).toBeDisabled()
    expect(panel.getByRole('checkbox', { name: 'Equalizer' })).toBeDisabled()
    slide(panel.getByRole('slider', { name: 'Playback speed' }), 1.5)
    expect(audio.playbackRate).toBe(1.5)
  })

  it('pitch alone can be unavailable (no AudioWorklet) and never falls back to changing the speed', async () => {
    usePlayback.setState({ pitchUnavailable: true })
    const { panel } = await openPanel()
    expect(panel.getByRole('slider', { name: 'Pitch' })).toBeDisabled()
    expect(panel.getByText(/Pitch shifting needs a secure connection/)).toBeInTheDocument()
    expect(panel.getByRole('checkbox', { name: 'Reverb' })).toBeEnabled()
    act(() => useSettings.getState().setEffects({ pitch: 5 }))
    expect(audio.playbackRate).toBe(1)
  })
})
