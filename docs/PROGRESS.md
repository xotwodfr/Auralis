# Progress log

## 2026-10-12 (Linux session)

### Done
- `eslint.config.js`: ignore `src-tauri/target`, `src-tauri/gen`, `apple/AuralisKit/.build` (lint was failing on a generated Tauri file).
- `shell.nix` (new): reproducible Tauri dev shell (Rust, WebKitGTK 4.1, GTK3, libsoup3, GStreamer good/bad/libav).
- `src-tauri/src/main.rs`: on Linux, default `WEBKIT_DISABLE_DMABUF_RENDERER=1`. Without it the window crashed here (Wayland protocol error / GBM buffer failure).

### Commands actually run (results)
| Command | Result |
|---|---|
| `npm run typecheck` / `npm test` / `npm run build` | pass (532 tests, 35 files) |
| `npm run lint` | pass after ignore-list fix |
| `nix-shell --run 'cd src-tauri && cargo build'` | pass (debug) |
| debug binary + `npm run dev`, Hyprland/Wayland | window opens, connect screen renders (screenshot); stays up 12s+ |

### Not verified
- `cargo tauri build` (release bundle, deb/AppImage). Debug binary loads `devUrl` (needs `npm run dev`).
- Sign-in against a real Navidrome server, library, queue, real audio playback, MPRIS/media keys from the desktop shell.
- Windows build (needs a Windows machine). Swift/Xcode: `swift`/`xcodebuild` not installed here; nothing under `apple/` compiled.
- Mica/Acrylic/Linux blur: not started.

### Next
1. Release build: `nix-shell --run 'cd src-tauri && cargo install tauri-cli --version "^2" --locked && cargo tauri build'`.
2. Manually sign in to Navidrome in the desktop window and play a track; check MPRIS (`playerctl status`).
3. Windows: `window-vibrancy` crate for Mica/Acrylic, on a Windows machine.
4. Xcode 26 pass on the Hackintosh per `docs/APPLE.md`.

- `.github/workflows/ci.yml` added (2026-10-12): web, Linux Tauri `cargo check`, and macOS Xcode build + AuralisKit tests. **Never run yet**; it only executes once pushed to GitHub. The `macos-26` runner label is unconfirmed.

### Live Navidrome check (2026-10-12, web app in Chromium, not the Tauri window)
- `ping`, `getAlbumList2`, CORS preflight against the real server (Navidrome 0.64.0, OpenSubsonic, `Access-Control-Allow-Origin: *`): OK.
- Playwright driving `npm run dev`: sign-in → Artists → Albums grid → play: track started and the progress bar advanced (0:05 / 3:28, screenshot). Chromium came from `nix-shell -p chromium`; Playwright's bundled browser cannot run on NixOS.
- **Still unverified:** the same flow inside the Tauri/WebKitGTK window (audio codecs via GStreamer, MPRIS), queue next/prev, lyrics. Credentials were passed via env vars only and are not stored in the repo.

### Live queue + lyrics check (2026-10-12, web app in Chromium against the real Navidrome)
- Next → different track; Previous → back to the first; Pause/Play toggle; queue panel lists 8 rows; jumping to row 3 played "Peace Sign"; no HTTP >= 400 responses, no page errors.
- Lyrics page: 77 lyric lines, word-synced highlighting, attributed "Apple Music (via Spicy Lyrics)", served by the local Vite dev bridge (`server/spicy.mjs` plugin). Not tested: the standalone `server/index.mjs` production path, or the Tauri window.
- Not verified: seek-bar scrubbing, shuffle/repeat behavior, audible output, media keys.

