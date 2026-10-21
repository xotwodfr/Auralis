import { useEffect, useState, type ReactNode } from 'react'
import { LyricsServerForm, spicyText, useAccountActions } from '@auralis/ui/features/settings/Settings'
import { ChatServerSection } from '@auralis/ui/features/settings/ChatServerSection'
import { useLyricsBackend } from '@auralis/ui/features/lyrics/useLyricsBackend'
import { useAuth } from '@auralis/ui/state/auth'
import { MAX_CROSSFADE_S, useSettings, type LyricSize, type StreamQuality } from '@auralis/ui/state/settings'
import { EFFECTS_UNAVAILABLE } from '@auralis/ui/features/effects/EffectsPanel'
import { EqualizerBands } from '@auralis/ui/features/effects/Equalizer'
import { usePlayback } from '@auralis/ui/state/playback'
import { useSpotifyLinks } from '@auralis/ui/state/spotifyLinks'
import { toast } from '@auralis/ui/state/toast'
import { Icon, type IconName } from '@auralis/ui/ui/Icon'
import { SegmentedControl } from '@auralis/ui/ui/SegmentedControl'
import { Slider } from '@auralis/ui/ui/Slider'
import { Switch } from '@auralis/ui/ui/Switch'
import { BackButton } from './parts'

const QUALITIES: { value: StreamQuality; label: string; caption: string }[] = [
  { value: 'low', label: 'Low', caption: '96 kbps' },
  { value: 'normal', label: 'Normal', caption: '192 kbps' },
  { value: 'high', label: 'High', caption: 'Original' },
]
const SIZES: { value: LyricSize; label: string }[] = [
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
]

/** A collapsible settings section (M3 expandable list item). Closed by default, so the page reads as a short menu. */
function Section({ icon, title, summary, children }: { icon: IconName; title: string; summary: string; children: ReactNode }) {
  return (
    <details className="m-set">
      <summary className="m-set__head">
        <span className="m-set__icon" aria-hidden>
          <Icon name={icon} size={22} />
        </span>
        <span className="m-set__text">
          <h2 className="m-set__title">{title}</h2>
          <span className="m-set__hint">{summary}</span>
        </span>
        <span className="m-set__chevron" aria-hidden>
          <Icon name="down" size={22} />
        </span>
      </summary>
      <div className="m-set__body">{children}</div>
    </details>
  )
}

/** One M3 list item inside a section: headline, optional supporting text, and a trailing control or value. */
function Row({ label, hint, children, onClick, danger = false }: { label: string; hint?: string; children?: ReactNode; onClick?: () => void; danger?: boolean }) {
  const body = (
    <>
      <span className="m-set__text">
        <span className={danger ? 'm-set__label m-set__label--danger' : 'm-set__label'}>{label}</span>
        {hint && <span className="m-set__hint">{hint}</span>}
      </span>
      {children}
    </>
  )
  return onClick ? (
    <button type="button" className="m-set__row m-set__row--button" onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className="m-set__row">{body}</div>
  )
}

/** Ten-band equaliser: a switch, then presets and one vertical slider per band (the same controls as Now Playing's). */
function Equalizer() {
  const on = useSettings((s) => s.eqEnabled)
  const setOn = useSettings((s) => s.setEqEnabled)
  const unavailable = usePlayback((s) => s.effectsUnavailable)
  return (
    <>
      <Row label="Equalizer" hint={unavailable ? EFFECTS_UNAVAILABLE : 'Shape the sound. Applies to everything you play.'}>
        <Switch label="Equalizer" checked={on} disabled={unavailable} onChange={setOn} />
      </Row>
      {on && !unavailable && (
        <div className="m-set__row m-set__row--stack eq">
          <EqualizerBands chip="m-chip" />
        </div>
      )}
    </>
  )
}

