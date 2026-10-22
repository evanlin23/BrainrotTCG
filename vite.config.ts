import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { testBudget } from './scripts/test-budget.ts'

const GITHUB_PAGES_URL = 'https://evanlin23.github.io/BrainrotTCG/'
const buildRevision = () => {
  // This checkout's revision, wherever the build is started from.
  const cwd = fileURLToPath(new URL('.', import.meta.url))
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() }
  catch { return 'unknown' }
}

/** The page's own address in its link-preview tags: SITE_URL (with or without its trailing /) when the site is hosted elsewhere. */
const siteUrl = (): Plugin => ({
  name: 'site-url',
  transformIndexHtml: (html) => (process.env.SITE_URL ? html.replaceAll(GITHUB_PAGES_URL, `${process.env.SITE_URL.replace(/\/+$/, '')}/`) : html),
})

// The site's path: GitHub Pages serves it under /BrainrotTCG/; another host can set BASE_PATH=/.
export default defineConfig({
  base: process.env.BASE_PATH ?? '/BrainrotTCG/',
  define: { __BUILD_REVISION__: JSON.stringify(buildRevision()) },
  plugins: [react(), siteUrl(), testBudget()],
  test: {
    // Vitest's defaults (any node_modules, .git) plus the Playwright suites, build output and the
    // agent worktrees nested under .claude/worktrees (each a full checkout with its own tests).
    exclude: [
      '**/node_modules/**',
      '**/.git/**',
      'tests/browser/**',
      'tests/performance/*.spec.ts',
      'dist/**',
      '.claude/worktrees/**',
    ],
    // `npm test` turns coverage on for app code only, and the budget reporter (added by testBudget(),
    // after any --reporter flag) checks the run's wall time. Both budgets sit below the measured
    // baseline: docs/DEVELOPMENT.md, Test budgets.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**', 'src/**/*.d.ts'],
      reporter: ['text-summary'],
      thresholds: { branches: 75, statements: 78, lines: 80 },
    },
  },
})
