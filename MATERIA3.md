# Material Design 3 migration plan

> **Status (2026-10-21):** first pass shipped as an override layer, not the full plan below.
> Android motion (2026-10-21, third pass): `android/frontend/mobile/transitions.tsx` runs every navigation in a View Transition: top-level tabs fade through, deeper pages share the X axis (forward/back, also for the hardware button), a tapped cover morphs into the next page's hero art, and the mini-player grows into Now Playing as a container transform and back. Scroll position is restored on Back. Hero actions are an M3 button group, shelves are carousels, the queue and chat composer follow M3, and tabs/switches give a haptic tick (`mobile/haptics.ts`, VIBRATE permission). It is still a WebView UI: system Predictive Back animation and native Compose components are not reachable from here.
> Web/desktop: `shared/ui/src/styles/m3.css` (tonal surfaces derived per theme via `color-mix`, shape scale, state
> layers, M3 buttons/fields/chips/segmented/slider/dialog/snackbar, navigation drawer, floating player, bottom
> navigation bar under 720px, fade-through page transitions). Android (2026-10-21, second pass): `android/frontend/mobile.css`
> is rewritten on M3 colour roles only (no hard-coded colours); `mobile/scheme.ts` generates the scheme with Material Color
> Utilities (Tonal Spot, 2025 spec), light and dark by system setting, from the app's seed or from the playing cover with
> Dynamic colour on (replaces the blurred-cover backdrop and tint gradients). Top app bars that take the container colour
> on scroll, search bar, filter chips with checks, list items, FAB, Expressive slider and transport, navigation bar,
> bottom sheets, outlined text fields and checkboxes. Settings is a list of expandable sections (grouped list items,
> animated open/close, icon shape morph). Ripple: `shared/ui/src/app/ripple.ts`. Roboto Flex is bundled
> (`@fontsource-variable/roboto-flex`, 34 KB latin subset, works offline and under the Tauri CSP). The glass layer is
> gone: `.glass-nav` / `--glass-*` removed, overlays use `.surface-overlay`. Desktop (Tauri, WebKitGTK 2.54) supports
> every CSS feature used (`color-mix`, oklab, `@starting-style`). Still open: splitting `global.css` by feature.

**Short answer: yes, it is feasible, and it is mostly a styling job, not a rewrite.**

Auralis is a React 19 app (`shared/ui`) wrapped by web, Tauri and Android shells. Every colour, radius, shadow and
motion value already goes through CSS custom properties in `shared/ui/src/styles/tokens.css`, and the UI primitives
are small (`shared/ui/src/ui/`: Dialog, Switch, Slider, SegmentedControl, Toggle, Toast, Icon, ...). No component
library is involved. That is the right starting point for M3: the work is to swap the token vocabulary and restyle
the primitives, then sweep `global.css`.

## What M3 changes, and what it does not

| Area | Today | Material 3 |
|------|-------|------------|
| Colour | Hand-written neutrals + one accent per theme (`--bg`, `--surface`, `--text-2`, `--accent`) | Tonal palette generated from a seed colour, mapped to roles (`--md-sys-color-primary`, `surface-container-*`, `on-*`, ...) |
| Shape | Radius tiers 6 to 26px, pills | Shape scale: none / xs 4 / sm 8 / md 12 / lg 16 / xl 28 / full |
| Elevation | Two-layer shadows | Tonal elevation (surface tint) plus levels 0 to 5 |
| Type | System font (SF Pro) | Type scale roles (Display / Headline / Title / Body / Label), Roboto Flex or system |
| Motion | Spring and out-quart easing | Emphasized / standard easing tokens and durations |
| Glass blur nav | `--glass-*` on the player and nav | Not part of M3; replaced by solid `surface-container` |
| Components | Custom | M3 specs: top app bar, navigation rail / bar / drawer, FAB, chips, cards, sliders, switches, dialogs, snackbars |

Not affected: audio engine, Subsonic API, lyrics, chat protocol, state stores, routing.

## Decision needed first: hand-roll vs. a library

| Option | Pros | Cons |
|--------|------|------|
| **A. Tokens + own CSS (recommended)** | Fully matches M3 look, no runtime dependency, keeps the 10-theme system, works in Tauri / Android WebViews, no bundle growth | We implement the specs ourselves (state layers, ripples, focus rings) |
| B. `@material/web` (Google web components) | Official components | In maintenance mode, web components inside React 19 are awkward in tests (jsdom), adds weight, theming conflicts with `artwork` theme |
| C. MUI / other React M3 kit | Ready components | Large bundle, MUI's M3 support is partial, replaces our primitives and their tests |

Recommendation: **A**, using `@material/material-color-utilities` (small, build-time or runtime) only to generate the
tonal palettes. This also fits Auralis's existing `artworkTheme.ts`, which already derives a palette from cover art:
M3 dynamic colour is the same idea, so that theme can be rebuilt on the official algorithm.

## Phases

Each phase ships on its own and keeps `npm test`, `npm run test:e2e` and the axe contrast spec green.

### Phase 0: Decisions and baseline (0.5 day)
- Pick the approach (above), a default seed colour, and whether to keep all 10 themes (see Theme mapping).
- Capture baseline screenshots of every page and theme (`docs/screenshots/`), so visual diffs are reviewable.
- Add `docs/MATERIAL3.md` pointers from `ARCHITECTURE.md` once Phase 1 lands.

