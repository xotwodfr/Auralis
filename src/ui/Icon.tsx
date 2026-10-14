const PATHS = {
  play: <path d="M7 4.5v15l12-7.5z" fill="currentColor" />,
  pause: (
    <>
      <rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor" />
      <rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor" />
    </>
  ),
  prev: <path d="M18 5v14l-9-7zM6 5v14" fill="currentColor" />,
  next: <path d="M6 5v14l9-7zM18 5v14" fill="currentColor" />,
  shuffle: <path d="M3 7h3.5c5 0 5 10 10 10H21M3 17h3.5c1.8 0 3-1 4-2.3M13.5 9.3C14.5 8 15.7 7 17.5 7H21M18.5 4.5L21 7l-2.5 2.5M18.5 14.5L21 17l-2.5 2.5" />,
  repeat: <path d="M17 3l3 3-3 3M4 11V9a3 3 0 013-3h13M7 21l-3-3 3-3M20 13v2a3 3 0 01-3 3H4" />,
  'repeat-one': <path d="M17 3l3 3-3 3M4 11V9a3 3 0 013-3h13M7 21l-3-3 3-3M20 13v2a3 3 0 01-3 3H4M11 10l1.5-1v6" />,
  queue: <path d="M4 6h12M4 12h12M4 18h8M18 14l4 3-4 3z" />,
  volume: <path d="M4 9.5v5h3.5l4.5 4v-13l-4.5 4zM15.5 9a4 4 0 010 6M18 6.5a8 8 0 010 11" />,
  lyrics: <path d="M4 6h16M4 11h16M4 16h9M17 15.5a2.5 2.5 0 105 0v-4l-5 1z" />,
  plus: <path d="M12 5v14M5 12h14" />,
  'play-next': <path d="M4 5l9 7-9 7zM18 7v10M15 12h6" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  up: <path d="M6 15l6-6 6 6" />,
  down: <path d="M6 9l6 6 6-6" />,
  search: <path d="M11 4a7 7 0 100 14 7 7 0 000-14M16.2 16.2L20.5 20.5" />,
  artist: <path d="M12 11.5a3.6 3.6 0 100-7.2 3.6 3.6 0 000 7.2M4.8 20a7.2 7.2 0 0114.4 0" />,
  album: <path d="M12 3.2a8.8 8.8 0 100 17.6 8.8 8.8 0 000-17.6M12 10.4a1.6 1.6 0 100 3.2 1.6 1.6 0 000-3.2" />,
  added: <path d="M12 4v9.5M8.5 10L12 13.5 15.5 10M4.5 16.5v2.5a1 1 0 001 1h13a1 1 0 001-1v-2.5" />,
  playlist: <path d="M4 7h11M4 12h11M4 17h7M19.5 16.2V8l-3.5 1v7.2M16 16.2a1.75 1.75 0 103.5 0 1.75 1.75 0 00-3.5 0" />,
  heart: <path d="M20.3 5.1a4.9 4.9 0 00-7 0L12 6.4l-1.3-1.3a4.9 4.9 0 00-7 7l8.3 8.3 8.3-8.3a4.9 4.9 0 000-7z" />,
  'heart-fill': <path d="M20.3 5.1a4.9 4.9 0 00-7 0L12 6.4l-1.3-1.3a4.9 4.9 0 00-7 7l8.3 8.3 8.3-8.3a4.9 4.9 0 000-7z" fill="currentColor" />,
  clock: <path d="M12 3.5a8.5 8.5 0 100 17 8.5 8.5 0 000-17M12 7.5V12l3.2 1.9" />,
  settings: <path d="M4 7h9.5M17.5 7h2.5M4 17h2.5M10.5 17H20M15.5 4.5v5M8.5 14.5v5" />,
  rail: <path d="M4.5 5h15a1 1 0 011 1v12a1 1 0 01-1 1h-15a1 1 0 01-1-1V6a1 1 0 011-1M9.5 5v14" />,
  back: <path d="M14.5 5.5L8 12l6.5 6.5" />,
  'playlist-add': <path d="M4 7h11M4 12h11M4 17h7M18 13.5v6M15 16.5h6" />,
  wave: <path d="M4 10v4M8 6.5v11M12 4v16M16 7.5v9M20 10.5v3" />,
  more: (
    <>
      <circle cx="6" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="18" cy="12" r="1.5" fill="currentColor" stroke="none" />
    </>
  ),
  home: <path d="M4 10.5L12 4l8 6.5V20h-5.5v-6h-5v6H4z" />,
  library: <path d="M5 4v16M10 4v16M14.5 4.5l5 15" />,
  trash: <path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13" />,
} as const

export type IconName = keyof typeof PATHS

/** Line icons on a 24 grid, `currentColor`. Decorative: the parent button carries the label. */
export function Icon({ name, size = 22 }: { name: IconName; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  )
}
