import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['**/dist', '**/.e2e-dist', '**/coverage', '**/playwright-report', '**/test-results', '**/target', '**/gen', 'shared/apple/AuralisKit/.build'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['**/*.config.{js,ts}', '**/e2e/**/*.{mjs,ts}', 'shared/ui/testing/*.{mjs,ts}', 'shared/ui/vite.base.ts', 'server/**/*.{mjs,ts}', 'scripts/*.mjs'],
    languageOptions: { globals: globals.node },
  }
)
