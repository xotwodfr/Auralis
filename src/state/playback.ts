import { create } from 'zustand'
import { coverArtUrl, ping, scrobble, streamUrl } from '../api/subsonic/endpoints'
import { SubsonicError } from '../api/subsonic/errors'
import type { Song } from '../api/subsonic/types'
import { toast } from './toast'
import { DEFAULT_AMOUNT, type KaraokeState } from '../audio/karaoke'
import { AudioEngine, type EngineErrorKind, type PlayStatus } from '../audio/engine'
import { setMediaHandlers, setMediaInfo } from '../audio/mediaSession'
import { currentEntry, initialQueue, nextIndex, previousIndex, queueReducer, type QueueAction, type QueueState, type Repeat } from '../audio/queue'
import { kvDelete, kvGet, kvSet } from '../lib/storage'
import { useAuth } from './auth'
import { useSettings } from './settings'

const KEY = 'playback'
const RESTART_THRESHOLD_S = 3
const SAVE_DEBOUNCE_MS = 500
const POSITION_SAVE_MS = 5000
/** Last.fm's long-standing rule, which Subsonic servers expect: half the track, or four minutes. */
const SCROBBLE_FRACTION = 0.5
const SCROBBLE_CAP_S = 240

export type PlaybackErrorKind = EngineErrorKind | 'auth'
export interface PlaybackError {
  kind: PlaybackErrorKind
  /** Fixed copy only: never contains URLs, tokens or credentials. */
  message: string
}

const MESSAGES: Record<PlaybackErrorKind, string> = {
  auth: 'Your session was rejected by the server. Reconnect in Settings.',
  network: 'Network problem: playback stopped. Check your connection and try again.',
  decode: "This track couldn't be decoded.",
  unsupported: "This track's format isn't supported by your browser or the server couldn't stream it.",
  blocked: 'Your browser blocked autoplay. Press play to continue.',
  unknown: "Playback failed. Try again.",
}
const fail = (kind: PlaybackErrorKind): PlaybackError => ({ kind, message: MESSAGES[kind] })

interface PlaybackState {
  queue: QueueState<Song>
  status: PlayStatus
  /** The user wants audio running (covers the loading/buffering gaps before `playing`). */
  autoplay: boolean
  position: number
  duration: number
  volume: number
  error: PlaybackError | null
  /** Vocal remover: `mono` = on, but the track is mono so it is bypassed; `unavailable` = this server or browser can't do it. */
  karaoke: KaraokeState
  /** How much of the centre (vocals) is taken out, 0-1. Remembered between sessions. */
  karaokeAmount: number

  playTracks: (tracks: Song[], start?: number) => void
  shufflePlay: (tracks: Song[]) => void
  addNext: (tracks: Song[]) => void
  addToQueue: (tracks: Song[]) => void
  removeAt: (index: number) => void
  clearQueue: () => void
  reorder: (from: number, to: number) => void
  jump: (index: number) => void
  togglePlay: () => void
  next: () => void
  previous: () => void
  seek: (seconds: number) => void
  setVolume: (volume: number) => void
  setKaraoke: (on: boolean) => void
  setKaraokeAmount: (amount: number) => void
  setShuffle: (on: boolean) => void
  cycleRepeat: () => void
  retry: () => void
  restore: () => Promise<void>
  reset: () => void
}

const engine = new AudioEngine()
const AMOUNT_KEY = 'auralis:karaoke-amount'
const initialAmount = (() => {
  try {
    const n = Number.parseFloat(localStorage.getItem(AMOUNT_KEY) ?? '')
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : DEFAULT_AMOUNT
  } catch {
    return DEFAULT_AMOUNT
  }
})()
engine.setKaraokeAmount(initialAmount)
/** Whether the engine currently holds the current entry's stream (false after a restore, until first play). */
let loaded = false
let saveTimer: ReturnType<typeof setTimeout> | undefined
let lastPositionSave = 0
/** Queue entry keys already reported, so a repeat or a seek can't report the same play twice. */
let announced: number | undefined
let submitted: number | undefined

