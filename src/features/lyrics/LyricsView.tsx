import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { activeLine } from '../../api/lyrics/lrc'
import type { MatchOutcome } from '../../api/lyrics/resolve'
import type { SpotifyCandidate } from '../../api/lyrics/spotifyMatch'
import { LyricsError, type LyricLine, type LyricWord, type Lyrics, type LyricsTrack } from '../../api/lyrics/types'
import { formatDuration } from '../../lib/format'
import { NO_SPOTIFY, parseSpotifyTrackId, linkKey, useSpotifyLinks } from '../../state/spotifyLinks'
import { useAuth } from '../../state/auth'
import { playbackTime, usePlayback } from '../../state/playback'
import { EmptyState, ErrorState } from '../../ui/State'
import { useLyrics } from './useLyrics'

const SOURCES = { server: 'your server', lrclib: 'LRCLIB' } as const
/** Where the active line settles, as a fraction of the lyrics viewport from the top. */
const FOCUS = 0.32
const SCROLL_MS = 700
const easeOutQuart = (k: number) => 1 - (1 - k) ** 4
const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '])

/**
 * Syllables grouped into words, so a word never wraps between its syllables. Each syllable carries its timing for the
 * painter in SyncedLines; React renders this once per lyrics load, never per frame.
 */
function Words({ words }: { words: LyricWord[] }) {
  const groups: LyricWord[][] = [[]]
  for (const w of words) {
    groups[groups.length - 1]!.push(w)
    if (!w.joinNext) groups.push([])
  }
  const list = groups.filter((g) => g.length)
  return list.map((g, i) => (
    <Fragment key={i}>
      <span className="lyric__word">
        {g.map((s, j) => (
          <span key={j} className="syl" data-start={s.start} data-end={s.end}>
            {s.text}
          </span>
        ))}
      </span>
      {i < list.length - 1 ? ' ' : ''}
    </Fragment>
  ))
}

type LineState = 'past' | 'active' | 'next'

/** Memoized: an active-line change re-renders only the two lines whose state changed. */
const Line = memo(function Line({ line, index, state, onSeek }: { line: LyricLine; index: number; state: LineState; onSeek: (i: number) => void }) {
  if (!line.text) {
    // An instrumental gap in LRC: a quiet marker while it is "sung", nothing otherwise.
    return <li data-line={index} aria-hidden className={`lyric lyric--gap lyric--${state}`} />
  }
  return (
    <li data-line={index} className={`lyric lyric--${state}${line.opposite ? ' lyric--opposite' : ''}${line.words ? ' lyric--timed' : ''}`}>
      <button type="button" className="lyric__btn" aria-label={line.text} aria-current={state === 'active' || undefined} onClick={() => onSeek(index)}>
        <span className="lyric__lead">{line.words ? <Words words={line.words} /> : line.text}</span>
        {line.background?.map((b, j) => (
          <span key={j} className="lyric__bg">
            {b.words ? <Words words={b.words} /> : b.text}
          </span>
        ))}
      </button>
    </li>
  )
})

interface Syllable {
  el: HTMLElement
  start: number
  end: number
  /** Last painted progress, so unchanged syllables cost nothing. */
  p: number
}

/**
 * Synced lyrics driven by the audio clock. Line changes go through React (a few times a minute); syllable progress is
 * painted imperatively every animation frame while playing, writing a style only for the syllable being sung.
 */
