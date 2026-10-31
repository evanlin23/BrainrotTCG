import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { reducedMotionCss } from './scripts/reduced-motion-css.ts'
import { HANG_TIMEOUT_MS, testBudget } from './scripts/test-budget.ts'
import { CANONICAL_SITE_URL, notFoundHtml, robotsTxt, siteFromEnv, sitemapXml } from './scripts/crawler-files.ts'

const buildRevision = () => {
  // This checkout's revision, wherever the build is started from.
  const cwd = fileURLToPath(new URL('.', import.meta.url))
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() }
  catch { return 'unknown' }
}

/**
 * The site's address (SITE_URL, with or without its trailing /, or production's) in index.html's
 * link-preview tags, and the robots.txt and sitemap.xml beside it (scripts/crawler-files.ts).
 */
const siteUrl = (): Plugin => {
  const site = siteFromEnv(process.env.SITE_URL)
  let base = process.env.BASE_PATH ?? '/BrainrotTCG/'
  return {
    name: 'site-url',
    configResolved(config) {
      base = config.base
    },
    transformIndexHtml: (html) => html.replaceAll(CANONICAL_SITE_URL, site),
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'robots.txt', source: robotsTxt(site) })
      this.emitFile({ type: 'asset', fileName: 'sitemap.xml', source: sitemapXml(site) })
      this.emitFile({ type: 'asset', fileName: '404.html', source: notFoundHtml(base) })
    },
  }
}

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
  // The Motion setting reaches every reduced-motion rule in the stylesheets (scripts/reduced-motion-css.ts).
  css: { postcss: { plugins: [reducedMotionCss()] } },
  plugins: [react(), siteUrl(), preloadRecovery(), testBudget()],
  test: {
    // Vitest's defaults (any node_modules, .git) plus the Playwright suites, build output and the
    // agent worktrees nested under .claude/worktrees (each a full checkout with its own tests).
    exclude: [
      '**/node_modules/**',
      '**/.git/**',
      'tests/browser/**',
      'tests/performance/*.spec.ts',
      'tests/visual/**',
      'dist/**',
      '.claude/worktrees/**',
    ],
    // Every git call a test makes inherits these (command-scope config, which GIT_CONFIG_GLOBAL and
    // GIT_CONFIG_NOSYSTEM leave alone). They stop `git commit` from leaving a detached
    // `git maintenance run --auto --detach` behind (CI's git 2.55 does), which can still be writing
    // in a scratch repo's .git while the test's rmSync deletes it, failing with ENOTEMPTY.
    env: {
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'maintenance.auto',
      GIT_CONFIG_VALUE_0: 'false',
      GIT_CONFIG_KEY_1: 'gc.auto',
      GIT_CONFIG_VALUE_1: '0',
    },
    // The shared isolation resets for every test file (src/test/isolation.ts; docs/DEVELOPMENT.md, Test isolation).
    setupFiles: ['src/test/isolation.ts'],
    // One timeout for every test and hook, only to name a test that hangs: no test sets its own, and
    // wall time fails nothing else (docs/DEVELOPMENT.md, Test timing).
    testTimeout: HANG_TIMEOUT_MS,
    hookTimeout: HANG_TIMEOUT_MS,
    // Never retry a failed test: a retry turns a flake into a pass. Vitest's default is no key at all,
    // so it is set to 0 here for scripts/test-budget.test.ts to check in the resolved config.
    retry: 0,
    // `npm test` turns coverage on for app code only, and the timing reporter (added by testBudget(),
    // after any --reporter flag) prints the run's wall time without judging it. The coverage floors
    // sit below the measured baseline: docs/DEVELOPMENT.md, Test timing.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**', 'src/**/*.d.ts'],
      reporter: ['text-summary'],
      thresholds: { branches: 75, statements: 78, lines: 80 },
    },
  },
})
