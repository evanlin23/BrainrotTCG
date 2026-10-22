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

/** Replaces text in Vite's generated code, failing the build if a Vite upgrade changed it. */
const patchHelper = (code: string, from: string, to: string) => {
  if (!code.includes(from)) throw new Error(`preload-recovery: Vite's preload helper no longer contains ${JSON.stringify(from)}; update vite.config.ts`);
  return code.replaceAll(from, to);
};

/**
 * Lets Retry fetch a lazy screen's stylesheet and preloaded chunks again after they failed (#664).
 * Vite's preload helper remembers every href it has preloaded (`seen[href] = void 0` keeps the key,
 * so a later import skips it) and skips any href with a <link> already in the document, while a
 * <link> that failed never loads again. The patch forgets an href once its preload settles and
 * removes a <link> that fired `error`, so the next import adds a fresh one. Links still loading, or
 * belonging to other screens, are left alone. Build only: the dev server doesn't use the helper.
 */
const preloadRecovery = (): Plugin => {
  let patched = false;
  return {
    name: 'preload-recovery',
    apply: 'build',
    transform(code, id) {
      if (!id.includes('vite/preload-helper')) return null;
      let out = patchHelper(code, 'seen[href] = void 0;', 'delete seen[href];');
      out = patchHelper(
        out,
        'link.addEventListener("error", () => rej(/* @__PURE__ */ new Error(`Unable to preload CSS for ${dep}`)));',
        'link.addEventListener("error", () => { link.remove(); rej(new Error(`Unable to preload CSS for ${dep}`)); });',
      );
      patched = true;
      return out;
    },
    buildEnd(error) {
      if (!error && !patched) throw new Error("preload-recovery: Vite's preload helper was never transformed; update vite.config.ts");
    },
  };
};

// The site's path: GitHub Pages serves it under /BrainrotTCG/; another host can set BASE_PATH=/.
export default defineConfig({
  base: process.env.BASE_PATH ?? '/BrainrotTCG/',
  define: { __BUILD_REVISION__: JSON.stringify(buildRevision()) },
  plugins: [react(), siteUrl(), preloadRecovery(), testBudget()],
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
