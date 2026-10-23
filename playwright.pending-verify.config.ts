import { defineConfig } from '@playwright/test';
import performanceConfig from './playwright.performance.config';

/** Opt-in, report-only: checking pending Hall of Fame pulls on the constrained profile (#777, docs/DEVELOPMENT.md). */
export default defineConfig({
  ...performanceConfig,
  testMatch: 'pending-verify.spec.ts',
  outputDir: 'test-results/performance-pending-verify',
  reporter: [['list']],
  projects: [{ name: 'pending-verify-chromium', use: { browserName: 'chromium', viewport: { width: 393, height: 727 }, launchOptions: { executablePath: process.env.CHROMIUM_PATH || undefined } } }],
});
