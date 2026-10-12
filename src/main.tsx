import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import App from './App'
import { useAuth } from './state/auth'
import { initArtworkTheme } from './app/artworkTheme'
import { initTheme } from './app/theme'
import './styles/tokens.css'
import './styles/global.css'

initTheme()
initArtworkTheme()

const root = document.getElementById('root')
if (!root) throw new Error('Root element #root not found')

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 60_000, refetchOnWindowFocus: false } } })

// Library and lyrics queries belong to the signed-in account.
useAuth.subscribe((s, prev) => {
  if (prev.session && !s.session) queryClient.clear()
})

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
