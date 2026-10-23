import { defineConfig, devices } from '@playwright/test';
import browserConfig from './playwright.config';

// The cross-browser smoke (#658): the first-pack and share journeys tagged @cross-browser in
// tests/browser, on Firefox and WebKit. Everything else stays on Chromium (playwright.config.ts).
// WebKit here is Playwright's Linux build with iPhone touch emulation: not iOS Safari, a physical
// phone or its native share sheet. Firefox has no mobile emulation, so it runs on desktop only.
export default defineConfig({
  ...browserConfig,
  grep: /@cross-browser/,
  outputDir: 'test-results/compat',
  reporter: [process.env.CI ? ['github'] : ['list'], ['./scripts/compat-reporter.ts']],
  // Traces of failures only (screenshots too, no video), so what a failed run uploads stays small.
  use: { ...browserConfig.use, video: 'off' },
  projects: [
    { name: 'desktop-firefox', use: { ...devices['Desktop Firefox'], viewport: { width: 1280, height: 800 } } },
    { name: 'mobile-webkit', use: { ...devices['iPhone 13'] } },
  ],
});
