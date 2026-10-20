import { act, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import ErrorBoundary from '../../src/app/ErrorBoundary'
import { toast, useToasts } from '../../src/state/toast'
import { ConfirmDialog } from '../../src/ui/Dialog'
import { SwapIcon } from '../../src/ui/Icon'
import { SegmentedControl } from '../../src/ui/SegmentedControl'
import { ToastRegion } from '../../src/ui/Toast'

describe('ErrorBoundary', () => {
  it('shows a recoverable fallback instead of crashing, and retries', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let broken = true
    const Bomb = () => {
      if (broken) throw new Error('boom')
      return <p>fine</p>
    }
    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong')
    broken = false
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(screen.getByText('fine')).toBeInTheDocument()
  })
})

describe('toasts', () => {
  beforeEach(() => useToasts.setState({ toasts: [] }))

  it('announces, dismisses, and auto-dismisses', () => {
    vi.useFakeTimers()
    render(<ToastRegion />)
    act(() => toast.info('Saved'))
    act(() => toast.error('It broke'))
    expect(screen.getByText('Saved')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('It broke') // errors are alerts

    fireEvent.click(screen.getAllByRole('button', { name: 'Dismiss notification' })[0]!)
    expect(screen.queryByText('Saved')).not.toBeInTheDocument()
    act(() => void vi.advanceTimersByTime(9000))
    expect(screen.queryByText('It broke')).not.toBeInTheDocument()
    vi.useRealTimers()
  })

  it('keeps at most three', () => {
    for (let i = 0; i < 5; i++) toast.info(`t${i}`)
    expect(useToasts.getState().toasts.map((t) => t.message)).toEqual(['t2', 't3', 't4'].slice(-3))
  })
})

describe('ConfirmDialog', () => {
  function Host({ onConfirm }: { onConfirm: () => void }) {
    const [open, setOpen] = useState(false)
    return (
      <>
        <button onClick={() => setOpen(true)}>Open</button>
        {open && <ConfirmDialog title="Sure?" message="m" confirmLabel="Do it" onCancel={() => setOpen(false)} onConfirm={onConfirm} />}
      </>
    )
  }

  it('is a labelled modal, focuses Cancel, traps Tab, and restores focus on Escape', () => {
    render(<Host onConfirm={vi.fn()} />)
    const opener = screen.getByRole('button', { name: 'Open' })
    opener.focus()
    fireEvent.click(opener)

    const dialog = screen.getByRole('dialog', { name: 'Sure?' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    const confirm = screen.getByRole('button', { name: 'Do it' })
    expect(cancel).toHaveFocus()

    confirm.focus()
    fireEvent.keyDown(confirm, { key: 'Tab' }) // last → first
    expect(cancel).toHaveFocus()
    fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true }) // first → last
    expect(confirm).toHaveFocus()

    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(opener).toHaveFocus()
  })

  it('confirms only through the confirm button, and closes on scrim click', () => {
    const onConfirm = vi.fn()
    render(<Host onConfirm={onConfirm} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    fireEvent.click(screen.getByRole('button', { name: 'Do it' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)

    fireEvent.mouseDown(screen.getByRole('dialog').parentElement!)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('SegmentedControl', () => {
  it('is a radiogroup with roving tabindex and arrow-key selection', () => {
    const onChange = vi.fn()
    const options = [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }, { value: 'c', label: 'C' }]
    render(<SegmentedControl label="Pick" value="a" options={options} onChange={onChange} />)
    const radios = screen.getAllByRole('radio')
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false'])
    expect(radios.map((r) => r.tabIndex)).toEqual([0, -1, -1])

    fireEvent.keyDown(radios[0]!, { key: 'ArrowRight' })
    expect(onChange).toHaveBeenLastCalledWith('b')
    fireEvent.keyDown(radios[0]!, { key: 'ArrowLeft' })
    expect(onChange).toHaveBeenLastCalledWith('c') // wraps
  })
})

describe('SwapIcon', () => {
  it('stays still on mount and re-renders, and pops in only when the icon changes', () => {
    const { container, rerender } = render(<SwapIcon name="play" />)
    const span = () => container.querySelector('.swap-icon')!
    expect(span()).not.toHaveClass('swap-icon--new')
    rerender(<SwapIcon name="play" />)
    expect(span()).not.toHaveClass('swap-icon--new')
    rerender(<SwapIcon name="pause" />)
    expect(span()).toHaveClass('swap-icon--new')
  })
})
