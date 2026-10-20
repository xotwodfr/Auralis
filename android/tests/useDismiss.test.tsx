import { act, fireEvent, render, screen } from '@testing-library/react'
import { useDismiss } from '../frontend/mobile/parts'

describe('useDismiss', () => {
  function Sheet({ onDone }: { onDone: () => void }) {
    const [closing, dismiss] = useDismiss(onDone)
    return (
      <button type="button" className={closing ? 'is-closing' : ''} onClick={dismiss}>
        close
      </button>
    )
  }
  const reduced = (on: boolean) => vi.stubGlobal('matchMedia', (q: string) => ({ matches: on && q.includes('reduce'), media: q }))

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('plays the exit animation once, then closes', () => {
    reduced(false)
    vi.useFakeTimers()
    const done = vi.fn()
    render(<Sheet onDone={done} />)
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByRole('button')) // a second tap must not close twice
    expect(screen.getByRole('button')).toHaveClass('is-closing')
    expect(done).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(200))
    expect(done).toHaveBeenCalledTimes(1)
  })

  it('closes at once under reduced motion, and never after unmounting', () => {
    reduced(true)
    const done = vi.fn()
    render(<Sheet onDone={done} />)
    fireEvent.click(screen.getByRole('button'))
    expect(done).toHaveBeenCalledTimes(1)

    reduced(false)
    vi.useFakeTimers()
    const late = vi.fn()
    const { unmount } = render(<Sheet onDone={late} />)
    fireEvent.click(screen.getAllByRole('button')[1]!)
    unmount() // e.g. hardware Back closed it first
    act(() => vi.advanceTimersByTime(500))
    expect(late).not.toHaveBeenCalled()
  })
})
