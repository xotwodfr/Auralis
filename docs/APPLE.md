# Native iOS and macOS apps (SwiftUI, Liquid Glass)

**Status: source only.** Nothing under `apple/` has been compiled with Xcode. Only `AuralisKit` has been built and tested (on Linux, see below). Expect to fix compile errors on the first Xcode build; the SwiftUI layer was written against the iOS/macOS 26 API surface from memory, not against an installed SDK.

## What's genuinely Liquid Glass here

Only system APIs, no CSS-style imitation:
- `TabView` + `Tab(role: .search)` + `.tabBarMinimizeBehavior(.onScrollDown)` + `.tabViewBottomAccessory` (iOS mini player): system tab bar glass.
- `NavigationSplitView` (macOS sidebar): system floating sidebar.
- `.buttonStyle(.glass)` / `.glassProminent` and `GlassEffectContainer` (transport controls).
- `.glassEffect(.regular, in: .capsule)` (macOS player bar).
- Content (artwork, lists, lyrics) is deliberately not glass.

## Requirements
- A Mac with **Xcode 26** (needed for the iOS 26 / macOS 26 SDKs and the glass APIs). Check `xcodebuild -version`. Running macOS 26 apps needs macOS 26; a Hackintosh may not be able to run the SDK or Tahoe at all, so check before relying on it.
- `brew install xcodegen`
- An Apple Account signed in under Xcode → Settings → Accounts (free is fine).

## Moving the source to the Mac
```sh
# Linux
git add -A && git commit -m "..." && git push
# Mac
git clone <your-repo-url> Auralis && cd Auralis/apple
xcodegen generate            # creates Auralis.xcodeproj (git-ignored)
open Auralis.xcodeproj
```
`AuralisKit` tests need no project: `cd apple/AuralisKit && swift test`.

## Build and run
1. Open `Auralis.xcodeproj`. For each target (`AuralisiOS`, `AuralisMac`): Signing & Capabilities → Team → your **Personal Team**. Change the bundle identifier (`app.auralis.player`) to something unique if Xcode says it's taken.
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

Nothing in the project needs a paid account today. `DEVELOPMENT_TEAM` in `apple/project.yml` is blank; put a team ID there later.

## What the native app does not do yet
Artists / favourites / recent pages, queue screen, LRCLIB and Spicy word-synced lyrics, queue restore after relaunch, themes, playlist editing, iPad-specific layout.

## Verified on Linux (not Xcode)
`AuralisKit` (MD5 token auth against the Subsonic spec vector, URL building, response parsing, error mapping, queue logic, lyrics offset) compiled with Swift 5.10 and passed 14/14 tests, run through a small XCTest stand-in because the Nix Swift package has no XCTest/SwiftPM. The test file itself is standard XCTest for `swift test` on the Mac.
