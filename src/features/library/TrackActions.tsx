import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { addToPlaylist, createPlaylist, getPlaylists, removeFromPlaylist } from '../../api/subsonic/endpoints'
import type { Song } from '../../api/subsonic/types'
import { useAuth } from '../../state/auth'
import { usePlayback } from '../../state/playback'
import { toast } from '../../state/toast'
import { Dialog } from '../../ui/Dialog'
import { Icon, type IconName } from '../../ui/Icon'
import { connectErrorMessage } from '../connect/errorMessage'
import { useLibraryQuery } from './queries'
import { useToggleStar } from './starred'

function Action({ icon, label, onClick, autofocus }: { icon: IconName; label: string; onClick: () => void; autofocus?: boolean }) {
  return (
    <button type="button" className="menu__item" data-autofocus={autofocus || undefined} onClick={onClick}>
      <Icon name={icon} size={20} />
      {label}
    </button>
  )
}

/** Second step of "Add to playlist": the user's playlists, plus creating one from this track. */
function PlaylistPicker({ song, onDone }: { song: Song; onDone: () => void }) {
  const credentials = useAuth((s) => s.session?.credentials)
  const queryClient = useQueryClient()
  const playlists = useLibraryQuery(['playlists'], getPlaylists)
  const [name, setName] = useState('')
  // The button that opened this step just unmounted: without this, focus falls to <body> and Escape stops working.
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => root.current?.focus(), [])

  const add = useMutation({
    mutationFn: async (target: { id?: string; name: string }) => {
      if (!credentials) throw new Error('signed out')
      if (target.id) await addToPlaylist(credentials, target.id, [song.id])
      else await createPlaylist(credentials, target.name, [song.id])
    },
    onSuccess: (_d, target) => {
      void queryClient.invalidateQueries({ queryKey: [credentials?.baseUrl, credentials?.username, 'playlists'] })
      if (target.id) void queryClient.invalidateQueries({ queryKey: [credentials?.baseUrl, credentials?.username, 'playlist', target.id] })
      toast.info(`Added “${song.title}” to “${target.name}”.`)
      onDone()
    },
  })

  return (
    <div ref={root} tabIndex={-1}>
      {add.isError && (
        <p className="dialog__body" role="alert">
          {connectErrorMessage(add.error)}
        </p>
      )}
      {playlists.isPending ? (
        <p className="dialog__body">Loading your playlists…</p>
      ) : playlists.isError ? (
        <p className="dialog__body" role="alert">
          {connectErrorMessage(playlists.error)}
        </p>
      ) : (
        <div className="menu" role="group" aria-label="Your playlists">
          {playlists.data?.length === 0 && <p className="dialog__body">You have no playlists yet. Make one below.</p>}
          {playlists.data?.map((p) => (
            <Action key={p.id} icon="playlist" label={p.name} onClick={() => add.mutate({ id: p.id, name: p.name })} />
          ))}
        </div>
      )}
      <form
        className="menu__new"
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim()) add.mutate({ name: name.trim() })
        }}
      >
        <label className="field">
          New playlist
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" autoComplete="off" />
        </label>
        <button type="submit" className="btn btn--primary" disabled={!name.trim() || add.isPending}>
          {add.isPending ? 'Saving…' : 'Create'}
        </button>
      </form>
    </div>
  )
}

/** Every action for one track, in one place: the rows stay down to a heart and a "More" button. */
export function TrackActions({ song, index, starred, inPlaylist, onClose }: { song: Song; index: number; starred: boolean; inPlaylist?: string; onClose: () => void }) {
  const navigate = useNavigate()
  const credentials = useAuth((s) => s.session?.credentials)
  const queryClient = useQueryClient()
  const addNext = usePlayback((s) => s.addNext)
  const addToQueue = usePlayback((s) => s.addToQueue)
  const toggleStar = useToggleStar()
  const [picking, setPicking] = useState(false)

  async function removeHere() {
    onClose()
    if (!credentials || !inPlaylist) return
    try {
      await removeFromPlaylist(credentials, inPlaylist, [index])
      await queryClient.invalidateQueries({ queryKey: [credentials.baseUrl, credentials.username, 'playlist', inPlaylist] })
      void queryClient.invalidateQueries({ queryKey: [credentials.baseUrl, credentials.username, 'playlists'] })
      toast.info(`Removed “${song.title}” from the playlist.`)
    } catch (e) {
      toast.error(connectErrorMessage(e))
    }
  }

  const go = (to: string) => {
    onClose()
    void navigate(to)
  }
  const run = (fn: () => void) => () => {
    fn()
    onClose()
  }

  return (
    <Dialog title={picking ? `Add “${song.title}” to…` : song.title} onClose={onClose}>
      {picking ? (
        <PlaylistPicker song={song} onDone={onClose} />
      ) : (
        <>
          <p className="dialog__body">{[song.artist, song.album].filter(Boolean).join(' · ')}</p>
          <div className="menu" role="group" aria-label={`Actions for ${song.title}`}>
            <Action icon="play-next" label="Play next" autofocus onClick={run(() => addNext([song]))} />
            <Action icon="plus" label="Add to queue" onClick={run(() => addToQueue([song]))} />
            <Action icon="playlist-add" label="Add to playlist…" onClick={() => setPicking(true)} />
            <Action
              icon={starred ? 'heart-fill' : 'heart'}
              label={starred ? 'Remove from favorites' : 'Add to favorites'}
              onClick={run(() => void toggleStar({ kind: 'song', item: song }))}
            />
            {song.albumId && <Action icon="album" label="Go to album" onClick={() => go(`/library/albums/${encodeURIComponent(song.albumId!)}`)} />}
            {song.artistId && <Action icon="artist" label="Go to artist" onClick={() => go(`/library/artists/${encodeURIComponent(song.artistId!)}`)} />}
            {inPlaylist && <Action icon="trash" label="Remove from this playlist" onClick={() => void removeHere()} />}
          </div>
        </>
      )}
    </Dialog>
  )
}
