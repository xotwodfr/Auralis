# Auralis on every platform

| Platform | Technology | Where | Status |
|---|---|---|---|
| Browser | React + Vite | `src/` | Working, tested (see below) |
| Linux, Windows | Tauri shell around the same web app | `src-tauri/` | `cargo check` passes on Linux; **not built, launched or played**; Windows untested |
| iOS 26+, macOS 26+ | Native SwiftUI + Liquid Glass | `apple/` | Built in CI (macOS universal + iOS simulator); **not run against a server in CI** |
| Lyrics backend | Node, dependency-free | `server/`, `Dockerfile` | Working locally, tested; **not deployed** |

macOS deliberately has no Tauri build.

```
apple/AuralisKit   Foundation-only Swift package: models, Subsonic client, MD5 token auth, queue, lyrics providers + Spotify matching, artwork palette (shared by iOS + macOS)
apple/Shared       SwiftUI used by both apps: AppModel, PlayerModel (AVPlayer), views
apple/iOS|macOS    App entry point + platform shell (TabView / NavigationSplitView)
apple/project.yml  XcodeGen spec; the .xcodeproj is generated, not committed
src-tauri/         Tauri 2 shell (loads ../dist)
server/            Lyrics backend (Spicy Lyrics bridge + Spotify matching)
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
| Settings / themes | Implemented (9 themes, persisted) | Unverified | All web settings + the same themes: Unverified |
| Persistence | Implemented (IndexedDB session, queue restore) | Unverified | Credentials (Keychain), settings, queue restore: Unverified |
