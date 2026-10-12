// Best-effort OS media controls (lock screen, media keys). No-ops where unsupported.

export interface MediaInfo {
  title: string
  artist: string
  album: string
  artwork?: string
}

export interface MediaHandlers {
  play: () => void
  pause: () => void
  next: () => void
  previous: () => void
  seekTo: (seconds: number) => void
}

const session = () => (typeof navigator !== 'undefined' && 'mediaSession' in navigator ? navigator.mediaSession : undefined)

export function setMediaHandlers(h: MediaHandlers): void {
  const s = session()
  if (!s) return
  const set = (action: MediaSessionAction, fn: MediaSessionActionHandler) => {
    try {
      s.setActionHandler(action, fn)
    } catch {
      /* action unsupported by this browser */
    }
  }
  set('play', h.play)
  set('pause', h.pause)
  set('nexttrack', h.next)
  set('previoustrack', h.previous)
  set('seekto', (d) => d.seekTime != null && h.seekTo(d.seekTime))
}

export function setMediaInfo(info: MediaInfo | null, playing: boolean): void {
  const s = session()
  if (!s) return
  s.metadata =
    info && typeof MediaMetadata !== 'undefined'
      ? new MediaMetadata({ title: info.title, artist: info.artist, album: info.album, artwork: info.artwork ? [{ src: info.artwork }] : [] })
      : null
  s.playbackState = info ? (playing ? 'playing' : 'paused') : 'none'
}
