# Auralis — Design

> **Superseded in part by Material 3 (see `MATERIA3.md`).** Web, desktop and Android now use M3 tonal surfaces,
> shapes, state layers and motion (`shared/ui/src/styles/m3.css`, `android/frontend/m3-mobile.css`). There is no
> glass any more: wherever this file says "glass", read "solid tonal surface". Narrow web screens use a bottom
> navigation bar. The rest (tokens, themes, lyrics, accessibility rules) still applies.

> The visual system: tokens, Liquid Glass rules, navigation, screens, motion, performance, and
> accessibility. Applies the installed `apple-liquid-glass` and `frontend-design` skills. Do not
> duplicate the skill docs here — this file records how Auralis *uses* them.

The one-sentence brief: **cool grey-white ground + unified white surfaces + hairline dividers;
glass only where layers truly overlap; one accent color; motion only where it explains change.**

## 1. Design tokens

Canonical values live in `shared/ui/src/styles/tokens.css` (copied from the skill, unchanged). Summary:

**Neutrals** — `--bg #f5f5f7`, `--surface #ffffff`, `--hover #fbfbfd`, `--text #1d1d1f`,
`--text-2 #6e6e73`, `--text-3 #86868b`, `--faint #d2d2d7`, `--hairline rgba(0,0,0,.07)`.

**Accents (emphasis only)** — `--accent #0071e3` (actions/focus), `--heat #ff6b00`,
`--live #30d158`. Everything else is grayscale.

**Type** — system SF stack (`--font`), `--mono` for timing/code readouts.
Rules: negative letter-spacing on large titles; `tabular-nums` on all times/counts; body
line-height ≥ 1.7; long-form ≤ 80 characters per line.

**Radius tiers** — `--r-pill 999`, `--r-chip 6`, `--r-thumb 12`, `--r-card 18`, `--r-panel 22`,
`--r-hero 26`, `--r-sheet 16`. Never invent in-between radii.

**Shadow** — two-layer only: `--sh-card`, `--sh-panel`, `--sh-lift`, `--sh-cta`, `--sh-overlay`.

**Motion** — `--ease-spring cubic-bezier(.32,.72,0,1)` (enter ~400ms),
`--ease-out-quart cubic-bezier(.25,1,.5,1)` (small moves ~200ms).

### Dark theme
Same token names, swapped values, defined under `[data-theme="dark"]`:
ground `#0b0b0d` (cool near-black, not pure `#000`), surface `#161618`, hairline `rgba(255,255,255,.09)`,
text `#f5f5f7`, secondary `#a1a1a6`. Accent stays `#0a84ff` (slightly brighter for dark ground).
Theme switch eases over ~200ms; never animates across large blurred surfaces.

### Theme presets and Album Artwork
Choice (persisted in `localStorage`, applied before first paint by `index.html`): **System** (light/dark from the OS),
**Light**, **Dark**, plus presets **Midnight**, **OLED Black**, **Nord**, **Sunset**, **Forest** (dark) and **Sakura**
(light), and **Album Artwork** (dynamic, dark). Presets are `[data-theme='…']` blocks in `tokens.css` that override only
what differs from their light/dark base, so the Settings swatches are painted by the real tokens. Every preset must keep
AA contrast (text/secondary/tertiary on bg, surface and hover; accent as text; white on `--accent-fill`); this is
enforced by `shared/ui/tests/unit/themes.test.ts`, which parses `tokens.css`.

Album Artwork derives a palette from the playing track's cover (`lib/palette.ts`): only the **dominant hue** and a
bounded saturation (0.40–0.72) are borrowed; lightness is fixed by us, so bright, dark and washed-out covers all give the
same calm dark structure. Grayscale, missing or unreadable art falls back to a neutral palette or keeps the last one.
Text colours are nudged until they reach AA against the lightest surface. The palette is applied as inline custom
properties on `<html>` (`app/artworkTheme.ts`), cached per cover id (64 entries, LRU), computed once per cover from a
64px image sampled at 32×32 — never on playhead ticks — and mirrored to `localStorage` for the next load. Reading pixels
needs the server to send CORS headers for cover art; otherwise the default palette is used.

## 2. Liquid Glass rules (non-negotiable)

1. **Glass is the navigation layer, never content.** Use it only on: the top nav/toolbar, the
   persistent playback bar, overlays (sheets, popovers, modals), and colored CTA labels. Library
   grids, list rows, lyrics text, and settings panels are **solid `--surface` + hairline + soft shadow**.
2. **Glass only where layers overlap.** If nothing scrolls/renders behind it, it is solid.
3. **One accent.** Blue for primary action/focus. No color fills, no gradients as decoration.
4. **Unified panels, not card piles.** Sibling rows share one panel with hairline dividers.
5. **Materialize on enter/exit** (blur + scale + opacity together), scrim fades slightly faster.
6. **Artwork is the color.** The UI stays grayscale so cover art carries the visual life.

Reusable CSS class: `.surface-overlay` (raised tonal surface for dialogs, toasts, queue and effects panels).

