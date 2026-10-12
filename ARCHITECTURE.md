# Auralis — Architecture

> Stack, module boundaries, data flow, and the technical decisions behind them.
> Verified facts vs assumptions are marked. See API.md for the endpoint contracts.

## 1. Stack

| Layer | Choice | Why |
|-------|--------|-----|
| Build | **Vite** + **TypeScript** | Fast dev server, first-class TS, minimal config. |
| UI | **React 19** | Largest ecosystem; fine-grained enough with memo/virtualization. |
| Routing | **React Router** | Deep links to artist/album/playlist; standard, small. |
| Server state | **TanStack Query** | Caching, request dedup, staleness, cancellation — exactly what lyrics + library need. |
| Client state | **Zustand** | Tiny store for playback/queue/auth/settings without boilerplate. |
| Audio | **HTMLAudioElement** | Native streaming, broad codec support, runs off the React render path. |
| Styling | **CSS custom properties** + co-located CSS | Tokens from the Liquid Glass skill; no CSS-in-JS runtime cost. |
| Tests | **Vitest** + Testing Library, **Playwright**, **MSW** | Unit/component, e2e, network mocking. |

Dependency principle: none added unless it removes more code than it costs. TanStack Query and
Zustand earn their place by replacing hand-rolled caches/stores; nothing else is assumed.

## 2. Module boundaries

Each layer may depend only on the layers below it. `api/` and `audio/` are siblings.

```
app/        routing, providers, error boundaries, theme        (top)
  features/ screen-level composition
    ui/       presentational system — no API/state calls
      state/  client stores (auth, playback, settings)
        api/  typed external integration (subsonic, lyrics)   ┐ siblings:
        audio/ playback engine (imperative, framework-free)   ┘ neither imports the other
          lib/ pure helpers (format, http, storage)             (bottom)
```

- **`api/subsonic`** owns the wire format, auth, URL building, error mapping, and typed DTOs.
  Nothing above it sees raw Subsonic JSON.
- **`api/lyrics`** owns the provider registry, matching, caching, and LRC parsing. It consumes
  `api/subsonic` for server lyrics; the rest of the app only sees a normalized `Lyrics` object.
- **`audio`** is a plain class/module wrapping `HTMLAudioElement` + queue logic. It emits events;
  it never imports React. Playback therefore outlives any component.
- **`state`** stores are thin: auth/session, playback mirror, settings. Derived data is computed,
  not stored twice.
- **`ui`** is dumb and reusable. Screens compose `ui` + hooks into `state`/`api`.

## 3. Directory layout (target)

```
Auralis/
  index.html  package.json  tsconfig.json  vite.config.ts
  src/
    main.tsx  App.tsx
    app/        routes.tsx  providers.tsx  theme.ts  ErrorBoundary.tsx
    api/
      subsonic/ client.ts  auth.ts  endpoints.ts  types.ts  errors.ts
      lyrics/   types.ts  registry.ts  providers/{server.ts,lrclib.ts,spicy.ts}
                match.ts  lrc.ts  cache.ts  spotifyMatch.ts (scoring)  resolve.ts (Spotify id service)
    audio/      engine.ts  queue.ts  mediaSession.ts
    state/      auth.ts  playback.ts  settings.ts
    features/   library/  search/  player/  nowplaying/  lyrics/  settings/  connect/
    ui/         Glass*.tsx  Button.tsx  List.tsx  Slider.tsx  ...
    lib/        format.ts  http.ts  storage.ts  kvCache.ts (bounded, expiring IndexedDB blob)
    styles/     tokens.css  global.css
  server/       spicy.mjs (key-holding lyrics bridge)  spotify.mjs (Spotify search, Client Credentials)
                index.mjs (production server: dist/ + /api/spicy)
  tests/        unit  integration  e2e
```

## 4. Data flow

### Connect / auth (M1)
1. User submits server URL + username + password on `connect`.
2. `api/subsonic/auth` builds a request: random `salt`, `t = md5(password + salt)`, plus `u`,`v`,`c`,`f=json`.
3. Call `ping` to validate; call `getOpenSubsonicExtensions` to learn capabilities (e.g. `songLyrics`).
4. On success, store session (`state/auth`): base URL, username, credential blob, capabilities.
5. If "remember" is on → persist to IndexedDB; else keep in memory for the session only.

