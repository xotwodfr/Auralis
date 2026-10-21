import { useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent, type ReactNode } from 'react'
import { clearLyricsCache } from '../../api/lyrics/cache'
import { clearSpotifyMatches } from '../../api/lyrics/resolve'
import { ServerCheckError, probeLyricsServer, useLyricsBackend } from '../lyrics/useLyricsBackend'
import { DEFAULT_LYRICS_SERVER, backendBase, checkServerUrl } from '../../lib/backend'
import { SHORTCUTS } from '../../app/shortcuts'
import { paletteStyle, usePalette } from '../../app/artworkTheme'
import { THEME_OPTIONS, useTheme } from '../../app/theme'
import { isMobileApp } from '../../app/platform'
import { useAuth } from '../../state/auth'
import { useSettings } from '../../state/settings'
import { useSpotifyLinks } from '../../state/spotifyLinks'
import { toast } from '../../state/toast'
import { ConfirmDialog } from '../../ui/Dialog'
import { SegmentedControl } from '../../ui/SegmentedControl'
import { ChatServerSection } from './ChatServerSection'

/** A mini window painted by the theme's own tokens (the `data-theme` attribute scopes them to this element). */
function Swatch({ theme, style }: { theme: string; style?: Record<string, string> }) {
  return (
    <span className="swatch" data-theme={theme} style={style} aria-hidden="true">
      <span className="swatch__side" />
      <span className="swatch__line" />
      <span className="swatch__dot" />
    </span>
  )
}

export function spicyText(b: ReturnType<typeof useLyricsBackend>, serverOn: boolean): [string, string] {
  if (!serverOn) return ['Off: lyrics server lookup is disabled', 'Off']
  if (b.isPending) return ['Checking…', 'Checking…']
  if (b.isError) return [b.error.message, 'Not available']
  if (!b.data.enabled) return ['Backend running, but SPICY_LYRICS_SECRET_KEY is not set', 'Off: needs Spicy Lyrics first']
  return ['Ready', b.data.matching ? 'On (Spotify search)' : 'Off: SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET are not set; link tracks by hand']
}

/** The lyrics server address: validated, testable, saved locally. Holds no secrets: those live on the server. */
export function LyricsServerForm() {
  const saved = useSettings((s) => s.lyricsServerUrl)
  const on = useSettings((s) => s.lyricsServerEnabled)
  const setOn = useSettings((s) => s.setLyricsServerEnabled)
  const setUrl = useSettings((s) => s.setLyricsServerUrl)
  const [draft, setDraft] = useState(saved || DEFAULT_LYRICS_SERVER)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  /** An empty field means "use the default". */
  const normalized = () => (draft.trim() === '' ? { url: '' } : checkServerUrl(draft))

  async function test() {
    const n = normalized()
    if ('error' in n) return setResult({ ok: false, text: n.error })
    const url = n.url
    setBusy(true)
    setResult(null)
    try {
      const b = await probeLyricsServer(url || backendBase())
      setResult({ ok: true, text: !b.enabled ? 'Connected, but the server has no Spicy Lyrics key configured.' : b.matching ? 'Connected. Word-synced lyrics and automatic Spotify matching are available.' : 'Connected. Word-synced lyrics are available; automatic Spotify matching is not configured on that server.' })
    } catch (e) {
      setResult({ ok: false, text: e instanceof ServerCheckError ? e.message : 'The check failed.' })
    }
    setBusy(false)
  }

  function save(e: FormEvent) {
    e.preventDefault()
    const n = normalized()
    if ('error' in n) return setResult({ ok: false, text: n.error })
    const url = n.url
    setUrl(url === DEFAULT_LYRICS_SERVER ? '' : url)
    setDraft(url || DEFAULT_LYRICS_SERVER)
    setResult({ ok: true, text: 'Saved on this device.' })
  }

  return (
    <form onSubmit={save}>
      <label className="check">
        <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} />
        <span>Use a lyrics server</span>
      </label>
      <p className="hint">
        Word-synced lyrics and automatic Spotify matching come from a lyrics server. It receives the title, artist and ISRC of tracks
        you play, never your music server address or login. Turn off to stay on your server and LRCLIB.
      </p>
      <label className="field">
        <span>Auralis backend URL</span>
        <input
          type="url" inputMode="url" autoCapitalize="off" spellCheck={false} disabled={!on}
          value={draft} placeholder={DEFAULT_LYRICS_SERVER || 'https://lyrics.example.com'}
          onChange={(e) => (setDraft(e.target.value), setResult(null))}
        />
      </label>
      <div className="actions">
        <button className="btn" type="submit" disabled={!on}>Save</button>
        <button className="btn" type="button" disabled={!on || busy} onClick={() => void test()}>{busy ? 'Testing…' : 'Test connection'}</button>
        <button className="btn" type="button" disabled={!on} onClick={() => (setUrl(''), setDraft(DEFAULT_LYRICS_SERVER), setResult(null))}>Reset to default</button>
      </div>
      {result && <p className="hint" role={result.ok ? 'status' : 'alert'}>{result.text}</p>}
    </form>
  )
}