const credentials = () => useAuth.getState().session?.credentials
const scope = () => {
  const c = credentials()
  return c ? `${c.baseUrl}|${c.username}` : undefined
}

export const usePlayback = create<PlaybackState>()((set, get) => {
  const apply = (action: QueueAction<Song>) => set((s) => ({ queue: queueReducer(s.queue, action) }))
  const currentKey = () => currentEntry(get().queue)?.key

  function loadCurrent(autoplay: boolean, position = 0) {
    const entry = currentEntry(get().queue)
    if (!entry) {
      engine.stop()
      loaded = false
      set({ status: 'idle', autoplay: false, position: 0, duration: 0, error: null })
      return
    }
    const c = credentials()
    if (!c) {
      loaded = false
      set({ status: 'error', autoplay: false, error: fail('auth') })
      return
    }
    loaded = true
    set({ status: 'loading', autoplay, position, duration: entry.track.duration, error: null })
    engine.load(streamUrl(c, entry.track.id), { autoplay, position })
  }

  /** After a queue edit: load whatever is now current if it changed. */
  function syncCurrent(before: number | undefined, autoplay: boolean) {
    if (currentKey() !== before) loadCurrent(autoplay)
  }

  return {
    queue: initialQueue(),
    status: 'idle',
    autoplay: false,
    position: 0,
    duration: 0,
    volume: 1,
    error: null,
    karaoke: 'off',
    karaokeAmount: initialAmount,

    playTracks(tracks, start = 0) {
      if (!tracks.length) return
      apply({ type: 'set', tracks, start })
      loadCurrent(true)
    },
    shufflePlay(tracks) {
      if (!tracks.length) return
      apply({ type: 'setShuffle', on: true })
      apply({ type: 'set', tracks, start: Math.floor(Math.random() * tracks.length) })
      loadCurrent(true)
    },
    addNext: (tracks) => apply({ type: 'addNext', tracks }),
    addToQueue: (tracks) => apply({ type: 'addToQueue', tracks }),
    removeAt(index) {
      const before = currentKey()
      apply({ type: 'remove', index })
      syncCurrent(before, get().autoplay)
    },
    clearQueue() {
      apply({ type: 'clear' })
      loadCurrent(false)
    },
    reorder: (from, to) => apply({ type: 'reorder', from, to }),
    jump(index) {
      apply({ type: 'jump', index })
      loadCurrent(true)
    },

    togglePlay() {
      const s = get()
      if (!currentEntry(s.queue)) {
        if (s.queue.items.length) get().jump(0)
        return
      }
      if (s.status === 'error') return get().retry()
      if (!loaded) return loadCurrent(true, s.position)
      if (s.status === 'playing' || s.status === 'buffering' || (s.status === 'loading' && s.autoplay)) {
        set({ autoplay: false })
        engine.pause()
      } else {
        set({ autoplay: true })
        void engine.play() // from `ended`, play() restarts the track
      }
    },
    next() {
      const idx = nextIndex(get().queue, true)
      if (idx !== null) get().jump(idx)
    },
    previous() {
      const { queue, position } = get()
      const idx = previousIndex(queue)
      if (position > RESTART_THRESHOLD_S || idx === queue.index) get().seek(0)
      else get().jump(idx)
    },
    seek(seconds) {
      if (!loaded) return set({ position: Math.max(0, seconds) })
      engine.seek(seconds)
    },
    setVolume(volume) {
      const v = Math.min(1, Math.max(0, volume))
      engine.setVolume(v)
      set({ volume: v })
    },
    setKaraoke: (on) => engine.setKaraoke(on),
    setKaraokeAmount(amount) {
      const a = Math.min(1, Math.max(0, amount))
      engine.setKaraokeAmount(a)
      set({ karaokeAmount: a })
      try {
        localStorage.setItem(AMOUNT_KEY, String(a))
      } catch {
        // storage blocked: the slider still works for this session
      }
    },
    setShuffle: (on) => apply({ type: 'setShuffle', on }),
    cycleRepeat() {
      const order: Repeat[] = ['off', 'all', 'one']
      apply({ type: 'setRepeat', repeat: order[(order.indexOf(get().queue.repeat) + 1) % order.length]! })
    },
    retry: () => loadCurrent(true, get().position),

    async restore() {
      if (loaded || get().queue.items.length) return
      const saved = parseSaved(await kvGet<unknown>(KEY).catch(() => undefined))
      if (!saved || saved.scope !== scope()) return
      const q = saved.queue
      if (get().queue.items.length) return // the user started something while we were reading
      engine.setVolume(saved.volume)
      const entry = currentEntry(q)
      // Restored paused and unloaded: browsers can't resume audio on their own, so the first play press loads it.
      set({ queue: q, volume: saved.volume, position: saved.position, duration: entry?.track.duration ?? 0, status: entry ? 'paused' : 'idle' })
    },
    reset() {
      clearTimeout(saveTimer)
      engine.stop()
      loaded = false
      announced = submitted = undefined
      set({ queue: initialQueue(), status: 'idle', autoplay: false, position: 0, duration: 0, error: null })
      void kvDelete(KEY).catch(() => undefined)
    },
  }
})