### Library browse (M2)
`getArtists` → `getArtist` → `getAlbum` → `getSong`; `getAlbumList2` for recent/newest;
`getStarred2` for favorites; `getPlaylists`/`getPlaylist`. All responses map to typed models in
`api/subsonic/endpoints.ts`. TanStack Query caches by key; lists virtualize when large.

### Library writes (favourites, play reporting, playlists)
`api/subsonic/endpoints.ts` holds the four writes (`setStarred`, `scrobble`, `createPlaylist`/`addToPlaylist`/
`removeFromPlaylist`). None of them introduces a store: favourites read the single `getStarred2` query the Favorites
page already owns (`features/library/starred.ts`), flip it optimistically and reconcile by invalidating it, so no two
views can disagree. Play reporting lives in `state/playback.ts` next to the engine subscription, is fire-and-forget,
and is gated by a settings flag; it can never delay or fail playback.

### Playback (M3)
1. A user action (play album/track/playlist) sends a track list + start index to `audio/queue`.
2. `audio/engine` sets `HTMLAudioElement.src` to the signed `stream` URL and plays.
3. The engine emits `timeupdate`/`ended`/`error`; `state/playback` mirrors position/track/status.
4. UI reads the store; controls call engine methods. **The engine never waits on UI.**
5. `mediaSession` publishes OS-level metadata/controls (best effort).
6. State (queue, index, position, volume, repeat/shuffle) persists on change for restore.

### Lyrics (M4, extended for Spicy Lyrics)
0. On track change, `useLyrics` first settles the track's **Spotify identity** (only with *External lookups* on): a
   link the user made wins; otherwise, if the backend reports `matching`, `api/lyrics/resolve.ts` asks
   `/api/spicy/match` and scores the candidates (`spotifyMatch.ts`, API.md §6c). A confident match yields an id;
   ambiguity yields a chooser; anything else yields no id. Cached results make this instant on repeat plays.
1. Then the lyrics hook asks the **registry** for lyrics — never blocking playback.
2. Registry tries providers in order: **server** → **LRCLIB** → (future).
   - Server: if the `songLyrics` capability is advertised, `getLyricsBySongId`; else `getLyrics`.
   - LRCLIB: `/api/get` with title/artist/album/duration; fall back to `/api/search` if no exact hit.
   - Spicy Lyrics (optional, first when the track is linked to a Spotify id and external lookups are on): via the backend; see API.md §6b.
3. `match.ts` validates candidates (duration tolerance, title/artist normalization, remix/live/cover
   guards) before accepting.
4. Result normalized to `{ synced, lines: [{time,text}], source }`, cached (Query + IndexedDB).
5. Any in-flight request is aborted on track change; stale responses are ignored by request id.
6. The lyrics view derives the active line from the playback clock; clicking a line seeks.

### Lyrics timing and rendering
- **Clock:** the store's `position` follows `timeupdate` (~4 Hz in browsers), too coarse for words. `playbackTime()`
  (`state/playback.ts`) reads the audio element's `currentTime` directly; it is the only clock the lyrics use, so
  seeking, pausing, resuming, buffering and track changes are always reflected exactly (nothing is extrapolated).
- **Loop:** `SyncedLines` runs one `requestAnimationFrame` loop **only while playing**, plus one update on every store
  change (seek, pause, resume). Each frame: binary-search the active line; if it changed, `setState` (React re-renders
  only the two memoized lines whose state changed); then paint syllable progress. The loop and listeners are torn
  down on unmount/track change.
- **Painter:** for the active line only, each syllable's sung fraction is written as `--p` (0–1, rounded to 1%) when it
  changes, so roughly one style write per frame. CSS draws the sweep from `--p` with `background-clip: text`; `--p` is
  never transitioned, so the highlight cannot drift from the audio. Line-level sources (LRC) have no syllables and are
  highlighted per line; word times are never invented.
- **Scrolling:** the active line settles at 32 % of the lyrics viewport. A single interruptible rAF tween (700 ms,
  ease-out-quart) moves the scroller once per line change; a far jump (seek) starts near its target. Reduced motion
  jumps instantly. Wheel, touch, scroll keys or the scrollbar stop following; "Back to current line" or a line click
  resumes. Line offsets are read once per line change, never per frame.

## 5. Key decisions

