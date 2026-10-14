import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { paletteFor } from '../app/artworkTheme'
import type { Song } from '../api/subsonic/types'
import { currentEntry } from '../audio/queue'
import { Cover, StarButton } from '../features/library/components'
import { isStarred, useStarred, type StarTarget } from '../features/library/starred'
import { TrackActions } from '../features/library/TrackActions'
import { useAuth } from '../state/auth'
import { usePlayback } from '../state/playback'
import { Icon } from '../ui/Icon'

/** The cover's dominant hue as a dark, saturated tint for gradients; undefined until known (CSS falls back to grey). */
export function useCoverTint(coverArt: string | undefined, lightness = 32): string | undefined {
  const credentials = useAuth((s) => s.session?.credentials)
  // Tagged with the cover it belongs to, so a stale hue never shows while the next cover is decoding.
  const [found, setFound] = useState<{ cover: string; hue: number | null } | null>(null)
  useEffect(() => {
    if (!credentials || !coverArt) return
    let live = true
    void paletteFor(credentials, coverArt).then((p) => live && setFound({ cover: coverArt, hue: p?.hue ?? null }))
    return () => {
      live = false
    }
  }, [credentials, coverArt])
  const hue = found && found.cover === coverArt ? found.hue : null
  return hue === null ? undefined : `hsl(${Math.round(hue)} 45% ${lightness}%)`
}

export const tintStyle = (tint: string | undefined) => (tint ? ({ '--tint': tint } as CSSProperties) : undefined)

/** Opens Now Playing over the current page (see MobileApp). */
export function useOpenPlayer() {
  const navigate = useNavigate()
  const location = useLocation()
  /** `lyrics`: open already scrolled to the lyrics card. */
  return (lyrics = false) => navigate('/now-playing', { state: { background: location, lyrics } })
}

export function BackButton() {
  const navigate = useNavigate()
  return (
    <button type="button" className="m-round" aria-label="Back" onClick={() => (history.length > 1 ? navigate(-1) : navigate('/home'))}>
      <Icon name="back" size={22} />
    </button>
  )
}

/** Big tinted header for albums, playlists and artists: art, title, subtitle line. */
export function Hero({ cover, title, children, round = false, art }: { cover?: string; title: string; children?: ReactNode; round?: boolean; art?: ReactNode }) {
  const tint = useCoverTint(cover)
  return (
    <header className="m-hero" style={tintStyle(tint)}>
      <div className="m-hero__bar">
        <BackButton />
      </div>
      <div className={round ? 'm-hero__art m-hero__art--round' : 'm-hero__art'}>{art ?? <Cover id={cover} size={600} />}</div>
      <h1 className="m-hero__title">{title}</h1>
      {children}
    </header>
  )
}

/** Heart / add-to-queue on the left, shuffle and the big round play button on the right. */
export function ActionBar({ star, name, load, disabled = false }: { star?: StarTarget; name: string; load: () => Promise<Song[]> | Song[]; disabled?: boolean }) {
  const playTracks = usePlayback((s) => s.playTracks)
  const shufflePlay = usePlayback((s) => s.shufflePlay)
  const addToQueue = usePlayback((s) => s.addToQueue)
  const ids = useStarred()
  const [failed, setFailed] = useState(false)
  const run = (act: (songs: Song[]) => void) => async () => {
    setFailed(false)
    try {
      act(await load())
    } catch {
      setFailed(true)
    }
  }
  return (
    <div className="m-actions">
      {star && <StarButton target={star} name={name} starred={isStarred(ids, star.kind, star.item.id)} />}
      <button type="button" className="icon-btn" aria-label={`Add ${name} to queue`} disabled={disabled} onClick={run(addToQueue)}>
        <Icon name="playlist-add" size={24} />
      </button>
      <span className="m-actions__gap" />
      <button type="button" className="icon-btn" aria-label={`Shuffle ${name}`} disabled={disabled} onClick={run(shufflePlay)}>
        <Icon name="shuffle" size={24} />
      </button>
      <button type="button" className="m-play" aria-label={`Play ${name}`} disabled={disabled} onClick={run((s) => playTracks(s))}>
        <Icon name="play" size={26} />
      </button>
      {failed && <p role="alert" className="m-error">Couldn’t load the tracks.</p>}
    </div>
  )
}

