# Auralis — API

> Verified server operations, lyrics providers, matching, and limitations.
> **Rule: no endpoint here is invented.** Each is sourced from the official Subsonic API spec,
> the OpenSubsonic docs, the Navidrome compatibility docs/source, or LRCLIB's docs (see §9).
> Anything unverified is labelled **ASSUMED** and must be confirmed at implementation time.

## 1. Conventions

- **Base URL:** `{server}/rest/{endpoint}` (the `.view` suffix is optional and accepted).
- **Format:** `f=json` on every call; parse the top-level `subsonic-response` object.
- **Common params:** `u` (username), `v` (protocol version, use `1.16.1`), `c` (client id,
  `Auralis`), `f=json`.
- **Auth (token, required):** per request generate a random `salt` (≥6 chars) and send
  `s={salt}`, `t=md5(password + salt)` (lowercase hex, UTF-8). Never send `p` unless a server
  rejects token auth (pre-1.13 servers) — a clearly-labelled, guarded fallback only.
- **Errors:** inspect `subsonic-response.status` (`ok`/`failed`) and `error.code`.
  Key codes: `10` required param missing · `40` wrong username/password · `41` token auth not
  supported · `50` not authorized · `60` trial expired · `70` not found. Map to typed errors in
  `api/subsonic/errors.ts`; `40/41` → re-auth prompt; `70` → empty state, not an error banner.

### Capability discovery
- `getOpenSubsonicExtensions` (public, no auth) → list of `{name, versions[]}`. Store on the
  session. Presence of `songLyrics` ⇒ `getLyricsBySongId` is available. Presence of
  `apiKeyAuthentication` ⇒ API-key auth is available (future).
- `getLicense` / `ping` (auth) → server version + reachability; use `ping` to validate credentials.

## 2. Verified endpoint inventory (MVP)

All are Navidrome-compatible Subsonic v1.16.1 operations (Navidrome compat doc + `server/subsonic/api.go`).

| Purpose | Endpoint | Key params | Notes |
|---------|----------|-----------|-------|
| Validate auth | `ping` | — | Required before storing session. |
| Server info | `getLicense` | — | Server version/validity. |
| Extensions | `getOpenSubsonicExtensions` | — | Public; drives capability flags. |
| Browsing root | `getMusicFolders` | — | Usually one folder ("Music"). |
| Artists index | `getArtists` | `musicFolderId?` | Returns artists; preferred over `getIndexes`. |
| Artist detail | `getArtist` | `id` | Artist + albums. |
| Album detail | `getAlbum` | `id` | Album + songs. |
| Track detail | `getSong` | `id` | Single song. |
| Folder browse | `getMusicDirectory` | `id` | Fallback for folder-based browsing. |
| List albums | `getAlbumList2` | `type`, `size`, `offset`, `fromYear?`, `toYear?`, `genre?` | `type`: newest, recent, frequent, random, alphabeticalByName/Artist. |
| Starred | `getStarred2` | — | Artists, albums, songs. |
| Random | `getRandomSongs` | `size?`, `genre?` | Shuffle seeding. |
| By genre | `getSongsByGenre` | `genre`, `count?`, `offset?` | Optional browse. |
| Playlists | `getPlaylists` | — | List of playlists. |
| Playlist | `getPlaylist` | `id` | Ordered songs. |
| Now playing | `getNowPlaying` | — | Every user's current track (Navidrome: all users, filtered by library access; entries expire at track end). Social → Activity. **Used.** |
| Chat | `getChatMessages` / `addChatMessage` | `since?` / `message` | Server-wide room. **Navidrome answers 410**; Airsonic and some others implement it. Social → Chat, with an unavailable state. **Used.** |
| Search | `search3` | `query`, `artistCount?`, `artistOffset?`, `albumCount?`, `albumOffset?`, `songCount?`, `songOffset?` | OpenSubsonic uses `search3`; `search2` legacy, `search` returns 410. |
| Lyrics (by id) | `getLyricsBySongId` | `id`, `enhanced?` | Requires `songLyrics` extension. See §3. |
| Lyrics (legacy) | `getLyrics` | `artist?`, `title?` | Fallback. Returns plain `lyrics` only. |
| Stream | `stream` | `id`, `maxBitRate?`, `format?` | Binary audio; URL not JSON. |
| Cover art | `getCoverArt` | `id`, `size?` | Binary image; `size` is px. |
| Scrobble | `scrobble` | `id`, `submission` | `submission=false` ("now playing", visible to everyone on the server) only with *Share what I'm playing* on; `submission=true` at half the track or 4 min with *Report plays*. **Used.** |
| Star / unstar | `star`, `unstar` | `id`/`albumId`/`artistId` | Favorites. **Used.** |
| Create playlist | `createPlaylist` | `name`, `songId` (repeatable) | "Add to playlist → New playlist". **Used.** |
| Update playlist | `updatePlaylist` | `playlistId`, `songIdToAdd` / `songIndexToRemove` (repeatable) | Add a track; remove by position. **Used.** |
| Rating | `setRating` | `id`, `rating` | 0–5. |
| Play queue (server) | `savePlayQueue` / `getPlayQueue` | `id`, `current?`, `position?` | Optional cross-device queue; Auralis keeps its own state (local). |
| Scan status | `getScanStatus` | — | Optional; show library freshness. |
| User | `getUser` | `username?` | Returns authenticated user; roles reflect server capabilities. |

