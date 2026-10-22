import { defineConfig, devices } from '@playwright/test';

/*
 * Staging checks (docs/HOSTING.md#staging).
 *
 * With STAGING_URL (the deploy's staging-checks job): the candidate the deploy just published to its
 * staging address, before production gets the same files. The specs that read ./dist get the sealed
 * build there. No web server and no build: what's tested is what was deployed.
 *
 * Without it (CI on pull requests, or locally): a stand-in. One root-path build, made the way the
 * deploy makes it for Cloudflare, served at http://staging.localhost:PORT/ (a staging address: a
 * subdomain of the build's VITE_STAGING_HOST_SUFFIX) and at http://127.0.0.1:PORT/ (a production one,
 * checked by staging-local.check.ts, which the deploy leaves out: its production still serves the
 * previous release).
 */
const STAGING_URL = process.env.STAGING_URL?.replace(/\/*$/, '/');
const PORT = 4176;

export default defineConfig({
  testDir: './tests/browser',
  testMatch: STAGING_URL
    ? ['staging.check.ts', 'built-site.spec.ts', 'pack-opener.smoke.spec.ts', 'shared-pull.smoke.spec.ts']
    : ['staging.check.ts', 'staging-local.check.ts'],
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  outputDir: 'test-results/staging',
  use: {
    baseURL: STAGING_URL ?? `http://staging.localhost:${PORT}/`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    serviceWorkers: 'block',
  },
  projects: [{ name: 'desktop-chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } }],
  webServer: STAGING_URL ? undefined : {
    command: `npm run build && npx vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}/`,
    env: {
      BASE_PATH: '/',
      SITE_URL: 'https://brainrottcg.pages.dev/',
      VITE_STAGING_HOST_SUFFIX: 'localhost',
      VITE_OLD_ORIGIN: 'https://evanlin23.github.io',
      VITE_OLD_SITE_URL: 'https://evanlin23.github.io/BrainrotTCG/',
    },
    reuseExistingServer: false,
    timeout: 300000,
  },
});