type Pending = 'disconnect' | 'credentials' | 'lyrics' | null

const DIALOGS = {
  disconnect: { title: 'Disconnect?', message: 'You will be signed out and any stored credentials removed from this browser.', label: 'Disconnect' },
  credentials: { title: 'Clear stored credentials?', message: 'You stay connected now, but will need to sign in again next time.', label: 'Clear credentials' },
  lyrics: { title: 'Clear cached lyrics?', message: 'Lyrics and Spotify matches will be looked up again the next time you play each track.', label: 'Clear cache' },
} as const

/** The destructive account/cache actions and their confirmation dialog, shared by the web and phone settings pages. */
export function useAccountActions() {
  const disconnect = useAuth((s) => s.disconnect)
  const forgetDevice = useAuth((s) => s.forgetDevice)
  const queries = useQueryClient()
  const [pending, setPending] = useState<Pending>(null)

  const confirmed = {
    disconnect: () => disconnect().catch(() => toast.error("Couldn't clear the stored credentials from this browser.")),
    credentials: () =>
      forgetDevice().then(
        () => toast.info('Stored credentials cleared.'),
        () => toast.error("Couldn't clear the stored credentials from this browser."),
      ),
    lyrics: () =>
      Promise.all([clearLyricsCache(), clearSpotifyMatches()]).then(
        () => {
          queries.removeQueries({ queryKey: ['lyrics'] })
          queries.removeQueries({ queryKey: ['spotify-match'] })
          toast.info('Cached lyrics cleared.')
        },
        () => toast.error("Couldn't clear cached lyrics."),
      ),
  } as const

  const dialog = pending && DIALOGS[pending]
  const confirmDialog =
    pending && dialog ? (
      <ConfirmDialog
        title={dialog.title}
        message={dialog.message}
        confirmLabel={dialog.label}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          setPending(null)
          void confirmed[pending]()
        }}
      />
    ) : null
  return { setPending, confirmDialog }
}

/** A collapsible settings group; native <details> keeps it keyboard-accessible with no state. */
function Section({ id, title, defaultOpen, children }: { id: string; title: string; defaultOpen?: boolean; children: ReactNode }) {
  return (
    <details className="panel fold" open={defaultOpen}>
      <summary className="fold__summary">
        <h2 id={id} className="panel__title">{title}</h2>
      </summary>
      <div className="fold__body" role="region" aria-labelledby={id}>{children}</div>
    </details>
  )
}

