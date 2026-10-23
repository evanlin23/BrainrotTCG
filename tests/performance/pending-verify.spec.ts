import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { monitor } from '../browser/support';
import { ARGON2_BYTES_PER_JOB } from './optional-work';
import { PROFILE, REPETITIONS } from './report';

/**
 * Pending Hall of Fame pulls checked on the constrained profile (#777). The published list is served
 * in place of hall-of-fame.json, and stand-in relays answer with the signed pulls that
 * scripts/pending-verify-fixture.ts wrote. Each of those pulls qualifies, so each one the page
 * verifies adds a row. Nothing leaves the browser.
 */
const PENDING_FIXTURE = process.env.PENDING_FIXTURE || 'test-results/pending-verify-fixture.json';
const { set, events, keys } = JSON.parse(readFileSync(PENDING_FIXTURE, 'utf8')) as { set: { id: string; name: string }; events: unknown[]; keys: string[] };
const PUBLISHED = 3;
type PendingTicket = { t: number; kind: 'start' | 'done'; worker: number; key: string };
type Rows = { t: number; count: number };
declare global {
  interface Window { pendingVerify: { clickedAt?: number; tickets: PendingTicket[]; rows: Rows[]; frameTimes: number[]; longTasks: { start: number; duration: number }[] } }
}

const published = Array.from({ length: PUBLISHED }, (_, i) => ({
  id: `published-${i}`, proof: `fixture-proof-${i}`, name: `Published ${i}`, fingerprint: 'abcd1234', setId: set.id, setName: set.name,
  hand: 'High Card', multiplier: 1, score: 1 + i, cards: [], issue: 1000 + i, githubUser: 'fixture', submittedAt: new Date().toISOString(),
}));
const relaysAnswer = (page: Page) => page.routeWebSocket(/.*/, (socket) => socket.onMessage((message) => {
  const [type, subscription] = JSON.parse(String(message)) as [string, string];
  if (type !== 'REQ') return;
  for (const event of events) socket.send(JSON.stringify(['EVENT', subscription, event]));
  socket.send(JSON.stringify(['EOSE', subscription]));
}));
const isPending = (e: PendingTicket) => keys.includes(e.key.split('/')[0]);