Explicitly **not implemented by Navidrome** (returns 501/410): podcasts, `search` (legacy),
videos/captions, chat, and user create/update/delete. Chat is the one Auralis calls anyway (it works on other servers):
the 410 is read as "this server has no chat", once per session.

### ID handling
Navidrome IDs are **opaque strings** (MD5/UUID). Never cast to number; never parse structure.

### Streaming & artwork URLs
`stream` and `getCoverArt` are binary and can't carry JSON errors. Because token auth needs a
fresh salt per request, URLs are generated on demand. For the `<audio>` element and `<img>`, embed
`u/t/s/v/c` in the URL query (they are not secrets beyond the hashed token) and regenerate on auth
change. Do not cache the token beyond its request.

## 3. Server lyrics (first provider)

Order of attempts:
1. If session has `songLyrics` capability → `getLyricsBySongId?id={id}` (omit `enhanced` for MVP;
   v1 response carries `line[]` and `synced`). Handle `lyricsList.structuredLyrics[]`.
2. Else → `getLyrics?artist={artist}&title={title}` (plain text only; parse as unsynced).

**Verified response model** (`structuredLyrics`): `lang`, `synced` (bool), `line[]` where each line
has `start` (ms, when synced) and `value`. Optional `offset` (ms) shifts all lines (+ = sooner).
`enhanced=true` adds `kind` (`main`/`translation`/`pronunciation`), `agents`, and word-level
`cueLine[]` with `byteStart`/`byteEnd` — **out of MVP scope** (A6).

Normalize to Auralis `Lyrics`:
```
{ synced: boolean, source: 'server', lines: [{ time: number|null, text: string }] }
```
Apply `offset` when present. Absence of `synced`/`start` ⇒ unsynced plain text.

## 4. LRCLIB (fallback provider)

Base: `https://lrclib.net/api`. **CORS verified live:** responses include
`access-control-allow-origin: *`, so direct browser calls work. Send an identifying
`User-Agent` (LRCLIB requests it); respect `retry-after` on `429`.

| Endpoint | Params | Use |
|----------|--------|-----|
| `GET /api/get` | `track_name` (req), `artist_name` (req), `album_name` (rec), `duration` (sec, rec) | Exact lookup. |
| `GET /api/get/{id}` | — | Fetch by stable id. |
| `GET /api/search` | `q` **or** `track_name` (+ `artist_name?`, `album_name?`) | Fallback when `/get` misses. |

