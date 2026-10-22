# Auralis — Testing

> Test strategy, tooling, and measurable acceptance criteria. Tests target **critical
> functionality** only — playback, auth, lyrics matching, queue logic, and the visual system.
> Ponytail rule: every non-trivial unit of logic gets one small test; trivial changes get none.

## 1. Tooling

| Layer | Tool | Scope |
|-------|------|-------|
| Unit | **Vitest** | Pure logic: auth token, LRC parse, matching, queue reducer, mappers. |
| Component | **Vitest** + Testing Library + jsdom | UI primitives, stores, a11y roles. |
| Network | **MSW** | Mock Subsonic + LRCLIB responses (fixtures from API.md shapes). |
| E2E | **Playwright** | Real browser: connect → browse → play → lyrics → seek; keyboard; motion prefs. |
| Perf | Playwright traces + manual DevTools | Scroll, transitions, extended playback, memory. |

Commands (from the repo root, each runs every workspace that has the script): `npm test` (unit+component), `npm run test:e2e`, `npm run typecheck`, `npm run lint`. Where the suites live: `shared/ui/tests` (app core), `server/tests` (lyrics backend and the secret-leak guard), `android/tests` (phone UI), `web/e2e` and `android/e2e` (Playwright).
CI gate: typecheck + lint + unit green on every change; e2e before a milestone closes.

## 2. What must be tested (and what need not)

**Must:** auth/token generation, error-code mapping, LRC parsing, lyrics provider fallback order,
lyrics matching guards, queue next/prev/shuffle/repeat, session restore, stale-response discard,
artwork/URL building, a11y of interactive components.

**Need not (MVP):** pixel-perfect visual diffing of every screen, exhaustive mapping of every
Subsonic field, browser matrix beyond the three targets.

## 3. Unit tests

### Auth (`api/subsonic/auth`)
- `t = md5(password + salt)` matches the Subsonic example: password `sesame`, salt `c19b2d` ⇒
  `26719a1196d2a940705a59634eb18eab`.
- Salt is random and ≥6 chars; every request gets a fresh salt.
- URLs contain `u,v,c,f=json` and either `t`+`s` (never `p` in the default path).

### Errors (`api/subsonic/errors`)
- Code `40`/`41` map to an auth-required error; `70` maps to not-found/empty; unknown codes map to
  a generic typed error with the raw code preserved.

### Lyrics — LRC (`api/lyrics/lrc`)
- Parses `[mm:ss.xx]` and `[mm:ss.xxx]` timestamps into ms; multiple timestamps per line.
- Ignores metadata tags (`[ar:]`, `[ti:]`, `[offset:]`) while applying `offset` when present.
- Unsynchronized input yields `synced:false` with ordered plain lines.
- Malformed lines are skipped, never thrown.

### Lyrics — matching (`api/lyrics/match`)
- Exact title+artist+duration within 3s ⇒ accept.
- Duration off by >3s ⇒ reject (live/extended guard).
- Title has `(Live)` but candidate lacks it ⇒ reject; both have it ⇒ accept.
- Normalization: `feat.` suffix, punctuation, casing, extra whitespace all match.
- No valid candidate ⇒ structured "not found".

### Playback — queue (`audio/queue`)
- `next` at end of queue with `repeat: off` stops; with `repeat: all` wraps; with `repeat: one`
  repeats current.
- `previous` restarts current if position > ~3s, else moves back.
- `shuffle` on/off preserves the current track and produces no immediate repeat.
- `addNext`, `addToQueue`, `remove`, `reorder` keep the current index consistent.

### Stores
- `auth` persists only when "remember" is on; clearing session removes stored credentials.
- `settings` toggling "external lookups" disables the LRCLIB provider in the registry.
- Session restore rehydrates queue/index/position/volume/repeat/shuffle.

## 4. Integration tests (MSW)

- **Connect:** mocked `ping` ok → session stored + capability flags set; `ping` code 40 → typed
  auth error, no session stored.
- **Browse:** `getArtists`→`getArtist`→`getAlbum` map to typed models; pagination via offsets.
- **Lyrics fallback order:** server returns lyrics ⇒ LRCLIB never called; server 404/empty ⇒
  LRCLIB `/get` called; `/get` 404 ⇒ `/search` called; `instrumental:true` ⇒ no further calls.
- **Stale discard:** launch lyrics for track A, switch to B before A resolves; A's response is
  discarded and B's is shown.
- **Dedup:** two simultaneous lyric requests for the same track trigger one network call.
- **Timeout:** a slow provider aborts at ~6s and yields not-found with a retry action.

## 5. E2E (Playwright)

