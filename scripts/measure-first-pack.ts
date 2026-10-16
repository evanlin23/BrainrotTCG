/**
 * Time from first load to first pack revealed, for a brand-new player, in Chromium with phone
 * emulation (390x844, 4x CPU throttle, Fast 4G). Chromium emulation, not a real phone.
 * Needs a server: `npm run build && npx vite preview --port 4173`, then
 * `npx tsx scripts/measure-first-pack.ts [runs] [--waterfall]`.
 */
import { chromium } from '@playwright/test';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4173/BrainrotTCG/';
const RUNS = Number(process.argv[2] ?? 7);
const WATERFALL = process.argv.includes('--waterfall');
// Chrome DevTools' "Fast 4G" preset.
const FAST_4G = { offline: false, latency: 165, downloadThroughput: (9 * 1024 * 1024) / 8, uploadThroughput: (1.5 * 1024 * 1024) / 8 };

const median = (values: number[]) => {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const run = async (waterfall: boolean) => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium' });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  // Each run is a fresh browser, so the HTTP cache starts empty, as on a first visit (and still
  // serves what the page prefetched, as a real one does).
  // No outside traffic (relays, Hall of Fame): the run measures this site only.
  const origin = new URL(BASE).origin;
  await context.routeWebSocket('**/*', (socket) => socket.close());
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await cdp.send('Network.emulateNetworkConditions', FAST_4G);
  const log: { url: string; start: number; end?: number; bytes?: number }[] = [];
  const byId = new Map<string, (typeof log)[number]>();
  let t0 = 0;
  cdp.on('Network.requestWillBeSent', (e) => {
    if (!t0) t0 = e.timestamp;
    const entry = { url: e.request.url, start: (e.timestamp - t0) * 1000 };
    byId.set(e.requestId, entry);
    log.push(entry);
  });
  cdp.on('Network.loadingFinished', (e) => {
    const entry = byId.get(e.requestId);
    if (entry) { entry.end = (e.timestamp - t0) * 1000; entry.bytes = e.encodedDataLength; }
  });
  page.on('request', (r) => { if (new URL(r.url()).origin !== origin && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) console.warn('outside', r.url()); });
  await page.goto(BASE);
  const open = page.getByRole('button', { name: 'Open pack', exact: true });
  await open.waitFor({ state: 'visible', timeout: 60_000 });
  // TAP_DELAY_MS waits before the tap, to separate the tap-to-reveal floor from mining.
  if (process.env.TAP_DELAY_MS) await page.waitForTimeout(Number(process.env.TAP_DELAY_MS));
  const clickedAt = await page.evaluate(() => performance.now());
  await open.click({ timeout: 60_000 });
  const reveal = page.locator('.card-reveal-area');
  await reveal.waitFor({ state: 'visible', timeout: 120_000 });
  // Revealed means its images (the card backs) are drawn, not just the frame.
  await page.waitForFunction(() => {
    const imgs = Array.from(document.querySelectorAll<HTMLImageElement>('.card-reveal-area img'));
    return imgs.length > 0 && imgs.every((img) => img.complete && img.naturalWidth > 0);
  }, undefined, { timeout: 120_000, polling: 'raf' });
  const ms = await page.evaluate(() => performance.now());
  if (waterfall) {
    for (const entry of log) {
      const path = entry.url.replace(BASE, '').slice(0, 70);
      console.log(`${entry.start.toFixed(0).padStart(6)} ${(entry.end ?? NaN).toFixed(0).padStart(6)} ${String(entry.bytes ?? '').padStart(8)} ${path}`);
    }
  }
  await browser.close();
  return { ms, clickedAt };
};

const times: number[] = [];
for (let i = 0; i < RUNS; i++) {
  const { ms, clickedAt } = await run(WATERFALL && i === 0);
  times.push(ms);
  console.log(`run ${i + 1}: ${ms.toFixed(0)} ms (button at ${clickedAt.toFixed(0)}, reveal ${(ms - clickedAt).toFixed(0)} ms after the tap)`);
}
console.log(`median of ${RUNS}: ${median(times).toFixed(0)} ms (min ${Math.min(...times).toFixed(0)}, max ${Math.max(...times).toFixed(0)}), Chromium emulation`);
