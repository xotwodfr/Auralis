import { useEffect, useId, useRef, type ReactNode } from 'react'
import { isMobileApp } from '../../app/platform'
import { DEFAULT_EFFECTS, isAudible, PITCH_RANGE, resolveFx, SPEED_MAX, SPEED_MIN, SPEED_STEP, type Effects, type Room } from '../../audio/effects'
import { usePlayback } from '../../state/playback'
import { FLAT_EQ, useSettings } from '../../state/settings'
import { Icon } from '../../ui/Icon'
import { SegmentedControl } from '../../ui/SegmentedControl'
import { Slider } from '../../ui/Slider'
import { Toggle as BaseToggle } from '../../ui/Toggle'
import { EqualizerBands } from './Equalizer'

export const EFFECTS_UNAVAILABLE = 'Your server doesn’t allow cross-origin audio (CORS), so pitch, reverb and the equalizer can’t process its stream. Speed still works.'
const PITCH_UNAVAILABLE = 'Pitch shifting needs a secure connection (HTTPS) and a current browser.'
const ROOMS: { value: Room; label: string }[] = [
  { value: 'room', label: 'Room' },
  { value: 'hall', label: 'Hall' },
  { value: 'plate', label: 'Plate' },
]
const PANEL_ID = 'fx-panel'

const speedText = (v: number) => `${v.toFixed(2).replace(/0$/, '')}×`
const pitchText = (v: number) => (v === 0 ? 'Original' : `${v > 0 ? '+' : '−'}${Math.abs(v)} semitone${Math.abs(v) === 1 ? '' : 's'}`)
const isDefault = (e: Effects) => (Object.keys(DEFAULT_EFFECTS) as (keyof Effects)[]).every((k) => e[k] === DEFAULT_EFFECTS[k])

/** Opens the panel. Tinted while an effect is changing the sound, like the karaoke button while it is on. */
export function EffectsButton({ open, onClick, className = 'icon-btn', size = 22 }: { open: boolean; onClick: () => void; className?: string; size?: number }) {
  const active = useSettings((s) => isAudible(resolveFx(s.effects, s.eqEnabled, s.eqGains)))
  const label = active ? 'Audio effects (on)' : 'Audio effects'
  return (
    <button type="button" className={`${className} fx-btn`} data-active={active || undefined} aria-label={label} title={label} aria-expanded={open} aria-controls={open ? PANEL_ID : undefined} onClick={onClick}>
      <Icon name="effects" size={size} />
    </button>
  )
}

const Toggle = (p: { label: string; checked: boolean; disabled?: boolean; onChange: (on: boolean) => void }) => <BaseToggle {...p} className="fx__toggle" labelClassName="fx__label" />

function Section({ title, value, onReset, children }: { title: string; value: string; onReset?: () => void; children: ReactNode }) {
  const id = useId()
  return (
    <section className="fx__section" aria-labelledby={id}>
      <div className="fx__row">
        <h3 id={id} className="fx__label">
          {title}
        </h3>
        <span className="fx__value">{value}</span>
        <button type="button" className="fx__reset" aria-label={`Reset ${title.toLowerCase()}`} disabled={!onReset} onClick={onReset}>
          Reset
        </button>
      </div>
      {children}
    </section>
  )
}

const Scale = ({ marks }: { marks: string[] }) => (
  <div className="fx__scale" aria-hidden>
    {marks.map((m) => (
      <span key={m}>{m}</span>
    ))}
  </div>
)

/**
 * Speed, pitch, reverb and the equaliser for what is playing. Non-modal, in the queue overlay's place (a bottom sheet in
 * the phone UI), so the track and the transport stay in view while you listen. Settings are global and persisted.
 */
