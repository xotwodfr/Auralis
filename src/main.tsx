import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import App from './App'
import { useAuth } from './state/auth'
import { initArtworkTheme } from './app/artworkTheme'
import { applyTheme, initTheme } from './app/theme'
import { IS_MOBILE_APP } from './app/platform'
import './styles/tokens.css'
import './styles/global.css'
import './styles/mobile.css'

if (IS_MOBILE_APP) {
  // The phone UI has one look (styles/mobile.css, scoped to this attribute), so the theme pickers are skipped.
  document.documentElement.dataset.platform = 'mobile'
  // Edge-to-edge: lets env(safe-area-inset-*) report the status and navigation bars.
  document.querySelector('meta[name="viewport"]')?.setAttribute('content', 'width=device-width, initial-scale=1.0, viewport-fit=cover')
  applyTheme('dark')
} else {
  initTheme()
  initArtworkTheme()
}

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
