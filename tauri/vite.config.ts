import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { spicyLyricsApi } from '../server/vite-plugin.mjs'
import { envDir, uiAlias } from '../shared/ui/vite.base.ts'

// `tauri dev` loads the dev server below; `tauri build` embeds frontend/dist. The lyrics bridge is dev-only: a release build
// talks to the hosted lyrics server (VITE_AURALIS_BACKEND_URL / DEFAULT_LYRICS_SERVER).
export default defineConfig({
  root: 'frontend',
  plugins: [react(), spicyLyricsApi()],
  resolve: { alias: uiAlias },
  envDir,
  server: { port: 5174, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true },
})
