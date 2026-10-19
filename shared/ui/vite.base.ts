import { fileURLToPath } from 'node:url'

/** Every platform resolves `@auralis/ui/...` to this package's source, so there is one copy of the app core in each bundle. */
export const uiAlias = { '@auralis/ui': fileURLToPath(new URL('./src', import.meta.url)) }

/** The repo-root .env holds the build-time VITE_* defaults for every platform. */
export const envDir = fileURLToPath(new URL('../..', import.meta.url))
