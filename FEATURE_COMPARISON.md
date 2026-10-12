# Competitive Feature Comparison

> Research of competing music clients and analysis of features worth adopting. Based on current versions as of 2026. Distinguishes verified features from assumptions.

This analysis examines Navidrome/OpenSubsonic clients and major commercial services to identify the strongest ideas that would genuinely improve Auralis while avoiding feature bloat.

## 1. Compared Applications

| Application | Type | Notes |
|-------------|------|-------|
| [Feishin](https://github.com/jeffvli/feishin) | OpenSubsonic client (web/desktop) | Modern React + TypeScript, very polished, active development. Excellent UX patterns. |
| [Tempo](https://github.com/CappielloAntonio/tempo) | Android Subsonic client | Material Design, strong offline support, smart queues. |
| [Supersonic](https://github.com/dweymouth/supersonic) | Desktop (Go + Fyne) | Native desktop feel, gapless, cross-platform. |
| [Substreamer](https://github.com/Substreamer/substreamer) | Web client | Lightweight, simple. |
| [Navidrome](https://www.navidrome.org/) (web UI) | Self-hosted server + web UI | Baseline reference - Auralis improves on it significantly. |
| [Apple Music](https://music.apple.com) | Commercial | Reference for polished interactions and Liquid Glass aesthetic. |
| [Spotify](https://open.spotify.com) | Commercial | Queue UX, playlists, radio, recommendations, stats. |
| [YouTube Music](https://music.youtube.com) | Commercial | Lyrics, related content, autoplay. |

## 2. Feature Comparison Matrix

### Core Library & Navigation
| Feature | Auralis | Feishin | Tempo | Supersonic | Apple Music | Spotify | Assessment |
|---|---|---|---|---|---|---|---|
| Library browsing (artists/albums/playlists) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | All solid. Auralis comparable. |
| Virtualized lists | ✓ (lists) | ✓ | ✓ | ✓ | ✓ | ✓ | Good. Album grids not virtualized in Auralis - minor gap. |
| Search | ✓ (search3) | ✓ | ✓ | ✓ | ✓ | ✓ | Good. |
| Recently added/recently played | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Good. |
| Favorites/starred | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Good. |
| Album art theming | ✓ (dynamic) | Partial | ✗ | ✗ | ✓ | ✓ | Auralis is ahead here - unique strength. |
| Responsive/mobile | ✓ (rail + tabs) | ✓ | ✓ (mobile) | Desktop-only | ✓ | ✓ | Good. |

### Playback & Queue
| Feature | Auralis | Feishin | Tempo | Supersonic | Apple Music | Spotify | Assessment |
|---|---|---|---|---|---|---|---|
| Queue management | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Good. Auralis has basic reorder; Spotify has more flexible drag-drop. |
| Shuffle/repeat | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Good. |
| Media Session API | ✓ | ✓ | ✓ (mobile) | ✓ | ✓ | ✓ | Good. |
| Gapless playback | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | **Missing** - notable gap for albums with seamless transitions. |
| Crossfade | ✗ | ✓ | Partial | ✗ | ✗ | ✓ | Nice-to-have, not critical. |
| Persistent queue across sessions | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Good. |
| Smart/random playback | ✓ (random) | ✓ | ✓ | ✓ | ✓ | ✓ | Good. |

### Lyrics
| Feature | Auralis | Feishin | Tempo | Supersonic | Apple Music | Spotify | Assessment |
|---|---|---|---|---|---|---|---|
| Server lyrics (Subsonic) | ✓ | ✓ | ✓ | ✓ | ✗ (own) | ✗ (own) | Good. |
| LRCLIB fallback | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | Good. |
| Word-synced lyrics (Spicy) | ✓ | ✗ | ✗ | ✗ | ✓ (Apple Music) | ✓ (some tracks) | **Strong differentiator** - Auralis is ahead of other self-hosted clients. |
| Automatic matching for synced lyrics | ✓ (Spotify API) | ✗ | ✗ | ✗ | ✓ | ✓ | Strong. |
| Click-to-seek in lyrics | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Good. |
| Syllable highlighting | ✓ | ✗ | ✗ | ✗ | ✓ | Partial | Very strong. |

### Playlists & Organization
| Feature | Auralis | Feishin | Tempo | Supersonic | Apple Music | Spotify | Assessment |
|---|---|---|---|---|---|---|---|
| Server playlists | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Good. |
| Create/edit playlists | ✓ (add/remove) | ✓ | ✓ | ✓ | ✓ | ✓ | Good - basic ops work. |
| Smart playlists | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | Nice-to-have but server-dependent (Navidrome has smart playlists). |
| Queue-based playlists | ✗ | ✓ | ✗ | ✗ | ✓ | ✓ | Minor. |
| Multi-select | ✗ | ✓ | ✓ | ✓ | ✓ | ✓ | **Useful for bulk ops** - currently missing. |
