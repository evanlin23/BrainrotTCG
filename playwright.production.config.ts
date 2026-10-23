import { defineConfig, devices } from '@playwright/test';

/*
 * Production smoke checks (docs/HOSTING.md#read-only-checks-after-deployment-or-recovery), run by
 * the deploy's smoke job against PRODUCTION_URL once the release is published, after
 * scripts/production-smoke.ts.
 *
 * Read-only: shared-pull.smoke.spec.ts opens public proof fixtures (spec/vectors*.json), their
 * share and card pages, malformed links and every lazy screen in a fresh browser context, and its
 * network guard (tests/browser/support.ts) refuses every write and every request to another origin,
 * so nothing reaches a relay, the Hall of Fame or analytics (Cloudflare Web Analytics' beacon script
 * gets an inert stand-in, so the smoke isn't counted as a visit). It opens no pack and imports no save.
 * Traces and screenshots stay on the runner, which is discarded with the job.
 */
const PRODUCTION_URL = process.env.PRODUCTION_URL?.replace(/\/*$/, '/');
if (!PRODUCTION_URL) throw new Error('PRODUCTION_URL must name the production address');

export default defineConfig({
  testDir: './tests/browser',
  testMatch: ['shared-pull.smoke.spec.ts'],
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  outputDir: 'test-results/production',
  use: {
    baseURL: PRODUCTION_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    serviceWorkers: 'block',
  },
  projects: [{ name: 'desktop-chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } }],
});