**Verified record shape:** `id`, `name` (=`trackName`), `trackName`, `artistName`, `albumName`,
`duration` (sec), `instrumental` (bool), `hasWordSync`, `plainLyrics` (string|null),
`syncedLyrics` (LRC string|null), `lyricsfile`. Prefer `syncedLyrics`; else `plainLyrics`.
`instrumental: true` ⇒ render "Instrumental" (no lyrics), do not search further.
`/api/get` returns **404** when no exact match — treat as "try `/search`", not an error.

## 5. Matching (avoid wrong matches)

Applied in `api/lyrics/match.ts` before accepting any candidate (server or LRCLIB).

- Normalize: casefold, strip punctuation, collapse whitespace, drop `feat.`/`ft.` suffixes and
  bracketed qualifiers for the comparison keys.
- **Require** title + artist match (normalized). Album is a tie-breaker, not a gate.
- **Duration gate:** reject if `|candidate.duration − track.duration| > tolerance`
  (tolerance ≈ 3s; relax to ≈ 5s only when the title+artist match is exact). This is the primary
  guard against live/remix/extended versions.
- **Guard tokens:** if the track title contains `remix|live|acoustic|instrumental|cover|demo|edit`
  and the candidate's title/album does not share the same token, prefer/reject accordingly. Never
  accept a candidate that introduces a version token the track lacks.
- **ISRC:** no dedupe by ISRC in MVP — Subsonic exposes ISRC inconsistently and LRCLIB does not
  index it. **ASSUMED:** duration + normalized title/artist is sufficient; revisit if wrong-match
  reports appear.
- If no candidate passes, return "No lyrics found" (with source attribution and a refresh action).

## 6. Caching, dedup, timeouts, staleness

- **Key:** `lyrics:{provider}:{trackId}:{title|artist|duration}` for server; add duration for LRCLIB.
- **Cache layers:** TanStack Query (memory, `staleTime` long for lyrics) + IndexedDB persistence
  (`lib/storage`) keyed per track; survives reload.
- **Dedup:** TanStack Query dedupes identical in-flight keys; the registry also coalesces concurrent
  requests for the same track.
- **Timeout:** abort provider requests after ~6s (AbortController); on timeout, treat as not-found
  and surface a retry.
- **Staleness:** every lyrics request carries the `trackId` it was launched for; a response whose
  `trackId` ≠ the current track is discarded. Changing track aborts the prior request.
- **Never block playback:** lyrics is fully async and optional; the audio engine starts/stops
  independently of any lyrics request.
- **User control:** "External lookups" toggle disables the LRCLIB provider entirely (server-only);
  "Clear cached lyrics" purges the IndexedDB lyrics store.

### As built (M6)
- Lyrics cache entries are scoped by server + user + track (+ lookup mode). **Disconnecting or switching account clears
  the whole lyrics cache** along with the in-memory query cache; "Clear cached lyrics" does the same on demand.
- Cache bounds: 300 lyrics entries (oldest evicted), "not found" remembered for 24 h, failures never stored; 64 cover
  palettes (LRU); 2000 signed cover URLs.
- No endpoint is retried automatically. Provider timeouts (6 s) and LRCLIB `429` (honouring `retry-after`) end the
  attempt; the UI offers a manual retry.

## 6b. Spicy Lyrics (optional first provider, via our backend)

Sources: https://developers.spicylyrics.org/docs (+ `/docs/sync-sources`, `/docs/attribution`, `/docs/keys`, `/terms`).
Items marked **observed** are not in the docs; they come from calling the live API once with the project's key.

- `GET https://api.spicylyrics.org/v1/lyrics/{TRACK_ID}` with `Authorization: Bearer <secret key>`. The key is a *secret
  key* for "a server you control": **never** in client code (docs). Auralis therefore calls it only from
  `server/spicy.mjs`; the browser calls `GET /api/spicy/lyrics/{id}` on its own origin.