function SyncedLines({ lines, footer }: { lines: LyricLine[]; footer: ReactNode }) {
  const seek = usePlayback((s) => s.seek)
  const box = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(() => activeLine(lines, playbackTime()))
  const activeRef = useRef(active)
  const syllables = useRef<Syllable[]>([])
  const [follow, setFollow] = useState(true)
  const followRef = useRef(follow)
  const tween = useRef(0)
  const firstScroll = useRef(true)

  const paint = useCallback((t: number) => {
    for (const s of syllables.current) {
      const p = t <= s.start ? 0 : t >= s.end ? 1 : Math.round(((t - s.start) / (s.end - s.start)) * 100) / 100
      if (p === s.p) continue
      s.p = p
      s.el.style.setProperty('--p', String(p))
      s.el.classList.toggle('is-active', p > 0 && p < 1)
      s.el.classList.toggle('is-done', p === 1)
    }
  }, [])

  // One clock for everything: the audio element's time, every frame while playing, and on every seek/pause/resume.
  useEffect(() => {
    let raf = 0
    const update = () => {
      const t = playbackTime()
      const idx = activeLine(lines, t)
      if (idx !== activeRef.current) {
        activeRef.current = idx
        setActive(idx) // the layout effect below re-targets the painter before the next paint
      }
      paint(t)
    }
    const frame = () => {
      raf = 0
      update()
      if (usePlayback.getState().status === 'playing') raf = requestAnimationFrame(frame)
    }
    const unsubscribe = usePlayback.subscribe((s, prev) => {
      if (s.position === prev.position && s.status === prev.status) return
      update()
      if (s.status === 'playing' && !raf) raf = requestAnimationFrame(frame)
    })
    frame()
    return () => {
      unsubscribe()
      cancelAnimationFrame(raf)
    }
  }, [lines, paint])

  const scrollToActive = useCallback((instant: boolean) => {
    const c = box.current
    if (!c) return
    cancelAnimationFrame(tween.current)
    const el = c.querySelector<HTMLElement>(`[data-line="${activeRef.current}"]`)
    const target = Math.max(0, Math.min(el ? el.offsetTop - c.clientHeight * FOCUS : 0, c.scrollHeight - c.clientHeight))
    if (instant || reduceMotion()) return void c.scrollTo?.({ top: target, behavior: 'auto' })
    const distance = target - c.scrollTop
    if (Math.abs(distance) < 1) return
    // A long jump (seek) starts near its destination, so the motion stays short and readable.
    const from = Math.abs(distance) > c.clientHeight ? target - Math.sign(distance) * c.clientHeight * 0.4 : c.scrollTop
    const t0 = performance.now()
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / SCROLL_MS)
      c.scrollTop = from + (target - from) * easeOutQuart(k)
      if (k < 1) tween.current = requestAnimationFrame(step)
    }
    tween.current = requestAnimationFrame(step)
  }, [])

  // Re-target the painter to the new line, reset the old one to its CSS state, and follow.
  useLayoutEffect(() => {
    for (const s of syllables.current) {
      s.el.style.removeProperty('--p')
      s.el.classList.remove('is-active', 'is-done')
    }
    const li = box.current?.querySelector(`[data-line="${active}"]`)
    syllables.current = li
      ? [...li.querySelectorAll<HTMLElement>('.syl')].map((el) => ({ el, start: Number(el.dataset.start), end: Number(el.dataset.end), p: -1 }))
      : []
    paint(playbackTime())
    if (followRef.current) scrollToActive(firstScroll.current)
    firstScroll.current = false
  }, [active, paint, scrollToActive])

  useEffect(() => {
    followRef.current = follow
    if (follow) scrollToActive(false)
  }, [follow, scrollToActive])

  // Keep the focal position when the viewport changes size (rotation, window resize, font load).
  useEffect(() => {
    const c = box.current
    if (!c || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => followRef.current && scrollToActive(true))
    ro.observe(c)
    return () => ro.disconnect()
  }, [scrollToActive])

  useEffect(() => () => cancelAnimationFrame(tween.current), [])

  // Wheel, touch, scroll keys and the scrollbar are the user scrolling; our own scrolling fires none of these.
  const manual = () => {
    cancelAnimationFrame(tween.current)
    setFollow(false)
  }
  const onSeek = useCallback(
    (i: number) => {
      seek(lines[i]!.time!)
      setFollow(true)
    },
    [lines, seek],
  )

  return (
    <div className="lyrics-stage">
      <div
        ref={box}
        className="lyrics"
        role="region"
        aria-label="Lyrics"
        tabIndex={0}
        onWheel={manual}
        onTouchMove={manual}
        onKeyDown={(e) => SCROLL_KEYS.has(e.key) && e.target === e.currentTarget && manual()}
        onPointerDown={(e) => e.target === e.currentTarget && manual()}
      >
        <ol className="lyrics__lines">
          {lines.map((l, i) => (
            <Line key={i} line={l} index={i} state={i === active ? 'active' : i < active ? 'past' : 'next'} onSeek={onSeek} />
          ))}
        </ol>
      </div>
      {!follow && active >= 0 && (
        <button type="button" className="lyrics-resume glass-overlay" onClick={() => setFollow(true)}>
          Back to current line
        </button>
      )}
      <div className="lyrics-stage__footer">
        {footer}
        <button type="button" className="lyrics-follow" aria-pressed={follow} onClick={() => setFollow((f) => !f)}>
          Follow playback
        </button>
      </div>
    </div>
  )
}