/** Whole-page track list (no inner scroller): tap a row to play the list from there; ⋯ opens the track menu. */
export function SongRows({ songs, numbered = false, inPlaylist }: { songs: Song[]; numbered?: boolean; inPlaylist?: string }) {
  const playTracks = usePlayback((s) => s.playTracks)
  const currentId = usePlayback((s) => currentEntry(s.queue)?.track.id)
  const ids = useStarred()
  const [menuFor, setMenuFor] = useState<{ song: Song; index: number } | null>(null)
  return (
    <>
      <ol className="m-songs" aria-label="Tracks">
        {songs.map((s, i) => {
          const current = s.id === currentId
          return (
            <li key={`${s.id}-${i}`} className={current ? 'm-song m-song--current' : 'm-song'}>
              <button type="button" className="m-song__main" aria-current={current ? 'true' : undefined} onClick={() => playTracks(songs, i)}>
                {numbered ? <span className="m-song__num">{s.track ?? i + 1}</span> : <span className="m-thumb"><Cover id={s.coverArt} size={96} /></span>}
                <span className="m-text">
                  <span className="m-text__title">{s.title}</span>
                  <span className="m-text__sub">{numbered ? s.artist : [s.artist, s.album].filter(Boolean).join(' • ')}</span>
                </span>
              </button>
              <button type="button" className="icon-btn" aria-label={`More actions for ${s.title}`} onClick={() => setMenuFor({ song: s, index: i })}>
                <Icon name="more" size={20} />
              </button>
            </li>
          )
        })}
      </ol>
      {menuFor && (
        <TrackActions
          song={menuFor.song}
          index={menuFor.index}
          inPlaylist={inPlaylist}
          starred={isStarred(ids, 'song', menuFor.song.id)}
          onClose={() => setMenuFor(null)}
        />
      )}
    </>
  )
}

/** A library row: thumbnail (round for artists), title and a grey subtitle. */
export function MediaRow({ to, cover, title, sub, round = false, art }: { to: string; cover?: string; title: string; sub?: string; round?: boolean; art?: ReactNode }) {
  return (
    <li>
      <Link to={to} className="m-row">
        <span className={round ? 'm-thumb m-thumb--lg m-thumb--round' : 'm-thumb m-thumb--lg'}>{art ?? <Cover id={cover} size={128} />}</span>
        <span className="m-text">
          <span className="m-text__title">{title}</span>
          {sub && <span className="m-text__sub">{sub}</span>}
        </span>
      </Link>
    </li>
  )
}

/** Horizontally scrolling row of cards under a heading. */
export function Shelf({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="m-shelf">
      <h2 className="m-h2">{title}</h2>
      <ul className="m-shelf__row">{children}</ul>
    </section>
  )
}

export function Tile({ to, cover, title, sub, round = false }: { to: string; cover?: string; title: string; sub?: string; round?: boolean }) {
  return (
    <li className={round ? 'm-tile m-tile--round' : 'm-tile'}>
      <Link to={to}>
        <Cover id={cover} size={300} />
        <span className="m-tile__title">{title}</span>
        {sub && <span className="m-tile__sub">{sub}</span>}
      </Link>
    </li>
  )
}

/** The "Liked Songs" artwork: a gradient square with a heart. */
export function LikedArt() {
  return (
    <span className="m-liked-art">
      <Icon name="heart-fill" size={28} />
    </span>
  )
}

/** Fetches the next page when the sentinel scrolls into view (paged album lists). */
export function AutoLoad({ q }: { q: { hasNextPage: boolean; isFetchingNextPage: boolean; isFetchNextPageError: boolean; fetchNextPage: () => unknown } }) {
  const ref = useRef<HTMLDivElement>(null)
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = q
  useEffect(() => {
    const el = ref.current
    if (!el || !hasNextPage || isFetchingNextPage || isFetchNextPageError || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && void fetchNextPage(), { rootMargin: '600px' })
    io.observe(el)
    return () => io.disconnect()
  }, [hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage])
  if (!hasNextPage) return null
  return (
    <div ref={ref} className="m-more">
      {isFetchNextPageError ? (
        <button type="button" className="m-chip" onClick={() => void fetchNextPage()}>
          Try again
        </button>
      ) : (
        <span className="m-spinner" role="status" aria-label="Loading more" />
      )}
    </div>
  )
}