for (let repetition = 1; repetition <= REPETITIONS; repetition++) {
  test(`pending-verify / ${repetition}`, async ({ page, context, browser, baseURL }, testInfo) => {
    const cdp = await context.newCDPSession(page);
    const errors = await monitor(page, baseURL!, 0, { returning: true });
    await relaysAnswer(page);
    await page.route('**/hall-of-fame.json', (route) => route.fulfill({ json: published }));
    // From page start: the first click, every animation frame with the number of rows on screen, long
    // tasks, and every ticket job a worker is given and its answer (by key and nonce).
    await page.addInitScript(() => {
      const state: Window['pendingVerify'] = window.pendingVerify = { tickets: [], rows: [], frameTimes: [], longTasks: [] };
      const { tickets: events, rows, frameTimes: frames, longTasks } = state;
      document.addEventListener('click', () => { state.clickedAt ??= performance.now(); }, true);
      try {
        new PerformanceObserver((list) => { for (const e of list.getEntries()) longTasks.push({ start: e.startTime, duration: e.duration }); }).observe({ type: 'longtask', buffered: true });
      } catch { /* no Long Tasks API: the counts stay 0 and the frame gaps still show stalls */ }
      let last = -1;
      const tick = (t: number) => {
        frames.push(t);
        const count = document.querySelectorAll('.hof-list .hof-entry').length;
        if (count !== last) rows.push({ t, count });
        last = count;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      const Native = window.Worker;
      let workers = 0;
      window.Worker = class extends Native {
        private index = workers++;
        private jobs = new Map<unknown, string>();
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          this.addEventListener('message', (event: MessageEvent<{ id?: unknown }>) => {
            const key = this.jobs.get(event.data?.id);
            if (key === undefined) return;
            this.jobs.delete(event.data.id);
            events.push({ t: performance.now(), kind: 'done', worker: this.index, key });
          });
        }
        postMessage(message: unknown, options?: StructuredSerializeOptions | Transferable[]) {
          const job = message as { id?: unknown; nonce?: unknown; publicKeyHex?: unknown };
          if (typeof job?.nonce === 'number') {
            const key = `${String(job.publicKeyHex)}/${job.nonce}`;
            this.jobs.set(job.id, key);
            events.push({ t: performance.now(), kind: 'start', worker: this.index, key });
          }
          super.postMessage(message, options as StructuredSerializeOptions);
        }
        terminate() {
          for (const key of this.jobs.values()) events.push({ t: performance.now(), kind: 'done', worker: this.index, key });
          this.jobs.clear();
          super.terminate();
        }
      };
    });
    let workersCreated = 0;
    page.on('worker', () => workersCreated++);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: PROFILE.cpuSlowdown });
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', PROFILE.network);
    try {
      await page.goto('./');
      await page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('button', { name: 'Rankings', exact: true }).click();
      // Every pending pull has been mined once as many pending tickets are done, and shown once every row is.
      await page.waitForFunction((keys) => window.pendingVerify.tickets.filter((e) => e.kind === 'done' && keys.includes(e.key.split('/')[0])).length >= keys.length, keys, { timeout: 120_000 });
      await page.waitForFunction((n) => (window.pendingVerify.rows.at(-1)?.count ?? 0) >= n, PUBLISHED + events.length, { timeout: 10_000, polling: 'raf' });
      const { clickedAt, ticketEvents, rows, frames, longTasks } = await page.evaluate(() => { const s = window.pendingVerify; return { clickedAt: s.clickedAt!, ticketEvents: s.tickets, rows: s.rows, frames: s.frameTimes, longTasks: s.longTasks }; });
      const starts = ticketEvents.filter((e) => isPending(e) && e.kind === 'start');
      const dones = ticketEvents.filter((e) => isPending(e) && e.kind === 'done');
      const busy = new Set<string>();
      let peakBusy = 0;
      for (const e of ticketEvents) {
        if (e.kind === 'start') busy.add(`${e.worker}:${e.key}`); else busy.delete(`${e.worker}:${e.key}`);
        peakBusy = Math.max(peakBusy, busy.size);
      }
      // The worker's idle time from one pending ticket's answer to the next one's start.
      const gaps = starts.slice(1).map((s, i) => s.t - dones[i].t);
      const lastRowAt = rows.find((r) => r.count >= PUBLISHED + events.length)!.t;
      const during = frames.filter((t) => t >= starts[0].t && t <= lastRowAt);
      const intervals = during.slice(1).map((t, i) => t - during[i]).sort((a, b) => a - b);
      const tasks = longTasks.filter((e) => e.start >= starts[0].t && e.start <= lastRowAt);
      const heap = await cdp.send('Runtime.getHeapUsage');
      const since = (t: number) => Math.round(t - clickedAt);
      const measurement = {
        browser: browser.version(), pending: events.length,
        boardPaintMs: since(rows.find((r) => r.count >= PUBLISHED)!.t),
        firstPendingRowMs: since(rows.find((r) => r.count > PUBLISHED)!.t),
        lastPendingRowMs: since(lastRowAt),
        pendingRowsMs: rows.filter((r) => r.count > PUBLISHED).map((r) => since(r.t)),
        pendingTicketsDoneMs: dones.map((d) => since(d.t)),
        meanTicketMs: Math.round(dones.reduce((sum, d, i) => sum + d.t - starts[i].t, 0) / dones.length),
        workerIdleBetweenTicketsMs: { total: Math.round(gaps.reduce((a, b) => a + b, 0)), max: Math.round(Math.max(...gaps)) },
        workersCreated, peakBusyTickets: peakBusy, estimatedArgon2PeakBytes: peakBusy * ARGON2_BYTES_PER_JOB,
        frames: { medianMs: intervals[Math.floor(intervals.length / 2)], maxMs: intervals.at(-1), over50: intervals.filter((v) => v > 50).length },
        longTasks: { count: tasks.length, totalMs: tasks.reduce((a, e) => a + e.duration, 0), maxMs: Math.max(0, ...tasks.map((e) => e.duration)) },
        mainHeapUsedBytes: heap.usedSize,
      };
      console.log(`pending-verify ${JSON.stringify(measurement)}`);
      await testInfo.attach('pending-verify', { body: Buffer.from(JSON.stringify(measurement)), contentType: 'application/json' });
      expect(errors).toEqual([]);
    } finally {
      await cdp.detach();
    }
  });
}
