import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { monitor, artUrl } from '../browser/support';
import { REPETITIONS } from './report';

/**
 * How long card art stays a placeholder (#762), on the profile the issue's evidence used: a cold load at
 * 360x640 with touch, 120ms per response, 1.6Mbps down and the main thread slowed 4x. Report-only: one
 * JSON line per run and no budget. It is desktop-Chromium emulation, not a phone, and the CPU slowdown
 * doesn't reach the ticket worker that re-derives a shared pull.
 *
 * From navigation start, in page time: when a shared pull shows as verified and when each of its slots
 * is drawn (CardImage marks it ready), and for a 20-row Rankings board, when the first row and every
 * row on screen have their thumbnails. Art bytes are the card art's encoded bodies, from Resource Timing.
 */
const NETWORK = { offline: false, latency: 120, downloadThroughput: 1_600_000 / 8, uploadThroughput: 750_000 / 8 };
const CPU_SLOWDOWN = 4;

const vectors = JSON.parse(readFileSync(new URL('../../spec/vectors-python.json', import.meta.url), 'utf8')) as {
  valid: { note: string; proof: string }[];
};
const PULLS = {
  'pull-finished': 'modifiers (§5.4): a Silver misprint, stacked',
  'pull-plain': 'mined Full House',
} as const;
const proofOf = (note: string) => vectors.valid.find((v) => v.note === note)!.proof;

const CARDS = ['ai-rumpelstiltskin', 'black-cat-clapping', 'bukangi', 'chile-memes', 'huss-valley', 'jimothy', 'la-peace', 'niu-lai', 'pirate-gaster', 'remember-november', 'steal-an-egg', 'verity'];
const board = Array.from({ length: 20 }, (_, row) => ({
  id: `art-${row}`, proof: `art-proof-${row}`, name: `Player ${row}`, fingerprint: 'abcd', setId: 'right-now', setName: 'Right Now',
  hand: 'High Card', multiplier: 1, score: 100_000 - row, submittedAt: '2026-10-01T00:00:00.000Z', issue: 1000 + row, githubUser: 'fixture',
  cards: Array.from({ length: 5 }, (_, i) => ({ cardId: CARDS[(row * 5 + i) % CARDS.length], isHolo: false })),
}));

type Probe = { verifiedAt?: number; slotsReadyAt: (number | undefined)[]; firstRowAt?: number; firstRowReadyAt?: number; onScreenReadyAt?: number };
declare global {
  interface Window { artPending: Probe }
}