interface SavedPlayback {
  scope: string
  queue: QueueState<Song>
  position: number
  volume: number
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStr = (v: unknown): v is string => typeof v === 'string'

function validEntries(v: unknown): v is QueueState<Song>['items'] {
  return (
    Array.isArray(v) &&
    v.every((e) => isObj(e) && isNum(e.key) && isObj(e.track) && isStr(e.track.id) && isStr(e.track.title) && isStr(e.track.artist) && isStr(e.track.album) && isNum(e.track.duration))
  )
}

/** Stored state is untrusted (older builds, tampering, partial writes): anything malformed is ignored, never partly applied. */
export function parseSaved(raw: unknown): SavedPlayback | null {
  if (!isObj(raw) || !isStr(raw.scope) || !isObj(raw.queue) || !isNum(raw.position) || !isNum(raw.volume)) return null
  const q = raw.queue
  if (!validEntries(q.items) || !Number.isInteger(q.index) || (q.index as number) < -1 || (q.index as number) >= q.items.length) return null
  if (q.repeat !== 'off' && q.repeat !== 'all' && q.repeat !== 'one') return null
  if (typeof q.shuffle !== 'boolean' || !(q.original === null || validEntries(q.original)) || !isNum(q.nextKey)) return null
  if (q.nextKey <= Math.max(0, ...q.items.map((e) => e.key))) return null // a duplicate key would break React lists
  return {
    scope: raw.scope,
    queue: q as unknown as QueueState<Song>,
    position: Math.max(0, raw.position),
    volume: Math.min(1, Math.max(0, raw.volume)),
  }
}

function save() {
  const s = usePlayback.getState()
  const sc = scope()
  lastPositionSave = Date.now()
  if (!sc) return
  if (!s.queue.items.length) {
    void kvDelete(KEY).catch(() => undefined) // a cleared queue must not come back after a reload
    return
  }
  // shortcut: rewrites the whole queue each time; fine for thousands of tracks, revisit if profiling says otherwise.
  void kvSet(KEY, { scope: sc, queue: s.queue, position: s.position, volume: s.volume } satisfies SavedPlayback).catch(() => undefined)
}

/**
 * Tell the server what is playing. Fire-and-forget on purpose: play reporting must never delay or break
 * playback, and a server that doesn't implement `scrobble` simply answers an error we ignore.
 */
function report(id: string, submission: boolean) {
  const c = credentials()
  if (!c || !useSettings.getState().reportPlays) return
  void scrobble(c, id, submission).catch(() => undefined)
}

/** "Now playing" when a track starts, then one submission once it has been played far enough. */
function reportProgress(position: number) {
  const entry = currentEntry(usePlayback.getState().queue)
  if (!entry) return
  if (announced !== entry.key) {
    announced = entry.key
    submitted = undefined
    report(entry.track.id, false)
  }
  const target = Math.min(entry.track.duration * SCROBBLE_FRACTION, SCROBBLE_CAP_S)
  if (submitted !== entry.key && entry.track.duration > 0 && position >= target) {
    submitted = entry.key
    report(entry.track.id, true)
  }
}

/** A failed stream has no HTTP status in the browser, so ask the server whether the session is still good. */
async function diagnose(kind: EngineErrorKind) {
  const c = credentials()
  const key = currentEntry(usePlayback.getState().queue)?.key
  usePlayback.setState({ error: fail(kind) })
  if (!c) return usePlayback.setState({ error: fail('auth') })
  try {
    await ping(c)
  } catch (e) {
    const stale = currentEntry(usePlayback.getState().queue)?.key !== key
    if (stale || !(e instanceof SubsonicError)) return
    if (e.kind === 'auth') usePlayback.setState({ error: fail('auth') })
    else if (e.kind === 'network' || e.kind === 'http') usePlayback.setState({ error: fail('network') })
  }
}

engine.subscribe((e) => {
  const { setState: set, getState: get } = usePlayback
  switch (e.type) {
    case 'status':
      set({ status: e.status })
      if (e.status === 'paused' || e.status === 'ended') save()
      break
    case 'time':
      set({ position: e.position, ...(e.duration > 0 && { duration: e.duration }) })
      reportProgress(e.position)
      if (Date.now() - lastPositionSave > POSITION_SAVE_MS) save()
      break
    case 'ended': {
      const idx = nextIndex(get().queue, false)
      if (idx === null) set({ autoplay: false })
      else if (idx === get().queue.index) {
        engine.seek(0) // repeat-one
        void engine.play()
      } else get().jump(idx)
      break
    }
    case 'karaoke':
      if (e.state !== get().karaoke) {
        if (e.state === 'mono') toast.info('Mono track: vocals can’t be removed from it.')
        if (e.state === 'unavailable') toast.error('Karaoke mode needs a server that allows cross-origin audio (CORS).')
      }
      set({ karaoke: e.state })
      break
    case 'error':
      set({ autoplay: false })
      void diagnose(e.kind)
      break
  }
})

// Persist queue/volume edits (debounced), publish OS media info, and drop everything on disconnect.
usePlayback.subscribe((s, prev) => {
  if (s.queue !== prev.queue || s.volume !== prev.volume) {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(save, SAVE_DEBOUNCE_MS)
  }
  const track = currentEntry(s.queue)?.track
  const playing = s.status === 'playing' || s.status === 'buffering'
  if (track !== currentEntry(prev.queue)?.track || playing !== (prev.status === 'playing' || prev.status === 'buffering')) {
    const c = credentials()
    setMediaInfo(
      track ? { title: track.title, artist: track.artist, album: track.album, artwork: c && track.coverArt ? coverArtUrl(c, track.coverArt, 512) : undefined } : null,
      playing,
    )
  }
})

setMediaHandlers({
  play: () => {
    const s = usePlayback.getState()
    if (s.status !== 'playing') s.togglePlay()
  },
  pause: () => {
    const s = usePlayback.getState()
    if (s.status === 'playing' || s.status === 'buffering') s.togglePlay()
  },
  next: () => usePlayback.getState().next(),
  previous: () => usePlayback.getState().previous(),
  seekTo: (t) => usePlayback.getState().seek(t),
})

const accountOf = (s: { session: { credentials: { baseUrl: string; username: string } } | null }) =>
  s.session ? `${s.session.credentials.baseUrl}|${s.session.credentials.username}` : null

// Signing out, or switching to another server/user, drops the queue and the stream that belonged to the old one.
useAuth.subscribe((s, prev) => {
  if (accountOf(prev) && accountOf(s) !== accountOf(prev)) usePlayback.getState().reset()
})

/**
 * The audio element's own clock, for per-frame visuals (word-synced lyrics). The store's `position` follows
 * `timeupdate`, which browsers fire only ~4 times a second; reading `currentTime` directly stays exact between those.
 */
export function playbackTime(): number {
  const s = usePlayback.getState()
  return loaded && s.status !== 'loading' && s.status !== 'idle' ? engine.element.currentTime : s.position
}

/** Test hook: the underlying `<audio>` element. */
export const audioElement = engine.element
