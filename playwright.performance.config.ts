import { defineConfig } from '@playwright/test';
import browserConfig from './playwright.config';

export default defineConfig({
  ...browserConfig,
  testDir: './tests/performance',
  testMatch: 'baseline.spec.ts',
  timeout: 60_000,
  globalTimeout: 12 * 60_000,
  outputDir: 'test-results/performance',
  reporter: [['list'], ['./scripts/performance-reporter.ts']],
  use: { ...browserConfig.use, video: 'off' },
  projects: [{ name: 'baseline-chromium', use: { browserName: 'chromium', viewport: { width: 393, height: 727 } } }],
});