Smoke path (the release gate):
1. Enter server URL + credentials → lands on Library.
2. Open an artist → album → play a track; transport shows the correct metadata.
3. Seek to the middle; progress updates; next/previous work.
4. Open Now Playing; lyrics appear and the active line advances with playback; click a line → seeks.
5. Toggle shuffle + repeat; queue reflects the change.
6. Reload → queue, track, and position restore.
7. Toggle dark theme; disconnect network → an error state with retry appears (no crash).

Additional:
- Keyboard-only traversal of the main shell; shortcuts (Space, arrows, `/`, Esc) work.
- `prefers-reduced-motion: reduce` ⇒ no travel animations; `prefers-reduced-transparency: reduce`
  ⇒ glass surfaces become solid.
- External-lookups-off ⇒ no request to `lrclib.net` is made (assert via route interception).

## 6. Performance acceptance criteria (measurable)

Profiled on a mid-range device; failures block M6 sign-off.

| Scenario | Budget |
|----------|--------|
| Library scroll, 10k rows (virtualized) | ≥55 fps sustained; no long task > 50ms |
| Route/screen transition | completes ≤ 400ms; no dropped frame burst |
| Playhead tick during playback | only the progress component re-renders; no full-tree render |
| Lyrics line highlight | change is transform/opacity only; ≤ 4ms per update |
| Lyrics request | never delays audio start; audio begins independent of the request |
| Extended playback (60 min) | no unbounded memory growth (JS heap stable within a small band) |
| Total blurred area on screen | bounded to toolbar + player bar (or one overlay), never full-page content |
| Artwork grid scroll | images lazy-load; no layout shift (reserved aspect-ratio) |

## 7. Accessibility checks
- Automated: axe-core on key screens (Connect, Library, Album, Now Playing, Settings) — zero
  critical/serious violations.
- Manual: focus order, visible focus ring, slider keyboard operation, contrast on both themes,
  reduced-motion/transparency/contrast media queries active.

## 8. Definition of done (per milestone)
A milestone is done only when: its unit tests are green, its integration tests (where applicable)
are green, the e2e smoke steps it touches pass, typecheck + lint are clean, and the acceptance
criteria above that it affects are met.

## 9. As built (M6)

### Commands
| Command | What it runs |
|---------|--------------|
| `npm test` | Vitest (jsdom, plus the Node-environment backend tests): unit, component and MSW-mocked integration tests, 531 tests. No network, no real server, no real Spicy Lyrics key or Spotify credentials. |
| `npm run typecheck` / `npm run lint` | `tsc -p` per workspace (app, tests, Playwright specs) / ESLint 9 flat config plus `scripts/check-boundaries.mjs`, which fails on any import that crosses a platform boundary. |
| `npm run build` | Type-check + production web bundle (`web/dist/`). `npm run build -w @auralis/tauri` / `-w @auralis/android` build the other two bundles. |
| `npm run test:e2e` | Playwright against the **production build** and a mock Subsonic server. |

### Browser tests (`web/e2e/`, `android/e2e/`)
- `web/playwright.config.ts` starts two servers (`android/playwright.config.ts` does the same for the phone-UI build, on ports 5299/4699 so both suites can run side by side): `shared/ui/testing/mock-server.mjs` (deterministic Subsonic/OpenSubsonic fixtures, real
  token-auth check, range-capable WAV audio, solid-colour cover art with CORS headers, synced lyrics for one track,
  failure injection via `/__fail?endpoint=…&times=n`, bulk artists via `/__bulk?artists=n`) and `vite build` +
  `vite preview` of the app. It uses a production build on purpose: the dev server's StrictMode fires duplicate
  requests, and the minified CSS differs from dev (a minifier bug that dropped `backdrop-filter` was only visible here).
- No real credentials or live services: `lrclib.net` is stubbed with `page.route`, the mock uses `demo` / `e2e-pass`.
- One-time browser install: `npx playwright install chromium`. If Playwright's download can't run on your system
  (e.g. NixOS), point it at any Chromium: `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chromium npm run test:e2e`.
