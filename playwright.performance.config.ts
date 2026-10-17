import { defineConfig } from '@playwright/test';
import browserConfig from './playwright.config';
import { REPETITIONS } from './tests/performance/report';

export default defineConfig({
  ...browserConfig,
  testDir: './tests/performance',
  testMatch: 'baseline.spec.ts',
  timeout: 60_000,
  // 12 minutes at the default 3 runs per scenario; a larger PERF_REPETITIONS sample scales it.
  globalTimeout: 4 * REPETITIONS * 60_000,
  outputDir: 'test-results/performance',
  reporter: [['list'], ['./scripts/performance-reporter.ts']],
  use: { ...browserConfig.use, video: 'off' },
  projects: [{ name: 'baseline-chromium', use: { browserName: 'chromium', viewport: { width: 393, height: 727 } } }],
});
