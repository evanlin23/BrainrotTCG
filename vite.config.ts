import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const GITHUB_PAGES_URL = 'https://evanlin23.github.io/BrainrotTCG/'
const buildRevision = () => {
  // This checkout's revision, wherever the build is started from.
  const cwd = fileURLToPath(new URL('.', import.meta.url))
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() }
  catch { return 'unknown' }
}

/** The page's own address in its link-preview tags: SITE_URL when the site is hosted elsewhere. */
const siteUrl = (): Plugin => ({
  name: 'site-url',
  transformIndexHtml: (html) => (process.env.SITE_URL ? html.replaceAll(GITHUB_PAGES_URL, process.env.SITE_URL) : html),
})

// The site's path: GitHub Pages serves it under /BrainrotTCG/; another host can set BASE_PATH=/.
export default defineConfig({
  base: process.env.BASE_PATH ?? '/BrainrotTCG/',
  define: { __BUILD_REVISION__: JSON.stringify(buildRevision()) },
  plugins: [react(), siteUrl()],
  test: {
    // Vitest's defaults (any node_modules, .git) plus the Playwright suites and build output.
    exclude: ['**/node_modules/**', '**/.git/**', 'tests/browser/**', 'tests/performance/*.spec.ts', 'dist/**'],
  },
})
