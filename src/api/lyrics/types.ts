/** One word or syllable with its own timing (seconds from track start). */
export interface LyricWord {
  text: string
  start: number
  end: number
  /** Syllable of a longer word: no space before the next piece. */
  joinNext?: boolean
}

export interface LyricLine {
  /** Seconds from track start; null for unsynchronized lines. */
  time: number | null
  text: string
  /** Word/syllable timings, when the source has them. `text` is always the plain joined form. */
  words?: LyricWord[]
  /** Background/backing vocals sung alongside this line. */
  background?: { text: string; words?: LyricWord[] }[]
  /** Sung by the second voice (duets). */
  opposite?: boolean
}

export interface Credit {
  role: 'Uploader' | 'Maker'
  name: string
  /** http(s) only. */
  url?: string
}

export interface Attribution {
  /** Who answered, as the API reports it ("Apple Music", "Spicy Lyrics", …). */
  provider: string
  credits: Credit[]
}

export interface Lyrics {
  synced: boolean
  source: 'server' | 'lrclib' | 'spicy'
  /** Required by the Spicy Lyrics terms wherever its lyrics are shown. */
  attribution?: Attribution
  lines: LyricLine[]
  /** LRCLIB flags instrumental tracks; there are no lines to show. */
  instrumental?: boolean
}

/** What a provider needs to know about the playing track. */
export interface LyricsTrack {
  id: string
  title: string
  artist: string
  album: string
  /** Seconds. */
  duration: number
  /** Recording ISRC(s) from the library's tags, when known. */
  isrc?: string[]
  /** Explicit (true) or clean (false) release; absent when the library doesn't say. */
  explicit?: boolean
}

export interface LyricsProvider {
  id: Lyrics['source']
  /** Resolves null when this provider has nothing; throws LyricsError on failure. */
  fetch(track: LyricsTrack, signal: AbortSignal): Promise<Lyrics | null>
}

export type LyricsErrorKind = 'timeout' | 'network' | 'rate-limited' | 'auth' | 'unavailable' | 'aborted'

export class LyricsError extends Error {
  constructor(
    readonly kind: LyricsErrorKind,
    message: string,
  ) {
    super(message)
    this.name = 'LyricsError'
  }
}
