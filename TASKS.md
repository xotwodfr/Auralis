# Auralis — Tasks

> Ordered, actionable implementation checklist. Work top-to-bottom; each milestone ends at its
> **Done when** gate (see PLAN.md). Check items off as completed. Reference ARCHITECTURE.md for
> boundaries, API.md for endpoints, DESIGN.md for visuals, TESTING.md for the checks.

Legend: `[ ]` todo · `[x]` done. Keep the diff minimal and prefer existing helpers over new ones.

## M0 — Baseline & toolchain

- [x] `package.json` (Vite + React 19 + TS; TanStack Query, Zustand, React Router; Vitest, Testing
      Library, MSW, Playwright, ESLint) with scripts: `dev`, `build`, `preview`, `test`, `test:e2e`,
      `typecheck`, `lint`.
- [x] `tsconfig.json` / `tsconfig.node.json`, `vite.config.ts`, `index.html`, `.gitignore`.
- [x] `src/styles/tokens.css` (Liquid Glass tokens) + `src/styles/global.css` (reset, base ground).
- [x] `src/main.tsx` + `src/App.tsx` minimal shell that mounts and shows the app name.
- [x] Configure ESLint (typescript-eslint) and Vitest (jsdom environment).
- **Done when:** `npm run build`, `npm test`, `npm run typecheck`, `npm run lint` all pass.

## M1 — Server connection & auth

- [x] `api/subsonic/types.ts` — `SubsonicResponse<T>`, `SubsonicError`, session/capability types.
- [x] `api/subsonic/auth.ts` — salt generation, `t = md5(password+salt)`, request URL builder
      (never send `p` by default). Add unit test with the Subsonic example vector.
- [x] `api/subsonic/client.ts` — fetch wrapper: injects common params, `f=json`, parses
      `subsonic-response`, throws typed errors, supports AbortSignal.
- [x] `api/subsonic/errors.ts` — map codes 10/40/41/50/60/70 → typed errors. Unit test.
- [x] `api/subsonic/endpoints.ts` — `ping`, `getLicense`, `getOpenSubsonicExtensions`.
- [x] `state/auth.ts` — session store (base URL, user, credential blob, capabilities); persist only
      when "remember" is on (`lib/storage` over IndexedDB); clear action. Unit test.
- [x] `features/connect/` — Connect screen: URL/user/password/remember; loading + typed errors.
- [x] `features/settings/` — connection info, disconnect, clear credentials.
- [x] Wire TanStack Query provider; add `getOpenSubsonicExtensions` capability parse.
- [x] Tests: integration — `ping` ok stores session + capabilities; `ping` 40 → typed error.
- **Done when:** valid credentials reach Library; invalid show a specific non-crashing error;
      capability flags stored.
- **Manually verified (browser):** connected to a real Navidrome server as user `fsidblad` and
      reached the Library screen. Other flows (remember/restore, disconnect, error cases) are
      covered by automated tests only.

## M2 — Library browsing & search

- [x] `api/subsonic/types.ts` — add `Artist`, `Album`, `Song`, `Playlist`, `Genre` DTOs (IDs are
      strings). (`Genre` omitted: no genre endpoint is in M2 scope.)
- [x] `api/subsonic/endpoints.ts` — `getArtists`, `getArtist`, `getAlbum`, `getSong`,
      `getAlbumList2`, `getStarred2`, `getRandomSongs`, `getPlaylists`, `getPlaylist`, `search3`;
      mappers to models. Unit tests for mapping.
- [x] `features/library/` — sidebar sections (Artists, Albums, Recently Added, Playlists,
      Favorites, Recent) + routes; `Artist`, `Album`, `Playlist` detail views; unified-panel track lists.
- [x] Replaced the Tracks section with **Recently Added** (`getAlbumList2` `type=newest`, date added shown,
      Load more); the standalone all-tracks view and its route were removed. Search tracks and album
      track lists are unaffected.
- [x] `features/search/` — debounced query → `search3`; grouped results (artists/albums/tracks).
- [x] `ui/VirtualList` + `ui/Grid` + `ui/Artwork` (lazy image, cover-art id cache, reserved ratio).
- [x] Empty/loading/error states for each view.
- [x] Tests: integration — browse mapping + pagination; unit — 10k-row list renders only a DOM window.
- [ ] Perf: measure synthetic 10k-row scroll ≥55fps in a real browser (not measurable in jsdom).
- **Done when:** all browse views navigate; search returns typed results; scrolling holds 55fps.

