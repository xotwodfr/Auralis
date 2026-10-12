import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { SubsonicError } from '../../api/subsonic/errors'
import { coverArtUrl, getAlbum } from '../../api/subsonic/endpoints'
import type { Album, Artist, Playlist, Song } from '../../api/subsonic/types'
import { formatDate, formatDuration } from '../../lib/format'
import { currentEntry } from '../../audio/queue'
import { useAuth } from '../../state/auth'
import { usePlayback } from '../../state/playback'
import { Artwork } from '../../ui/Artwork'
import { isStarred, useStarred, useToggleStar, type StarTarget } from './starred'
import { TrackActions } from './TrackActions'
import { Icon } from '../../ui/Icon'
import { Grid } from '../../ui/Grid'
import { ErrorState, Skeleton } from '../../ui/State'
import { VirtualList } from '../../ui/VirtualList'
import { connectErrorMessage } from '../connect/errorMessage'

const href = (kind: string, id: string) => `/library/${kind}/${encodeURIComponent(id)}`

export function Cover({ id, size }: { id?: string; size: number }) {
  const credentials = useAuth((s) => s.session?.credentials)
  return <Artwork src={id && credentials ? coverArtUrl(credentials, id, size) : undefined} />
}

/** The one favourite control: the same heart on tracks, albums and artists. */
export function StarButton({ target, starred, name }: { target: StarTarget; starred: boolean; name: string }) {
  const toggle = useToggleStar()
  return (
    <button
      type="button"
      className="icon-btn star"
      aria-pressed={starred}
      aria-label={starred ? `Remove ${name} from favorites` : `Add ${name} to favorites`}
      title={starred ? 'Remove from favorites' : 'Add to favorites'}
      onClick={() => void toggle(target)}
    >
      <Icon name={starred ? 'heart-fill' : 'heart'} size={20} />
    </button>
  )
}

export function Page({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <h1 className="page__title">{title}</h1>
      {children}
    </>
  )
}

interface QueryLike {
  isPending: boolean
  isError: boolean
  error: unknown
  refetch: () => unknown
}

/** Loading skeleton / error with retry; otherwise the children. */
export function Boundary({ q, children }: { q: QueryLike; children: ReactNode }) {
  if (q.isPending) return <Skeleton />
  if (q.isError) {
    // An expired or revoked login can't be fixed by retrying: send the user back to sign in.
    if (q.error instanceof SubsonicError && (q.error.kind === 'auth' || q.error.kind === 'not-authorized')) {
      return <ErrorState message="Your session was rejected by the server." actionLabel="Sign in again" onRetry={() => void useAuth.getState().disconnect()} />
    }
    return <ErrorState message={connectErrorMessage(q.error)} onRetry={() => void q.refetch()} />
  }
  return children
}

export function LoadMore({
  q,
}: {
  q: { hasNextPage: boolean; isFetchingNextPage: boolean; isFetchNextPageError: boolean; fetchNextPage: () => unknown }
}) {
  if (!q.hasNextPage) return null
  return (
    <div className="load-more">
      {q.isFetchNextPageError && <p role="alert">Couldn’t load more.</p>}
      <button className="btn" type="button" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
        {q.isFetchingNextPage ? 'Loading…' : q.isFetchNextPageError ? 'Try again' : 'Load more'}
      </button>
    </div>
  )
}

export function Header({ cover, title, meta, children, actions, star }: { cover?: string; title: string; meta?: string; children?: ReactNode; actions?: ReactNode; star?: StarTarget }) {
  return (
    <header className="hero">
      <div className="hero__art">
        <Cover id={cover} size={400} />
      </div>
      <div>
        <h1 className="page__title">
          {title}
          {star && <HeroStar target={star} name={title} />}
        </h1>
        {children}
        {meta && <p className="page__lede">{meta}</p>}
        {actions}
      </div>
    </header>
  )
}

function HeroStar({ target, name }: { target: StarTarget; name: string }) {
  const ids = useStarred()
  return <StarButton target={target} name={name} starred={isStarred(ids, target.kind, target.item.id)} />
}