- **TRACK_ID** is a Spotify track id: 22 base62 characters (**observed**: `400 invalid_track_id` says so; the docs only
  show a placeholder). The API has no title/artist/ISRC lookup (docs re-checked 2026-10: one endpoint only), and
  Navidrome/OpenSubsonic expose no Spotify id (the `Child` song object has `musicBrainzId` and `isrc[]`, nothing else
  external). The id therefore comes from automatic matching (§6c) or a link the user makes; a user link always wins.
  As a sanity guard the normalizer still rejects lyrics that run more than 5 s past the track's duration.
- Response: `{ Body: { Type, Content, StartTime, EndTime, SongWriters, id, source, UploadAttribution? }, Status, Type }`.
  **Observed** for `Type: "Syllable"`: `Content[] = { Type: "Vocal", OppositeAligned, Lead: { Syllables[{ Text,
  IsPartOfWord, StartTime, EndTime }], StartTime, EndTime }, Background?: [{ Syllables[], … }] }`, times in **seconds**.
  `Line` and `Static` shapes are not documented; the parser handles inferred shapes and fails closed (null).
- Errors (**observed**): `400 invalid_track_id`, `404 lyrics_not_found`, `Ratelimit-*` headers (60 per window for this
  key). Docs give no error table; `429`, `401/403` are mapped defensively.
- **Sync sources** (`Body.source`): `spicy_lyrics` (community), `apple_music`, `spotify`; chosen by the API, not by us.
- **Attribution (binding, ToS §6):** always show the provider that answered; for `spicy_lyrics` also credit and link
  uploader and maker; on the same screen as the lyrics; if the source is missing say "an unknown source". Implemented in
  `LyricsView` (`Source`). Links are http(s) only and open with `rel="noopener noreferrer"`.
- **Caching (ToS §7):** caching "for your own application" is allowed; anything stored must be refetched or discarded
  within 30 days; no persistent mirror/archive; no downloader or redistribution (§5). Auralis: backend cache is memory-only
  (6 h, 500 entries); the browser's persistent lyrics cache expires found lyrics after **7 days** (all sources) and drops
  stale entries when it loads; disconnecting clears it. The backend never offers a bulk/raw export, only single-id lookups.
- Limits: the backend rate-limits each client (default 30/min, `SPICY_RATE_PER_MINUTE`), so one browser cannot exhaust the
  key's quota; the key's own limit is shown in the Spicy Lyrics dashboard.
- Provider order when the track has a Spotify id (linked or matched) and *External lookups* is on: **Spicy Lyrics →
  Navidrome → LRCLIB**; anything else is unchanged. Spicy Lyrics is skipped (silently) when there is no confident id, the
  user turned it off for the track, the setting is off, or the backend is missing or has no key.

## 6c. Automatic Spotify matching (via our backend)

Sources (checked 2026-10-12): Spotify Web API reference for `GET /search` and the Client Credentials tutorial
(developer.spotify.com), the February 2026 Development Mode migration guide and the February/March/July 2026 changelogs;
OpenSubsonic `Child` response (opensubsonic.netlify.app/docs/responses/child/); the Spicy Lyrics docs.

**Why Spotify's own API.** Options considered: (1) a Spotify id in library metadata: OpenSubsonic has none; (2) Spicy
Lyrics lookup by metadata: not offered; (3) Odesli/song.link (Deezer/Apple id → Spotify id): its keyless API is withdrawn
(**observed** 2026-10-12: `401 PUBLIC_API_ACCESS_DEPRECATED`), and chaining two third parties adds failure modes;
(4) MusicBrainz URL relationships: Spotify links on recordings are sparse. The Spotify Web API search is the only
legitimate, reliable source of Spotify ids, so Auralis uses it, server-side, with the user's own app credentials.

**Access requirements (verified, primary sources).**
- Client Credentials flow: `POST https://accounts.spotify.com/api/token`, `Authorization: Basic base64(id:secret)`,
  body `grant_type=client_credentials`; token valid `expires_in` (3600) seconds. No user login; only non-user endpoints.
