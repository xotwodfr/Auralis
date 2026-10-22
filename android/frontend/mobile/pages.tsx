import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { Link, Outlet, useParams, useSearchParams } from 'react-router'
import { getAlbum, getAlbumList2, getArtist, getArtists, getPlaylist, getPlaylists, getStarred2, search3, type AlbumListType } from '@auralis/ui/api/subsonic/endpoints'
import { Boundary, Cover, useAlbumSongs } from '@auralis/ui/features/library/components'
import { useLibraryQuery, usePagedQuery } from '@auralis/ui/features/library/queries'
import { Profile, SocialTabs } from '@auralis/ui/features/social/Social'
import { formatDuration } from '@auralis/ui/lib/format'
import { useAuth } from '@auralis/ui/state/auth'
import { Icon } from '@auralis/ui/ui/Icon'
import { EmptyState } from '@auralis/ui/ui/State'
import { markArt } from './transitions'
import { ActionBar, AutoLoad, BackButton, Hero, LikedArt, MediaRow, Shelf, SongRows, Tile } from './parts'

const href = (kind: string, id: string) => `/library/${kind}/${encodeURIComponent(id)}`
const SHELF_SIZE = 16
const PAGE = 60

function greeting(hour = new Date().getHours()) {
  return hour < 5 ? 'Good night' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'
}

/** Top-left on every tab's page: opens Social. */
function SocialLink() {
  return (
    <Link to="/social" className="m-round m-round--plain m-social" aria-label="Social">
      <Icon name="people" size={24} />
    </Link>
  )
}

function SettingsLink() {
  return (
    <Link to="/settings" className="m-round m-round--plain" aria-label="Settings">
      <Icon name="settings" size={22} />
    </Link>
  )
}

function useAlbumShelf(type: AlbumListType) {
  return useLibraryQuery(['albums', type, 'shelf'], (c, s) => getAlbumList2(c, { type, size: SHELF_SIZE, offset: 0 }, s))
}

function AlbumShelf({ title, type }: { title: string; type: AlbumListType }) {
  const q = useAlbumShelf(type)
  if (!q.data?.length) return null
  return (
    <Shelf title={title}>
      {q.data.map((a) => (
        <Tile key={a.id} to={href('albums', a.id)} cover={a.coverArt} title={a.name} sub={a.artist} />
      ))}
    </Shelf>
  )
}

