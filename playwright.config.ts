import { defineConfig, devices } from '@playwright/test';

// PREVIEW_PORT moves a local run off a busy port; unset or empty keeps the default.
function previewPort(value = '') {
  if (!value.trim()) return 4173;
  // Digits only: Number() alone would accept "1e3", "0x50" or " 80 ".
  const port = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PREVIEW_PORT must be digits only, from 1 to 65535, got "${value}"`);
  }
  return port;
}
const PORT = previewPort(process.env.PREVIEW_PORT);
const BASE_PATH = process.env.BASE_PATH ?? '/BrainrotTCG/';
const baseURL = `http://127.0.0.1:${PORT}${BASE_PATH}`;

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  // No retries: a test that fails once is fixed, not re-run. If retries are ever added, CI still
  // fails a test that only passed on a retry.
  retries: 0,
  failOnFlakyTests: !!process.env.CI,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  outputDir: 'test-results',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    serviceWorkers: 'block',
  },
  projects: [
    {
      name: 'desktop-chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
    {
      name: 'mobile-chromium',
      use: { ...devices['Pixel 5'] },
    },
  ],
  webServer: {
    // The runner owns a fresh build and server; an unrelated server on this port must fail.
    command: `npm run build && npx vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: 300000,
  },
});