## M3 — Playback engine & queue

- [x] `audio/engine.ts` — `HTMLAudioElement` wrapper: play/pause/seek/volume, `stream` URL
      generation, event emission, error handling. Framework-free.
- [x] `audio/queue.ts` — queue model + reducer: set/addNext/addToQueue/remove/reorder/next/previous/
      shuffle/repeat. Unit tests for edge cases.
- [x] `state/playback.ts` — mirror engine state (track, position, status, volume, repeat, shuffle);
      persist for restore; subscribe progress in an isolated component.
- [x] `audio/mediaSession.ts` — publish metadata + handlers (best effort). (Wired in `state/playback.ts`; no automated test, not checked in a real browser.)
- [x] `features/player/PlayerBar.tsx` + `ui/TransportControls.tsx` (+ `ui/Slider.tsx`, `ui/Icon.tsx`; PlayerBar lives in `features/` because `ui/` must stay state-free) (glass, ≥44px targets, keyboard operable).
- [ ] `features/nowplaying/` — partly done in M4: large art + metadata + lyrics. Still missing: its own seekable progress, transport and queue panel (the persistent player bar provides those).
- [x] `features/queue/` — queue panel: current/played/upcoming, reorder via move up/down buttons (no drag-and-drop), remove, clear.
- [x] Session restore on load (queue, index, position, volume, repeat, shuffle).
- [x] Tests: unit — queue reducer, engine; integration — engine event → store, restore, player UI.
- [ ] e2e (Playwright) — play/seek/repeat/shuffle against a real browser. Not written.
- **Done when:** playback survives navigation; state restores on reload; no glitch under load.
- **Verification status:** all of the above is covered by automated tests with a fake `<audio>` element
      and mocked Subsonic responses. Real playback against a Navidrome server and in a real browser is
      **not yet verified**; "no glitch under load" is unmeasured.

## M4 — Lyrics (MVP-critical)

- [x] `api/lyrics/types.ts` — `Lyrics` model, `LyricsProvider` interface, `LyricsCandidate`
      (`LyricsCandidate` lives in `match.ts`).
- [x] `api/lyrics/lrc.ts` — LRC parser (timestamps, offset, metadata skip,
      malformed tolerance). Unit tests.
- [x] `api/lyrics/providers/server.ts` — `getLyricsBySongId` when `songLyrics` capability present,
      else `getLyrics`; normalize `structuredLyrics` → `Lyrics`. Unit/integration tests.
- [x] `api/lyrics/providers/lrclib.ts` — `/api/get` → fallback `/api/search`; prefer `syncedLyrics`;
      handle `instrumental`, 404, `429`/`retry-after`; identifying User-Agent. Unit/integration.
      (No User-Agent/custom header is sent: browsers forbid setting it and a custom header forces a CORS preflight.)
- [x] `api/lyrics/match.ts` — normalization + duration gate + version-token guards. Unit tests.
- [x] `api/lyrics/registry.ts` — ordered providers, coalescing, AbortController timeout (~6s),
      stale-response discard by trackId, provider-disable flag. Unit/integration tests.
      (Registry has ordering, timeout, abort, provider-disable via the settings flag. Request coalescing and
      stale-discard come from TanStack Query keyed by track — no separate registry-level dedup map; dedup has no dedicated test.)
- [x] `api/lyrics/cache.ts` — TanStack Query keys + IndexedDB persistence; clear action.
      (One bounded blob, 300 entries; "not found" expires after 24h; failures are never stored.)
- [x] `features/lyrics/LyricsView.tsx` — synced highlight, click-to-seek, manual scroll + follow
      toggle, refresh, source attribution, unsynced plain text, "Instrumental", empty/error.
- [x] `state/settings.ts` — "External lookups" toggle + "Clear cached lyrics".
- [x] Tests: unit — parse/match/cache keys/stale discard; integration — fallback order,
      timeout, instrumental. (Dedup not separately tested.)