- Since Feb/Mar 2026, Development Mode apps require the **app owner to have an active Spotify Premium subscription**
  (requests fail with 403 otherwise); new apps are limited in users (irrelevant here: no user login is used).
- `GET /v1/search?type=track&q=…&limit=…`: `limit` is now **0–10** (default 5). Field filters `track:`, `artist:`,
  `isrc:` are documented for tracks. `market` is optional.
- Track objects still carry `external_ids.isrc` (removed in Feb 2026, **reverted** in March 2026), `duration_ms`,
  `explicit`, `artists[]`, `album`. `popularity`/`available_markets`/`linked_from` were removed and are not used.
- Rate limits: a rolling 30-second window (not published as a number); `429` carries `Retry-After`. Since July 2026 the
  quota is counted per developer account and the 429 body may say `QUOTA_EXCEEDED`.

**Our endpoint.** `GET /api/spicy/match?title=…&artist=…&isrc=…` on the same backend as §6b, with the same guards
(same-site only, per-client rate limit). Only those three fields are accepted (each length-limited, none repeated); the
Spotify query is built server-side with query syntax (`"`, `:`) stripped from the text, so it is not a search proxy. It
tries `isrc:<ISRC>` (when the library has one), then `track:<title> artist:<artist>`, then free text, stopping at the first
query that returns tracks (≤3 upstream calls), and returns only `{id, name, artists[], album, albumType, durationMs,
explicit, isrc}`. Answers are cached in memory for 24 h (empty for 1 h) and concurrent identical lookups share one
upstream call; after a 429 it stops calling Spotify until `Retry-After` has passed. `/api/spicy/health` reports
`{ enabled, matching }`; `matching` is true only when both the Spicy key and the Spotify credentials are set.

**Scoring (`src/api/lyrics/spotifyMatch.ts`), every point explained by a signal.**
- Normalization: NFKD with Latin diacritics removed, case-fold, apostrophes dropped, `&`/`+` → `and`, punctuation to
  spaces. Featuring credits are removed from titles and artists. Bracketed or dash-suffixed qualifiers are split off
  the title; those naming a version are tokens, the rest stay part of the title ("(I Can't Get No) Satisfaction").
- **Hard rejections**: a *material* version on one side only (live, remix, acoustic/unplugged, instrumental/karaoke,
  demo, cover, extended, edit, sped up/slowed, orchestral, re-recorded/"Taylor's Version"; live also from album names
  like "Live at …"), a duration difference over 10 s, a different title, or no artist in common.
- **Score**: title 0.35 (0.28 when equal only without qualifiers) + artist 0.25 (whole credit, else primary artist 0.9×,
  else any shared artist 0.6×) + duration 0.25 (≤2 s full, ≤4 s 0.7, ≤7 s 0.35, ≤10 s 0.1) + album 0.15 (tie-breaker,
  never a gate) − 0.08 per *soft* version difference (remaster, mono, "version", "mix") − 0.15 when the library says
  explicit/clean and the candidate is the other. A matching **ISRC** with duration within 3 s scores 0.97 regardless of
  spelling (translations, transliterations).
- **Decision**: accept automatically only when the best score is ≥ 0.80, no *different* recording scores within 0.12 of
  it, and the artist is known (or the ISRC matched). Candidates that are the same recording (same ISRC, or same base
  title/version and duration within 1.5 s) are not rivals, so single/album/compilation duplicates don't cause a
  question. Otherwise, if anything scores ≥ 0.5 (or the artist is unknown), the distinct plausible recordings (≤5) are
  offered to the user; else "no match". Without a duration or an artist nothing is accepted without the ISRC.

