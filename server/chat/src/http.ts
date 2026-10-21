// Small HTTP helpers shared by every route module: typed API errors, client address, sliding-window rate limits.
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { ErrorCode } from '../../../shared/chat-protocol/index.ts'

export class ApiError extends Error {
  readonly status: number
  readonly code: ErrorCode
  readonly retryAfter?: number
  constructor(status: number, code: ErrorCode, message: string, retryAfter?: number) {
    super(message)
    this.status = status
    this.code = code
    this.retryAfter = retryAfter
  }
}

export const notFound = () => new ApiError(404, 'conversation_not_found', 'Conversation not found')
export const badRequest = (message: string) => new ApiError(400, 'bad_request', message)
export const forbidden = (message: string) => new ApiError(403, 'forbidden', message)

/** Socket address, or the proxy-reported client when CHAT_TRUST_PROXY=1 (only allowed with a loopback bind). */
export function clientAddress(req: FastifyRequest, trustProxy: boolean): string {
  // Callers control the start of X-Forwarded-For; only the hop the nearest proxy appended (the last) is trustworthy.
  const forwarded = trustProxy
    ? String(req.headers['cf-connecting-ip'] ?? '').trim() || String(req.headers['x-forwarded-for'] ?? '').split(',').pop()?.trim()
    : ''
  return forwarded || req.socket.remoteAddress || 'unknown'
}

/**
 * In-memory sliding window per key. Correct for one process; counters reset on restart (CHAT.md §7.7).
 * `hit` records an attempt and returns 0, or the seconds until the next attempt is allowed.
 */
export function limiter(max: number, windowMs: number, now: () => number = Date.now) {
  const hits = new Map<string, number[]>()
  const recent = (key: string, t: number) => (hits.get(key) ?? []).filter((x) => t - x < windowMs)
  return {
    /** Seconds to wait if the key is over the limit, without recording anything. */
    check(key: string): number {
      const t = now()
      const r = recent(key, t)
      return r.length >= max ? Math.max(1, Math.ceil((windowMs - (t - r[0])) / 1000)) : 0
    },
    hit(key: string): number {
      const t = now()
      const r = recent(key, t)
      if (r.length >= max) {
        hits.set(key, r)
        return Math.max(1, Math.ceil((windowMs - (t - r[0])) / 1000))
      }
      r.push(t)
      hits.set(key, r)
      // Bound memory: drop the oldest keys once the map gets large.
      if (hits.size > 10_000) for (const k of hits.keys()) { hits.delete(k); if (hits.size <= 5000) break }
      return 0
    },
    reset(key: string) {
      hits.delete(key)
    },
  }
}

export function enforce(wait: number, what = 'Too many requests') {
  if (wait > 0) throw new ApiError(429, 'rate_limited', `${what}. Try again in ${wait} s.`, wait)
}

export function sendError(reply: FastifyReply, err: ApiError) {
  if (err.retryAfter) reply.header('retry-after', String(err.retryAfter))
  return reply.code(err.status).send({ error: { code: err.code, message: err.message } })
}

// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g
/** NFC, trimmed, control and bidi-override characters removed (newline and tab kept). */
export function cleanText(value: string): string {
  return value.normalize('NFC').replace(CONTROL, '').trim()
}
/** Code points, which is what Postgres char_length counts. */
export const charLength = (value: string): number => [...value].length
