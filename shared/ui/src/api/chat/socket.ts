// The chat push channel (CHAT.md §5.4–5.5), framework-free like audio/engine.ts: connect, authenticate with the first
// frame (never the URL), reconnect with full-jitter backoff, and stop for good on 4401 (signed out).
import type { ServerEvent } from '../../../../chat-protocol'
import { parseEvent } from './validate'

export type SocketState =
  | { status: 'connecting' }
  | { status: 'connected' }
  | { status: 'reconnecting'; at: number }
  | { status: 'closed' }
  | { status: 'signed-out' }

const BASE_MS = 1000
const CAP_MS = 30_000
const STABLE_MS = 60_000

/** Full jitter: uniformly random in [0, min(cap, base·2^attempt)]. */
export const backoffDelay = (attempt: number, random = Math.random) => Math.round(random() * Math.min(CAP_MS, BASE_MS * 2 ** attempt))

/** `retry:N` in a 4429 close reason: the server says when to come back. */
const retryHint = (reason: string) => {
  const s = Number(/^retry:(\d+)/.exec(reason)?.[1])
  return Number.isFinite(s) && s > 0 ? s * 1000 : null
}

export class ChatSocket {
  private ws: WebSocket | null = null
  private attempt = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private stableTimer: ReturnType<typeof setTimeout> | undefined
  private stopped = false
  private readonly url: string
  private readonly token: string
  private readonly onEvent: (e: ServerEvent) => void
  private readonly onState: (s: SocketState) => void

  constructor(url: string, token: string, onEvent: (e: ServerEvent) => void, onState: (s: SocketState) => void) {
    this.url = url
    this.token = token
    this.onEvent = onEvent
    this.onState = onState
  }

  connect() {
    if (this.stopped || this.ws) return
    clearTimeout(this.timer)
    this.onState({ status: 'connecting' })
    let ws: WebSocket
    try {
      ws = new WebSocket(this.url)
    } catch {
      return this.schedule(null) // e.g. blocked by CSP; retried with backoff
    }
    this.ws = ws
    ws.onopen = () => ws.send(JSON.stringify({ v: 1, type: 'auth', data: { token: this.token } }))
    ws.onmessage = (m) => {
      const event = parseEvent(m.data)
      if (!event) return
      if (event.type === 'ready') {
        this.onState({ status: 'connected' })
        // Only a connection that stays up resets the backoff; a server that accepts then drops us keeps backing off.
        this.stableTimer = setTimeout(() => (this.attempt = 0), STABLE_MS)
      }
      this.onEvent(event)
    }
    ws.onclose = (e) => {
      clearTimeout(this.stableTimer)
      this.ws = null
      if (this.stopped) return
      if (e.code === 4401) {
        this.stopped = true
        return this.onState({ status: 'signed-out' })
      }
      this.schedule(e.code === 4429 ? retryHint(e.reason) : null)
    }
  }

  private schedule(delay: number | null) {
    const ms = delay ?? backoffDelay(this.attempt++)
    this.onState({ status: 'reconnecting', at: Date.now() + ms })
    this.timer = setTimeout(() => this.connect(), ms)
  }

  /** Coming back online or to the foreground: don't wait out the backoff. */
  nudge() {
    if (this.stopped || this.ws) return
    this.connect()
  }

  get open() {
    return this.ws?.readyState === WebSocket.OPEN
  }

  close() {
    this.stopped = true
    clearTimeout(this.timer)
    clearTimeout(this.stableTimer)
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.onclose = ws.onmessage = ws.onopen = null
      ws.close(1000)
    }
    this.onState({ status: 'closed' })
  }
}