export default function Settings() {
  const session = useAuth((s) => s.session)
  const external = useSettings((s) => s.externalLookups)
  const setExternal = useSettings((s) => s.setExternalLookups)
  const reportPlays = useSettings((s) => s.reportPlays)
  const setReportPlays = useSettings((s) => s.setReportPlays)
  const shareListening = useSettings((s) => s.shareListening)
  const setShareListening = useSettings((s) => s.setShareListening)
  const theme = useTheme((s) => s.pref)
  const setTheme = useTheme((s) => s.setPref)
  const palette = usePalette((s) => s.palette)
  const { setPending, confirmDialog } = useAccountActions()
  const serverOn = useSettings((s) => s.lyricsServerEnabled)
  const [spicy, matching] = spicyText(useLyricsBackend(), serverOn)
  const clearLinks = useSpotifyLinks((s) => s.clear)

  if (!session) return null
  const { credentials, server, capabilities, remember } = session

  const rows: [string, string][] = [
    ['Server', credentials.baseUrl],
    ['User', credentials.username],
    ['Software', [server.type, server.serverVersion].filter(Boolean).join(' ') || 'Unknown'],
    ['API version', server.apiVersion],
    ['OpenSubsonic', capabilities.openSubsonic ? 'Yes' : 'No'],
    ['Server lyrics', capabilities.songLyrics ? 'Supported' : 'Not available'],
    ['Credentials stored on this device', remember ? 'Yes' : 'No'],
  ]

  return (
    <section className="page">
      <h1 className="page__title">Settings</h1>

      {!isMobileApp() && <Section id="appearance" title="Appearance" defaultOpen>
        <SegmentedControl
          variant="cards"
          label="Theme"
          value={theme}
          onChange={setTheme}
          options={THEME_OPTIONS.map((o) => ({
            value: o.value,
            label: o.label,
            caption: o.scheme === 'Auto' ? 'Follows your OS' : o.scheme,
            preview:
              o.value === 'system' ? (
                <span className="swatch swatch--split" aria-hidden="true">
                  <Swatch theme="light" />
                  <Swatch theme="dark" />
                </span>
              ) : (
                <Swatch theme={o.value} style={o.value === 'artwork' ? paletteStyle(palette) : undefined} />
              ),
          }))}
        />
        {theme === 'artwork' && (
          <p className="hint">
            Colours follow the cover of the playing track. If your server blocks cross-origin image reads, the default palette is used.
          </p>
        )}
      </Section>}

      <Section id="connection" title="Connection" defaultOpen>
        <dl className="rows">
          {rows.map(([label, value]) => (
            <div className="rows__row" key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <div className="actions">
          {remember && (
            <button className="btn" type="button" onClick={() => setPending('credentials')}>
              Clear stored credentials
            </button>
          )}
          <button className="btn btn--primary" type="button" onClick={() => setPending('disconnect')}>
            Disconnect
          </button>
        </div>
      </Section>

      <Section id="chat-server" title="Chat server">
        <ChatServerSection />
      </Section>

      <Section id="playback-settings" title="Playback">
        <label className="check">
          <input type="checkbox" checked={reportPlays} onChange={(e) => setReportPlays(e.target.checked)} />
          <span>Report plays to your server</span>
        </label>
        <p className="hint">
          Record each track on your own server once you have heard half of it. This is what keeps its play counts, “recently
          played” lists and smart playlists accurate. Nothing is sent anywhere else.
        </p>
        <label className="check">
          <input type="checkbox" checked={shareListening} onChange={(e) => setShareListening(e.target.checked)} />
          <span>Share what I’m playing</span>
        </label>
        <p className="hint">
          Tell your server which track you start. Everyone signed in to the same server can then see it, in Social and in other
          apps. Off unless you turn it on.
        </p>
      </Section>

      <Section id="lyrics-settings" title="Lyrics">
        <label className="check">
          <input type="checkbox" checked={external} onChange={(e) => setExternal(e.target.checked)} />
          <span>External lookups</span>
        </label>
        <p className="hint">
          When your server has no lyrics, send the track title, artist, album and length to lrclib.net. Turn off to use only your server.
        </p>
        <LyricsServerForm />
        <dl className="rows">
          <div className="rows__row">
            <dt>Spicy Lyrics (word-synced, via the Auralis backend)</dt>
            <dd>{spicy}</dd>
          </div>
          <div className="rows__row">
            <dt>Automatic Spotify matching</dt>
            <dd>{matching}</dd>
          </div>
        </dl>
        <div className="actions">
          <button className="btn" type="button" onClick={() => setPending('lyrics')}>
            Clear cached lyrics
          </button>
          <button
            className="btn"
            type="button"
            onClick={() => {
              clearLinks()
              toast.info('Spotify links removed.')
            }}
          >
            Remove Spotify links
          </button>
        </div>
      </Section>

      {!isMobileApp() && <Section id="shortcuts" title="Keyboard shortcuts">
        <dl className="rows">
          {SHORTCUTS.map((s) => (
            <div className="rows__row" key={s.keys}>
              <dt>{s.action}</dt>
              <dd>
                <kbd>{s.keys}</kbd>
              </dd>
            </div>
          ))}
        </dl>
      </Section>}

      {confirmDialog}
    </section>
  )
}
