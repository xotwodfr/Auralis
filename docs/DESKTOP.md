# Windows and Linux (Tauri)

The desktop app is the existing web app in a native webview (`tauri/`, Tauri 2). The UI is not copied: `tauri/frontend/` is a thin entry point over the shared app core (`shared/ui`), `beforeBuildCommand` runs `npm run build` in `tauri/` and the shell loads `tauri/frontend/dist`. The desktop bundle is built separately from the web one.

**Verification status: see "Verified" at the bottom. Windows has not been built.**

## Toolchain
- Node 20.12+ and `npm ci`
- Rust (stable) via rustup, plus the Tauri CLI: `cargo install tauri-cli --version "^2" --locked` (no npm dependency was added)
- **Linux:** WebKitGTK 4.1, GTK3, libsoup3, OpenSSL, librsvg and a C toolchain.
  - Debian/Ubuntu: `sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev`
  - Arch: `sudo pacman -S webkit2gtk-4.1 base-devel curl wget file openssl libayatana-appindicator librsvg`
  - **Audio:** WebKitGTK plays through GStreamer. Install `gst-plugins-good`, `gst-plugins-bad`, `gst-libav` or FLAC/MP3/AAC from your server may not play.
- **Windows:** Visual Studio Build Tools ("Desktop development with C++"), WebView2 (preinstalled on Windows 11), Rust MSVC toolchain. NSIS installer target needs NSIS (Tauri downloads it).

## Commands
NixOS: `nix-shell` (repo-root `shell.nix`) provides Rust and all Linux libraries; then `cd tauri && cargo build`.

```sh
npm ci
cd tauri
cargo tauri dev        # runs `npm run dev` (tauri/vite.config.ts, port 5174) and opens the window
cargo tauri build      # bundles: deb + AppImage (Linux), NSIS .exe (Windows)
# or, without cargo-tauri, from the repo root: npm run dev:tauri / npm run build:tauri
```
Icons in `tauri/icons/` are a flat placeholder. Replace with `cargo tauri icon path/to/1024.png`.

## Lyrics from the desktop app
Production builds default to the hosted backend `https://lyrics.folk3s.com`. Users can change or disable it at runtime in **Settings → Lyrics** (stored on the device, no rebuild). To bake a different default: `VITE_AURALIS_BACKEND_URL=https://lyrics.example.com cargo tauri build`.
The backend must list the webview origin in `AURALIS_ALLOWED_ORIGINS`: `http://tauri.localhost` (Windows) / `tauri://localhost` (Linux, macOS). If the lyrics server is unreachable the app says so and falls back to server/LRCLIB lyrics; it never asks `tauri://localhost` for API data.

## Known risks and unknowns
- CSP (`tauri/tauri.conf.json`, `android/tauri.conf.json`): `connect-src`, `img-src` and `media-src` allow any `http:`/`https:` host because the Subsonic server, cover art and streams live on user-chosen hosts. Scripts stay `'self'`. Your server still needs CORS for the webview origin, exactly as for the browser.
- An `https://` webview cannot call `http://` servers (mixed content). The Settings field therefore accepts `http://` only for `localhost`, `127.0.0.1` and `[::1]`; any other backend must use `https://`. A backend must also allow the webview origin in its CORS list, so "Test connection" from the desktop app fails with "Couldn't reach the server" for a backend that does not list `tauri://localhost` / `http://tauri.localhost`, even if it is up; the browser cannot tell CORS from network errors.
- **Media keys / system media controls:** the web `MediaSession` code exists. Whether WebKitGTK exposes it over MPRIS and WebView2 over SMTC is untested.
- **Background playback:** HTMLAudio keeps playing in a hidden/minimised window in most webviews, but not verified here. No tray/close-to-background behavior exists.
- **Audio device selection:** follows the OS default; no in-app picker.

## Verified
- Linux (NixOS, Wayland): `cargo build` (debug) succeeds and the window opens and renders the connect screen against `npm run dev`. The shell sets `WEBKIT_DISABLE_DMABUF_RENDERER=1` on Linux because WebKitGTK crashed without it here.
- Linux: `cargo check` in `tauri/` succeeded (Tauri 2.12 against WebKitGTK 4.1, via a Nix shell): config, `generate_context!` and icons are valid. **Not done:** `cargo tauri build`, launching the window, audio playback, media keys, packaging.
- Windows: nothing run.
