import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import { spicyLyricsApi } from '../server/vite-plugin.mjs'
import { envDir, uiAlias } from '../shared/ui/vite.base.ts'

// `tauri android dev` loads the dev server below; `tauri android build` embeds frontend/dist. Run `npm run dev` on its own to
// preview the phone UI in a desktop browser. The lyrics bridge is dev-only: a release build uses the hosted lyrics server.
export default defineConfig({
  root: 'frontend',
  plugins: [react(), spicyLyricsApi()],
  resolve: { alias: uiAlias },
  envDir,
  server: { port: 5175, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true },
  test: {
    root: '.',
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    css: false,
    // Its ESM imports omit file extensions, which only a bundler resolves; Node (Vitest's default for deps) does not.
    server: { deps: { inline: ['@material/material-color-utilities'] } },
  },
})
