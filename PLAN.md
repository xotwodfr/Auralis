# Auralis — Plan

> Premium Navidrome / Subsonic music client with an Apple-inspired Liquid Glass interface.
> This document defines goals, MVP scope, assumptions, and milestones. It is the entry point;
> see ARCHITECTURE.md, DESIGN.md, API.md, TESTING.md, TASKS.md for the detail.

## 1. Product vision

Make self-hosted music feel like a polished commercial player. Auralis targets the four things
self-hosted clients usually get wrong: **reliable playback**, **fast browsing of large libraries**,
**integrated lyrics that are actually in sync**, and **calm, premium visual design**.

### Priority order (drives every trade-off)

1. Reliable playback — it must never glitch, stall, or lose the queue.
2. UX and visual design — Apple-grade restraint, not decoration.
3. Performance — large libraries stay fast; Liquid Glass never costs responsiveness or battery.
4. Integrated lyrics — server-first, LRCLIB fallback, tight matching, non-blocking.
5. Maintainable, secure architecture — typed boundaries, minimal dependencies.

## 2. Assumptions (made because the repo was empty and no questions were allowed)

| # | Assumption | Rationale |
|---|-----------|-----------|
| A1 | **Web SPA** (Vite + React + TypeScript), not native mobile/desktop. | Repo empty; Liquid Glass skills target web/CSS; only Node.js is installed. Browser `HTMLAudioElement` is sufficient for a first-class player. |
| A2 | **Subsonic/OpenSubsonic REST API** is the integration surface for all servers. | Broadest compatibility ("Navidrome and compatible servers"); avoids a Navidrome-only path. |
| A3 | Server requires CORS enabled and HTTPS if Auralis is served over HTTPS. | Browser security model; documented as a deployment requirement, not code. |
| A4 | Credentials: Subsonic **token auth** (`t = md5(password + salt)`) with a fresh salt per request; "remember this device" is opt-in. | Prevents plaintext password over the wire; see ARCHITECTURE.md §6 for the at-rest limitation. |
| A5 | Single active server per browser profile for MVP; multi-server is a future enhancement. | Keeps auth/state simple; avoids premature abstraction. |
| A6 | Lyrics MVP supports LRC line-level sync (not word/`cueLine`-level). | Word-level is an OpenSubsonic v2 enhancement; line-level covers ~all real content. |
| A7 | Target evergreen browsers (Chromium, Safari, Firefox). | Modern CSS (`backdrop-filter`, `:has`) is required by the design. |
| A8 | "Claude Code" will implement milestones from TASKS.md; docs must be self-sufficient. | Stated in the brief. |

## 3. MVP scope

### In scope
- Connect / authenticate to a Subsonic or OpenSubsonic server; validate credentials.
- Browse: artists, albums, tracks, playlists, favorites (starred), recently played.
- Library search across artists/albums/tracks.
- Persistent playback engine: play/pause/seek/next/previous/shuffle/repeat, volume, queue.
- Queue management (play now, play next, add to queue, reorder, remove).
- Now Playing screen: artwork, metadata, progress, lyrics panel.
- Lyrics: server-first (`getLyricsBySongId` → `getLyrics`), LRCLIB fallback, sync highlight,
  click-to-seek, manual scroll, follow toggle, refresh, attribution, disable-external, clear cache.
- Session restore: last queue, track, position, volume, repeat/shuffle.
- Responsive shell + keyboard shortcuts + clear error/empty/loading states.
- Light and dark themes.

### Out of scope for MVP (named, deferred)
- Word/syllable-level (`cueLine`) karaoke highlighting.
- Transcoding quality selection UI (server default/stream params only).
- Offline downloads, casting, external (Last.fm) scrobbling — Auralis only sends the Subsonic
  `scrobble` submission — smart playlists, multi-server, equalizer.
- User account management, sharing, podcasts, radio, video (endpoints unimplemented by Navidrome).
- Native platform integrations (media keys beyond the browser, OS notifications) — best-effort only.

## 4. Milestones

Each milestone lists objective, modules, dependencies, tests, and completion criteria.
Detailed tasks live in TASKS.md.