### Live seek / shuffle / repeat + production server (2026-10-12)
Run against the real Navidrome with the built app served by `node --env-file-if-exists=.env server/index.mjs` (port 8787, Spicy bridge enabled), headless Chromium:
- Seek: set to 103s, position 106s three seconds later.
- Shuffle: pressed, queue order changed, same set of tracks, current track kept.
- Repeat cycle off -> all -> one -> off. Repeat one at track end restarted the same track; repeat off at track end advanced to the next track.
- Lyrics via the production server: 67 lines, attributed to Apple Music (via Spicy Lyrics). No HTTP >= 400, no page errors.
- Still unverified: the Tauri/WebKitGTK window, audible output, media keys, Docker image of the server.

### Lyrics backend Docker image, run locally (2026-10-12)
`docker build -t auralis-backend .` succeeded. Ran with `--read-only --cap-drop ALL --security-opt no-new-privileges --env-file .env -e SPICY_RATE_PER_MINUTE=6 -e AURALIS_ALLOWED_ORIGINS=tauri://localhost`, bound to 127.0.0.1:18787:
- Health check reports `healthy`; `/api/spicy/health` -> `{"enabled":true,"matching":true}`; runs as uid 1000; writes to `/app` fail (read-only).
- 405 on POST, 403 on `Sec-Fetch-Site: cross-site`, 400 on bad track id / query on lyrics / missing title / unknown field / over-long title, 404 on unknown path.
- CORS: `access-control-allow-origin` returned only for the allowed origin, never for others.
- Rate limit: 429 after the configured limit; recovered after the window.
- Real data: `/match?title=Peace Sign&artist=Usher` returned the Spotify candidate; `/lyrics/<id>` returned word-synced (`Syllable`) lyrics. Secrets did not appear in container logs.
- Not tested: `docker compose up` itself, behind cloudflared/HTTPS, on `alwaysonpc`. Nothing was deployed. Startup logs a harmless "dist/ not found" because the image is API-only.

- `docs/BACKEND.md` deployment section rewritten as a step-by-step runbook for `alwaysonpc` (Arch prerequisites, secrets, compose, tunnel via config file or dashboard, allowed origins, verification, update/rollback). **Not executed.** It flags a likely rate-limit bypass via client-supplied `X-Forwarded-For` (unverified; code unchanged).

- `server/spicy.mjs` `clientKey`: with `TRUST_PROXY=1` now uses `CF-Connecting-IP`, else the last `X-Forwarded-For` entry (was the first, caller-controlled). Two new tests in `tests/integration/spicy-server.test.ts`; both fail on the old logic and pass on the new. Not yet checked through a real Cloudflare Tunnel.

## 2026-10-12 (Linux release + WebKitGTK playback pass)

### Done
- `shell.nix`: added `cargo-tauri` (nixpkgs, 2.11.0) to `nativeBuildInputs`; no npm dependency added.
- **Defect found and fixed:** under Wayland `gdk_screen_get_resolution()` returns -1, so WebKitGTK computed `devicePixelRatio = -1/96` and laid pages out at negative width (the connect panel rendered ~110px wide, unstyled-looking). Reproduced on `about:blank` in a bare WebKit2 view. Fix in `src-tauri/src/main.rs`: on Linux, `gtk::init()` then set the screen resolution to 96 when it is <= 0. Added `gtk = "0.18"` as a Linux-only dependency in `src-tauri/Cargo.toml` (same version Tauri already pulls in; no second copy). After the fix the packaged window renders the connect card correctly (screenshot checked).
- No regression test: this is native-shell behaviour that no jsdom/Vitest test can exercise.

### Release build (verified)
- `nix-shell --run 'cargo tauri build --bundles deb'` -> `src-tauri/target/release/bundle/deb/Auralis_0.1.0_amd64.deb` (3.1 MB, rebuilt after the fix). Release binary: `src-tauri/target/release/auralis-desktop`.
- **AppImage fails on NixOS**: `cargo tauri build --bundles appimage` -> `failed to run linuxdeploy` (it downloads a prebuilt linuxdeploy AppImage, which does not run on NixOS without FUSE/ld shims). Not an app defect; build it on a normal distro or CI. No `.AppImage` exists.
- The release binary was launched from the nix-shell under Hyprland/Wayland and stays up. The `.deb` itself was not installed.
- Warning left alone: `STATIC_VCRUNTIME is deprecated` (Windows-only; from `build.rs`).

