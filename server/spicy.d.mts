import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SpotifySearch } from './spotify.mjs'

export const TRACK_ID: RegExp
export interface SpicyOptions {
  secretKey?: string
  apiBase?: string
  allowedOrigins?: string[]
  ratePerMinute?: number
  trustProxy?: boolean
  fetchImpl?: typeof fetch
  now?: () => number
  log?: (msg: string) => void
  spotify?: SpotifySearch
}
export type SpicyHandler = ((req: IncomingMessage, res: ServerResponse) => Promise<boolean>) & { enabled: boolean; matching: boolean }
export function createSpicyHandler(options?: SpicyOptions): SpicyHandler
export function spicyHandlerFromEnv(env: Record<string, string | undefined>): SpicyHandler
