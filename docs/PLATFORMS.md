# Auralis on every platform

| Platform | Technology | Where | Status |
|---|---|---|---|
| Browser | React + Vite | `web/` | Working, tested (see below) |
| Linux, Windows | Tauri shell around its own build of the shared app core | `tauri/` | Debug build links on Linux (`tauri build --debug --no-bundle`); **not launched or played**; Windows untested |
| Android | Tauri mobile shell with the phone UI | `android/` | Release APK builds and signs (arm64); **not installed or played on a device in this change** |
| macOS 26+, iOS 26+ | Native SwiftUI + Liquid Glass | `macos/`, `ios/` | Built in CI (macOS universal + iOS simulator); **not run against a server in CI** |
| Lyrics backend | Node, dependency-free | `server/`, `Dockerfile` | Working locally, tested; **not deployed** |

macOS deliberately has no Tauri build.

```
shared/apple/AuralisKit  Foundation-only Swift package: models, Subsonic client, MD5 token auth, queue, lyrics providers + Spotify matching, artwork palette (shared by iOS + macOS)
shared/apple/AuralisUI   SwiftUI used by both apps: AppModel, PlayerModel (AVPlayer), views
macos/ , ios/            App entry point + platform shell (NavigationSplitView / TabView) and that app's XcodeGen spec (project.yml); the .xcodeproj is generated, not committed
shared/ui                Web app core (React): api, audio, state, features, ui, styles. Source only; each web-based platform builds its own bundle from it
web/                     Web entry point, Vite build, Playwright e2e
tauri/                   Tauri 2 desktop shell (Rust) + desktop entry point (loads frontend/dist)
android/                 Tauri 2 mobile shell (Rust + Gradle project in gen/android) + phone UI (frontend/)
server/                  Lyrics backend (Spicy Lyrics bridge + Spotify matching) and the Vite dev bridge
```

## Feature matrix (from repository evidence)

Legend: **Implemented** = code exists *and* was exercised by tests/running; **Partial**; **Planned**; **Unverified** = code exists, never run.

| Feature | Web | Linux/Windows (Tauri) | iOS / macOS (SwiftUI) |
|---|---|---|---|
| Playback (stream, pause, seek) | Implemented (HTMLAudio, 531 tests incl. fake audio) | Unverified (same code; webview audio codecs untested) | Unverified (AVPlayer code, never compiled) |
| Queue (next/prev, shuffle, repeat, play next, add) | Implemented | Unverified | Logic **Implemented** (Linux tests). Queue popover (jump, move, remove, clear): Unverified |
| Library browsing | Implemented | Unverified | Artists, Albums, Recently Added, Recent, Playlists, Favorites + detail pages, favourites, playlist editing: Unverified |
| Search | Implemented | Unverified | Unverified (search3) |
| Lyrics | Implemented (server → LRCLIB → Spicy word-synced) | Partial (needs `VITE_AURALIS_BACKEND_URL` + `AURALIS_ALLOWED_ORIGINS`; untested) | Parsing/matching **Implemented** (Linux tests); server, LRCLIB, Spicy + Spotify matching UI: Unverified |
| Authentication | Implemented (Subsonic token auth) | Unverified | Client logic **Implemented** (Linux tests); Keychain + UI Unverified |
| Media keys / lock screen | Partial (Media Session API, browser-dependent) | Unverified (Linux needs MPRIS from WebKitGTK; Windows SMTC from WebView2) | Unverified (MPRemoteCommandCenter + NowPlayingInfo written) |
| Background playback | n/a | Planned: investigate (window hidden/minimised behaviour untested) | Unverified (UIBackgroundModes=audio + `.playback` session) |
| Play reporting (scrobble) | Implemented | Unverified | Unverified |
| Audio effects (speed, pitch, reverb, EQ) | Implemented; real output measured in Chromium only (`web/e2e/effects.spec.ts`), Firefox/Safari untested. Pitch, reverb and EQ need CORS on the server's `stream`; pitch also needs HTTPS or localhost (AudioWorklet) | Unverified on every webview (same code; WebKitGTK/WebView2/Android WebView AudioWorklet and time-stretch untested; the worklet is a same-origin file, so the CSP allows it) | Not implemented (AVPlayer; would need AVAudioEngine with AVAudioUnitTimePitch/Reverb/EQ) |
| Social (activity, server chat, people, profiles) | Implemented; Chromium e2e against the mock server (`web/e2e/social.spec.ts`). Chat only where the server has the Subsonic chat room (not Navidrome) | Linux/Windows: Unverified. Android: same code in the phone UI (top-left button on every tab), in the built APK; **not run on a device** | Not implemented |
| Chat server (direct + group messages, `server/chat`) | Implemented; Chromium e2e against the real server + PostgreSQL (`web/e2e/chat.spec.ts`). Over https from an https page; plain http only to loopback, or to a LAN address from an http page with the explicit opt-in | Linux/Windows: Unverified (CSP allows `ws:`/`wss:`; LAN `http://` from the webview unmeasured). Android: same code in the phone UI (Settings → Chat server, Social); **not run on a device** | **Deferred** (CHAT.md Phase 12: Swift client, Keychain token; needs a Mac) |
| Settings / themes | Implemented (9 themes, persisted) | Unverified | All web settings + the same themes: Unverified |
| Persistence | Implemented (IndexedDB session, queue restore) | Unverified | Credentials (Keychain), settings, queue restore: Unverified |
