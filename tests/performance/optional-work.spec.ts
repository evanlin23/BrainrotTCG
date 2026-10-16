import { test, expect } from '@playwright/test';
import { monitor, expectDecoded, expectRecordedPack } from '../browser/support';
import { STORAGE_KEYS } from '../../src/constants/config';
import { PROFILE, REPETITIONS } from './report';
import { ARGON2_BYTES_PER_JOB, OPTIONAL_HISTORY_RECORDS, OPTIONAL_SCENARIOS, type OptionalMeasurement } from './optional-work';

type TicketEvent = { t: number; kind: 'start' | 'done'; worker: number; nonce: number };
declare global {
  interface Window { ticketEvents: TicketEvent[] }
}

const N = OPTIONAL_HISTORY_RECORDS;
const SEED01_PUBLIC_KEY = '8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c';

for (const scenario of OPTIONAL_SCENARIOS) for (let repetition = 1; repetition <= REPETITIONS; repetition++) {
  test(`${scenario} / ${repetition}`, async ({ page, context, browser, baseURL }, testInfo) => {
    const active = scenario === 'optional-active';
    const cdp = await context.newCDPSession(page);
    const errors = await monitor(page, baseURL!, N);
    if (active) {
      // As if a re-open was left unfinished: the same synthetic records without their cards, so the
      // app re-mines them in the background on load. Only once, before any pack is added.
      await page.addInitScript(({ keys, origin, records, publicKeyHex }) => {
        if (location.origin !== origin || localStorage.getItem('brainrot-reopen-pending-v1')) return;
        const history: { c?: string }[] = JSON.parse(localStorage.getItem(keys.HISTORY) ?? '[]');
        if (history.length !== records || !history.every((record) => record.c)) return;
        for (const record of history) delete record.c;
        localStorage.setItem(keys.HISTORY, JSON.stringify(history));
        localStorage.setItem('brainrot-reopen-pending-v1', publicKeyHex);
      }, { keys: STORAGE_KEYS, origin: new URL(baseURL!).origin, records: N, publicKeyHex: SEED01_PUBLIC_KEY });
    }
    // Every ticket job a worker is given, and its answer: the live lane mines nonce N (the next
    // pack), optional work mines the older nonces.
    await page.addInitScript(() => {
      const events: TicketEvent[] = window.ticketEvents = [];
      const Native = window.Worker;
      let workers = 0;
      window.Worker = class extends Native {
        private index = workers++;
        private jobs = new Map<unknown, number>();
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          this.addEventListener('message', (event: MessageEvent<{ id?: unknown }>) => {
            const nonce = this.jobs.get(event.data?.id);
            if (nonce === undefined) return;
            this.jobs.delete(event.data.id);
            events.push({ t: performance.now(), kind: 'done', worker: this.index, nonce });
          });
        }
        postMessage(message: unknown, options?: StructuredSerializeOptions | Transferable[]) {
          const job = message as { id?: unknown; nonce?: unknown };
          if (typeof job?.nonce === 'number') {
            this.jobs.set(job.id, job.nonce);
            events.push({ t: performance.now(), kind: 'start', worker: this.index, nonce: job.nonce });
          }
          super.postMessage(message, options as StructuredSerializeOptions);
        }
        terminate() {
          for (const nonce of this.jobs.values()) events.push({ t: performance.now(), kind: 'done', worker: this.index, nonce });
          this.jobs.clear();
          super.terminate();
        }
      };
    });
    let workersCreated = 0;
    page.on('worker', () => workersCreated++);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Network.clearBrowserCache');
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: PROFILE.cpuSlowdown });
    await cdp.send('Network.emulateNetworkConditions', PROFILE.network);
    try {
      const shell = page.locator('.pack-shell');
      const openButton = page.getByRole('button', { name: 'Open pack', exact: true });
      await page.goto('./');
      await expectDecoded(shell.locator('img'), 2);
      await openButton.click({ trial: true });
      const navigationToClickableMs = await page.evaluate(() => performance.now());
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem('brainrot-player-v1')!).nextNonce)).toBe(N);
      // Press only once the live ticket is ready, so both scenarios time the same opening; the active
      // one also waits for optional tickets to be mining.
      await page.waitForFunction(({ live, active }) => {
        const events = window.ticketEvents;
        const busy = new Map<string, number>();
        for (const e of events) busy.set(`${e.worker}:${e.nonce}`, (busy.get(`${e.worker}:${e.nonce}`) ?? 0) + (e.kind === 'start' ? 1 : -1));
        const optional = [...busy].filter(([key, open]) => open > 0 && Number(key.split(':')[1]) < live).length;
        return events.some((e) => e.kind === 'done' && e.nonce === live) && (!active || optional > 0);
      }, { live: N, active }, { timeout: 45_000 });
      await openButton.focus();
      const pressedAt = await page.evaluate(() => performance.now());
      await page.keyboard.press('Space');
      // The first frame with the summary; optional work stays held until its cards decode (2 s cap).
      const summaryShown = page.waitForFunction(() => document.querySelector('.pack-summary') && performance.now(), undefined, { polling: 'raf', timeout: 30_000 });
      await expect(page.locator('.card-reveal-area')).toBeVisible({ timeout: 15_000 });
      await page.locator('button.reveal-skip').click({ timeout: 15_000 });
      await expect(page.locator('.pack-summary')).toBeVisible({ timeout: 30_000 });
      const summaryAt = Number(await (await summaryShown).jsonValue());
      await expectDecoded(page.locator('.summary-cards img'), 5);
      const resultAt = await page.evaluate(() => performance.now());
      const { events, device } = await page.evaluate(() => ({
        events: window.ticketEvents,
        device: { hardwareConcurrency: navigator.hardwareConcurrency, deviceMemory: (navigator as { deviceMemory?: number }).deviceMemory ?? null },
      }));

      const busyAt = (t: number) => {
        const open = new Map<string, TicketEvent>();
        for (const e of events.filter((e) => e.t <= t)) {
          if (e.kind === 'start') open.set(`${e.worker}:${e.nonce}`, e); else open.delete(`${e.worker}:${e.nonce}`);
        }
        return [...open.values()];
      };
      const optional = (e: TicketEvent) => e.nonce < N;
      const between = (from: number, to: number) => events.filter((e) => e.t > from && e.t <= to && optional(e));
      const held = between(pressedAt, summaryAt);
      const liveStart = events.find((e) => e.kind === 'start' && e.nonce === N)!;
      const liveDone = events.find((e) => e.kind === 'done' && e.nonce === N)!;
      const peakBusy = Math.max(0, ...events.filter((e) => e.t <= resultAt).map((e) => busyAt(e.t).length));
      let memory: OptionalMeasurement['memory'];
      try {
        const heap = await cdp.send('Runtime.getHeapUsage');
        memory = { supported: true, value: { scope: 'main-target-js-heap-only', usedBytes: heap.usedSize, totalBytes: heap.totalSize } };
      } catch {
        memory = { supported: false, reason: 'Runtime.getHeapUsage unavailable in selected browser/target' };
      }
      const measurement: OptionalMeasurement = {
        browser: browser.version(), device, navigationToClickableMs, liveTicketMs: liveDone.t - liveStart.t,
        openToSummaryMs: summaryAt - pressedAt,
        openToResultMs: resultAt - pressedAt,
        workers: {
          created: workersCreated, peakBusy,
          optionalInFlightAtPress: busyAt(pressedAt).filter(optional).length,
          optionalStartedBeforeSummary: held.filter((e) => e.kind === 'start').length,
          optionalFinishedBeforeSummary: held.filter((e) => e.kind === 'done').length,
          optionalStartedAfterSummary: between(summaryAt, resultAt).filter((e) => e.kind === 'start').length,
        },
        estimatedArgon2PeakBytes: peakBusy * ARGON2_BYTES_PER_JOB,
        memory,
      };
      await testInfo.attach('performance-measurement', { body: Buffer.from(JSON.stringify(measurement)), contentType: 'application/json' });
      if (active) expect(measurement.workers.optionalInFlightAtPress).toBeGreaterThan(0);
      // The opening saved exactly as without optional work: the new record leads the history.
      await expectRecordedPack(page, N, N + 1);
      expect(errors).toEqual([]);
    } finally {
      await cdp.detach();
    }
  });
}
