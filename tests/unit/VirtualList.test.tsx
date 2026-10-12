import { fireEvent, render, screen } from '@testing-library/react'
import { VirtualList } from '../../src/ui/VirtualList'

describe('VirtualList', () => {
  it('keeps only a window of a 10k-row list in the DOM and moves it on scroll', () => {
    render(<VirtualList count={10_000} rowHeight={50} label="Big" renderRow={(i) => <span>row {i}</span>} />)
    const list = screen.getByRole('list', { name: 'Big' })
    expect(screen.getAllByRole('listitem').length).toBeLessThan(40)
    expect(screen.getByText('row 0')).toBeInTheDocument()
    expect(screen.queryByText('row 5000')).not.toBeInTheDocument()

    list.scrollTop = 5000 * 50
    fireEvent.scroll(list)
    expect(screen.getByText('row 5000')).toBeInTheDocument()
    expect(screen.queryByText('row 0')).not.toBeInTheDocument()
    expect(screen.getAllByRole('listitem').length).toBeLessThan(40)
  })
})
