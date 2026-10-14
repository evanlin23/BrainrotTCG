import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const GITHUB_PAGES_URL = 'https://evanlin23.github.io/BrainrotTCG/'

/** The page's own address in its link-preview tags: SITE_URL when the site is hosted elsewhere. */
const siteUrl = (): Plugin => ({
  name: 'site-url',
  transformIndexHtml: (html) => (process.env.SITE_URL ? html.replaceAll(GITHUB_PAGES_URL, process.env.SITE_URL) : html),
})

// The site's path: GitHub Pages serves it under /BrainrotTCG/; another host can set BASE_PATH=/.
export default defineConfig({
  base: process.env.BASE_PATH ?? '/BrainrotTCG/',
  plugins: [react(), siteUrl()],
  test: {
    exclude: ['tests/browser/**', 'node_modules/**', 'dist/**'],
  },
})
