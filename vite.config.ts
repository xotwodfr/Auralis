import react from '@vitejs/plugin-react'
import type { Connect } from 'vite'
import { loadEnv, type Plugin } from 'vite'
import { defineConfig } from 'vitest/config'
import { spicyHandlerFromEnv } from './server/spicy.mjs'

/**
 * Mounts the Spicy Lyrics bridge on the dev and preview servers, so `npm run dev` works with no second process.
 * The key is read here, on the Node side, from .env / the environment (prefix '' = every variable, not just VITE_*),
 * and is never put in `define` or `import.meta.env`, so it cannot reach the bundle.
 */
function spicyLyricsApi(): Plugin {
  let handler: ReturnType<typeof spicyHandlerFromEnv>
  const mount = (middlewares: Connect.Server) =>
    middlewares.use((req, res, next) => {
      void handler(req, res).then((handled) => !handled && next())
    })
  return {
    name: 'auralis-spicy-lyrics-api',
    configResolved(config) {
      handler = spicyHandlerFromEnv(loadEnv(config.mode, config.envDir || process.cwd(), ''))
    },
    configureServer(server) {
      mount(server.middlewares)
    },
    configurePreviewServer(server) {
      mount(server.middlewares)
    },
  }
}

export default defineConfig({
  plugins: [react(), spicyLyricsApi()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/unit/**/*.test.{ts,tsx}', 'tests/integration/**/*.test.{ts,tsx}'],
    css: false,
  },
})
