import { loadEnv } from 'vite'
import { spicyHandlerFromEnv } from './spicy.mjs'

/**
 * Mounts the Spicy Lyrics bridge on the dev and preview servers, so `npm run dev` works with no second process.
 * The key is read here, on the Node side, from .env / the environment (prefix '' = every variable, not just VITE_*),
 * and is never put in `define` or `import.meta.env`, so it cannot reach the bundle.
 * Shared by the web, tauri and android dev servers; production builds never include it.
 * @returns {import('vite').Plugin}
 */
export function spicyLyricsApi() {
  /** @type {ReturnType<typeof spicyHandlerFromEnv>} */
  let handler

  /** @param {import('vite').Connect.Server} middlewares */
  const mount = (middlewares) =>
    middlewares.use((req, res, next) => {
      void handler(req, res).then((handled) => !handled && next())
    })

  return {
    name: 'auralis-spicy-lyrics-api',
    configResolved(config) {
      handler = spicyHandlerFromEnv(
        loadEnv(config.mode, config.envDir || process.cwd(), ''),
      )
    },
    configureServer(server) {
      mount(server.middlewares)
    },
    configurePreviewServer(server) {
      mount(server.middlewares)
    },
  }
}