/** Fetches an album's tracks through the query cache (shared with the album page). */
function useAlbumSongs() {
  const queryClient = useQueryClient()
  const credentials = useAuth((s) => s.session?.credentials)
  return useCallback(
    async (id: string): Promise<Song[]> => {
      if (!credentials) return []
      const data = await queryClient.fetchQuery({
        queryKey: [credentials.baseUrl, credentials.username, 'album', id],
        queryFn: ({ signal }) => getAlbum(credentials, id, signal),
      })
      return data.songs
    },
    [queryClient, credentials],
  )
}

function AlbumCard({ album: a, showAdded, starred }: { album: Album; showAdded: boolean; starred: boolean }) {
  const songsOf = useAlbumSongs()
  const playTracks = usePlayback((s) => s.playTracks)
  const [state, setState] = useState<'idle' | 'busy' | 'failed'>('idle')
  async function play() {
    setState('busy')
    try {
      playTracks(await songsOf(a.id))
      setState('idle')
    } catch {
      setState('failed')
    }
  }
  return (
    <li className="card">
      <Link to={href('albums', a.id)}>
        <Cover id={a.coverArt} size={300} />
        <span className="card__title">{a.name}</span>
        <span className="card__meta">{[a.artist, a.year].filter(Boolean).join(' · ')}</span>
        {showAdded && formatDate(a.created) && <span className="card__meta">Added {formatDate(a.created)}</span>}
      </Link>
      <div className="card__actions">
        <StarButton target={{ kind: 'album', item: a }} name={a.name} starred={starred} />
        <button type="button" className="card__play" aria-label={`Play ${a.name}`} disabled={state === 'busy'} onClick={() => void play()}>
          <Icon name="play" size={20} />
        </button>
      </div>
      {state === 'failed' && <span role="alert" className="card__meta">Couldn’t load this album.</span>}
    </li>
  )
}

/** `showAdded`: add an "Added <date>" line (for Recently Added). */
export function AlbumGrid({ albums, label = 'Albums', showAdded = false }: { albums: Album[]; label?: string; showAdded?: boolean }) {
  const ids = useStarred()
  return (
    <Grid label={label}>
      {albums.map((a) => (
        <AlbumCard key={a.id} album={a} showAdded={showAdded} starred={isStarred(ids, 'album', a.id)} />
      ))}
    </Grid>
  )
}

/** Play / Shuffle / Add to queue for a loaded list of tracks. */
export function PlayActions({ songs }: { songs: Song[] }) {
  // Actions are selected one by one: `(s) => s` would re-render this on every playhead tick.
  const playTracks = usePlayback((s) => s.playTracks)
  const shufflePlay = usePlayback((s) => s.shufflePlay)
  const addToQueue = usePlayback((s) => s.addToQueue)
  return <PlayButtons disabled={!songs.length} onPlay={() => playTracks(songs)} onShuffle={() => shufflePlay(songs)} onAdd={() => addToQueue(songs)} />
}

/** Same actions for an artist: gathers every album's tracks first (one request per album, cached). */
export function ArtistActions({ albums }: { albums: Album[] }) {
  const songsOf = useAlbumSongs()
  const playTracks = usePlayback((s) => s.playTracks)
  const shufflePlay = usePlayback((s) => s.shufflePlay)
  const addToQueue = usePlayback((s) => s.addToQueue)
  const [failed, setFailed] = useState(false)
  const run = (act: (songs: Song[]) => void) => async () => {
    setFailed(false)
    try {
      act((await Promise.all(albums.map((a) => songsOf(a.id)))).flat())
    } catch {
      setFailed(true)
    }
  }
  return (
    <>
      <PlayButtons disabled={!albums.length} onPlay={run((s) => playTracks(s))} onShuffle={run(shufflePlay)} onAdd={run(addToQueue)} />
      {failed && <p role="alert">Couldn’t load this artist’s tracks.</p>}
    </>
  )
}

function PlayButtons({ disabled, onPlay, onShuffle, onAdd }: { disabled: boolean; onPlay: () => void; onShuffle: () => void; onAdd: () => void }) {
  return (
    <div className="actions">
      <button type="button" className="btn btn--primary" disabled={disabled} onClick={onPlay}>
        Play
      </button>
      <button type="button" className="btn" disabled={disabled} onClick={onShuffle}>
        Shuffle
      </button>
      <button type="button" className="btn" disabled={disabled} onClick={onAdd}>
        Add to queue
      </button>
    </div>
  )
}

const ROW = 56

