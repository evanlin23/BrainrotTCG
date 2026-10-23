import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

// Fixed, whatever PREVIEW_PORT, BASE_PATH or SITE_URL say locally: the share sheet's QR code encodes
// location.origin and the path (src/game/pulls.ts), and index.html carries the site's address, so
// either would draw different pixels.
const PORT = 4173;
const BASE_PATH = '/BrainrotTCG/';
const baseURL = `http://127.0.0.1:${PORT}${BASE_PATH}`;

/**
 * Screenshot baselines for a few core screens (#745), run with `npm run test:visual`. Pixels depend
 * on the browser build and the system's font rasteriser, so they run only in the pinned Playwright
 * container CI uses (the visual-baselines job in .github/workflows/browser-tests.yml), locally too; the same
 * spec on another OS or Chromium would differ without a design change. docs/DEVELOPMENT.md says how
 * a baseline is updated and reviewed.
 *
 * Everything that could move a pixel without a design change is fixed: the browser, viewport, device
 * scale factor (1, which also keeps the images small), locale, time zone, the page clock (in the
 * spec), reduced motion, and CSS animations and the caret at screenshot time. The fixture player and
 * its first ticket fix the cards.
 */
export default defineConfig({
  ...base,
  testDir: './tests/visual',
  testMatch: '*.spec.ts',
  outputDir: 'test-results/visual',
  // One file per screen and project, beside the spec; the platform isn't in the name because only
  // the pinned container may write or compare them.
  snapshotPathTemplate: '{testDir}/baselines/{arg}-{projectName}{ext}',
  // Never write a missing baseline on CI: a new or renamed screen fails until a reviewed image is committed.
  updateSnapshots: process.env.CI ? 'none' : 'missing',
  use: {
    ...base.use,
    baseURL,
    // Only the images are evidence here; traces and videos would hold the fixture's saved data too.
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    locale: 'en-US',
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
    colorScheme: 'light',
  },
  expect: {
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
      // No tolerance: the pinned container draws the same pixels every run (proven with
      // --repeat-each), so any difference at all is a change to review.
      threshold: 0,
      maxDiffPixels: 0,
    },
  },
  webServer: {
    ...base.webServer,
    command: `npm run build && npx vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: baseURL,
    // Merged over the runner's environment, so these win; an empty SITE_URL builds production's address.
    env: { BASE_PATH, SITE_URL: '' },
  },
  projects: [
    { name: 'narrow', use: { ...devices['Pixel 5'], deviceScaleFactor: 1 } },
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 } },
  ],
});