/** The provider name is always shown; community syncs also credit and link uploader and maker (API terms §6). */
function Source({ lyrics, onRefresh }: { lyrics: Lyrics; onRefresh: () => void }) {
  const a = lyrics.attribution
  return (
    <p className="lyrics__source">
      {lyrics.source === 'spicy' && a ? (
        <>
          Lyrics from {a.provider} (via Spicy Lyrics)
          {a.credits.map((c) => (
            <span key={c.role}>
              {' · '}
              {c.role}:{' '}
              {c.url ? (
                <a href={c.url} target="_blank" rel="noopener noreferrer">
                  {c.name}
                </a>
              ) : (
                c.name
              )}
            </span>
          ))}
        </>
      ) : (
        <>Lyrics from {SOURCES[lyrics.source as keyof typeof SOURCES]}</>
      )}
      {' · '}
      <button type="button" className="link-btn" onClick={onRefresh}>
        Refresh
      </button>
    </p>
  )
}

const describe = (c: SpotifyCandidate) => [c.album, formatDuration(c.durationMs / 1000), c.explicit && 'Explicit'].filter(Boolean).join(' · ')

/**
 * The track's Spotify identity, which Spicy Lyrics is addressed by: what was matched (or why not), a chooser when
 * several recordings fit, and a manual link that always wins.
 */
function SpotifyPanel({ track, q }: { track: LyricsTrack; q: ReturnType<typeof useLyrics> }) {
  const credentials = useAuth((s) => s.session?.credentials)
  const link = useSpotifyLinks((s) => s.link)
  const unlink = useSpotifyLinks((s) => s.unlink)
  const [text, setText] = useState('')
  const [invalid, setInvalid] = useState(false)
  const summary = useRef<HTMLElement>(null)
  if (!credentials) return null
  const key = linkKey(credentials, track.id)
  const { linked, resolution, external } = q
  const off = linked === NO_SPOTIFY
  const candidates = !linked && resolution?.status === 'ambiguous' ? resolution.candidates : []
  const choose = (id: string) => {
    link(key, id)
    summary.current?.focus() // the chooser disappears; keep focus somewhere sensible
  }
  const noSpicy = !!q.spotifyId && q.isSuccess && q.data?.source !== 'spicy'

  return (
    <details className="spicy" open={candidates.length > 0 || undefined}>
      <summary ref={summary}>
        Word-synced lyrics (Spicy Lyrics)
        {status(linked, off, resolution, q.backendMissing)}
        {noSpicy && ' · none for this recording'}
      </summary>
      <div className="spicy__body">
        {!linked && resolution?.status === 'matched' && (
          <p className="hint">
            Matched automatically to “{resolution.candidate.name}” by {resolution.candidate.artists.join(', ')} ({describe(resolution.candidate)}).
          </p>
        )}
        {candidates.length > 0 && (
          <fieldset className="spicy__choices">
            <legend>Which recording is this?</legend>
            <p className="hint">Several Spotify recordings fit this track. Pick the one you are playing, so the word timing matches.</p>
            <ul>
              {candidates.map((c) => (
                <li key={c.id}>
                  <button type="button" className="choice" onClick={() => choose(c.id)}>
                    <span className="choice__title">
                      {c.name} — {c.artists.join(', ')}
                    </span>
                    <span className="choice__meta">{describe(c)}</span>
                  </button>
                </li>
              ))}
            </ul>
            <button type="button" className="btn" onClick={() => choose(NO_SPOTIFY)}>
              None of these
            </button>
          </fieldset>
        )}
        <form
          className="spicy__form"
          onSubmit={(e) => {
            e.preventDefault()
            const id = parseSpotifyTrackId(text)
            setInvalid(!id)
            if (id) {
              link(key, id)
              setText('')
            }
          }}
        >
          <p className="hint">
            {q.matching ? 'Tracks are matched to Spotify automatically. To correct a match, paste' : 'Paste'} this track’s Spotify link (or its 22-character id).
            It is saved on this device and sent, with no other track details, to your Auralis server, which asks Spicy Lyrics.
            {!external && ' Turn on External lookups in Settings to use it.'}
          </p>
          <label className="field">
            <span>Spotify track link</span>
            <input value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" spellCheck={false} placeholder="https://open.spotify.com/track/…" aria-invalid={invalid || undefined} />
          </label>
          {invalid && (
            <p role="alert" className="error">
              That isn’t a Spotify track link or id.
            </p>
          )}
          <div className="actions">
            <button type="submit" className="btn" disabled={!text.trim()}>
              {linked && !off ? 'Replace link' : 'Link track'}
            </button>
            {linked && (
              <button type="button" className="btn" onClick={() => unlink(key)}>
                {off ? (q.matching ? 'Match automatically again' : 'Use Spicy Lyrics again') : 'Remove link'}
              </button>
            )}
            {!linked && resolution?.status === 'matched' && (
              <button type="button" className="btn" onClick={() => link(key, NO_SPOTIFY)}>
                Wrong recording
              </button>
            )}
          </div>
        </form>
      </div>
    </details>
  )
}