### M0 — Baseline & toolchain
- **Objective:** reproducible dev/build/test pipeline and design tokens in place.
- **Modules:** repo config (`package.json`, `tsconfig`, `vite.config.ts`), `src/styles/tokens.css`.
- **Depends on:** nothing.
- **Tests:** `npm run build` and `npm test` run green on the empty scaffold.
- **Done when:** a dev server renders the app shell; tokens are importable; lint/typecheck pass.

### M1 — Server connection & auth
- **Objective:** connect to a server, verify credentials, detect OpenSubsonic capabilities, persist session.
- **Modules:** `src/api/subsonic/*` (client, auth, typed responses), `src/state/auth`, connect screen, settings.
- **Depends on:** M0.
- **Tests:** unit — token/salt generation, request URL building, error-code mapping; integration — mocked `ping`/`getOpenSubsonicExtensions`; e2e — connect flow.
- **Done when:** valid credentials reach the Library; invalid ones show a specific, non-crashing error; capability flags are stored.

### M2 — Library browsing & search
- **Objective:** browse artists/albums/tracks/playlists/starred/recent; fast search over large libraries.
- **Modules:** `src/features/library/*`, `src/features/search/*`, `src/api/subsonic/endpoints`, virtualized grids/lists.
- **Depends on:** M1.
- **Tests:** unit — response mapping, pagination; integration — `getArtists`/`getAlbum`/`search3` mapping with mocks; perf — scroll a synthetic 10k-item list.
- **Done when:** navigation between all browse views works; search returns typed results; no dropped frames while scrolling.

### M3 — Playback engine & queue
- **Objective:** reliable playback independent of the UI; full transport controls; queue; session restore.
- **Modules:** `src/audio/*` (engine, queue, media session), `src/state/playback`, player bar + Now Playing.
- **Depends on:** M2.
- **Tests:** unit — queue reducer (next/prev/shuffle/repeat edge cases), resume logic; integration — engine event → store state; e2e — play an album, seek, switch repeat/shuffle.
- **Done when:** playback survives view navigation; queue and position restore after reload; no audio glitch during heavy UI work.

### M4 — Lyrics (MVP-critical)
- **Objective:** server-first lyrics with LRCLIB fallback, correct matching, sync highlight, seek, cache.
- **Modules:** `src/api/lyrics/*` (providers, registry, matcher, LRC parser, cache), `src/features/lyrics`.
- **Depends on:** M1 (server lyrics) and M3 (playback clock).
- **Tests:** unit — LRC parsing, duration matching/tolerance, cache keys, stale-response cancellation; integration — provider fallback order with mocked server + LRCLIB.
- **Done when:** lyrics render synced to the playhead, click-to-seek works, wrong-match guards reject remix/live/duration mismatches, and playback is never blocked by a lyrics request.

### M5 — Design system & polish
- **Objective:** apply the Liquid Glass system consistently; themes; motion; accessibility; empty/error states.
- **Modules:** `src/ui/*` (glass surfaces, buttons, lists, sliders), theme provider, motion layer.
- **Depends on:** M2–M4 surfaces exist.
- **Tests:** unit — component behavior/a11y roles; e2e — screenshot checkpoints, keyboard navigation, reduced-motion/transparency.
- **Done when:** light/dark themes match tokens; reduced-motion/transparency/contrast honored; all screens have empty/loading/error states.

### M6 — Performance, hardening, release readiness
- **Objective:** profile real bottlenecks, fix the biggest ones, finalize tests and docs.
- **Modules:** artwork cache, list virtualization, render profiling, error boundaries.
- **Depends on:** M5.
- **Tests:** perf — scroll, transitions, extended playback, memory; e2e — full smoke path.
- **Done when:** measurable budgets in TESTING.md are met and the smoke path passes without errors.

## 5. Success criteria (baseline)

- A user can connect, find music, play it, and read synced lyrics without a dead end.
- Playback continues unaffected by lyrics fetching, scrolling, or theme changes.
- Adding a new lyrics provider requires touching only the lyrics module (one file + registration).
- No verified-vs-assumed gap: every server call in API.md is documented from official sources.
