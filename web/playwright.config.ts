import { defineConfig } from '@playwright/test'

const APP_PORT = 5199
const MOCK_PORT = 4599
const CHAT_PORT = 8791
// The real chat server (server/chat) against a PostgreSQL the caller provides, e.g. CI's service container. Without it,
// e2e/chat.spec.ts skips. The database must be empty or a previous e2e run's (users get unique names per run).
const CHAT_DB = process.env.E2E_CHAT_DATABASE_URL

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false, // the mock server's failure injection is global
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${APP_PORT}`,
    trace: 'retain-on-failure',
    // Optional: use a system Chromium instead of the Playwright download (e.g. on NixOS).
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, args: ['--no-sandbox'] }
      : {},
  },
  webServer: [
    { command: 'node ../shared/ui/testing/mock-server.mjs', url: `http://127.0.0.1:${MOCK_PORT}/health`, env: { MOCK_PORT: String(MOCK_PORT) }, reuseExistingServer: false },
    // The production build, as shipped: the dev server's StrictMode double-mount fires duplicate requests that make failure injection racy.
    { command: `npx vite build --outDir .e2e-dist && npx vite preview --outDir .e2e-dist --port ${APP_PORT} --strictPort --host 127.0.0.1`, url: `http://127.0.0.1:${APP_PORT}`,
      // Fake keys and local stand-in upstreams: the run never reads the real .env values or reaches api.spicylyrics.org
      // (process.env takes precedence over .env in Vite's loadEnv).
      env: {
        SPICY_LYRICS_SECRET_KEY: 'e2e-fake-secret', SPICY_LYRICS_API_BASE: `http://127.0.0.1:${MOCK_PORT}/spicy-upstream`, SPICY_RATE_PER_MINUTE: '200',
        // Fake Spotify credentials against a local stand-in for automatic matching (never api.spotify.com).
        SPOTIFY_CLIENT_ID: 'e2e-spotify-client', SPOTIFY_CLIENT_SECRET: 'e2e-spotify-secret',
        SPOTIFY_API_BASE: `http://127.0.0.1:${MOCK_PORT}/spotify-upstream`, SPOTIFY_TOKEN_URL: `http://127.0.0.1:${MOCK_PORT}/spotify-upstream/token`,
        // Production builds default to the hosted lyrics server; point this one at the preview server's own bridge.
        VITE_AURALIS_BACKEND_URL: `http://127.0.0.1:${APP_PORT}`,
      },
      reuseExistingServer: false,
    },
    ...(CHAT_DB
      ? [
          {
            command: 'node ../server/chat/src/migrate.ts && node ../server/chat/src/main.ts',
            url: `http://127.0.0.1:${CHAT_PORT}/readyz`,
            env: {
              DATABASE_URL: CHAT_DB, CHAT_PORT: String(CHAT_PORT), CHAT_LISTEN_HOST: '127.0.0.1', CHAT_BIND_ADDRESS: '127.0.0.1',
              CHAT_REGISTRATION: 'open', CHAT_ALLOWED_ORIGINS: `http://127.0.0.1:${APP_PORT}`, CHAT_LOG_LEVEL: 'warn',
              // Lets the spec give each API sign-up its own address (sign-ups are rate-limited per address).
              CHAT_TRUST_PROXY: '1',
            },
            reuseExistingServer: false,
          },
        ]
      : []),
  ],
})