## 3. Navigation & layout

Shell: left sidebar (library sections) + main content + persistent bottom playback bar;
right-side or overlay lyrics panel on Now Playing.

```
┌───────────┬─────────────────────────────────────────┐
│           │  glass toolbar (search, back/forward)    │
│  sidebar  ├─────────────────────────────────────────┤
│  (solid)  │                                          │
│  Library  │            content (solid)               │
│  Artists  │      grids / lists / detail views        │
│  Albums   │                                          │
│  Tracks   │                                          │
│  Playlists│                                          │
│  Favorites├─────────────────────────────────────────┤
│  Recent   │  playback bar (glass) — art, transport,  │
│  Settings │  queue button, now-playing — always up    │
└───────────┴─────────────────────────────────────────┘
```

- **Sidebar:** solid surface, hairline right border, no glass. Three rows: brand + collapse toggle, a scrolling
  destination list, and a pinned account/Settings footer behind a full-bleed hairline, so Settings stays reachable on
  short viewports. Destinations are grouped — **Social** (first, so it holds the top-left corner, with an unread count
  badge) and **Now Playing**, then **Library** (Artists, Albums, Recently Added), then
  **Yours** (Playlists, Favorites, Recent) — with 11px uppercase group headings. Each item is a 42px icon + label pill;
  the active one takes a tinted pill, 600 weight, an accent icon and a 3px accent bar on its leading edge. Hover and
  active tints are `color-mix(in oklab, var(--text) …)` so every preset gets the same contrast step without new tokens;
  the account sub-line uses `--nav-sub` (82%), which is what keeps it AA *on the active pill*, the tightest case.
  **Collapsed rail** (72px, persisted in `localStorage`): icons only, names carried by `title`/`aria-label`.
  Widths come from one `--sidebar-w` token that the fixed player bar also reads.
- **Social:** solid panels with hairline rows (content, not navigation); pill tabs (Activity · Chat · People) in the
  segmented-control style, inactive labels in `--text` because the track on the page ground is too dark for `--text-2`
  to reach AA. "Listening now" carries a `--live` dot *and* the words. Avatars are neutral initial circles (the server
  doesn't give other users' pictures); own chat bubbles take `--accent-fill` with white text. In the phone UI the same
  sections sit under a back-button header and green chips, and the Social button is the top-left control of every tab.
- **Narrow screens (≤720px):** the sidebar becomes a horizontally scrolling strip of icon-above-label tabs above the
  content, with Settings pinned at its right behind a hairline; the active tab is underlined instead of edge-barred.
- **Toolbar:** a Back button on detail routes, then the search field.
- **Toolbar:** M3 top app bar on the page ground, with a search bar.
- **Playback bar:** floating tonal card (M3 surface-container-highest), fixed, ≥44px targets.
- **Lyrics panel:** on Now Playing, a right column (≈ 64 %) beside the artwork on wide screens; on narrow screens a
  compact header (64 px art + title) above a full-width lyrics stage.

### Wayfinding
Every screen answers: where am I (title/breadcrumb), where can I go (sidebar + toolbar), what's
here (content), how do I get out (back + sidebar). No dead ends.

## 4. Screens

| Screen | Purpose | Key elements |
|--------|---------|--------------|
| `Connect` | Enter server URL + credentials | URL, username, password, remember toggle, clear error |
| `Library` | Index of artists/albums/tracks | Virtualized grid/table, section tabs |
| `Artist` | Artist + albums | Header (name), album grid, top tracks |
| `Album` | Album detail | Large art, favourite heart, track list (unified panel), play/shuffle |
| `Playlist` | Playlist detail | Header, ordered track list, play |
| `Search` | Cross-type search | Debounced field, grouped results |
| `Favorites` / `Recent` | Starred / recently played | Same list components |
| `Now Playing` | Focal playback view | Lyrics first: art + metadata column, full-height lyrics stage, attribution + follow control in the stage footer, Spicy Lyrics/Spotify panel below |
| `Queue` | Reorder/manage queue | Draggable list, play-now/remove |
| `Settings` | Server, playback, lyrics options | Connection, theme, external lookups on/off, clear cache |

States required on every data screen: **loading** (skeleton, not a spinner alone), **empty**
(a direction, not a mood), **error** (what failed + retry). See copy rules in the skill.

## 5. Component inventory (`shared/ui/src/ui`)

Primitive-first; screens compose these.

- `GlassSurface` (nav / bar / overlay variants), `Panel`, `Hairline`
- `Button` (primary/secondary/icon), `IconButton`, `SegmentedControl`, `Tag`
- `List` + `ListRow` (unified panel + hairline), `Grid`, `VirtualList`
- `Artwork` (lazy, cached, placeholder `--grad-blue`), `ProgressBar` (seekable, `--track`),
  `Slider` (volume), `Skeleton`, `EmptyState`, `ErrorState`, `Toast`
- `StarButton` (the one favourite heart, on tracks/albums/artists; filled `--heat` when starred),
  `TrackActions` (every per-track action in one `Dialog`: play next, add to queue, add to playlist, favourite,
  go to album/artist, remove from this playlist) — rows therefore carry only a heart and a "More" button
