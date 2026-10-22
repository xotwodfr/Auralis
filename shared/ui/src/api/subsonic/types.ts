export interface Credentials {
  baseUrl: string
  username: string
  password: string
}

export interface ResponseBody {
  status: 'ok' | 'failed'
  version: string
  type?: string
  serverVersion?: string
  openSubsonic?: boolean
  error?: { code: number; message?: string }
}

export interface SubsonicResponse<T extends object = object> {
  'subsonic-response': ResponseBody & T
}

export interface OpenSubsonicExtension {
  name: string
  versions: number[]
}

export interface Capabilities {
  openSubsonic: boolean
  extensions: OpenSubsonicExtension[]
  /** `getLyricsBySongId` is available. */
  songLyrics: boolean
}

export interface ServerInfo {
  apiVersion: string
  type?: string
  serverVersion?: string
}

export interface Session {
  credentials: Credentials
  server: ServerInfo
  capabilities: Capabilities
  /** Credentials are persisted on this device. */
  remember: boolean
}

// Library models. IDs are opaque strings (API.md "ID handling").
export interface Artist {
  id: string
  name: string
  albumCount: number
  coverArt?: string
  /** The signed-in user has starred this. */
  starred?: boolean
}

export interface Album {
  id: string
  name: string
  artist: string
  artistId?: string
  coverArt?: string
  songCount: number
  /** Seconds. */
  duration: number
  year?: number
  /** ISO timestamp the album was added to the library. */
  created?: string
  /** The signed-in user has starred this. */
  starred?: boolean
}

export interface Song {
  id: string
  title: string
  album: string
  albumId?: string
  artist: string
  artistId?: string
  track?: number
  discNumber?: number
  /** Seconds. */
  duration: number
  coverArt?: string
  /** OpenSubsonic: the recording's ISRC(s), when the files are tagged. */
  isrc?: string[]
  /** OpenSubsonic `explicitStatus`; absent when unknown. */
  explicit?: boolean
  /** The signed-in user has starred this. */
  starred?: boolean
}

export interface Playlist {
  id: string
  name: string
  songCount: number
  duration: number
  coverArt?: string
  owner?: string
}

export interface SearchResults {
  artists: Artist[]
  albums: Album[]
  songs: Song[]
}

export interface StructuredLyrics {
  lang?: string
  synced: boolean
  /** Milliseconds; positive shows lyrics sooner. */
  offset?: number
  line: { start?: number; value: string }[]
}

/** One `getNowPlaying` entry: someone on this server and the track their player last reported. */
export interface NowPlayingEntry {
  username: string
  /** Minutes since that player reported the track. */
  minutesAgo: number
  playerName?: string
  /** Only some servers say so (Navidrome's `state`); absent means "not known to be paused". */
  paused: boolean
  song: Song
}
