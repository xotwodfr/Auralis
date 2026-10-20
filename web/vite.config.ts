import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { spicyLyricsApi } from '../server/vite-plugin.mjs'
import { envDir, uiAlias } from '../shared/ui/vite.base.ts'

export default defineConfig({
  plugins: [react(), spicyLyricsApi()],
  resolve: { alias: uiAlias },
  envDir,
  server: {
    allowedHosts: ['dish-reappear-freckled.ngrok-free.dev'],
  },
})