**Client (`src/api/lyrics/resolve.ts`).** Runs only on track change when *External lookups* is on, the user has no
link of their own for the track, and the backend reports `matching`. Waits 300 ms first (rapid skipping never reaches
the network), 6 s timeout, cancelled when the track changes (a shared lookup is cancelled only when no caller wants
it), concurrent calls deduplicated. Results persist in IndexedDB keyed by server + user + track id + title/artist/
album/duration/ISRC/explicit: matches for 30 days, "no match"/"ambiguous" for 1 day, 1000 entries, failures never.
Cleared on sign-out and by *Clear cached lyrics*. A user's choice (from the chooser or a pasted link, or "off for this
track") is stored as a link (`state/spotifyLinks.ts`) and always wins.

**Data sent.** To our backend: title (without featuring credits), primary artist and the first ISRC. From the backend to
Spotify: the same, as a search query. Nothing else (no server address, user name or library ids).


## 7. Limitations & assumptions

- Navidrome compatibility target is Subsonic **v1.16.1** (per Navidrome docs); other servers may
  support less. Detect via `getOpenSubsonicExtensions` and degrade gracefully.
- `getLyrics` (legacy) is unsynced only.
- Word-level sync (`cueLine`) exists in OpenSubsonic `songLyrics` v2 but is **out of MVP scope**.
- LRCLIB lyrics are community-contributed; quality varies. Attribution + graceful "not found" is
  mandatory. LRCLIB coverage for obscure/self-hosted-only material may be low.
- **ASSUMED:** Navidrome's default CORS is `*` (source-confirmed) but a reverse proxy that also sets
  `Access-Control-Allow-Origin` can break CORS; document this for users.
- **ASSUMED:** audio codecs supported by the user's browser are the ceiling; transcode-quality UI
  is deferred (server default transcode applies).
- Scrobbling: Auralis sends `scrobble` with `submission=false` when a track starts and once with
  `submission=true` after half the track (capped at 4 minutes), the long-standing Last.fm rule that Subsonic
  servers expect. It is fire-and-forget: a server without `scrobble` just answers an error, which is ignored.
  Settings → Playback → "Report plays to your server" turns it off. Last.fm/ListenBrainz forwarding is
  Navidrome-side, not client-side.
- Favourites and playlist edits go through the one `getStarred2` / `getPlaylists` cache the browse views already
  use, so a change made anywhere is reflected everywhere. `star`/`unstar` use `id` for songs and `albumId`/
  `artistId` for ID3 albums and artists, as the spec requires. Known cost: each toggle refetches `getStarred2`,
  which returns the user's whole starred library.

## 8. Future enhancements (not MVP)
- OpenSubsonic API-key auth (`apiKeyAuthentication`) to avoid storing passwords at all.
- Navidrome **native** REST API (`/api/*`) for features Subsonic lacks (e.g. richer play stats),
  gated behind server-type detection.
- `getPlayQueue`/`savePlayQueue` for cross-device queue continuity.
- `enhanced=true` word-level lyrics.
- A metadata-only Spotify-id source that needs no account (none exists that is legitimate and reliable as of 2026-10).

## 9. Sources
- Subsonic API (auth, common params): https://www.subsonic.org/pages/api.jsp
- OpenSubsonic `getLyricsBySongId`: https://opensubsonic.netlify.app/docs/endpoints/getlyricsbysongid/
- OpenSubsonic `getLyrics`: https://opensubsonic.netlify.app/docs/endpoints/getlyrics/
- OpenSubsonic `structuredLyrics` + `songLyrics` extension (v1/v2): opensubsonic.netlify.app/docs/responses/structuredlyrics/
- Navidrome Subsonic compatibility: https://www.navidrome.org/docs/developers/subsonic-api/
- Navidrome route table / CORS: `navidrome/server/subsonic/api.go`, `navidrome/server/middlewares.go`
- LRCLIB API docs: https://lrclib.net/docs
- Spicy Lyrics API: https://developers.spicylyrics.org/docs
- Spotify search: https://developer.spotify.com/documentation/web-api/reference/search
- Spotify Client Credentials: https://developer.spotify.com/documentation/web-api/tutorials/client-credentials-flow
- Spotify Feb 2026 Development Mode changes: https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide
  (+ changelogs: …/references/changes/march-2026, …/references/changes/july-2026)
