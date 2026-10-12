import { fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import App from '../../src/App'
import { kvGet } from '../../src/lib/storage'
import { useAuth } from '../../src/state/auth'
import { BASE, PASSWORD, USER } from '../server'

beforeEach(async () => {
  await useAuth.getState().disconnect()
  useAuth.setState({ hydrated: false })
})

async function fillAndSubmit(password: string, remember = false) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/']}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  fireEvent.change(await screen.findByLabelText('Server address'), { target: { value: BASE } })
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: USER } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } })
  if (remember) fireEvent.click(screen.getByLabelText('Remember this device'))
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
}

describe('connect flow', () => {
  it('connects, lands on the library and shows connection info in settings', async () => {
    await fillAndSubmit(PASSWORD)
    expect(await screen.findByRole('heading', { name: 'Artists' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('link', { name: 'Settings' }))
    expect(await screen.findByText(BASE)).toBeInTheDocument()
    expect(screen.getByText('Supported')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Clear stored credentials' })).not.toBeInTheDocument()
  })

  it('shows a specific, non-crashing error for wrong credentials', async () => {
    await fillAndSubmit('wrong')
    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong username or password.')
    expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled()
    expect(useAuth.getState().session).toBeNull()
  })

  it('remembers the device, then disconnect clears the stored credentials', async () => {
    await fillAndSubmit(PASSWORD, true)
    await screen.findByRole('heading', { name: 'Artists' })
    fireEvent.click(screen.getByRole('link', { name: 'Settings' }))
    expect(await kvGet('session')).toBeDefined()

    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Disconnect' }))
    expect(await screen.findByRole('button', { name: 'Connect' })).toBeInTheDocument()
    expect(await kvGet('session')).toBeUndefined()
  })

  it('clear stored credentials keeps the session', async () => {
    await fillAndSubmit(PASSWORD, true)
    await screen.findByRole('heading', { name: 'Artists' })
    fireEvent.click(screen.getByRole('link', { name: 'Settings' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Clear stored credentials' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Clear credentials' }))
    expect(await screen.findByText('No')).toBeInTheDocument()
    expect(await kvGet('session')).toBeUndefined()
  })
})