/** One frame loop from page start that only reads the DOM: the first frame each milestone is on screen. */
async function probe(page: Page) {
  await page.addInitScript(() => {
    const state: Probe = window.artPending = { slotsReadyAt: [] };
    const drawn = (img: HTMLImageElement) => img.dataset.state === 'ready' && img.complete && img.naturalWidth > 0;
    const tick = (t: number) => {
      if (state.verifiedAt === undefined && document.querySelector('.pull-viewer-badge')?.textContent?.includes('checks out')) state.verifiedAt = t;
      document.querySelectorAll<HTMLImageElement>('.pack-viewer-cards img.card-image').forEach((img, i) => {
        if (state.slotsReadyAt[i] === undefined && drawn(img)) state.slotsReadyAt[i] = t;
      });
      const first = document.querySelector('.hof-list .hof-entry');
      if (first && state.firstRowAt === undefined) state.firstRowAt = t;
      const firstThumbs = first ? Array.from(first.querySelectorAll<HTMLImageElement>('img.card-image')) : [];
      if (state.firstRowReadyAt === undefined && firstThumbs.length && firstThumbs.every(drawn)) state.firstRowReadyAt = t;
      const onScreen = Array.from(document.querySelectorAll<HTMLImageElement>('.hof-cards img.card-image')).filter((img) => img.getBoundingClientRect().top < innerHeight);
      if (state.onScreenReadyAt === undefined && onScreen.length && onScreen.every(drawn)) state.onScreenReadyAt = t;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

const artTransfer = (page: Page) => page.evaluate((source) => {
  const art = performance.getEntriesByType('resource').filter((e) => new RegExp(source).test(new URL(e.name).pathname)) as PerformanceResourceTiming[];
  return {
    requests: art.length,
    bytes: art.reduce((sum, e) => sum + e.encodedBodySize, 0),
    firstRequestMs: Math.round(Math.min(...art.map((e) => e.startTime))),
    lastResponseMs: Math.round(Math.max(...art.map((e) => e.responseEnd))),
  };
}, artUrl.source);

async function throttle(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_SLOWDOWN });
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', NETWORK);
  return cdp;
}

for (const [scenario, note] of Object.entries(PULLS)) for (let repetition = 1; repetition <= REPETITIONS; repetition++) {
  test(`${scenario} / ${repetition}`, async ({ page, browser, baseURL }, testInfo) => {
    test.setTimeout(120_000);
    const errors = await monitor(page, baseURL!, 0, { returning: true, routeHttp: false });
    await probe(page);
    const cdp = await throttle(page);
    try {
      await page.goto(`./#/pull/${proofOf(note)}`);
      await page.waitForFunction(() => window.artPending.slotsReadyAt.filter((t) => t !== undefined).length === 5, undefined, { timeout: 90_000 });
      const { verifiedAt, slotsReadyAt } = await page.evaluate(() => window.artPending);
      // The comparison is from the moment the pull checks out; without it the numbers mean nothing.
      if (verifiedAt === undefined) throw new Error('The pull showed all five cards but never showed as verified');
      const slots = slotsReadyAt.map((t) => Math.round(t!));
      const measurement = {
        browser: browser.version(), scenario, verifiedMs: Math.round(verifiedAt), slotsReadyMs: slots,
        placeholderAfterVerifiedMs: Math.max(...slots) - Math.round(verifiedAt), art: await artTransfer(page),
      };
      console.log(`art-pending ${JSON.stringify(measurement)}`);
      await testInfo.attach('art-pending', { body: Buffer.from(JSON.stringify(measurement)), contentType: 'application/json' });
      expect(errors).toEqual([]);
    } finally {
      await cdp.detach();
    }
  });
}

for (let repetition = 1; repetition <= REPETITIONS; repetition++) {
  test(`rankings / ${repetition}`, async ({ page, browser, baseURL }, testInfo) => {
    test.setTimeout(120_000);
    const errors = await monitor(page, baseURL!, 0, { returning: true, routeHttp: false });
    await page.route('**/hall-of-fame.json', (route) => route.fulfill({ json: board }));
    // No rejected pulls. Served like the board, so it isn't queued behind the throttled thumbs.
    await page.route('**/hall-of-fame-withdrawn.json', (route) => route.fulfill({ json: [] }));
    // Relays that store nothing, so the board is the published list alone.
    await page.routeWebSocket(/.*/, (socket) => socket.onMessage((message) => {
      const [type, subscription] = JSON.parse(String(message)) as [string, string];
      if (type === 'REQ') socket.send(JSON.stringify(['EOSE', subscription]));
    }));
    await probe(page);
    const cdp = await throttle(page);
    try {
      await page.goto('./#/rankings');
      await page.getByRole('main', { name: 'Rankings', exact: true }).getByRole('tab', { name: 'All-time', exact: true }).click();
      await page.waitForFunction(() => window.artPending.onScreenReadyAt !== undefined, undefined, { timeout: 90_000 });
      const { firstRowAt, firstRowReadyAt, onScreenReadyAt } = await page.evaluate(() => window.artPending);
      if (firstRowAt === undefined || firstRowReadyAt === undefined) throw new Error('The on-screen thumbs showed but the probe never saw the first row and its thumbs');
      const measurement = {
        browser: browser.version(), scenario: 'rankings', firstRowMs: Math.round(firstRowAt), firstRowThumbsMs: Math.round(firstRowReadyAt),
        onScreenThumbsMs: Math.round(onScreenReadyAt!), artByThen: await artTransfer(page),
      };
      console.log(`art-pending ${JSON.stringify(measurement)}`);
      await testInfo.attach('art-pending', { body: Buffer.from(JSON.stringify(measurement)), contentType: 'application/json' });
      expect(errors).toEqual([]);
    } finally {
      await cdp.detach();
    }
  });
}
