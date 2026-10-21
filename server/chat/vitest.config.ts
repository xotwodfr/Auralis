import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.test.ts'],
    // One Postgres container for the run; every test file gets its own database (tests/helpers.ts).
    globalSetup: ['./tests/global-setup.ts'],
    testTimeout: 20_000,
    hookTimeout: 120_000,
  },
})