- [x] Now Playing view (`features/nowplaying/`) hosting the lyrics (art, title, artist, album).
- **Done when:** synced lyrics follow the playhead, click-to-seek works, wrong-match guards reject
      live/remix/duration mismatches, and playback is never blocked.
- **Verification status:** all of the above is covered by automated tests (jsdom, fake `<audio>`, MSW-mocked
      server and LRCLIB). **Not verified:** real Navidrome lyrics, live LRCLIB, smooth scrolling and
      highlight feel in a real browser, and the "playback is never blocked" claim under real load.

## M5 — Design system & polish

- [x] `ui/` primitives that screens actually use: `Dialog`/`ConfirmDialog`, `SegmentedControl`, `Toast`,
      `Slider`, `Skeleton`, `EmptyState`, `ErrorState`, `VirtualList`, `Grid`, `Artwork`, `Icon`.
- [ ] Not built as components (deliberate): `GlassSurface`, `Panel`, `Hairline`, `Button`, `IconButton`,
      `Tag`, `List`/`ListRow`, `ProgressBar`. Their roles are filled by shared CSS classes (`.glass-nav`,
      `.glass-overlay`, `.panel`, `.list-panel`, `.btn`, `.icon-btn`, `.row`); wrapping them would only
      add indirection. Revisit if a second variant appears.
- [x] `app/theme.ts` — System/Light/Dark via `[data-theme]`; persisted in `localStorage` (not IndexedDB, so
      `index.html` can apply it synchronously before first paint); follows the OS while on System;
      ~200ms colour ease that skips glass surfaces and reduced motion.
- [x] Theme presets (Midnight, OLED Black, Nord, Sunset, Forest, Sakura) + **Album Artwork** dynamic theme with a
      swatch picker in Settings (see DESIGN.md §1). AA contrast of every preset is asserted from `tokens.css`;
      palette derivation, cache bounds, stale/failed/missing-art handling and persistence are unit tested.
      **Not verified in a browser:** how each preset and cover palette actually looks (rapid track changes,
      bright covers, lyrics/dialogs/queue readability, narrow vs wide), and extraction against a real Navidrome
      (needs CORS on cover art).
- [x] Motion: pointer-down feedback on buttons, enter "materialize" for glass overlays/scrim via
      `@starting-style` (opacity/transform only), reduced-motion honoured globally and for lyrics scrolling.
      Exit animations are not implemented (overlays unmount immediately).
- [x] Reduced transparency / increased contrast / no-`backdrop-filter` fallbacks for every glass class
      (`tokens.css`). **CSS only: not covered by automated tests** (jsdom does not evaluate media queries).
- [x] `app/ErrorBoundary.tsx` (per-route, keyed by path, sidebar + player survive) + `Toast` surface
      (Settings actions use it).
- [x] Icons: line style, 24-grid, `currentColor`, grayscale with accent on active/pressed only; `title`
      tooltips on icon-only buttons.
- [x] Keyboard shortcuts (`app/shortcuts.ts`) + reference in Settings. Ignored while typing, with
      modifiers, in modals, on controls that own the key, and for arrows/Space in scrollable lists/lyrics.
- [x] Audit by code review: contrast-fixed tokens (`--text-3`, `--accent-fill`, `--danger-text`),
      confirmations for destructive actions, ≥44px targets, one global focus ring, truncation/wrapping.
      **Not visually audited in a browser.**
- [x] Tests: dialog focus trap/restore, shortcuts, theme, toasts, error boundary, segmented control,
      reduced-motion lyrics scroll, axe-core (critical/serious, colour-contrast rule off) on Connect,
      Artists, Albums, Settings, Now Playing. `axe-core` added as a dev dependency for TESTING.md §7.
- [ ] e2e (Playwright) — keyboard + reduced-motion/transparency in a real browser. Not written.
- **Done when:** both themes match tokens; all media queries honored; every screen has empty/
      loading/error states.
- **Verification status:** automated tests + typecheck/lint/build pass. **Not verified in a browser:** the
      visual result in either theme at any width, real contrast ratios (jsdom cannot compute them),
      reduced-transparency/contrast rendering, and the overlay enter transition.

## M6 — Performance, hardening, release readiness

