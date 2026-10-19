import { setupServer } from 'msw/node'

/** Intercepts the upstream calls (Spicy Lyrics, Spotify) the handlers make; each test registers its own responses. */
export const server = setupServer()
