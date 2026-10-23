import { defineConfig } from '@playwright/test';
import browserConfig from './playwright.config';

/** Opt-in, report-only: growing saves and bounded long sessions in emulated Chromium (#709, docs/DEVELOPMENT.md > Capacity). */
export default defineConfig({
  ...browserConfig,
  testDir: './tests/performance',
  testMatch: 'capacity.spec.ts',
  outputDir: 'test-results/performance-capacity',
  // Every test sets its own timeout; this bounds the whole run if one hangs.
  globalTimeout: 60 * 60_000,
  reporter: [['list']],
  use: { ...browserConfig.use, video: 'off' },
});