- [x] Profile: 10k-row list scroll, playhead-tick render scope, lyrics sync, rapid skipping — measured in headless
      Chromium with software rendering (`e2e/perf.spec.ts`, numbers in TESTING.md §9). Not done: real device,
      60-minute memory run, grid scroll.
- [x] Fix the bottlenecks found: none were found in scroll/playhead rendering (ticks mutate only the progress bar;
      lists stay windowed). Fixed instead: the signed cover-URL cache was unbounded (now 2000, cleared on sign-out).
- [x] Reliability fixes with regression tests: saved queue validated before restore (corrupt/foreign data ignored);
      a **cleared queue no longer resurrects after reload**; session restore validated; switching account drops the
      old queue/stream; sign-out clears signed URLs, lyrics cache, cover palette and query cache; malformed list
      payloads degrade to empty; rejected credentials offer "Sign in again" instead of a pointless retry;
      stale stream-failure diagnosis cannot mark the next track as failed.
- [x] Real bug found by browser tests: the production CSS build dropped the unprefixed `backdrop-filter`, removing
      the glass blur in Chrome/Firefox (fixed; guarded by `prefs.spec.ts`).
- [x] Runtime fallback to solid surfaces for reduced transparency / increased contrast / no `backdrop-filter`
      (CSS media queries, verified for increased contrast in a real browser). **Not built:** a runtime jank probe
      that switches to solid surfaces on low-end devices.
- [x] API.md endpoints used are error-mapped; capability-gated where the server may differ (`songLyrics`, OpenSubsonic
      extensions). `getMusicFolders`, `getSongsByGenre`, `getNowPlaying`, `getScanStatus`, `getUser`, `setRating`,
      `star`/`unstar`, `savePlayQueue`/`getPlayQueue` are listed in API.md but not used by the app.
- [x] Browser smoke path (`e2e/smoke.spec.ts`) passes against the mock server; finalized TESTING.md §9.
- [x] Docs match shipped behaviour: README.md (run, checks, manual Navidrome checklist, security notes),
      ARCHITECTURE.md §6, API.md "As built", DESIGN.md themes, TESTING.md §9.
- [ ] Manual verification against a real Navidrome (README checklist) — playback, lyrics, artwork palette (CORS),
      empty-query `search3`/Recently Added ordering, long sessions. **Not done.**
- [ ] Real-device performance, 60-minute memory, Firefox/WebKit, screen-reader pass. **Not done.**
- **Done when:** TESTING.md budgets are met and the smoke path passes with no console errors.
- **Status:** the automated smoke path passes. Budgets are *partially* evidenced (desktop headless only). This is a
      release candidate for your own server, **not** a verified production release: known limitations are the
      plaintext password in IndexedDB when "Remember" is on, reusable token URLs for audio/art, unvirtualized
      album grids, and no real-server or real-device verification yet.

## Post-M6 — Spicy Lyrics integration

- [x] `server/spicy.mjs` (+ `server/index.mjs`, Vite dev/preview plugin): key-holding bridge with two fixed GET routes,
      id validation, same-site check, per-client rate limit, 6 h in-memory cache, request timeout, no redirects, no
      client headers forwarded, key never logged/returned. 22 backend tests (`tests/integration/spicy-server.test.ts`).
- [x] `api/lyrics/providers/spicy.ts`: word/syllable-timed lines, backing vocals, duet side, attribution (provider always;
      uploader/maker links for community syncs), overrun guard, fail-closed parsing. Priority Spicy → Navidrome → LRCLIB.
- [x] Track matching by an explicit, user-linked Spotify track id (`state/spotifyLinks.ts`, UI under the lyrics). Now also
      automatic: see the next section.
- [x] Persistent lyrics cache: found entries now expire after 7 days (API terms: refetch or discard within 30 days) and are
      pruned on load; the linked id is part of the cache key.
- [x] Secret handling: `.env`/`.env.*` ignored, `.env.example` placeholder, bundle/`import.meta.env` guard tests, e2e with a fake
      key. Verified once by hand: the real key works through `npm run dev` and `npm start` (200, `source: apple_music`), and
      is absent from `dist/`, responses, logs and `/@vite/env`.
