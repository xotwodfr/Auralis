import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen } from '@testing-library/react'
import { Profiler, type ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import type { Song } from '../../src/api/subsonic/types'
import { PlayActions } from '../../src/features/library/components'
import { usePlayback } from '../../src/state/playback'

/**
 * Playhead ticks arrive ~4 times a second. Anything that subscribes to the whole playback store re-renders
 * on every one of them; this pins the page-level controls to "render once".
 */
const SONG: Song = { id: 's1', title: 'A', album: 'B', artist: 'C', duration: 100 }

function Counted({ onRender, children }: { onRender: () => void; children: ReactNode }) {
  return (
    <Profiler id="subject" onRender={onRender}>
      {children}
    </Profiler>
  )
}

it('playhead ticks do not re-render the page play controls', async () => {
  let renders = 0
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <Counted onRender={() => renders++}>
          <PlayActions songs={[SONG]} />
        </Counted>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument()
  const initial = renders

  act(() => {
    for (let i = 1; i <= 20; i++) usePlayback.setState({ position: i, duration: 100 })
  })
  expect(renders).toBe(initial)
})
