# Native iOS and macOS apps (SwiftUI, Liquid Glass)

**Status:** CI (`macos-26` runner, `.github/workflows/ci.yml`) builds the macOS app as a universal binary (arm64 + x86_64) and the iOS app, and runs `swift test` for `AuralisKit`. The UI has not been run against a real server from CI; check playback and lyrics by hand on a Mac.

## What's genuinely Liquid Glass here

Only system APIs, no CSS-style imitation:
- `TabView` + `Tab(role: .search)` + `.tabBarMinimizeBehavior(.onScrollDown)` + `.tabViewBottomAccessory` (iOS mini player): system tab bar glass.
- `NavigationSplitView` (macOS sidebar): system floating sidebar.
- `.buttonStyle(.glass)` / `.glassProminent` and `GlassEffectContainer` (transport controls).
- `.glassEffect(.regular, in: .rect(cornerRadius: 22))` (macOS floating player bar), `.glassEffect` on toasts, `.buttonStyle(.glass)` for "Back to current line" over the lyrics, and the system toolbar search field and queue popover.
- Content (artwork, lists, panels, lyrics) is deliberately not glass: it uses the web's solid theme surfaces.

## macOS ↔ web map

The macOS app follows the web app (the reference) screen for screen. Colours, radii and type sizes come from `shared/ui/src/styles/tokens.css` (`shared/apple/AuralisUI/Theme.swift`), icons are the web's own SVGs (`shared/apple/AuralisUI/Assets.xcassets/Icons`, generated from `shared/ui/src/ui/Icon.tsx`).

| Web | macOS |
|---|---|
| Sidebar: Now Playing; Library (Artists, Albums, Recently Added); Yours (Playlists, Favorites, Recent); footer Settings + `user · server` | Same items and groups in the `NavigationSplitView` sidebar; collapse = native sidebar toggle |
| Toolbar search (`/` focuses) → `/library/search` | Toolbar `.searchable`, 300 ms debounce, `/` or ⌘F focuses |
| Artist / album / playlist detail, back button | `RoutedStack` detail pages, native back |
| Album grid card: play + heart on hover; "Added" date on Recently Added | Same, plus a right-click menu |
| Track row: play from here, heart, More (play next, add to queue, add to playlist / new playlist, favourite, go to album / artist, remove from playlist) | Same actions in the More menu and the right-click menu |
| Player bar: track, transport, progress, volume, lyrics, queue | Floating glass bar, same three columns; queue in a popover (jump, move, remove, clear) |
| Now Playing: cover + halo, lyrics (synced, word-synced, follow / back to current line, source + refresh, Spotify link panel) | Same |
| Settings: Appearance (10 themes incl. Album Artwork), Connection, Playback, Lyrics (external lookups, lyrics server URL with save/test/reset, Spicy status, clear cache, remove Spotify links), Keyboard shortcuts | Same sections and controls; ⌘, opens it |
| Shortcuts: Space, ←/→, ↑/↓, N/P, /, Esc | Same keys (ignored while typing), plus a Playback menu with ⌘ equivalents |
| Queue restore after reload | Restored paused after relaunch (per server + user) |

## Requirements
- A Mac with **Xcode 26** (needed for the iOS 26 / macOS 26 SDKs and the glass APIs). Check `xcodebuild -version`. Running macOS 26 apps needs macOS 26; a Hackintosh may not be able to run the SDK or Tahoe at all, so check before relying on it.
- `brew install xcodegen`
- An Apple Account signed in under Xcode → Settings → Accounts (free is fine).

## Moving the source to the Mac
```sh
# Linux
git add -A && git commit -m "..." && git push
# Mac
git clone <your-repo-url> Auralis && cd Auralis/macos     # or Auralis/ios
xcodegen generate            # creates Auralis.xcodeproj (git-ignored) with that app's scheme only
open Auralis.xcodeproj
```
The macOS app (`macos/`, scheme `AuralisMac`) and the iOS app (`ios/`, scheme `AuralisiOS`) are separate Xcode projects. Both compile `shared/apple/AuralisUI` and depend on the `shared/apple/AuralisKit` package.
`AuralisKit` tests need no project: `cd shared/apple/AuralisKit && swift test`.

## Build and run
1. Open `macos/Auralis.xcodeproj` and/or `ios/Auralis.xcodeproj`. For each target (`AuralisMac`, `AuralisiOS`): Signing & Capabilities → Team → your **Personal Team**. Change the bundle identifier (`app.auralis.player`) to something unique if Xcode says it's taken.
2. **macOS:** select `AuralisMac` → My Mac → Run.
3. **iOS:** simulator needs the iOS 26 runtime (Xcode → Settings → Components). Real iPhone: enable Developer Mode (Settings → Privacy & Security), plug in, trust the computer, select it, Run; then trust your profile under Settings → General → VPN & Device Management.
4. In the app, enter your Navidrome/Subsonic address, username, password. Plain `http://` LAN servers work because `NSAllowsArbitraryLoads` is set (tighten when everything is on https).

## Free vs paid signing
| | Free Apple Account | Paid Developer Program |
|---|---|---|
| Run on your own Mac / iPhone | Yes | Yes |
| Provisioning lifetime | ~7 days, then the app stops launching until re-run from Xcode | 1 year |
| App IDs | Limited number per week; few devices | Normal |
| Family member's phone | Only by plugging into your Mac and re-signing every 7 days | TestFlight or ad-hoc, reliably |
| macOS app for someone else | Unsigned/ad-hoc apps hit Gatekeeper; they must right-click → Open | Developer ID + notarization |

Nothing in the project needs a paid account today. `DEVELOPMENT_TEAM` in `macos/project.yml` and `ios/project.yml` is blank; put a team ID there later.

## What the native app does not do yet
- Lyrics and Spotify matches are cached in memory only (the web keeps them in IndexedDB), so a relaunch looks them up again.
- No drag-to-reorder in the queue (move up / down buttons, as on the web).
- iOS reuses the shared screens in a tab bar; there is no iPad-specific layout.

## Verified on Linux (not Xcode)
`AuralisKit` (token auth, URL building, response parsing, error mapping, queue logic, LRC parsing, LRCLIB match guards, Spicy parsing, Spotify matching, artwork palette) compiles with Swift 5.10 and passes its 33 tests, run through a small XCTest stand-in because the Nix Swift package has no XCTest/SwiftPM. The test file itself is standard XCTest for `swift test` on the Mac. SwiftUI code can only be syntax-checked on Linux (`swiftc -parse`).