- [x] Docs: README (local + production setup), API.md §6b, ARCHITECTURE.md §6, TESTING.md §9.
- [x] ~~Automatic Spotify-id resolution~~, ~~word-level timing for backing vocals~~, ~~smooth sub-word sweep~~: done below.
- [ ] Still open: a `Line`/`Static` response was never observed (parser for them is inferred); the Spicy Lyrics
      dashboard's real rate limits and error table are undocumented.

## Post-M6 — Automatic Spotify matching + lyrics experience

- [x] Research (API.md §6c): OpenSubsonic exposes `isrc[]`/`musicBrainzId` but no Spotify id; Spicy Lyrics has no lookup;
      song.link's keyless API is gone (observed 401); Spotify Web API search via Client Credentials chosen. Verified the
      Feb/Mar/Jul 2026 Development Mode changes (Premium-owner requirement, `limit` ≤ 10, `external_ids` kept).
- [x] Backend: `server/spotify.mjs` (token cache + refresh, ISRC → fielded → free-text, 429 back-off, Premium/credential
      warnings without secrets) and `GET /api/spicy/match` in `server/spicy.mjs` (bounded fields only, same guards, cache,
      coalescing); `/api/spicy/health` reports `matching`. 20 backend tests.
- [x] Library metadata: `Song.isrc` / `Song.explicit` from OpenSubsonic `isrc` / `explicitStatus`.
- [x] Scoring (`api/lyrics/spotifyMatch.ts`): explainable signals, version guards, same-recording grouping, accept / ask /
      none decision. 14 unit tests.
- [x] Service (`api/lyrics/resolve.ts`): settle delay for skipping, timeout, cancellation, dedup, persistent bounded cache
      (`lib/kvCache.ts`, shared with the lyrics cache) scoped by server/user/track, cleared on sign-out and with the
      lyrics cache.
- [x] `useLyrics`: identity first (user link > automatic match), then providers; "off for this track" (`NO_SPOTIFY`).
- [x] UI: status in the Spicy panel (matched / linked / choose / no match / none for this recording / off), recording
      chooser (fieldset, focus kept), "Wrong recording", manual link kept; Settings shows matching status.
- [x] Lyrics stage redesign (DESIGN.md "Lyrics stage"): audio-clock rAF painter (syllable sweep via `--p`), memoized lines,
      interruptible focal-region scroller, resume pill, word-timed backing vocals, duet alignment, gap marker,
      lyric-shaped loading state, attribution always on screen, theme-aware dim tokens with a contrast test, reduced
      motion / contrast / transparency handling, compact phone layout.
- [x] Tests: unit + integration (above), e2e `lyrics-auto.spec.ts` (7), a11y now also scans word-synced lyrics in all nine
      themes; existing specs updated for the new markup. All green: 516 Vitest, 30 Playwright.
- [ ] **Not verified against the real services:** no Spotify credentials or Spicy key were available here, so matching
      accuracy on a real library and real vocal sync are unmeasured (see README checklist step 4).
- [ ] Not built: an "intro" indicator before the first line; per-line end-time dimming during long instrumental gaps in
      word-synced lyrics (lines stay lit until the next line starts).

## M7 — Navigation redesign, favourites, play reporting, playlist editing

### Sidebar and navigation (P0)
- [x] Sidebar rebuilt (DESIGN.md §3): grouped destinations with icons, 11px group headings, tinted active pill with a
      3px accent edge bar and accent icon, pinned account/Settings footer behind a full-bleed hairline, scrolling
      middle section so Settings survives a short viewport. Hover/active/sub-line tints are `color-mix` on `--text`,
      so all nine themes get the same contrast step with no new tokens.
- [x] Collapsed 72px rail, toggled from the brand row and persisted in `localStorage`; names kept via
      `title`/`aria-label`. One `--sidebar-w` token now drives both the grid column and the fixed player bar's `left`
      (the width was hard-coded twice before).
- [x] Narrow screens (≤720px): icon-above-label tab strip with Settings pinned at the right, underlined active tab,
      replacing the plain horizontal text list.
- [x] Toolbar Back button on `/library/<kind>/<id>` routes (DESIGN.md asked for it; it was never built).
- [x] **Bug fixed:** a new route kept the previous page's scroll position (the window, not a pane, scrolls the content).
      `Shell` now resets it; covered by `e2e/actions.spec.ts`.
