# Repository structure

One folder per platform, plus two explicitly named places for what the platforms genuinely share.

```
shared/ui/      React app core (api, audio, state, features, ui, styles). Source only, no entry point, no platform code.
shared/apple/   AuralisKit (Swift package) and AuralisUI (SwiftUI used by both Apple apps).
web/            The web app: entry point, Vite build, dev-server lyrics bridge hookup, Playwright e2e.
tauri/          Desktop (Linux, Windows): Tauri 2 Rust crate + its own frontend entry and Vite build.
android/        Android: its own Tauri 2 Rust crate, the Gradle project (gen/android), the phone UI, its tests and e2e.
macos/          Native macOS app: Sources/ + project.yml (XcodeGen).
ios/            Native iOS app: Sources/ + project.yml (XcodeGen).
server/         Lyrics backend (Docker image) and the Vite dev plugin that mounts it. Not a client.
```

## What is platform-specific, what is shared

| Area | Lives in | Notes |
|---|---|---|
| Web entry, HTML, theme pre-paint script, Vite config, dev-server bridge hookup, browser e2e | `web/` | |
| Desktop Rust (GTK/Wayland/GStreamer workarounds, `custom-protocol`), Tauri config, icons, desktop entry point | `tauri/` | `tauri.conf.json` has the desktop `identifier`, window and bundle targets |
| Android Rust, Tauri config, Gradle project, manifest, launcher icons, signing inputs, phone UI (`frontend/mobile/`, `mobile.css`), phone e2e | `android/` | `app.auralis.desktop` is kept as the identifier/applicationId so updates install over existing APKs |
| macOS / iOS app entry, shell, Info/entitlements, bundle IDs, signing | `macos/`, `ios/` | each has its own `project.yml` and generates its own `.xcodeproj` |
| Subsonic client, audio engine, queue, lyrics providers, state, library/search/player/lyrics/settings/social/effects screens, shared UI primitives, design tokens | `shared/ui/` | used by web, tauri and android |
| Models, Subsonic client, queue, lyrics + Spotify matching (Swift) | `shared/apple/AuralisKit` | used by macOS and iOS |
| SwiftUI views and models | `shared/apple/AuralisUI` | used by macOS and iOS |

Where a shared component has a platform variant, the platform says so through a seam instead of the core detecting
the platform:

- `startApp({ shell, mobile })` (`shared/ui/src/bootstrap.tsx`) is the only thing an entry point calls. The Android entry passes
  its phone UI as `shell`; web and tauri pass nothing.
- `configurePlatform({ mobile })` / `isMobileApp()` (`shared/ui/src/app/platform.ts`) lets the few shared components that
  have a phone variant (chips, toggles, social tabs, settings sections) pick it. Nothing sniffs `navigator.userAgent` any more.

## Dependency rules

```
web      -> shared/ui, server (dev only: lyrics bridge plugin)
tauri    -> shared/ui, server (dev only)
android  -> shared/ui, server (dev only)
macos    -> shared/apple
ios      -> shared/apple
shared/* -> nothing
server   -> nothing
```

Platforms never import each other. `npm run lint` runs `scripts/check-boundaries.mjs`, which resolves every import in
`shared/ui`, `server`, `web`, `tauri` and `android` and fails when one crosses these lines. (The Apple side has no such check:
its boundary is the XcodeGen `sources`/`packages` entries in each `project.yml`.)

`@auralis/ui/...` resolves to `shared/ui/src/...` through a Vite/TypeScript alias (`shared/ui/vite.base.ts`, `paths` in each
`tsconfig.app.json`). Each platform bundles its own copy of the core, so a change to a platform's folder cannot alter another
platform's bundle; a change to `shared/ui` alters all three web-based ones, on purpose.

## Remaining shared dependencies (honest list)

- **`shared/ui` is shared by three platforms.** web, tauri and android are three builds of one app core. Android swaps the
  routed layout for its phone UI, but its screens (library queries, social, lyrics, effects, settings) are the shared ones.
  Changing `shared/ui` changes all three.
- **`server/vite-plugin.mjs`** is used by the web, tauri and android dev servers (and previews) so the lyrics bridge works
  without a second process. Production builds never include it.
- **One npm lockfile and one `node_modules`** (npm workspaces). Each package declares its own dependencies, but versions are
  resolved together. Rust is separate: `tauri/` and `android/` have their own `Cargo.toml`/`Cargo.lock`/`target/`.
- **`shared/apple/AuralisUI` contains a few `#if os(iOS)` / `#if os(macOS)` branches** (7 at the time of writing). Splitting
  them would need Swift changes that could not be compiled in the environment this was done in.
- **Design tokens** exist twice by design: `shared/ui/src/styles/tokens.css` and `shared/apple/AuralisUI/Theme.swift`. Kept in
  sync by hand; there is no code dependency.
- **Version numbers** are repeated in each platform's manifest (`package.json`, `Cargo.toml`, `tauri.conf.json`) and must be
  bumped together on release.
- **`.env` stays at the repo root** and is read by the web/tauri/android Vite configs (`envDir`) and by `server/`.

## Develop and build each platform on its own

Run everything from the repo root after `npm install`.

| Platform | Develop | Build / check |
|---|---|---|
| web | `npm run dev` (http://localhost:5173) | `npm run build:web` · `npm run test:e2e -w @auralis/web` |
| shared/ui | n/a (no entry point) | `npm test -w @auralis/ui` · `npm run typecheck -w @auralis/ui` |
| server | `npm start` (serves `web/dist` + `/api/spicy`) | `npm test -w @auralis/server` · `docker build .` |
| tauri | `npm run dev:tauri` (or `cd tauri && cargo tauri dev`) | `npm run build:tauri` (or `cargo tauri build`); Linux libs: `nix-shell` at the root |
| android | `npm run dev -w @auralis/android` previews the phone UI in a desktop browser (http://localhost:5175); `npm run dev:android` runs it on a device/emulator | `npm run build:android` → `android/gen/android/app/build/outputs/apk/universal/release/`; `npm test -w @auralis/android` · `npm run test:e2e -w @auralis/android` |
| macos | `cd macos && xcodegen generate && open Auralis.xcodeproj` | scheme `AuralisMac` |
| ios | `cd ios && xcodegen generate && open Auralis.xcodeproj` | scheme `AuralisiOS` |
| everything | | `npm run typecheck` · `npm run lint` · `npm test` |

Android needs JDK 17, the Android SDK/NDK and `NDK_HOME`; on NixOS `nix-shell android-shell.nix` provides them.

### How Tauri finds things (why the layout is what it is)

The Tauri CLI looks for `tauri.conf.json` from the directory it is run in and puts the Android Gradle project at
`<that directory>/gen/android`. That location is fixed by the CLI, so `android/` is its own Tauri project (its own
`Cargo.toml`, `tauri.conf.json`, icons and `gen/android`) rather than a folder that points into `tauri/`. `gen/android` is
committed (Tauri's recommendation) with two deliberate edits to the generated files: `compileSdk`/`targetSdk` 36 (what
`android-shell.nix` provides) and `usesCleartextTraffic="true"` (self-hosted servers are often plain http; CI used to
patch this with `sed`). After upgrading `@tauri-apps/cli`, regenerate with `cd android && npx tauri android init --ci` and
re-apply both edits (check with `git diff android/gen`).
