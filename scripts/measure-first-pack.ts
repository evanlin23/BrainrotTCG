/**
 * Time from first load to first pack revealed, for a brand-new player, in Chromium with phone
 * emulation (390x844, 4x CPU throttle, Fast 4G). Chromium emulation, not a real phone.
 * `npm run build`, then `npx tsx scripts/measure-first-pack.ts [runs] [--waterfall] [--preview]`.
 * By default it serves dist/ the way GitHub Pages does (max-age=600, gzip, ETags); --preview uses
 * a running `npx vite preview --port 4173` instead (no-cache, so reused files are revalidated).
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { gzipSync } from 'node:zlib';
import { chromium } from '@playwright/test';

const RUNS = Number(process.argv.find((arg) => /^\d+$/.test(arg)) ?? 7);
const WATERFALL = process.argv.includes('--waterfall');
const PREVIEW = process.argv.includes('--preview');

const TYPES: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm', '.webp': 'image/webp', '.png': 'image/png', '.mp3': 'audio/mpeg', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
};

/** Serve dist/ under /BrainrotTCG/ with GitHub Pages' headers. */
const servePagesLike = async (): Promise<string> => {
  const root = join(process.cwd(), 'dist');
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/BrainrotTCG/')) { res.writeHead(404).end(); return; }
    let path = normalize(decodeURIComponent(url.pathname.slice('/BrainrotTCG/'.length)));
    if (path.startsWith('..')) { res.writeHead(404).end(); return; }
    if (path === '.' || path.endsWith('/')) path = join(path, 'index.html');
    let body: Buffer;
    try { body = await readFile(join(root, path)); } catch { res.writeHead(404).end(); return; }
    const type = TYPES[extname(path)] ?? 'application/octet-stream';
    const etag = `"${createHash('sha1').update(body).digest('hex')}"`;
    const headers: Record<string, string> = { 'content-type': type, 'cache-control': 'max-age=600', etag };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers).end(); return; }
    if (/^(text\/|application\/(json|wasm|manifest)|image\/svg)/.test(type) && /gzip/.test(String(req.headers['accept-encoding']))) {
      body = gzipSync(body);
      headers['content-encoding'] = 'gzip';
    }
    res.writeHead(200, headers).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.unref();
  const { port } = server.address() as { port: number };
  return `http://127.0.0.1:${port}/BrainrotTCG/`;
};

const BASE = process.env.BASE_URL ?? (PREVIEW ? 'http://127.0.0.1:4173/BrainrotTCG/' : await servePagesLike());
// Chrome DevTools' "Fast 4G" preset.
const FAST_4G = { offline: false, latency: 165, downloadThroughput: (9 * 1024 * 1024) / 8, uploadThroughput: (1.5 * 1024 * 1024) / 8 };

const median = (values: number[]) => {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const run = async (waterfall: boolean) => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
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
  const open = page.getByRole('button', { name: /^Open pack/ });
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