| Decision | Alternative rejected | Reason |
|----------|---------------------|--------|
| Subsonic REST API | Navidrome native API | Compatibility across servers; native API is extra surface for MVP. |
| `HTMLAudioElement` | Web Audio graph / MSE | Native streaming + range; no gapless requirement in MVP; far less code. |
| TanStack Query for async cache | Hand-rolled cache | Dedup, abort, staleness, retries are exactly the lyrics requirements. |
| Zustand | Redux / Context-only | Playback state updates frequently; Context would re-render the tree. |
| Server lyrics first | LRCLIB first | Respects the user's own server; avoids needless external calls. |
| Credentials via token auth | Plaintext password | Never sends password in clear; documented at-rest limitation (§6). |
| CSS variables + plain CSS | Tailwind / CSS-in-JS | Skill tokens are CSS-native; no runtime, no purge ambiguity. |

## 6. Security & persistence

- **In transit:** Subsonic token auth only (`t`/`s`); never `p`. A guarded plaintext fallback for pre-1.13 servers was
  **not** built: such servers get a clear error instead.
- **Tokens in URLs (known limitation):** `<audio>`/`<img>` cannot send headers, so `stream` and `getCoverArt` URLs carry
  `u`/`t`/`s`. That pair is reusable against the same server by anyone who can read the URL (history, proxy or server
  logs). Mitigations: HTTPS, error messages and logs never include URLs, and the signed-URL cache is cleared on
  sign-out. An API-key or cookie scheme (OpenSubsonic `apiKeyAuthentication`) would remove this and is future work.
- **At rest (known limitation):** the browser has no OS keychain. "Remember this device" stores the **plaintext
  password** in IndexedDB (token auth needs it per request). Default is memory-only. Disconnect, or "Clear stored
  credentials" in Settings, deletes it. A WebCrypto-encrypted vault is future work and would only protect against
  casual disk reads, not against script running in the page.
- **Stored data is untrusted:** the session, the saved queue, settings and the cached palette are all validated on
  read; malformed data is ignored (and corrupt sessions deleted) rather than partly applied.
- **Account boundaries:** signing out or switching to another server/user drops the queue and stream, the signed-URL
  cache, the cover palette, cached lyrics, cached Spotify matches and the in-memory query cache. Spotify links and
  matches are keyed by server + user + track, so they are never reused across accounts even before that.
- **Network:** HTTPS required when Auralis is served over HTTPS (mixed content); server must allow CORS. Validate/
  marshal all server input (odd list shapes degrade to empty); never `eval`; treat lyrics text as plain text.
- **Least privilege:** the browser talks directly to the user's Navidrome server and LRCLIB. The one exception is a
  small same-origin backend (`server/spicy.mjs`, run by Vite in dev/preview and by `server/index.mjs` in production)
  that holds the **Spicy Lyrics secret key** and, optionally, the **Spotify client id/secret** (`server/spotify.mjs`),
  and exposes only `GET /api/spicy/health`, `GET /api/spicy/lyrics/{22-char id}` and
  `GET /api/spicy/match?title&artist&isrc`: fixed upstream paths, validated and bounded input (the Spotify query is
  built server-side), same-site only, per-client rate limit, in-memory caches, no client headers forwarded, secrets and
  the Spotify access token never logged or returned. Without a key or backend the integration is
  inert and the rest of the app is unaffected. The keys are read from `process.env`/`.env` on the Node side only (no
  `VITE_` prefix, not in `define`), and `tests/integration/no-secret-in-bundle.test.ts`, `e2e/spicy.spec.ts` and
  `e2e/lyrics-auto.spec.ts` check they cannot reach the bundle or responses.
- **No retry loops:** the HTTP client never retries; TanStack Query is configured with `retry: false`. The one exception
  is server-side: a Spotify search answered `401` is retried once with a fresh token. Failures surface
  with a manual "Try again" (or "Sign in again" for rejected credentials).

## 7. Verified vs assumed

- **Verified:** Subsonic token auth (`u`/`t`/`s`/`v`/`c`/`f`); Navidrome Subsonic v1.16.1 compatibility;
  the endpoint list in API.md; OpenSubsonic `getLyricsBySongId`
  (with `enhanced`) and `getLyrics`; extension discovery via `getOpenSubsonicExtensions`; LRCLIB
  `/api/get` and `/api/search` request/response shapes.
- **Assumed (verify during implementation):** exact Navidrome CORS defaults; which of
  `/api/get` vs `/api/search` gives best hit rate for a given library; browser media-session support
  matrix; that evergreen browsers all support the required CSS.
