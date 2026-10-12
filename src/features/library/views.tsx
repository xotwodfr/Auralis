import type { ReactNode } from 'react'
import { Link, useParams } from 'react-router'
import { getAlbum, getAlbumList2, getArtist, getArtists, getPlaylist, getPlaylists, getStarred2, type AlbumListType } from '../../api/subsonic/endpoints'
import { formatDuration } from '../../lib/format'
import { EmptyState } from '../../ui/State'
import { AlbumGrid, ArtistActions, ArtistList, Boundary, Header, LoadMore, Page, PlayActions, PlaylistList, TrackList } from './components'
import { useLibraryQuery, usePagedQuery } from './queries'

const ALBUM_PAGE = 60

export function Artists() {
  const q = useLibraryQuery(['artists'], getArtists)
  return (
    <Page title="Artists">
      <Boundary q={q}>
        {q.data?.length ? <ArtistList artists={q.data} /> : <EmptyState title="No artists yet" hint="Add music to your server and run a scan." />}
      </Boundary>
    </Page>
  )
}

function AlbumPages({ title, type, hint, showAdded = false }: { title: string; type: AlbumListType; hint: string; showAdded?: boolean }) {
  const q = usePagedQuery(['albums', type], ALBUM_PAGE, (c, offset, signal) =>
    getAlbumList2(c, { type, size: ALBUM_PAGE, offset }, signal),
  )
  const albums = q.data?.pages.flat() ?? []
  return (
    <Page title={title}>
      <Boundary q={q}>
        {albums.length ? (
          <>
            <AlbumGrid albums={albums} label={title} showAdded={showAdded} />
            <LoadMore q={q} />
          </>
        ) : (
          <EmptyState title={`No ${title.toLowerCase()} yet`} hint={hint} />
        )}
      </Boundary>
    </Page>
  )
}

export const Albums = () => <AlbumPages title="Albums" type="alphabeticalByName" hint="Add music to your server and run a scan." />
// `newest` = most recently added to the library (Subsonic spec), unlike `recent` = recently played.
export const RecentlyAdded = () => (
  <AlbumPages title="Recently Added" type="newest" hint="Newly added albums will show up here." showAdded />
)
export const Recent = () => <AlbumPages title="Recent" type="recent" hint="Albums you play will show up here." />

export function Playlists() {
  const q = useLibraryQuery(['playlists'], getPlaylists)
  return (
    <Page title="Playlists">
      <Boundary q={q}>
        {q.data?.length ? <PlaylistList playlists={q.data} /> : <EmptyState title="No playlists yet" hint="Create a playlist in Navidrome." />}
      </Boundary>
    </Page>
  )
}

export function Favorites() {
  const q = useLibraryQuery(['starred'], getStarred2)
  const { artists = [], albums = [], songs = [] } = q.data ?? {}
  return (
    <Page title="Favorites">
      <Boundary q={q}>
        {artists.length + albums.length + songs.length === 0 ? (
          <EmptyState title="No favorites yet" hint="Star artists, albums or tracks to see them here." />
        ) : (
          <>
            {artists.length > 0 && <Section title="Artists"><ArtistList artists={artists} /></Section>}
            {albums.length > 0 && <Section title="Albums"><AlbumGrid albums={albums} label="Favorite albums" /></Section>}
            {songs.length > 0 && <Section title="Tracks"><TrackList songs={songs} label="Favorite tracks" /></Section>}
          </>
        )}
      </Boundary>
    </Page>
  )
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="section">
      <h2 className="section__title">{title}</h2>
      {children}
    </section>
  )
}

export function ArtistDetail() {
  const id = useParams().id!
  const q = useLibraryQuery(['artist', id], (c, s) => getArtist(c, id, s))
  return (
    <Boundary q={q}>
      {q.data && (
        <>
          <Header cover={q.data.artist.coverArt} title={q.data.artist.name} meta={`${q.data.albums.length} albums`}
            star={{ kind: 'artist', item: q.data.artist }}
            actions={<ArtistActions albums={q.data.albums} />}
          />
          {q.data.albums.length ? <AlbumGrid albums={q.data.albums} /> : <EmptyState title="No albums for this artist" />}
        </>
      )}
    </Boundary>
  )
}

export function AlbumDetail() {
  const id = useParams().id!
  const q = useLibraryQuery(['album', id], (c, s) => getAlbum(c, id, s))
  const a = q.data?.album
  return (
    <Boundary q={q}>
      {a && q.data && (
        <>
          <Header
            cover={a.coverArt}
            title={a.name}
            meta={[a.year, `${a.songCount} tracks`, formatDuration(a.duration)].filter(Boolean).join(' · ')}
            star={{ kind: 'album', item: a }}
            actions={<PlayActions songs={q.data.songs} />}
          >
            {a.artistId ? <Link to={`/library/artists/${encodeURIComponent(a.artistId)}`}>{a.artist}</Link> : <p>{a.artist}</p>}
          </Header>
          {q.data.songs.length ? <TrackList songs={q.data.songs} numbered /> : <EmptyState title="No tracks on this album" />}
        </>
      )}
    </Boundary>
  )
}

export function PlaylistDetail() {
  const id = useParams().id!
  const q = useLibraryQuery(['playlist', id], (c, s) => getPlaylist(c, id, s))
  return (
    <Boundary q={q}>
      {q.data && (
        <>
          <Header
            cover={q.data.playlist.coverArt}
            title={q.data.playlist.name}
            meta={`${q.data.playlist.songCount} tracks · ${formatDuration(q.data.playlist.duration)}`}
            actions={<PlayActions songs={q.data.songs} />}
          />
          {q.data.songs.length ? <TrackList songs={q.data.songs} inPlaylist={q.data.playlist.id} /> : <EmptyState title="This playlist is empty" />}
        </>
      )}
    </Boundary>
  )
}
