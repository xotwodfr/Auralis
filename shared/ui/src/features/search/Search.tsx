import { useSearchParams } from 'react-router'
import { search3 } from '../../api/subsonic/endpoints'
import { EmptyState } from '../../ui/State'
import { AlbumGrid, ArtistList, Boundary, Page, TrackList } from '../library/components'
import { useLibraryQuery } from '../library/queries'
import { Section } from '../library/views'

export default function Search() {
  const query = (useSearchParams()[0].get('q') ?? '').trim()
  // shortcut: one capped page per type (no pagination); add "show more" if users hit the caps.
  const q = useLibraryQuery(
    ['search', query],
    (c, s) => search3(c, { query, artistCount: 10, albumCount: 20, songCount: 50 }, s),
    query !== '',
  )
  if (!query) {
    return (
      <Page title="Search">
        <EmptyState title="Search your library" hint="Type an artist, album or track name in the search box." />
      </Page>
    )
  }
  const { artists = [], albums = [], songs = [] } = q.data ?? {}
  return (
    <Page title={`Results for “${query}”`}>
      <Boundary q={q}>
        {artists.length + albums.length + songs.length === 0 ? (
          <EmptyState title={`No results for “${query}”`} hint="Check the spelling or try a shorter search." />
        ) : (
          <>
            {artists.length > 0 && <Section title="Artists"><ArtistList artists={artists} /></Section>}
            {albums.length > 0 && <Section title="Albums"><AlbumGrid albums={albums} label="Album results" /></Section>}
            {songs.length > 0 && <Section title="Tracks"><TrackList songs={songs} label="Track results" /></Section>}
          </>
        )}
      </Boundary>
    </Page>
  )
}
