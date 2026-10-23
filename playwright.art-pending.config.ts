import { defineConfig } from '@playwright/test';
import performanceConfig from './playwright.performance.config';

/** Opt-in, report-only: how long card art stays a placeholder on a slow phone profile (#762, docs/DEVELOPMENT.md). */
export default defineConfig({
  ...performanceConfig,
  testMatch: 'art-pending.spec.ts',
  outputDir: 'test-results/performance-art-pending',
  reporter: [['list']],
  projects: [{
    name: 'art-pending-chromium',
    use: {
      browserName: 'chromium', viewport: { width: 360, height: 640 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
      launchOptions: { executablePath: process.env.CHROMIUM_PATH || undefined },
    },
  }],
});
