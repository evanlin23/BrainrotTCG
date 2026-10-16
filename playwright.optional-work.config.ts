import { defineConfig } from '@playwright/test';
import performanceConfig from './playwright.performance.config';

/** Opt-in, report-only: a live opening with optional work idle vs running (docs/DEVELOPMENT.md). */
export default defineConfig({
  ...performanceConfig,
  testMatch: 'optional-work.spec.ts',
  outputDir: 'test-results/performance-optional-work',
  reporter: [['list'], ['./scripts/optional-work-reporter.ts']],
  projects: [{ name: 'optional-work-chromium', use: { browserName: 'chromium', viewport: { width: 393, height: 727 } } }],
});