- [x] Verified in a real browser (headless Chromium 154) at 1280×800, 1100×520 and 390×760: screenshots of light,
      dark and Nord, hover/focus states, the rail, and no horizontal overflow at 390px. `e2e/a11y.spec.ts` (axe,
      WCAG 2 A/AA including contrast) passes in all nine themes.
      It caught one real defect: the account sub-line was 4.01:1 on the active pill — fixed via `--nav-sub`.

### Performance (P0)
- [x] `PlayActions` / `ArtistActions` subscribed to the whole playback store (`usePlayback((s) => s)`), so every
      album, artist and playlist page re-rendered them on every playhead tick. Now one selector per action, pinned by
      `tests/unit/render-scope.test.tsx` (verified to fail against the old code).
- [x] `VirtualList` no longer reads `clientHeight` inside the scroll handler (the ResizeObserver owns the height).
      **No measurable win** on this machine — kept because it keeps a layout read out of the scroll path.
- [x] Measured, not guessed: a 3 s scripted scroll over 10,000 rows and six route switches, via CDP
      `Performance.getMetrics`, before and after. Numbers and the negative glass result in TESTING.md §10.
- [ ] **Not reproduced:** the reported sluggishness on one laptop. Everything measured here sits at the 60 fps cap
      under software rendering, which hides any headroom difference. Next step is a trace from that machine.

### Features (P1)
- [x] **Favourites** (`star`/`unstar`): one heart on track rows, album cards, artist rows and the album/artist
      headers. The Favorites page existed but nothing could fill it. Every heart reads the single `getStarred2`
      query (`features/library/starred.ts`), flips optimistically, rolls back and warns on failure.
- [x] **Play reporting** (`scrobble`): "now playing" on start, submission at half the track or 4 minutes.
      This is what makes the server's play counts, the **Recent** page and Navidrome smart playlists work — none of
      them could ever fill up before. Fire-and-forget; Settings → Playback → "Report plays to your server" turns it off.
- [x] **Track actions dialog**: play next, add to queue, add to playlist, favourite, go to album, go to artist,
      remove from this playlist. Built on the existing `Dialog` (focus trap, Escape, focus restore), so rows now
      carry only a heart and "More" instead of two always-visible icon buttons.
- [x] **Playlist editing**: add a track to an existing playlist, create a playlist from a track
      (`createPlaylist`/`updatePlaylist`), remove a track by position from the playlist page.
- [x] `buildUrl` now sends repeated parameters (`songId=a&songId=b`) for the list-valued playlist endpoints.
- [x] Tests: 14 new Vitest cases (`tests/integration/library-actions.test.tsx`, `tests/unit/render-scope.test.tsx`)
      and 6 new Playwright cases (`e2e/actions.spec.ts`); the MSW and e2e mocks now hold starred/playlist state, so a
      refetch after a write behaves like a real server.
- [x] **Bug fixed:** moving the dialog to its playlist step dropped focus to `<body>`, so Escape stopped closing it.

### Next (P2 — not started)
- [ ] Virtualize the album grid. Albums/Recent/Recently Added still grow without bound as "Load more" is pressed;
      this is the largest remaining structural performance risk on a big library.
- [ ] Sort and filter in the album views (Supersonic has both: by name, year, added, played).
- [ ] Richer artist page: `getArtistInfo2` biography and similar artists, `getTopSongs`.
- [ ] Multi-track selection, drag-and-drop queue reordering, and adding a whole album/playlist to a playlist.
- [ ] `getStarred2` refetch on every heart click is wasteful on a large starred library — move to a targeted update.
- [ ] 5-star ratings (`setRating`), internet radio, `savePlayQueue` cross-device continuity, offline caching.
- [ ] Keyboard shortcuts for favourite / queue / Now Playing; a type-ahead jump in long lists.

## Cross-cutting rules (all milestones)

- Never block playback for any UI/lyrics/network work.
- New provider ⇒ touch only `api/lyrics/{providers,registry}`.
- No new dependency without a one-line justification and an owner.
- Every non-trivial logic unit ships with one small test.
- Do not commit without explicit permission.
