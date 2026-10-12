import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist', '.e2e-dist', 'coverage', 'playwright-report', 'test-results', 'src-tauri/target', 'src-tauri/gen', 'apple/AuralisKit/.build'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['*.config.{js,ts}', 'e2e/**/*.mjs', 'server/**/*.mjs'],
    languageOptions: { globals: globals.node },
  },
)