const formatBytes = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`)

/** Browser storage this app holds: cached lyrics, Spotify matches, settings and the queue. Not audio: tracks are streamed. */
function useStorageUsed(refresh: unknown) {
  const [bytes, setBytes] = useState<number | null>(null)
  useEffect(() => {
    let live = true
    void navigator.storage?.estimate?.().then((e) => live && setBytes(e.usage ?? null), () => undefined)
    return () => {
      live = false
    }
  }, [refresh])
  return bytes
}

export default function SettingsPage() {
  const session = useAuth((s) => s.session)
  const settings = useSettings()
  const clearLinks = useSpotifyLinks((s) => s.clear)
  const { setPending, confirmDialog } = useAccountActions()
  const [spicy, matching] = spicyText(useLyricsBackend(), settings.lyricsServerEnabled)
  const used = useStorageUsed(confirmDialog === null)
  if (!session) return null
  const { credentials, server, remember } = session

  return (
    <div className="m-page m-settings">
      <header className="m-top m-top--sticky">
        <BackButton />
        <h1 className="m-h1">Settings</h1>
      </header>

      <div className="m-set-list">
        <Section icon="wave" title="Playback" summary="Streaming quality, crossfade, equalizer">
          <div className="m-set__row m-set__row--stack">
            <Row label="Streaming quality" hint="Applies from the next track. Lower settings ask your server to transcode." />
            <SegmentedControl label="Streaming quality" value={settings.streamQuality} onChange={settings.setStreamQuality} options={QUALITIES} />
          </div>
          <div className="m-set__row m-set__row--stack">
            <Row label="Crossfade" hint="Overlap the end of a track with the start of the next">
              <span className="m-set__value">{settings.crossfadeSeconds === 0 ? 'Off' : `${settings.crossfadeSeconds} s`}</span>
            </Row>
            <Slider label="Crossfade" value={settings.crossfadeSeconds} max={MAX_CROSSFADE_S} step={1} live valueText={settings.crossfadeSeconds === 0 ? 'Off' : `${settings.crossfadeSeconds} seconds`} onCommit={settings.setCrossfadeSeconds} />
          </div>
          <Equalizer />
        </Section>

        <Section icon="album" title="Appearance" summary="Dynamic colour, lyrics display">
          <Row label="Dynamic colour" hint="Take the app's colours from the album art of what is playing">
            <Switch label="Dynamic colour" checked={settings.adaptiveColors} onChange={settings.setAdaptiveColors} />
          </Row>
          <Row label="Word-synced lyrics" hint="Highlight each word as it is sung, when available">
            <Switch label="Word-synced lyrics" checked={settings.lyricsWordSync} onChange={settings.setLyricsWordSync} />
          </Row>
          <Row label="Show lyrics source" hint="Where the lyrics came from and who made them">
            <Switch label="Show lyrics source" checked={settings.showLyricSource} onChange={settings.setShowLyricSource} />
          </Row>
          <div className="m-set__row m-set__row--stack">
            <Row label="Lyrics size" />
            <SegmentedControl label="Lyrics size" value={settings.lyricSize} onChange={settings.setLyricSize} options={SIZES} />
          </div>
        </Section>

        <Section icon="lyrics" title="Lyrics sources" summary="LRCLIB, lyrics server, Spotify matching">
          <Row label="External lookups" hint="When your server has no lyrics, ask lrclib.net">
            <Switch label="External lookups" checked={settings.externalLookups} onChange={settings.setExternalLookups} />
          </Row>
          <div className="m-set__row m-set__row--stack m-set__form">
            <LyricsServerForm />
          </div>
          <Row label="Spicy Lyrics" hint={spicy} />
          <Row label="Spotify matching" hint={matching} />
        </Section>

        <Section icon="people" title="Privacy" summary="Play reports, listening activity">
          <Row label="Report plays to your server" hint="Keeps its play counts and recently played lists right">
            <Switch label="Report plays to your server" checked={settings.reportPlays} onChange={settings.setReportPlays} />
          </Row>
          <Row label="Share what I'm playing" hint="Everyone on your server can see it in Social">
            <Switch label="Share what I'm playing" checked={settings.shareListening} onChange={settings.setShareListening} />
          </Row>
        </Section>

        <Section icon="send" title="Chat" summary="Chat server and account">
          <div className="m-set__row m-set__row--stack m-set__form">
            <ChatServerSection />
          </div>
        </Section>

        <Section icon="queue" title="Storage" summary={used === null ? 'Cached lyrics and matches' : `${formatBytes(used)} used on this device`}>
          <Row label="Local data" hint="Cached lyrics, matches and settings. Music is streamed, not stored.">
            <span className="m-set__value">{used === null ? '–' : formatBytes(used)}</span>
          </Row>
          <Row label="Clear cached lyrics" onClick={() => setPending('lyrics')} />
          <Row
            label="Remove Spotify links"
            onClick={() => {
              clearLinks()
              toast.info('Spotify links removed.')
            }}
          />
        </Section>

        <Section icon="artist" title="Account" summary={`${credentials.username} on ${credentials.baseUrl.replace(/^https?:\/\//, '')}`}>
          <Row label="Server" hint={credentials.baseUrl.replace(/^https?:\/\//, '')} />
          <Row label="Signed in as" hint={credentials.username} />
          <Row label="Software" hint={[server.type, server.serverVersion].filter(Boolean).join(' ') || `API ${server.apiVersion}`} />
          {remember && <Row label="Clear stored credentials" onClick={() => setPending('credentials')} />}
          <Row label="Disconnect" danger onClick={() => setPending('disconnect')} />
        </Section>
      </div>

      {confirmDialog}
    </div>
  )
}