/** `after`: controls that sit beside the row; they must stay outside the link, so the row wraps it. */
function Row({ lead, to, title, sub, end, after }: { lead: ReactNode; to?: string; title: string; sub?: string; end?: string; after?: ReactNode }) {
  const body = (
    <>
      <span className="row__lead">{lead}</span>
      <span className="row__text">
        <span className="row__title">{title}</span>
        {sub && <span className="row__sub">{sub}</span>}
      </span>
      {end && <span className="row__end">{end}</span>}
    </>
  )
  if (!to) return <div className="row">{body}</div>
  const link = (
    <Link className="row" to={to}>
      {body}
    </Link>
  )
  return after ? (
    <div className="row-split">
      {link}
      {after}
    </div>
  ) : (
    link
  )
}

export function ArtistList({ artists }: { artists: Artist[] }) {
  const ids = useStarred()
  return (
    <div className="list-panel">
      <VirtualList
        count={artists.length}
        rowHeight={ROW}
        label="Artists"
        renderRow={(i) => {
          const a = artists[i]!
          return (
            <Row
              lead={<Cover id={a.coverArt} size={96} />}
              to={href('artists', a.id)}
              title={a.name}
              end={`${a.albumCount} ${a.albumCount === 1 ? 'album' : 'albums'}`}
              after={<StarButton target={{ kind: 'artist', item: a }} name={a.name} starred={isStarred(ids, 'artist', a.id)} />}
            />
          )
        }}
      />
    </div>
  )
}

export function PlaylistList({ playlists }: { playlists: Playlist[] }) {
  return (
    <div className="list-panel">
      <VirtualList
        count={playlists.length}
        rowHeight={ROW}
        label="Playlists"
        renderRow={(i) => {
          const p = playlists[i]!
          return (
            <Row
              lead={<Cover id={p.coverArt} size={96} />}
              to={href('playlists', p.id)}
              title={p.name}
              sub={p.owner}
              end={`${p.songCount} tracks`}
            />
          )
        }}
      />
    </div>
  )
}

/** `numbered`: album context, so show the track number instead of art and omit the album name. Clicking a row plays the list from there. */
/** `inPlaylist`: the playlist these tracks belong to, which adds "Remove from this playlist" to the menu. */
export function TrackList({ songs, numbered = false, label = 'Tracks', inPlaylist }: { songs: Song[]; numbered?: boolean; label?: string; inPlaylist?: string }) {
  const playTracks = usePlayback((s) => s.playTracks)
  const currentId = usePlayback((s) => currentEntry(s.queue)?.track.id)
  // One starred lookup and one open menu for the whole list, not one per row.
  const ids = useStarred()
  const [menuFor, setMenuFor] = useState<{ song: Song; index: number } | null>(null)
  return (
    <div className="list-panel">
      <VirtualList
        count={songs.length}
        rowHeight={ROW}
        label={label}
        renderRow={(i) => {
          const s = songs[i]!
          const current = s.id === currentId
          return (
            <div className={current ? 'row row--current' : 'row'}>
              <button type="button" className="row__play" aria-label={`Play ${s.title}`} aria-current={current ? 'true' : undefined} onClick={() => playTracks(songs, i)}>
                <span className="row__lead">{numbered ? <span className="row__num">{s.track ?? i + 1}</span> : <Cover id={s.coverArt} size={96} />}</span>
                <span className="row__text">
                  <span className="row__title">{s.title}</span>
                  <span className="row__sub">{numbered ? s.artist : [s.artist, s.album].filter(Boolean).join(' · ')}</span>
                </span>
              </button>
              <span className="row__end">{formatDuration(s.duration)}</span>
              <StarButton target={{ kind: 'song', item: s }} name={s.title} starred={isStarred(ids, 'song', s.id)} />
              <button type="button" className="icon-btn" aria-label={`More actions for ${s.title}`} title="More" onClick={() => setMenuFor({ song: s, index: i })}>
                <Icon name="more" size={20} />
              </button>
            </div>
          )
        }}
      />
      {menuFor && (
        <TrackActions
          song={menuFor.song}
          index={menuFor.index}
          inPlaylist={inPlaylist}
          starred={isStarred(ids, 'song', menuFor.song.id)}
          onClose={() => setMenuFor(null)}
        />
      )}
    </div>
  )
}
