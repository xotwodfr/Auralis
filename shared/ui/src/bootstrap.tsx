import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import App from './App'
import { initArtworkTheme } from './app/artworkTheme'
import { configurePlatform } from './app/platform'
import { initTheme } from './app/theme'
import { installRipple } from './app/ripple'
import { useAuth } from './state/auth'
import '@fontsource-variable/roboto-flex'
import './styles/tokens.css'
import './styles/global.css'
import './styles/m3.css'

type AppOptions = Pick<ComponentProps<typeof App>, 'shell'> & {
  /** Phone UI: one fixed look, so the user-selectable themes are not initialised. The entry point applies its own theme. */
  mobile?: boolean
}

/** Mounts the app into #root. Every platform entry point (web, tauri, android) calls this and nothing else. */
export function startApp({ shell, mobile = false }: AppOptions = {}) {
  configurePlatform({ mobile })
  installRipple()
  if (!mobile) {
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
          <App shell={shell} />
        </BrowserRouter>
      </QueryClientProvider>
    </StrictMode>,
  )
}
