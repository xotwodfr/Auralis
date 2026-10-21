import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router'
import { useTransitionedLocation } from '../frontend/mobile/transitions'

function Probe() {
  const navigate = useNavigate()
  const shown = useTransitionedLocation(useLocation())
  return (
    <>
      <p data-testid="shown">{shown.pathname}</p>
      <button onClick={() => navigate('/search')}>tab</button>
      <button onClick={() => navigate('/library/albums/a1')}>push</button>
      <button onClick={() => navigate(-1)}>back</button>
      <button onClick={() => navigate('/home?x=1')}>same</button>
    </>
  )
}

describe('useTransitionedLocation', () => {
  const motions: (string | undefined)[] = []

  beforeEach(() => {
    motions.length = 0
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    // Records the motion set at the moment the transition starts, then commits the update like the browser would.
    document.startViewTransition = ((update: () => void) => {
      motions.push(document.documentElement.dataset.motion)
      update()
      return { finished: Promise.resolve() }
    }) as typeof document.startViewTransition
    window.scrollTo = vi.fn() as typeof window.scrollTo
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete (document as Partial<Document>).startViewTransition
  })

  const click = (name: string) => act(() => void fireEvent.click(screen.getByText(name)))

  it('fades between tabs, shares an axis into a page and back out, and skips query-only changes', () => {
    render(
      <MemoryRouter initialEntries={['/home']}>
        <Probe />
      </MemoryRouter>,
    )
    click('same')
    expect(motions).toEqual([])
    click('tab')
    click('push')
    click('back')
    expect(screen.getByTestId('shown')).toHaveTextContent('/search')
    expect(motions).toEqual(['tab', 'forward', 'back'])
  })

  it('shows the new page at once when the WebView has no view transitions', () => {
    delete (document as Partial<Document>).startViewTransition
    render(
      <MemoryRouter initialEntries={['/home']}>
        <Probe />
      </MemoryRouter>,
    )
    click('push')
    expect(screen.getByTestId('shown')).toHaveTextContent('/library/albums/a1')
  })
})