### Phase 1: Token layer (1 to 2 days)
- Add `styles/m3-tokens.css` defining the `--md-sys-color-*`, `--md-sys-shape-*`, `--md-sys-typescale-*`,
  `--md-sys-motion-*` and elevation tokens.
- **Alias, do not rename.** Map the existing names onto the new roles so nothing breaks while migrating:
  `--bg` -> `surface`, `--surface` -> `surface-container`, `--text` -> `on-surface`, `--text-2` -> `on-surface-variant`,
  `--accent` -> `primary`, `--hairline` -> `outline-variant`, `--danger-*` -> `error` / `on-error`, etc.
- Load a font (Roboto Flex via self-hosted file; no CDN so Tauri/Android work offline).
- `tests/unit/themes.test.ts` already checks contrast ratios per theme; extend it to the M3 role pairs
  (`on-primary` on `primary`, `on-surface-variant` on `surface-container`, ...) so every theme stays AA.

### Phase 2: Primitives (3 to 4 days)
Restyle in `shared/ui/src/ui/`, keeping props and ARIA unchanged so feature code and tests are untouched:
- `Switch` (M3 switch with handle growth and icon), `Slider` (seek and volume, 4px track, handle, value indicator),
  `SegmentedControl` (M3 segmented button; the `cards` variant used for themes becomes selectable cards),
  `Dialog`/`ConfirmDialog` (28px radius, scrim, tonal surface), `Toast` (snackbar), `Toggle`, `Icon`.
- Add shared state layers (hover 8%, focus 10%, pressed 10%) and a focus ring once in CSS, not per component.
- Add new primitives only where needed: `Button` variants (filled / tonal / outlined / text) replacing `.btn`,
  `IconButton`, `Chip`, `Fab`, `TopAppBar`.

### Phase 3: Shell and navigation (2 to 3 days)
- `app/Shell.tsx`: sidebar -> navigation drawer on wide screens, navigation rail at medium widths, bottom navigation
  bar on compact. Use M3 window size classes (compact < 600, medium 600 to 839, expanded >= 840).
- Player bar -> M3 mini player on a `surface-container-high` bar, with a filled-tonal play button; remove the
  backdrop blur (this also removes the contrast flakiness we saw with translucent glass behind text).
- Now Playing: large cover, M3 slider, tonal transport buttons.
- Update `web/e2e` selectors only if roles or names change (they mostly will not).

### Phase 4: Pages (4 to 6 days)
Library grids and lists, album/artist/playlist pages, Search, Queue, Lyrics, Social/Chat, Settings, Connect screen.
Mostly replacing radii, surfaces, padding rhythm and type roles in `global.css` (~2,900 lines, currently one file).
Use this phase to split `global.css` by feature while touching it, which makes the diff reviewable.
Settings already uses collapsible sections; restyle them as M3 list items with a trailing chevron.

### Phase 5: Themes and dynamic colour (2 days)
See below.

### Phase 6: Mobile / desktop parity and polish (2 to 3 days)
- Android (`android/frontend/mobile/`) has its own pages, mini player and settings. M3 is natively the Android
  language, so this is where the redesign pays off most: reuse the same tokens, add predictive-back friendly
  transitions, and a proper bottom navigation bar.
- Tauri desktop shares `shared/ui`; verify window controls and density.
- Reduced motion, forced colours, increased contrast (existing e2e tests cover these and must stay green).

**Rough total: 3 to 4 weeks for one developer**, most of it in Phases 2 to 4.

## Theme mapping

The ten current themes do not map one-to-one onto M3, which has light and dark schemes from one seed.

| Current | Proposed |
|---------|----------|
| System / Light / Dark | M3 baseline scheme from the default seed (auto, light, dark) |
| Album Artwork | M3 dynamic colour from the cover (seed from `artworkTheme.ts`) |
| Midnight, Nord, Sunset, Forest, Sakura | Seed-colour schemes (a seed each), same names |
| OLED Black | Dark scheme with `surface` forced to `#000` (M3 allows this as a custom variant) |
| (new) | "Material You" seed picker: user chooses a colour, palette is generated; contrast level standard / medium / high matches M3 |

Decision: either keep all themes as seeds (cheap, consistent) or trim to System / Light / Dark / OLED / Artwork /
Custom seed. Fewer themes means less contrast testing.

## Risks

- **Scope in `global.css`.** One 52 KB file with many hard-coded radii and shadows; the sweep is where time goes.
  Mitigation: aliasing in Phase 1 and a grep check that forbids new raw hex colours.
- **Contrast.** Some M3 role pairs are below AA in poorer seeds; the axe e2e will catch regressions. Generate palettes
  with the official utility rather than by hand.
- **Lyrics view.** Large, animated typography with its own dim/unsung rules (`--lyric-dim`, `--lyric-unsung`).
  Keep it custom; only retheme colours.
- **Identity.** M3 looks like an Android app. Auralis currently has an Apple-like look. Confirm this is wanted on
  web and desktop, or limit M3 to Android and the web "compact" layout first.
- **E2E churn.** Selectors use roles and names, so most survive; layout-dependent tests (player, Settings
  sections) need review.
- **Bundle and fonts.** Self-host one variable font; avoid Material Symbols webfont and keep the existing SVG `Icon`.

## Suggested first step

Do Phase 0 and Phase 1 only, behind the existing theme switch (a new `material` theme in `theme.ts`). That gives a
working M3 colour system and a visible preview in about two days, with no change to the current themes, and lets you
judge the direction before committing to the rest.