### Playback in WebKitGTK (what was and was not tested)
- **No Navidrome credentials were available in this session** (no env vars, `.env` only holds lyrics keys), so the real server was NOT used. Everything below used `e2e/mock-server.mjs` (WAV audio) served through `server/index.mjs`.
- The Tauri window itself was not driven (no input tooling in the session; WebKit's inspector port is not HTTP/CDP). Instead the same engine, WebKitGTK 4.1 from the same nixpkgs, ran in a minimal PyGObject WebView harness (scripts kept in the session scratchpad only, not in the repo). The harness sets `media-playback-requires-user-gesture=false` because scripted clicks are not user gestures; with real clicks the Tauri window is unaffected.
- Results: sign-in and album browse; play advanced `currentTime` (0.9 -> 4.9 s); pause held the position; resume continued; seek to 25 s landed on 26.97 s; next/previous changed tracks; no `MediaError`. `canPlayType`: mp3/flac/wav "maybe", ogg-vorbis/opus, AAC-in-mp4, webm-opus "probably". GStreamer logged only benign warnings (invalid stream-id, temp-file cleanup).
- Audio output: PipeWire showed the WebKit stream as `running` on the default analog sink during playback, i.e. audio was routed to hardware. I cannot hear it, so "audible" is inferred from that, not confirmed by ear.
- MPRIS: WebKitGTK registers `org.mpris.MediaPlayer2.*` itself from `navigator.mediaSession` (title, album, length, artwork). `busctl --user call ... Pause / Play / Next / Previous` each controlled the app. Real media keys and `playerctl` (not installed) were not tried.
- Not tested: shuffle/repeat, lyrics, real-codec files (FLAC/Opus from a real library) in WebKitGTK.

### Windows / Linux visual effects (not implemented)
- Tauri 2 can do Mica/Acrylic without a new crate via `windowEffects` in `tauri.conf.json` plus `"transparent": true`; this needs the web UI backgrounds to become translucent, which is a design change, so it was not attempted. Verify on Windows: `npm ci && npx tauri build --bundles nsis` (or `cargo tauri build`). Nothing Windows-specific was compiled.
- Linux blur is a compositor rule (Hyprland: `windowrulev2 = blur, class:auralis-desktop`) and also needs a transparent window; keep the solid fallback.

### Apple
- `swift` and `xcodebuild` are not installed; nothing under `apple/` was compiled or reviewed this pass. Steps remain as in `docs/APPLE.md` on the Hackintosh.

### Checks run (all pass)
`npm run typecheck`, `npm test` (35 files, 534 tests), `npm run build`, `npm run lint`; `cargo tauri build` (release).

### Next
1. Sign in to the real Navidrome inside the Tauri window by hand (credentials in the form only); confirm real-codec playback, shuffle/repeat, lyrics, and `playerctl`/media keys.
2. Decide on a translucent-window design before adding Mica/Acrylic/blur.
3. Xcode 26 pass on the Hackintosh.

## 2026-10-12 (Navidrome "Couldn't reach the server" in the Linux desktop app)

### Cause
- The server is fine: `/ping` and `/rest/ping.view` return 200 over HTTPS; `Access-Control-Allow-Origin: *`; a request with `Origin: tauri://localhost` gets a normal Subsonic JSON reply. URL normalization and request building are fine.
- WebKitGTK (libsoup 3) needs the GIO TLS backend `glib-networking`. On NixOS it is only found through `GIO_EXTRA_MODULES`, which the dev shell exports; a binary launched outside the shell has none, so every `https://` `fetch()` fails with "Load failed" and the app maps that to the generic network error.
- Reproduced with a WebKitGTK 4.1 test window serving `dist/` from a `tauri://localhost` origin and the app's real login form, against `https://navidrome.folk3s.com`: with `GIO_EXTRA_MODULES` empty -> the exact error from the report; with it set -> login succeeds and the Artists page loads. (Credentials were passed by environment variable only and are not stored anywhere in the repo.)
- Not verified: the packaged Tauri window itself (typing into it with `wtype` did not reach the webview), so the final fix is proven by the build-time/runtime logic and the harness, not by driving the release window.

### Fix
- `src-tauri/build.rs`: remembers `GIO_EXTRA_MODULES` at build time when it points at glib-networking (`AURALIS_GIO_EXTRA_MODULES`).
- `src-tauri/src/main.rs` (Linux): sets `GIO_EXTRA_MODULES` from that value when unset, before GTK starts; then warns on stderr if GIO still has no TLS backend. The release binary now contains the store path (checked with `strings`), and starting it with `GIO_EXTRA_MODULES` unset prints no TLS warning. Limit: the baked path is Nix-store specific, fine for this project; other distros ship the module in the system path.
- `src/api/subsonic/client.ts`: in dev only, `console.debug` of endpoint plus network error, HTTP status, or non-JSON response. It never logs the URL, token, or password.
- `src/features/connect/errorMessage.ts`: inside Tauri the network error also names the missing TLS library (glib-networking / nix-shell).
- Tests: `tests/integration/client.test.ts` (dev diagnostics, no secret leakage) and new `tests/unit/connect-error-message.test.ts`. No TLS verification was weakened; no server config touched.

### Results
`npm run typecheck`, `npm test` (36 files, 537 tests), `npm run build`, `npm run lint` pass; `cargo tauri build --bundles deb` succeeds, `.deb` at `src-tauri/target/release/bundle/deb/Auralis_0.1.0_amd64.deb`.

## 2026-10-12 (TLS backend, second pass: baked path no longer depends on an exported env var)

### Evidence from the user's run
Packaged binary printed `no GIO TLS backend found` and GIO chose `GDummyTlsBackend`; DNS/TCP fine. The earlier `build.rs` only baked `GIO_EXTRA_MODULES` if the build shell had exported it with a glib-networking path, so a build outside that exact condition embedded nothing.

### Changes
- `shell.nix`: `AURALIS_GIO_EXTRA_MODULES = "${pkgs.glib-networking}/lib/gio/modules"` as a derivation attribute (always present in the shell; `glib-networking` was already a buildInput). No flake exists in the repo.
- `src-tauri/build.rs`: reads that variable, bakes it only if `libgiognutls.so` is in the directory, otherwise emits a `cargo:warning` (missing var or missing module). Fails soft on purpose so non-Nix Linux builds still work.
- `src-tauri/src/main.rs`: before GTK/GIO start, appends the baked directory to any existing colon-separated `GIO_EXTRA_MODULES` (no overwrite, no duplicate). Unit tests `merge_module_paths` (2 tests, `cargo test` pass).
- The directory contains `libgiognutls.so` and a `giomodule.cache`, so no extra cache step is needed.

### Verification
- Built from `nix-shell` with `GIO_EXTRA_MODULES` unset: `cargo clean -p auralis-desktop --release`, `cargo tauri build --bundles deb` -> `src-tauri/target/release/bundle/deb/Auralis_0.1.0_amd64.deb`.
- `env -u GIO_EXTRA_MODULES GIO_DEBUG=modules G_MESSAGES_DEBUG=all ./src-tauri/target/release/auralis-desktop` (outside the nix-shell): main and WebKit processes both log `Found default implementation gnutls (GTlsBackendGnutls) for 'gio-tls-backend'`; no dummy backend; the "no GIO TLS backend" warning is gone.
- Packaged window, launched the same way: it restored an existing saved session for navidrome.folk3s.com and showed the library UI, player bar with artwork, and a search result page for text typed via `wtype` ("No results", no network error). So HTTPS requests to the server worked from the packaged app. I did **not** perform a fresh sign-in from the connect form in the packaged window, and the saved credentials were not touched or recorded.
- WebKitGTK 4.1 harness: `GET https://navidrome.folk3s.com/rest/ping.view` from a `tauri://localhost` origin returned HTTP 200 with a Navidrome reply (that run used the nix-shell GIO env, so it proves the server side, not the baked path).
- `npm run typecheck`, `npm test`, `npm run build`, `npm run lint`, `cargo check`, `cargo test`: pass.

## 2026-10-12 (GStreamer plugins outside nix-shell)

### Cause
`appsink` is in gst-plugins-base (`libgstapp.so`) and `autoaudiosink` in gst-plugins-good (`libgstautodetect.so`); both were already shell `buildInputs`, but a binary launched outside the shell has no `GST_PLUGIN_*` variables, so WebKit's media player could not create them.
The two `GLib-GObject-CRITICAL` lines (`invalid (NULL) pointer instance`, `g_signal_connect_data`) are consistent with WebKit connecting a signal on an element that failed to be created. After the fix they no longer appear (0 matches for `CRITICAL`/`not found` in the run log). I did not re-run the old binary to prove the link, so that attribution is inferred from the before/after logs, not isolated.

### Changes (Linux only; `build.rs` gates on `CARGO_CFG_TARGET_OS == linux`, so Windows/macOS builds are untouched)
- `shell.nix`: `AURALIS_GST_PLUGIN_PATH` (search path of gstreamer, base, good, bad, libav `lib/gstreamer-1.0`) and `AURALIS_GST_PLUGIN_SCANNER` (`gstreamer.out/libexec/.../gst-plugin-scanner`; the default `-bin` output does not contain it, which `build.rs` flagged).
- `src-tauri/build.rs`: generic `bake()` for GIO + GStreamer vars; checks `libgiognutls.so` / `libgstapp.so` / the scanner file exist and emits a `cargo:warning` otherwise. Previous GIO TLS behavior is unchanged.
- `src-tauri/src/main.rs`: before GTK/GStreamer start, merges the baked dirs into `GST_PLUGIN_PATH_1_0` (additive, existing entries kept, no duplicates) and sets `GST_PLUGIN_SCANNER` only if unset. `merge_module_paths` now handles lists; unit tests extended (`cargo test` 2 pass).

### Verification
- Built in `nix-shell` with `GIO_EXTRA_MODULES` unset: `cargo tauri build --bundles deb` -> `src-tauri/target/release/bundle/deb/Auralis_0.1.0_amd64.deb`; no build warnings besides the pre-existing `STATIC_VCRUNTIME` one; the binary contains the base/good plugin dirs and the scanner path.
- Launched `src-tauri/target/release/auralis-desktop` outside the shell with `GIO_EXTRA_MODULES`, `GST_PLUGIN_SYSTEM_PATH_1_0`, `GST_PLUGIN_PATH_1_0`, `GST_PLUGIN_SCANNER`, `GST_PLUGIN_PATH` unset and `GST_DEBUG=2`. The saved session restored; pressing Space started "Casual" (Chappell Roan) from the real Navidrome over HTTPS with synced lyrics; the position advanced 0:55 -> 1:10; PipeWire showed a `running` output stream owned by `auralis-desktop`'s `WebKitWebProcess`. No "element not found" and no CRITICAL lines. I can't hear the output; the running PipeWire stream is the evidence.
- Remaining GStreamer log noise is benign/optional-plugin: jack, VA-API NVDEC, LADSPA, nvav1encoder, invalid stream-id, temp-file removal. Also three `flacdec: Lost sync, flushing decoder` warnings during playback of real FLAC; playback continued, but this was not investigated (likely seek/range related).
- `npm run typecheck`, `npm test` (537), `npm run build`, `npm run lint`, `cargo check`, `cargo test`: pass.

## 2026-10-12 (automatic Spotify match for Spicy lyrics missing in the desktop app)

### Root cause
- Not a matching or provider regression. With the backend reachable, `/api/spicy/match` returned the right Spotify ids (Casual, Peace Sign, plus feat./remix/remaster title variants) and `/api/spicy/lyrics/<id>` returned word-synced lyrics. Served same-origin, the web app matched automatically.
- The packaged Tauri build had **no backend URL**. `VITE_AURALIS_BACKEND_URL` was unset when `cargo tauri build` ran, so `useLyricsBackend` asked `tauri://localhost/api/spicy/health`. Tauri's asset handler answered with a non-JSON 200, the app treated that as "no backend" (`matching: false`), and it silently skipped Spotify matching and showed "Lyrics from your server". Reproduced in a WebKitGTK window on a `tauri://localhost` origin; the only `/api/spicy` request was that health check. Navidrome playback and server lyrics were unaffected throughout.
- The Spicy key and Spotify client secret are server-side by design, so the desktop app needs a backend. No deployed backend exists (`lyrics.folk3s.com` and similar don't resolve), so the local `server/index.mjs` was used.
- Second, real bug found while testing: `/api/spicy/*` responses are cacheable (`max-age=300`) but sent `Vary: Origin` only to allowed origins. A copy cached from a same-origin request (no CORS header) was reused by WebKit for the `tauri://localhost` page and rejected ("Origin tauri://localhost is not allowed by Access-Control-Allow-Origin"). This would also bite behind Cloudflare.

### Changes
- `server/spicy.mjs`: every `/api/spicy/*` response sends `Vary: Origin`. `Access-Control-Allow-Origin` is still sent only to allow-listed origins.
- `src/features/lyrics/useLyrics.ts` + `LyricsView.tsx`: distinct states in the Spicy panel. "· no lyrics backend, so no automatic Spotify match" when the health check fails, and "· Spotify lookup failed, try Refresh" for a failed match request. These stay separate from "· no Spotify match", "· matched automatically", and so on.
- Tests: `tests/integration/spicy-server.test.ts` (Vary on plain and allowed-origin responses) and `tests/integration/spotify-auto.test.tsx` (missing backend, failed lookup vs no match, query construction drops a bracketed feat. credit and secondary artists but keeps "(Club Remix)"). Existing matching unit tests already cover feat./remix/live/remaster titles.

### Verification
- WebKitGTK harness against the real Navidrome (`subwave` account, credentials only in env vars) and the local backend (`AURALIS_ALLOWED_ORIGINS=tauri://localhost node --env-file-if-exists=.env server/index.mjs`):
  - Web, same origin: Casual matched automatically, Spicy lyrics (uploader credit).
  - `tauri://` origin, build with `VITE_AURALIS_BACKEND_URL=http://127.0.0.1:8787`, after a same-origin visit had warmed the cache (exercises the Vary fix): Casual -> Spotify `3WSOUb3U7tqURbBSgZTrZX`, Spicy lyrics; Peace Sign -> `3DlGY66fukwF71OYNLylxc`, Apple Music via Spicy. health/match/lyrics all 200 JSON.
  - `tauri://` origin, build without a backend URL: server lyrics plus the new "no lyrics backend" status.
- **Packaged app**: `VITE_AURALIS_BACKEND_URL=http://127.0.0.1:8787 cargo tauri build --bundles deb` (in nix-shell). Launched outside the shell: Casual showed "Lyrics from Spicy Lyrics (via Spicy Lyrics) · Uploader: pinkweddings!" with mid-word highlighting at 1:19. MPRIS `Next` -> "Super Graphic Ultra Modern Girl" showed "Lyrics from Apple Music (via Spicy Lyrics)", word-synced at 0:11.
- `npm run typecheck`, `npm test` (36 files, 541 tests), `npm run build`, `npm run lint`, `cargo check`, `cargo test` (2): pass.

### Note on the current artifacts
`dist/` and `src-tauri/target/release/bundle/deb/Auralis_0.1.0_amd64.deb` were built with `VITE_AURALIS_BACKEND_URL=http://127.0.0.1:8787`. Word-synced lyrics in that build need the backend running locally: `AURALIS_ALLOWED_ORIGINS=tauri://localhost node --env-file-if-exists=.env server/index.mjs`. Without it the app falls back to server/LRCLIB lyrics and says why. For a deployed backend, rebuild with its HTTPS URL (see `docs/DESKTOP.md`).

## 2026-10-12 (configurable lyrics server, deployment docs)

### Changes
- `src/lib/backend.ts`: server address resolved at call time: saved user URL, then `VITE_AURALIS_BACKEND_URL`, then `https://lyrics.folk3s.com` for production builds, then same origin (dev/`npm start`). `parseServerUrl` accepts only http(s), strips trailing slashes, rejects credentials/query/fragment. `backendUrl` throws on a Tauri origin with no server instead of asking the asset handler.
- `src/state/settings.ts`: `lyricsServerEnabled` and `lyricsServerUrl`, persisted with the existing settings store (same mechanism on Linux, macOS, Windows and web).
- `src/features/lyrics/useLyricsBackend.ts`: `probeLyricsServer` (8 s timeout; distinct messages for unreachable/CORS, timeout, HTTP error, not-an-Auralis-server; accepts 503 JSON). Query keyed by URL, idle when the server is switched off.
- Settings → Lyrics: on/off, address field, Save, Test connection, Use default. `useLyrics` skips Spicy and Spotify matching when off; Navidrome and LRCLIB fallback unchanged. Existing distinct states kept (no server, Spotify lookup failed, no match, none for this recording).
- `server/spicy.mjs`: health is 503 (same JSON) when the key is missing; `Content-Length` precheck on the upstream body. `server/index.mjs`: without `dist/` (the Docker image) non-API paths return 404 JSON (previously an unhandled stream error could crash the process); header/request timeouts. `.env.example`, `docs/BACKEND.md` (lyrics.folk3s.com, Caddy proposal), `docs/DESKTOP.md` updated. Dockerfile and compose already bound loopback, so unchanged.

### Verification
- `npm run typecheck`, `npm run lint`, `npm run build`: pass. `npm test`: 37 files, 562 tests pass (new: URL parsing, probe error states, health status, desktop-origin CORS). `cargo check` and `cargo test` (2 tests) pass inside `nix-shell`.
- Local server (`127.0.0.1:8799`, real keys from `.env`): health 200; `tauri://localhost` and `http://tauri.localhost` get `Access-Control-Allow-Origin` plus `Vary: Origin`; an unlisted origin gets 403. Match returned Spotify ids for Casual (`3WSOUb3U7tqURbBSgZTrZX`) and lyrics returned 200; Peace Sign (`3DlGY66fukwF71OYNLylxc`) returned a word-synced `Syllable` body.
- API-only run without `dist/`: `/` 404 JSON, process stays up, health 503 without a key.
- Secret scan: the three values in `.env` are absent from `dist/`. The packaged desktop artifact was **not** rebuilt or scanned this round.

### Not done / limitations
- Nothing deployed; `lyrics.folk3s.com` was not tested (no deployment authorized). The Cloudflare/Caddy changes are proposals in `docs/BACKEND.md`.
- Not tested: the 8 s probe timeout path, the Settings form in a real browser/webview, the Tauri-origin guard in `backendUrl` (jsdom cannot set the origin), fallback to Navidrome/LRCLIB with a dead server beyond existing tests, Windows/macOS builds.
- `docker build` was not re-run after the `server/index.mjs` change.
- An `https://` page cannot call an `http://` server (mixed content); the Settings error will read as "couldn't reach".
- Native SwiftUI apps still don't use this backend; no shared token (rate limiting only).