function status(linked: string | undefined, off: boolean, r: MatchOutcome | undefined, backendMissing: boolean): string {
  if (off) return ' · off for this track'
  if (linked) return ' · linked'
  if (backendMissing) return ' · no lyrics backend, so no automatic Spotify match'
  if (r?.status === 'unavailable') return ' · Spotify lookup failed, try Refresh'
  if (r?.status === 'matched') return ' · matched automatically'
  if (r?.status === 'ambiguous') return ' · choose a recording'
  if (r?.status === 'none') return ' · no Spotify match'
  return ''
}

function errorMessage(e: unknown): string {
  const kind = e instanceof LyricsError ? e.kind : 'unavailable'
  if (kind === 'timeout') return 'The lyrics service took too long to respond.'
  if (kind === 'network') return "Couldn't reach the lyrics service."
  if (kind === 'rate-limited') return 'The lyrics service is busy. Try again in a minute.'
  if (kind === 'auth') return 'Your session was rejected by the server. Reconnect in Settings.'
  return "Couldn't load lyrics."
}

/** Placeholder lines shaped like lyrics, so nothing jumps when they arrive. */
function LyricsLoading({ label }: { label: string }) {
  return (
    <div className="lyrics-loading" role="status" aria-label="Loading">
      {[72, 54, 86, 40, 64].map((w, i) => (
        <span key={i} className="skeleton lyrics-loading__line" style={{ width: `${w}%` }} />
      ))}
      <span className="sr-only">{label}</span>
    </div>
  )
}

function Body({ q }: { q: ReturnType<typeof useLyrics> }) {
  if (q.isPending) return <LyricsLoading label={q.resolving ? 'Finding this recording…' : 'Loading lyrics…'} />
  if (q.isError) return <div className="lyrics-empty"><ErrorState message={errorMessage(q.error)} onRetry={() => void q.refresh()} /></div>
  const lyrics = q.data
  if (!lyrics) {
    return (
      <div className="lyrics-empty">
        <EmptyState title="No lyrics found" hint={q.external ? 'Neither your server nor LRCLIB has lyrics for this track.' : 'Your server has no lyrics for this track. External lookups are off in Settings.'} />
        <div className="load-more">
          <button type="button" className="btn" onClick={() => void q.refresh()}>
            Look again
          </button>
        </div>
      </div>
    )
  }
  if (lyrics.instrumental) return <div className="lyrics-empty"><EmptyState title="Instrumental" hint="This track has no lyrics." /></div>
  const source = <Source lyrics={lyrics} onRefresh={() => void q.refresh()} />
  if (lyrics.synced) return <SyncedLines lines={lyrics.lines} footer={source} />
  return (
    <>
      <div className="lyrics lyrics--plain" role="region" aria-label="Lyrics" tabIndex={0}>
        {lyrics.lines.map((l, i) => (l.text ? <p key={i}>{l.text}</p> : <p key={i} aria-hidden className="lyrics__gap" />))}
      </div>
      {source}
    </>
  )
}

export default function LyricsView({ track }: { track: LyricsTrack }) {
  const q = useLyrics(track)
  // The panel keeps one place in the tree in every state, so it is never remounted (and never drops focus).
  return (
    <>
      <Body q={q} />
      <SpotifyPanel track={track} q={q} />
    </>
  )
}
