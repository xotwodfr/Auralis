import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import 'fake-indexeddb/auto'
import { afterAll, afterEach, beforeAll, vi } from 'vitest'
import { FakeAudio } from './fakeAudio'
import { server } from './server'

// jsdom has no media playback; the engine gets this fake wherever `new Audio()` is called.
vi.stubGlobal('Audio', FakeAudio)

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => {
  cleanup()
  server.resetHandlers()
})
afterAll(() => server.close())