- `LyricsView` (lines, active highlight, click-to-seek, follow toggle, attribution, refresh)
- `PlayerBar`, `TransportControls`, `QueueList`

Icons: line style on one 24-grid stroke, `currentColor`, grayscale; accent only on active/action.

## 6. Motion

- Static content: tiny budget — hover lift, segmented slide, pulse dot. No entrance keyframes on
  async content.
- Interactive layers (sheets, popovers, queue drawer, Now Playing transitions): full fluid
  treatment — pointer-down feedback, same-path enter/exit, anchored origin, materialize for glass,
  interruptible via CSS transitions (no keyframes for re-triggerable layers).
- Animate only `transform`/`opacity`. Springs via the two easing tokens.
- Honor all three signals: `prefers-reduced-motion` (cross-fade, no travel), `prefers-reduced-transparency`
  (glass → solid), `prefers-contrast: more` (solid + border).

### Lyrics stage (Now Playing)
- **Hierarchy:** active line at full `--text`; inactive lines at `--lyric-dim` opacity (0.5 on light grounds, 0.4 on dark;
  ≥ 3:1 for the large bold text in every theme, asserted by `shared/ui/tests/unit/themes.test.ts`). Within the active line,
  not-yet-sung words sit at `--lyric-unsung` (64 % / 60 %) — brighter than inactive lines, so the active line reads as
  active before its first word — and sweep to full colour syllable by syllable.
- **Type:** 700 weight, `clamp(1.5rem, 1rem + 1.5vw, 2.375rem)`, line-height 1.22, −0.022em; wraps with
  `text-wrap: pretty` and `overflow-wrap: anywhere` (no clipping, no horizontal scroll). Backing vocals at 0.62em under
  their line; duet (opposite) lines right-aligned. Words never break between syllables.
- **Focal region:** the active line settles at 32 % of the stage height; ~3 lines of past and 4–6 of upcoming context stay
  visible; a static mask fades lines at the top and bottom edges instead of hard cuts. Top/bottom padding (32cqh/62cqh)
  lets the first and last line reach the focal point, so the stage never jumps at the ends.
- **Motion (one set of rules):** `--lyric-move` (0.5 s ease-out-quart) for line opacity; scroll tween 700 ms
  ease-out-quart, interruptible, once per line; sung syllables rise 0.025em (transform, 0.6 s). No scaling of lines (it
  re-rasterises text and shifts wrapped lines), no blur on text, no keyframes, nothing animates continuously.
- **Reduced motion:** instant scroll, no rising syllables; the colour sweep stays (it carries timing, not travel).
  Increased contrast: dim 0.72, no edge mask. Reduced transparency: no artwork glow.
- **Colour:** the cover's own colours as a soft, static glow behind the artwork (blurred once, bounded to the art);
  Album Artwork theme tints the whole ground as before. Manual scroll shows a tonal "Back to current line" pill
  floating over the lyrics.
- **States:** loading shows lyric-shaped placeholder bars (no layout jump when lines arrive); empty/error/instrumental
  centre in the stage area; the attribution line is always on screen with synced lyrics (stage footer).

## 7. Performance budget

Design must not compromise responsiveness, battery, or playback. Enforced via TESTING.md.

- Limit **total blurred area** on screen; cap the playback bar + toolbar (never both full-screen).
- **No animated blur** and no expensive effects spanning large surfaces; animate opacity/transform.
- Artwork: lazy-load, decode off the main path, cache by cover-art id, request small sizes for grids.
- Virtualize lists/grids beyond ~200 items; memoize rows; avoid re-rendering the tree on playhead ticks
  (subscribe the progress component only).
- Lyrics: highlight via transform/opacity and one custom property; parse off the render path; never block playback.
  The per-frame painter writes only the sung syllable's `--p`; nothing reflows during a line.
- Provide a **simple visual fallback** (solid surfaces, no blur) when `prefers-reduced-transparency`,
  on low-end devices, or when a runtime perf probe flags jank.
- **Profile before optimizing** — no speculative micro-optimizations.

## 8. Accessibility

- All controls keyboard reachable; visible focus ring (`--accent`); logical DOM order.
- Keyboard shortcuts: Space (play/pause), ←/→ (seek), ↑/↓ (volume), N/P (next/prev), `/` (search),
  Esc (close overlays). Documented in-app.
- Touch targets ≥ 44px. Progress/volume sliders operable by keyboard with ARIA values.
- Contrast: body text meets WCAG AA on both themes; glass surfaces keep readable contrast (solid
  fallback under `prefers-contrast`).
- Lyrics: lines are buttons named by their text (click-to-seek), the active one has `aria-current`. Lines are **not**
  announced as they change (a live region would talk over the music on every line); loading states have a status
  label. The recording chooser is a `fieldset` with a legend, one button per recording; focus moves to the panel's
  summary after a choice. Under `forced-colors` the sweep falls back to system text/highlight colours.
