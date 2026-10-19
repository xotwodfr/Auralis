import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import { uiAlias } from './vite.base.ts'

export default defineConfig({
  plugins: [react()],
  resolve: { alias: uiAlias },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/unit/**/*.test.{ts,tsx}', 'tests/integration/**/*.test.{ts,tsx}'],
    css: false,
  },
})
