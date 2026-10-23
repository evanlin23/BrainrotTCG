import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // Agent worktrees nest full checkouts under .claude/worktrees; linting them breaks tsconfig resolution.
  globalIgnores(['dist', 'coverage', 'test-results', '.claude/worktrees']),
  {
    files: ['**/*.{js,jsx,ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]', argsIgnorePattern: '^_' }],
    },
  },
  {
    // Node scripts and test configs (CI verification, card compositor, browser tests)
    files: ['scripts/**/*.{js,ts}', 'tests/**/*.{js,ts}', 'playwright*.config.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    // src/engine runs in the browser, a Web Worker and Node, so it can't reach the DOM or storage.
    // The import map (scripts/check-import-boundaries.ts) covers imports; this covers globals (#711).
    files: ['src/engine/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        ...[
          'window', 'document', 'localStorage', 'sessionStorage', 'indexedDB', 'navigator', 'location', 'history',
          'screen', 'matchMedia', 'requestAnimationFrame', 'cancelAnimationFrame', 'alert', 'confirm', 'prompt',
          'Image', 'HTMLElement', 'Element', 'Document',
        ].map((name) => ({ name, message: 'src/engine is DOM-free (CLAUDE.md layers). Take it as a parameter or move this to src/game.' })),
      ],
    },
  },
])