export function EffectsPanel({ onClose }: { onClose: () => void }) {
  const titleId = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  const fx = useSettings((s) => s.effects)
  const eqOn = useSettings((s) => s.eqEnabled)
  const eqFlat = useSettings((s) => s.eqGains.every((g, i) => g === FLAT_EQ[i]))
  const setFx = useSettings((s) => s.setEffects)
  const setEqOn = useSettings((s) => s.setEqEnabled)
  const resetAll = useSettings((s) => s.resetEffects)
  const unavailable = usePlayback((s) => s.effectsUnavailable)
  const pitchUnavailable = usePlayback((s) => s.pitchUnavailable)

  useEffect(() => {
    // Safari doesn't focus a clicked button, so fall back to the button that opened the panel.
    const active = document.activeElement
    const opener = (active && active !== document.body ? active : document.querySelector('.fx-btn[aria-expanded="true"]')) as HTMLElement | null
    heading.current?.focus()
    // Give focus back only if it was lost with the panel: when another panel replaced this one, it keeps its focus.
    return () => {
      if (!document.activeElement || document.activeElement === document.body) opener?.focus?.()
    }
  }, [])

  return (
    <aside
      id={PANEL_ID}
      className="fx glass-overlay"
      aria-labelledby={titleId}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.stopPropagation() // don't also close the player underneath
        onClose()
      }}
    >
      <header className="fx__head">
        <h2 id={titleId} ref={heading} tabIndex={-1} className="fx__title">
          Audio Effects
        </h2>
        <button type="button" className="btn" disabled={isDefault(fx) && !eqOn && eqFlat} onClick={resetAll}>
          Reset all
        </button>
        <button type="button" className="icon-btn" aria-label="Close audio effects" title="Close" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>

      <div className="fx__body">
        <div className="fx__section fx__master">
          <Toggle label="Effects" checked={!fx.bypass} onChange={(on) => setFx({ bypass: !on })} />
          {fx.bypass && <p className="fx__note">Off: you hear the original sound. Your settings are kept.</p>}
        </div>

        <fieldset className="fx__controls" disabled={fx.bypass}>
          <legend className="sr-only">Effect settings</legend>
          <Section title="Speed" value={speedText(fx.speed)} onReset={fx.speed !== 1 ? () => setFx({ speed: 1 }) : undefined}>
            <Slider label="Playback speed" min={SPEED_MIN} max={SPEED_MAX} step={SPEED_STEP} live value={fx.speed} valueText={`${speedText(fx.speed)} speed`} onCommit={(v) => setFx({ speed: v })} />
            <Scale marks={[speedText(SPEED_MIN), speedText(SPEED_MAX)]} />
          </Section>

          {unavailable && (
            <p className="fx__note fx__note--block" role="status">
              {EFFECTS_UNAVAILABLE}
            </p>
          )}
          {/* Everything below runs on the Web Audio graph, so it goes together when the graph can't. */}
          <fieldset className="fx__controls" disabled={unavailable}>
            <legend className="sr-only">Pitch, reverb and equalizer</legend>
            <Section title="Pitch" value={pitchText(fx.pitch)} onReset={fx.pitch !== 0 && !pitchUnavailable ? () => setFx({ pitch: 0 }) : undefined}>
              <Slider label="Pitch" min={-PITCH_RANGE} max={PITCH_RANGE} live disabled={pitchUnavailable} value={fx.pitch} valueText={pitchText(fx.pitch)} onCommit={(v) => setFx({ pitch: v })} />
              <Scale marks={[`−${PITCH_RANGE}`, '0', `+${PITCH_RANGE}`]} />
              {pitchUnavailable && !unavailable && <p className="fx__note">{PITCH_UNAVAILABLE}</p>}
            </Section>

            <section className="fx__section" aria-label="Reverb">
              <Toggle label="Reverb" checked={fx.reverb} onChange={(on) => setFx({ reverb: on })} />
              {fx.reverb && (
                <>
                  <SegmentedControl label="Reverb space" value={fx.room} options={ROOMS} onChange={(room) => setFx({ room })} />
                  <div className="fx__row">
                    <span className="fx__sub">Amount</span>
                    <span className="fx__value">{Math.round(fx.reverbMix * 100)}%</span>
                  </div>
                  <Slider label="Reverb amount" max={1} step={0.01} live value={fx.reverbMix} valueText={`${Math.round(fx.reverbMix * 100)}%`} onCommit={(v) => setFx({ reverbMix: v })} />
                </>
              )}
            </section>

            <section className="fx__section" aria-label="Equalizer">
              <Toggle label="Equalizer" checked={eqOn} onChange={setEqOn} />
              {eqOn && (
                <div className="eq">
                  <EqualizerBands chip={isMobileApp() ? 'm-chip' : 'chip'} />
                </div>
              )}
            </section>
          </fieldset>
        </fieldset>
      </div>
    </aside>
  )
}