export function Home() {
  const recent = useAlbumShelf('recent')
  const newest = useAlbumShelf('newest')
  const playlists = useLibraryQuery(['playlists'], getPlaylists)
  // Quick-access grid: what was played lately, topped up with new additions on a fresh library.
  const quick = [...(recent.data ?? []), ...(newest.data ?? [])].filter((a, i, all) => all.findIndex((b) => b.id === a.id) === i).slice(0, 6)
  return (
    <div className="m-page m-page--home">
      <header className="m-top">
        <SocialLink />
        <h1 className="m-h1">{greeting()}</h1>
        <SettingsLink />
      </header>
      <Boundary q={recent}>
        {quick.length === 0 && !newest.isPending ? (
          <EmptyState title="Your library is empty" hint="Add music to your server and run a scan." />
        ) : (
          <ul className="m-quick">
            <li>
              <Link to="/library/favorites" className="m-quick__item">
                <span className="m-quick__art">
                  <LikedArt />
                </span>
                <span>Liked Songs</span>
              </Link>
            </li>
            {quick.slice(0, 5).map((a) => (
              <li key={a.id}>
                <Link to={href('albums', a.id)} className="m-quick__item" onClick={(e) => markArt(e.target)}>
                  <span className="m-quick__art">
                    <Cover id={a.coverArt} size={128} />
                  </span>
                  <span>{a.name}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Boundary>
      <AlbumShelf title="Recently played" type="recent" />
      <AlbumShelf title="New in your library" type="newest" />
      {!!playlists.data?.length && (
        <Shelf title="Your playlists">
          {playlists.data.map((p) => (
            <Tile key={p.id} to={href('playlists', p.id)} cover={p.coverArt} title={p.name} sub={`${p.songCount} songs`} />
          ))}
        </Shelf>
      )}
      <AlbumShelf title="Your top albums" type="frequent" />
      <AlbumShelf title="Something different" type="random" />
    </div>
  )
}

const BROWSE: { to: string; label: string }[] = [
  { to: '/browse/newest', label: 'New in your library' },
  { to: '/browse/recent', label: 'Recently played' },
  { to: '/browse/frequent', label: 'Most played' },
  { to: '/browse/random', label: 'Discover' },
  { to: '/browse/alphabeticalByName', label: 'Albums A–Z' },
  { to: '/library?view=artists', label: 'Artists' },
  { to: '/library/favorites', label: 'Liked Songs' },
  { to: '/library?view=playlists', label: 'Playlists' },
]

const DEBOUNCE_MS = 300

export function SearchPage() {
  const [params, setParams] = useSearchParams()
  const query = (params.get('q') ?? '').trim()
  const [value, setValue] = useState(params.get('q') ?? '')
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])

  function onChange(e: ChangeEvent<HTMLInputElement>) {
    const text = e.target.value
    setValue(text)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setParams(text.trim() ? { q: text.trim() } : {}, { replace: true }), DEBOUNCE_MS)
  }

  return (
    <div className="m-page">
      <header className="m-top">
        <SocialLink />
        <h1 className="m-h1">Search</h1>
        <SettingsLink />
      </header>
      <form role="search" className="m-search" onSubmit={(e) => e.preventDefault()}>
        <Icon name="search" size={22} />
        <input type="search" aria-label="Search library" placeholder="What do you want to listen to?" autoComplete="off" value={value} onChange={onChange} />
      </form>
      {query ? (
        <SearchResults query={query} />
      ) : (
        <>
          <h2 className="m-h2">Browse all</h2>
          <ul className="m-browse">
            {BROWSE.map((b) => (
              <li key={b.to}>
                <Link to={b.to} className="m-browse__tile">
                  {b.label}
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

function SearchResults({ query }: { query: string }) {
  // shortcut: one capped page per type (no pagination), same caps as the web search.
  const q = useLibraryQuery(['search', query], (c, s) => search3(c, { query, artistCount: 10, albumCount: 20, songCount: 50 }, s))
  const { artists = [], albums = [], songs = [] } = q.data ?? {}
  return (
    <Boundary q={q}>
      {artists.length + albums.length + songs.length === 0 ? (
        <EmptyState title={`No results for “${query}”`} hint="Check the spelling or try a shorter search." />
      ) : (
        <>
          {songs.length > 0 && (
            <section className="m-section">
              <h2 className="m-h2">Songs</h2>
              <SongRows songs={songs} />
            </section>
          )}
          {artists.length > 0 && (
            <section className="m-section">
              <h2 className="m-h2">Artists</h2>
              <ul className="m-rows">
                {artists.map((a) => (
                  <MediaRow key={a.id} to={href('artists', a.id)} cover={a.coverArt} title={a.name} sub="Artist" round />
                ))}
              </ul>
            </section>
          )}
          {albums.length > 0 && (
            <section className="m-section">
              <h2 className="m-h2">Albums</h2>
              <ul className="m-rows">
                {albums.map((a) => (
                  <MediaRow key={a.id} to={href('albums', a.id)} cover={a.coverArt} title={a.name} sub={['Album', a.artist].filter(Boolean).join(' • ')} />
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </Boundary>
  )
}

type View = 'playlists' | 'albums' | 'artists'
const VIEWS: { value: View; label: string }[] = [
  { value: 'playlists', label: 'Playlists' },
  { value: 'albums', label: 'Albums' },
  { value: 'artists', label: 'Artists' },
]

export function Library() {
  const [params, setParams] = useSearchParams()
  const view = (VIEWS.find((v) => v.value === params.get('view'))?.value ?? 'playlists') as View
  const user = useAuth((s) => s.session?.credentials.username)
  return (
    <div className="m-page">
      <header className="m-top m-top--sticky">
        <SocialLink />
        <h1 className="m-h1">Your Library</h1>
        <Link to="/settings" className="m-avatar" aria-label="Settings">
          {(user ?? '?').slice(0, 1).toUpperCase()}
        </Link>
      </header>
      <div className="m-chips" role="group" aria-label="Show">
        {VIEWS.map((v) => (
          <button key={v.value} type="button" className="m-chip" aria-pressed={view === v.value} onClick={() => setParams({ view: v.value }, { replace: true })}>
            {v.label}
          </button>
        ))}
      </div>
      <ul className="m-rows">
        <MediaRow to="/library/favorites" title="Liked Songs" sub="Playlist • Your favorites" art={<LikedArt />} />
        {view === 'playlists' && <PlaylistRows />}
        {view === 'albums' && <AlbumRows />}
        {view === 'artists' && <ArtistRows />}
      </ul>
    </div>
  )
}

function PlaylistRows() {
  const q = useLibraryQuery(['playlists'], getPlaylists)
  return (
    <Boundary q={q}>
      {q.data?.map((p) => (
        <MediaRow key={p.id} to={href('playlists', p.id)} cover={p.coverArt} title={p.name} sub={['Playlist', p.owner].filter(Boolean).join(' • ')} />
      ))}
    </Boundary>
  )
}

function AlbumRows() {
  const q = usePagedQuery(['albums', 'alphabeticalByName'], PAGE, (c, offset, signal) => getAlbumList2(c, { type: 'alphabeticalByName', size: PAGE, offset }, signal))
  return (
    <Boundary q={q}>
      {q.data?.pages.flat().map((a) => (
        <MediaRow key={a.id} to={href('albums', a.id)} cover={a.coverArt} title={a.name} sub={['Album', a.artist].filter(Boolean).join(' • ')} />
      ))}
      <li>
        <AutoLoad q={q} />
      </li>
    </Boundary>
  )
}

function ArtistRows() {
  const q = useLibraryQuery(['artists'], getArtists)
  return (
    <Boundary q={q}>
      {q.data?.map((a) => (
        <MediaRow key={a.id} to={href('artists', a.id)} cover={a.coverArt} title={a.name} sub="Artist" round />
      ))}
    </Boundary>
  )
}

const BROWSE_TITLES: Partial<Record<AlbumListType, string>> = {
  newest: 'New in your library',
  recent: 'Recently played',
  frequent: 'Most played',
  random: 'Discover',
  alphabeticalByName: 'Albums A–Z',
}

export function BrowsePage() {
  const type = useParams().type as AlbumListType
  const title = BROWSE_TITLES[type] ?? 'Albums'
  const q = usePagedQuery(['albums', type], PAGE, (c, offset, signal) => getAlbumList2(c, { type, size: PAGE, offset }, signal))
  const albums = q.data?.pages.flat() ?? []
  return (
    <div className="m-page">
      <header className="m-top m-top--sticky">
        <BackButton />
        <h1 className="m-h1 m-h1--small">{title}</h1>
      </header>
      <Boundary q={q}>
        {albums.length ? (
          <>
            <ul className="m-grid">
              {albums.map((a) => (
                <Tile key={a.id} to={href('albums', a.id)} cover={a.coverArt} title={a.name} sub={a.artist} />
              ))}
            </ul>
            <AutoLoad q={q} />
          </>
        ) : (
          <EmptyState title="Nothing here yet" hint="Albums will show up here as you add and play music." />
        )}
      </Boundary>
    </div>
  )
}

export function AlbumPage() {
  const id = useParams().id!
  const q = useLibraryQuery(['album', id], (c, s) => getAlbum(c, id, s))
  const a = q.data?.album
  return (
    <div className="m-page m-page--hero">
      <Boundary q={q}>
        {a && q.data && (
          <>
            <Hero cover={a.coverArt} title={a.name}>
              <p className="m-hero__by">
                {a.artistId ? <Link to={href('artists', a.artistId)}>{a.artist}</Link> : a.artist}
              </p>
              <p className="m-hero__meta">{['Album', a.year].filter(Boolean).join(' • ')}</p>
            </Hero>
            <ActionBar star={{ kind: 'album', item: a }} name={a.name} load={() => q.data.songs} disabled={!q.data.songs.length} />
            {q.data.songs.length ? <SongRows songs={q.data.songs} numbered /> : <EmptyState title="No tracks on this album" />}
            <p className="m-foot">{[`${a.songCount} songs`, formatDuration(a.duration)].join(' • ')}</p>
          </>
        )}
      </Boundary>
    </div>
  )
}

export function PlaylistPage() {
  const id = useParams().id!
  const q = useLibraryQuery(['playlist', id], (c, s) => getPlaylist(c, id, s))
  const p = q.data?.playlist
  return (
    <div className="m-page m-page--hero">
      <Boundary q={q}>
        {p && q.data && (
          <>
            <Hero cover={p.coverArt} title={p.name}>
              {p.owner && <p className="m-hero__by">{p.owner}</p>}
              <p className="m-hero__meta">{[`${p.songCount} songs`, formatDuration(p.duration)].join(' • ')}</p>
            </Hero>
            <ActionBar name={p.name} load={() => q.data.songs} disabled={!q.data.songs.length} />
            {q.data.songs.length ? <SongRows songs={q.data.songs} inPlaylist={p.id} /> : <EmptyState title="This playlist is empty" />}
          </>
        )}
      </Boundary>
    </div>
  )
}

export function ArtistPage() {
  const id = useParams().id!
  const q = useLibraryQuery(['artist', id], (c, s) => getArtist(c, id, s))
  const songsOf = useAlbumSongs()
  const data = q.data
  return (
    <div className="m-page m-page--hero">
      <Boundary q={q}>
        {data && (
          <>
            <Hero cover={data.artist.coverArt} title={data.artist.name} round>
              <p className="m-hero__meta">
                {data.albums.length} {data.albums.length === 1 ? 'album' : 'albums'}
              </p>
            </Hero>
            <ActionBar
              star={{ kind: 'artist', item: data.artist }}
              name={data.artist.name}
              disabled={!data.albums.length}
              load={async () => (await Promise.all(data.albums.map((a) => songsOf(a.id)))).flat()}
            />
            <section className="m-section">
              <h2 className="m-h2">Discography</h2>
              {data.albums.length ? (
                <ul className="m-rows">
                  {data.albums.map((a) => (
                    <MediaRow key={a.id} to={href('albums', a.id)} cover={a.coverArt} title={a.name} sub={[a.year, 'Album'].filter(Boolean).join(' • ')} />
                  ))}
                </ul>
              ) : (
                <EmptyState title="No albums for this artist" />
              )}
            </section>
          </>
        )}
      </Boundary>
    </div>
  )
}

export function LikedPage() {
  const q = useLibraryQuery(['starred'], getStarred2)
  const { songs = [], albums = [], artists = [] } = q.data ?? {}
  return (
    <div className="m-page m-page--hero">
      <Boundary q={q}>
        <Hero title="Liked Songs" art={<LikedArt />}>
          <p className="m-hero__meta">{songs.length} songs</p>
        </Hero>
        <ActionBar name="Liked Songs" load={() => songs} disabled={!songs.length} />
        {songs.length ? <SongRows songs={songs} /> : <EmptyState title="Songs you like will appear here" hint="Tap the heart on any song." />}
        {albums.length > 0 && (
          <Shelf title="Liked albums">
            {albums.map((a) => (
              <Tile key={a.id} to={href('albums', a.id)} cover={a.coverArt} title={a.name} sub={a.artist} />
            ))}
          </Shelf>
        )}
        {artists.length > 0 && (
          <Shelf title="Liked artists">
            {artists.map((a) => (
              <Tile key={a.id} to={href('artists', a.id)} cover={a.coverArt} title={a.name} sub="Artist" round />
            ))}
          </Shelf>
        )}
      </Boundary>
    </div>
  )
}

/** Social on the phone: the shared sections under this UI's own page header and chips. */
export function SocialPage() {
  return (
    <div className="m-page social">
      <header className="m-top m-top--sticky">
        <BackButton />
        <h1 className="m-h1">Social</h1>
      </header>
      <SocialTabs />
      <Outlet />
    </div>
  )
}

export function SocialProfilePage() {
  return (
    <div className="m-page social">
      <header className="m-top m-top--sticky">
        <BackButton />
        <h1 className="m-h1">Social</h1>
      </header>
      <Profile />
    </div>
  )
}
