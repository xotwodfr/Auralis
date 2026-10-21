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

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="m-set" aria-label={title}>
      <h2 className="m-set__title">{title}</h2>
      <div className="m-set__card">{children}</div>
    </section>
  )
}

/** One row of a grouped card: a coloured icon tile, a label with an optional hint, and a control or value on the right. */
function Row({ icon, label, hint, children, onClick, danger = false }: { icon?: IconName; label: string; hint?: string; children?: ReactNode; onClick?: () => void; danger?: boolean }) {
  const body = (
    <>
      {icon && (
        <span className="m-set__icon" aria-hidden>
          <Icon name={icon} size={18} />
        </span>
      )}
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
      <Row icon="wave" label="Equalizer" hint={unavailable ? EFFECTS_UNAVAILABLE : 'Shape the sound. Applies to everything you play.'}>
        <Switch label="Equalizer" checked={on} disabled={unavailable} onChange={setOn} />
      </Row>
      {on && !unavailable && (
        <div className="m-set__block eq">
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
    <div className="m-page m-page--settings m-settings">
      <header className="m-top m-top--sticky">
        <BackButton />
        <h1 className="m-h1">Settings</h1>
      </header>

      <Group title="Audio & streaming">
        <div className="m-set__block">
          <Row icon="wave" label="Streaming quality" hint="Applies from the next track. Lower settings ask your server to transcode." />
          <SegmentedControl
            label="Streaming quality"
            value={settings.streamQuality}
            onChange={settings.setStreamQuality}
            options={QUALITIES.map((q) => ({ value: q.value, label: q.label, caption: q.caption }))}
            variant="cards"
          />
        </div>
        <div className="m-set__block">
          <Row icon="clock" label="Crossfade" hint="Overlap the end of a track with the start of the next">
            <span className="m-set__value">{settings.crossfadeSeconds === 0 ? 'Off' : `${settings.crossfadeSeconds} s`}</span>
          </Row>
          <Slider label="Crossfade" value={settings.crossfadeSeconds} max={MAX_CROSSFADE_S} step={1} live valueText={settings.crossfadeSeconds === 0 ? 'Off' : `${settings.crossfadeSeconds} seconds`} onCommit={settings.setCrossfadeSeconds} />
        </div>
        <Equalizer />
      </Group>

      <Group title="Interface">
        <Row icon="album" label="Adaptive album colours" hint="Tint screens and blur the cover behind them">
          <Switch label="Adaptive album colours" checked={settings.adaptiveColors} onChange={settings.setAdaptiveColors} />
        </Row>
        <Row icon="lyrics" label="Word-synced lyrics" hint="Highlight each word as it is sung, when available">
          <Switch label="Word-synced lyrics" checked={settings.lyricsWordSync} onChange={settings.setLyricsWordSync} />
        </Row>
        <Row icon="lyrics" label="Show lyrics source" hint="Where the lyrics came from and who made them">
          <Switch label="Show lyrics source" checked={settings.showLyricSource} onChange={settings.setShowLyricSource} />
        </Row>
        <div className="m-set__block">
          <Row icon="lyrics" label="Lyrics size" />
          <SegmentedControl label="Lyrics size" value={settings.lyricSize} onChange={settings.setLyricSize} options={SIZES} />
        </div>
      </Group>

      <Group title="Server & account">
        <Row icon="home" label="Server">
          <span className="m-set__value">{credentials.baseUrl.replace(/^https?:\/\//, '')}</span>
        </Row>
        <Row icon="artist" label="Signed in as">
          <span className="m-set__value">{credentials.username}</span>
        </Row>
        <Row icon="settings" label="Software">
          <span className="m-set__value">{[server.type, server.serverVersion].filter(Boolean).join(' ') || `API ${server.apiVersion}`}</span>
        </Row>
        {remember && <Row icon="clock" label="Clear stored credentials" onClick={() => setPending('credentials')} />}
        <Row icon="back" label="Disconnect" danger onClick={() => setPending('disconnect')} />
      </Group>

      <Group title="Chat server">
        <div className="m-set__block m-set__form">
          <ChatServerSection />
        </div>
      </Group>

      <Group title="Storage">
        <Row icon="queue" label="Local data" hint="Cached lyrics, matches and settings. Music is streamed, not stored.">
          <span className="m-set__value">{used === null ? '–' : formatBytes(used)}</span>
        </Row>
        <Row icon="trash" label="Clear cached lyrics" onClick={() => setPending('lyrics')} />
        <Row
          icon="trash"
          label="Remove Spotify links"
          onClick={() => {
            clearLinks()
            toast.info('Spotify links removed.')
          }}
        />
      </Group>

      <Group title="Lyrics sources & privacy">
        <Row label="External lookups" hint="When your server has no lyrics, ask lrclib.net">
          <Switch label="External lookups" checked={settings.externalLookups} onChange={settings.setExternalLookups} />
        </Row>
        <Row label="Report plays to your server" hint="Keeps its play counts and recently played lists right">
          <Switch label="Report plays to your server" checked={settings.reportPlays} onChange={settings.setReportPlays} />
        </Row>
        <Row label="Share what I'm playing" hint="Everyone on your server can see it in Social">
          <Switch label="Share what I'm playing" checked={settings.shareListening} onChange={settings.setShareListening} />
        </Row>
        <div className="m-set__block m-set__form">
          <LyricsServerForm />
          <p className="m-set__hint">Spicy Lyrics: {spicy}. Spotify matching: {matching}.</p>
        </div>
      </Group>

      {confirmDialog}
    </div>
  )
}
