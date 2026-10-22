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

/**
 * Vite's built-in preload helper (__vitePreload) has two defects when preloading CSS/chunks:
 * 1. In `preloadOnce`, it clears the in-flight promise with `seen[href] = void 0` instead of `delete seen[href]`.
 *    Because `href in seen` remains true, any subsequent attempt (e.g. on Retry) returns undefined and skips preloading.
 * 2. Failed `<link>` elements remain in document.head. Vite's preload helper inspects document.head and skips
 *    already-appended links, while the browser refuses to re-fetch a failed link element.
 *
 * This plugin fixes the helper in production builds so that failed links are removed from document.head
 * on error and `seen[href]` is deleted, enabling clean in-place Retry recovery without duplicate link tags.
 */
const preloadRecovery = (): Plugin => ({
  name: 'preload-recovery',
  transform(code, id) {
    if (!id.includes('vite/preload-helper')) return null;
    let transformed = code;
    transformed = transformed.replaceAll('seen[href] = void 0;', 'delete seen[href];');
    transformed = transformed.replace(
      'link.addEventListener("error", () => rej(/* @__PURE__ */ new Error(`Unable to preload CSS for ${dep}`)));',
      'link.addEventListener("error", () => { link.remove(); rej(new Error(`Unable to preload CSS for ${dep}`)); });',
    );
    transformed = transformed.replace(
      'if (!isCss) link.as = "script";',
      'if (!isCss) { link.as = "script"; link.addEventListener("error", () => link.remove()); }',
    );
    return transformed;
  },
})

// The site's path: GitHub Pages serves it under /BrainrotTCG/; another host can set BASE_PATH=/.
export default defineConfig({
  base: process.env.BASE_PATH ?? '/BrainrotTCG/',
  define: { __BUILD_REVISION__: JSON.stringify(buildRevision()) },
  plugins: [react(), siteUrl(), preloadRecovery(), testBudget()],
  test: {
    // Vitest's defaults (any node_modules, .git) plus the Playwright suites and build output.
    exclude: ['**/node_modules/**', '**/.git/**', 'tests/browser/**', 'tests/performance/*.spec.ts', 'dist/**'],
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
