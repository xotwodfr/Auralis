export interface SpotifySearchOptions {
  clientId?: string
  clientSecret?: string
  market?: string
  apiBase?: string
  tokenUrl?: string
  fetchImpl?: typeof fetch
  now?: () => number
  log?: (msg: string) => void
}
export interface SpotifySearch {
  enabled: boolean
  search(t: { title: string; artist: string; isrc?: string }): Promise<{ status: number; body: string; retryAfter?: number }>
}
export function createSpotifySearch(options?: SpotifySearchOptions): SpotifySearch
