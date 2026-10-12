# Auralis — Current State Architecture

> Verified, as-implemented state of the codebase. This document captures what exists today based on code inspection (Phase 1 of the audit). All assertions are backed by actual files and behavior observed in the source.

_Last updated: October 12, 2026 (as found in the repository)_

## 1. What Works Today

Auralis is a production-ready web client for Navidrome/OpenSubsonic servers. The application is fully implemented and passing all tests.

### Authentication & Session (M1 - Complete)
- Subsonic token auth: `t = md5(password + salt)` with fresh salt per request (never sends plaintext `p`)
- Capability detection via `getOpenSubsonicExtensions` to discover OpenSubsonic features (e.g., `songLyrics`)
- Session persistence: optional "remember this device" stores session in IndexedDB; memory-only by default
- Account switching/sign-out properly clears cached data (lyrics, palettes, cover URLs)
- Validation with `ping` endpoint before storing session

### Library Browsing & Search (M2 - Complete)
- Browse: Artists, Albums, Recently Added (via `getAlbumList2` type=newest), Playlists, Favorites (`getStarred2`), Recent
- Artist → Album → Track detail navigation with proper routing
- Debounced search via `search3` with grouped results (artists/albums/tracks)
- Virtualized lists for large collections (tested with 10k items, renders only visible window)
- Cover art loading with lazy loading, caching, and CORS-aware extraction

### Playback Engine (M3 - Complete)
- Framework-free `AudioEngine` wrapping HTMLAudioElement (survives React re-renders)
- Full queue management: play tracks, shuffle, repeat (off/all/one), add next, add to queue, reorder, remove, jump
- Media Session API integration for OS-level controls (best effort)
- Session restore on reload (queue, index, position, volume, repeat/shuffle) — restored paused as browsers cannot auto-resume
- Smart play reporting: scrobbles at half track or 4 minutes (Subsonic `scrobble`), can be disabled in settings
- Robust error handling (network/decode/unsupported/blocked/auth) with user-friendly messages

### Lyrics System (M4, M6 - Complete)
- **Server-first**: tries server lyrics via `getLyricsBySongId` (if `songLyrics` capability) or `getLyrics`, falls back to LRCLIB
- **Spicy Lyrics** (word-synced) integration via backend bridge (`server/spicy.mjs`) holding secret key server-side only
- **Automatic Spotify matching** (via `server/spotify.mjs`) to find Spotify track IDs for Spicy Lyrics lookup
- LRC parsing with offset support, malformed line tolerance
- Synced lyrics: rAF-driven syllable highlighting with imperceptible per-frame updates, click-to-seek, manual scroll with "Back to current line" resume, follow playback toggle
- Matching guards to prevent wrong matches (duration tolerance, version tokens, title/artist normalization)
- Comprehensive caching (memory + IndexedDB) with bounded sizes and expiry
- Attribution shown for all lyric sources (required for Spicy Lyrics)

### Design System & UX (M5 - Complete)
- Liquid Glass design tokens (CSS custom properties)
- Light/Dark/System themes + 9 presets including Album Artwork dynamic theming
- Palette derivation from cover art with AA contrast enforcement
- Responsive layout: desktop sidebar rail (collapsible, persisted), mobile bottom tab strip
- Keyboard shortcuts (Space, arrows, N/P, /, Esc) with proper context handling
- Accessibility: axe-core clean, focus rings, ≥44px targets, reduced motion/transparency/contrast support
- Error boundaries, skeleton states, empty/error states throughout

### Backend Services
- `server/index.mjs`: Production server serving built app + API endpoints
- `server/spicy.mjs`: Spicy Lyrics bridge with validation, rate limiting, caching, CORS/same-site checks
- `server/spotify.mjs`: Spotify Client Credentials search with token caching and retry logic

## 2. Existing Architecture

As documented in ARCHITECTURE.md. Key points:
- Layered boundaries: `app/` → `features/` → `ui/` (presentational) → `state/` → `api/` and `audio/` (siblings)
- TanStack Query for server state (caching, dedup, aborts)
- Zustand for client state (playback, auth, settings, spotifyLinks, toast)
- HTMLAudioElement as source of truth for timing (playbackTime reads element directly for precision)

## 3. Verified Features

All major features from the original spec are implemented and tested:
- [x] Authentication with Subsonic token auth
- [x] Library browsing (artists, albums, playlists, favorites, recent, recently added)
- [x] Search with debounced queries
- [x] Playback engine with queue, shuffle, repeat, seek
- [x] Media Session integration
- [x] State persistence (session, playback queue, settings, theme, spotify links, palettes)
- [x] Lyrics with provider fallback chain (server → LRCLIB → Spicy)
- [x] Automatic Spotify matching for Spicy Lyrics
- [x] Word-synchronized lyrics with syllable highlighting
- [x] Dynamic Album Artwork theming
- [x] Responsive design with rail/collapsed modes
- [x] Keyboard shortcuts and accessibility

## 4. What the Codebase Reveals

### Strengths
1. **Robust error handling** - Every API call properly typed with error mapping; playback failures surface meaningful messages
2. **Non-blocking design** - Lyrics fetching never blocks playback; requests abort on track change
3. **Defense in depth** - Input validation, bounded caches, stale response discarding, untrusted data validation on restore
4. **Security-conscious** - Secrets never in client bundle (only in backend env vars), token auth, CORS/same-site checks on backend
5. **Well-tested** - 531 passing tests covering units, components, integration, and e2e smoke paths
6. **Performance-aware** - Virtualized lists, rAF for animations, memoization, bounded caches, render-scope optimization

### Known Limitations (as documented)
1. **Token auth URLs**: Stream/cover art URLs include auth params (can't use headers with HTML media elements) - reusable if leaked
2. **Password at rest**: "Remember this device" stores plaintext password in IndexedDB (needed for token generation) - documented, opt-in, clearable
3. **Spicy/Spotify require backend + credentials**: These are optional; app works without them, falling back to server/LRCLIB
4. **Virtualization**: Lists are virtualized but album grids are not (only lists beyond ~200 items)
5. **Browser-only**: Web SPA, requires modern evergreen browsers for backdrop-filter effects

### No Obvious Duplications/Broken Features
The codebase is coherent - no obviously broken or duplicate major features found. All major subsystems are integrated properly. Tests all pass.