- The app server for e2e runs with a **fake** `SPICY_LYRICS_SECRET_KEY` and fake `SPOTIFY_CLIENT_ID`/`SPOTIFY_CLIENT_SECRET`, with `SPICY_LYRICS_API_BASE`, `SPOTIFY_API_BASE` and `SPOTIFY_TOKEN_URL` pointing at the mock, so real `.env` values are never used and neither `api.spicylyrics.org` nor Spotify is contacted. The mock's Spotify stand-in checks the Basic/Bearer credentials and answers one confident match (*Quiet Hours*, with a dense word-timed fixture: wrapping line, syllables, backing vocals, duet), one ambiguous pair (*Fourth Song*) and nothing for the rest.
- Specs: `lyrics-auto.spec.ts` (Navidrome track → automatic match → Spicy Lyrics → word-synced lyrics with painted progress agreeing with the player clock; cached across reload; no secret or access token in any response, header or asset, browser never calls Spotify/Spicy directly; ambiguous recordings → keyboard choice, focus kept; no match → server lyrics; production CSS keeps `background-clip: text`, the edge mask and the glass resume pill; manual scroll → "Back to current line" → active line back at 32 %; painting touches only the active line with ~1 style write per frame and no re-render; reduced motion → no travel, no rise; 360 px → no horizontal overflow), `spicy.spec.ts` (link a track → word-timed lyrics + attribution; the fake key appears in no response, header or JS asset; the endpoint rejects bad ids, non-GET and cross-site calls), `smoke.spec.ts` (connect → browse → search → play → queue add/reorder/remove → Now Playing synced lyrics and
  click-to-seek → navigation without interrupting audio → preset and Album Artwork themes → reload persistence → API
  failure and retry; wrong password; keyboard shortcuts and focus ring; 390px viewport), `a11y.spec.ts` (axe-core,
  WCAG 2 A/AA **including colour contrast**, on four pages plus word-synced Now Playing mid-syllable, in all nine themes), `prefs.spec.ts` (OS colour scheme,
  reduced motion, increased contrast, default translucent glass, 360px player with a very long title),
  `perf.spec.ts` (see below), `effects.spec.ts` (a 440 Hz test tone through the real audio graph, measured with an
  analyser tapped onto the output: speed 1.5× advances the clock 1.5× with `preservesPitch`; pitch +12 moves the peak to
  880 Hz with speed unchanged; bypass returns to 440 Hz at 1× without reloading; EQ cuts lower the level; a Hall reverb
  tail is still sounding 300 ms after pause and the dry signal is not), `social.spec.ts` (the Social entry's position —
  first and top-left in the sidebar, the narrow-screen strip and every phone tab header, portrait and landscape; real
  activity from the mock's `getNowPlaying`; people → profile; sharing off by default; axe on Activity; no horizontal overflow; the same audio element keeps playing, unpaused and advancing, throughout).
- The e2e build sets `VITE_AURALIS_BACKEND_URL` to the preview server itself. Without it, production builds default to
  the hosted lyrics server and 19 specs failed (they never reached the local bridge).

### Measured performance (headless Chromium 154, software rendering, this development machine)
Absolute numbers are **not** representative of real hardware; the structural results are the useful part.

| Scenario | Result |
|----------|--------|
| 10,000-row artist list, one scripted top-to-bottom scroll over 3 s | 182 frames, avg 60.5 fps (the display cap), p95 frame 16.7 ms, worst 16.8 ms, 0 long tasks; 21 DOM rows for 10,000 |
| DOM mutations during 3 s of playback, album page | 61, **all** inside the progress bar; none in the player's other controls or the page |
| …on Now Playing | 61 in the progress bar, 4 in lyrics (active-line changes), none elsewhere |
| 30 rapid next-presses | settles on the last track, no error banner, no page errors |

Not measured: a real device, 60-minute memory behaviour, scrolling a *grid* of thousands of albums (album grids use
`content-visibility` but are not virtualized), transition cost under load.

### Lyrics matching and animation (added with automatic matching)
| Area | Tests |
|------|-------|
| Scoring (`shared/ui/tests/unit/spotify-match.test.ts`) | exact match; normalization (case, punctuation, diacritics, quotes, `&`, featuring); multi-artist credits; duration gate and album tie-breaker; live/remix/acoustic/re-recorded/edit rejected both ways; remaster preference; clean vs explicit; ISRC over spelling; ambiguity between different recordings; duplicate titles by other artists; missing artist/duration; low confidence; signals add up |
| Service (`shared/ui/tests/integration/spotify-auto.test.tsx`) | concurrent dedup; cancellation only when no caller is left; persistent cache per server/user/track identity; TTLs (1 day / 30 days); 429 back-off; malformed candidates; failures not cached |
| UI (`spotify-auto.test.tsx`, `spicy-ui.test.tsx`, `lyrics-view.test.tsx`) | automatic match with no user action; ambiguous chooser + fallback + remembered choice; "None of these"; no match → fallback, never a fabricated id; matched but no Spicy lyrics; "Wrong recording" and restore; manual link overrides; external lookups off; backend without Spotify; rapid skipping looks up only the last track; stale match discarded; syllable progress from real timestamps, seeking back un-sings; active line, click-to-seek, manual scroll/follow, reduced-motion instant scroll; Settings status |
| Backend (`server/tests/spotify-match-server.test.ts`) | token once and refresh; ISRC → fielded → free-text order; query syntax stripped; malformed items dropped; 429 back-off; 400/403/outage → 502 and one warning without secrets; 401 retried once; route validation (fields, repeats, sizes), 503 when unconfigured, cross-site refused, cache + coalescing, shared rate limit, API base with a path |
| Themes (`shared/ui/tests/unit/themes.test.ts`) | dimmed lyric lines ≥ 3:1 on `--bg` in all nine presets |

Measured in a real browser (headless Chromium 154, this machine): every active line settled at exactly 32 % of the lyrics
viewport (210 px of 656) across four consecutive lines; ~56 style writes per second while a line is sung (one per
frame); painted progress froze exactly on pause and continued on resume.

### Accessibility
Automated: axe-core in jsdom (`shared/ui/tests/integration/m5-ui.test.tsx`, contrast rule off) and in a real browser
(`e2e/a11y.spec.ts`, contrast on) found no serious or critical violations. Not covered by any tool: a real screen
reader pass, and judging how themes *look*. Do those by hand.

### Known gaps
- Playwright runs on Chromium only (Firefox/WebKit untested). No visual-regression screenshots (screens were inspected
  by hand during development, not asserted).
- Automatic matching is verified against a stand-in for Spotify built from the documented response shape, not against
  the live API (no credentials were available). Real-catalogue accuracy (how often ordinary tracks match, how often a
  choice is asked) is unmeasured.
- The syllable sweep was judged against fixture timings on silent audio, not against real vocals.
- Audio effects are measured on a test tone in Chromium. How they sound on music (phase-vocoder artefacts, reverb
  character) is a listening judgement: see the manual step in `README.md`. Unit tests use a recording Web Audio fake
  (`shared/ui/tests/fakeWebAudio.ts`) for wiring and lifecycle, and run the DSP itself on plain arrays.
- Real Navidrome behaviour (CORS on cover art, `search3` with an empty query, `getLyricsBySongId`) is only checked
  against the mock; use the manual checklist in `README.md`.
- Albums/Recent/Recently Added grow without bound as "Load more" is pressed (no virtualization for grids).
- Social is tested against the mock and MSW only: never against a real Navidrome
  `getNowPlaying`, and the Android build was not run on a device (none was available).

## 10. Navigation redesign, favourites and play reporting (M7)

### What was added
- `web/e2e/actions.spec.ts` (6): favourites survive a reload and reach the Favorites page; add a track to a playlist then
  remove it there; the track menu is keyboard operable and returns focus; playing a track reports it to the server and
  the preference stops it; the collapsed sidebar persists and keeps every destination reachable; a new route starts at
  the top of the page.
- `shared/ui/tests/integration/library-actions.test.tsx` (13): starred state read from the server; `star`/`unstar` parameter
  shapes (`id` for songs, `albumId`/`artistId` for ID3 albums and artists); optimistic flip, rollback and warning on
  failure; a star on the album page showing up on Favorites; add to an existing playlist; create a playlist from a
  track; remove by position; "Remove from this playlist" only inside a playlist; navigation from the menu; a playlist
  failure surfacing; `scrobble` announce → submit at half → never twice; nothing sent when the preference is off.
- `shared/ui/tests/unit/render-scope.test.tsx` (1): the page play controls do not re-render on playhead ticks. Checked against the
  previous code, where it fails.
- The MSW server and `shared/ui/testing/mock-server.mjs` now hold starred and playlist state, so a refetch after a write behaves like
  a real server (this is what exposed the optimistic-update path properly).

### Measured (headless Chromium 154, software rendering, this development machine, production build)
Measured through CDP `Performance.getMetrics` around two scripted scenarios, before and after the changes.
Absolute numbers are not representative of real hardware.

| Scenario | Before | After |
|----------|--------|-------|
| 3 s scripted scroll over 10,000 rows | layouts 180, style recalcs 181, layout 157.2 ms, style 92.9 ms, script 174.4 ms, task 566.1 ms | layouts 180, style recalcs 181, layout 162.5 ms, style 93.4 ms, script 173.9 ms, task 572.6 ms |
| 6 route switches (click → heading visible) | 50, 56, 46, 49, 49, 55 ms (median 50) | 50, 51, 47, 52, 48, 56 ms (median 51) |

**Both are flat: no improvement was measured, and none was lost.** Run-to-run noise is larger than any difference.
The honest reading is that on this machine neither the re-render fix nor the scroll-handler change is the bottleneck;
they are code-level corrections with a regression test, not a speed-up.

Glass A/B during the same scroll, with `backdrop-filter` forced off: 182 frames, avg 16.53 ms / p95 16.7 / worst 16.8
as shipped, versus 16.50 / 16.7 / 16.8 without the blur. Blurred area on screen is 179,568 px² at 1044×1080, **19.5 %
of the viewport**, within the DESIGN.md §7 cap. **The glass is not a measured cost here.**

### Not reproduced
The reported sluggishness on one laptop was **not reproduced**. Every scenario above runs at the 60 fps display cap
under software rendering, which hides any headroom difference — a machine with less headroom could still stutter where
this one does not. The useful next step is a DevTools performance trace recorded on that laptop, not more changes here.

