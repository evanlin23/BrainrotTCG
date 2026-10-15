import { test, expect } from '@playwright/test';
import { monitor, expectDecoded, expectRecordedPack, snapshot } from '../browser/support';
import { STORAGE_KEYS } from '../../src/constants/config';
import { PROFILE, REPETITIONS, SCENARIOS, range, type Measurement } from './report';

declare global {
  interface Window {
    baselineObservations: { longTasksSupported: boolean; longTasks: number[]; frames: number[] };
  }
}

for (const scenario of SCENARIOS) for (let repetition = 1; repetition <= REPETITIONS; repetition++) {
  test(`${scenario} / ${repetition}`, async ({ page, context, browser, baseURL }, testInfo) => {
    const historyCount = scenario === 'synthetic-history-cold' ? 100 : 0;
    const cdp = await context.newCDPSession(page);
    const errors = await monitor(page, baseURL!, historyCount);

    await page.addInitScript(() => {
      const state = window.baselineObservations = {
        longTasksSupported: PerformanceObserver.supportedEntryTypes.includes('longtask'), longTasks: [] as number[], frames: [] as number[],
      };
      if (state.longTasksSupported) new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) state.longTasks.push(entry.duration);
      }).observe({ type: 'longtask', buffered: true });
      let previous = 0;
      const frame = (time: number) => {
        if (previous) state.frames.push(time - previous);
        previous = time;
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });

    await cdp.send('Network.enable');
    // Keep #304 routing/isolation unchanged. Both scenarios have cold contexts; routing disables
    // HTTP cache, so these observations make no warm/browser-cache performance claim.
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Network.clearBrowserCache');
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: PROFILE.cpuSlowdown });
    await cdp.send('Network.emulateNetworkConditions', PROFILE.network);
    const shell = page.getByRole('button', { name: /^Open a .* pack$/ });
    let encodedBytes = 0;
    let completedRequests = 0;
    const requests = new Set<string>();
    let workersCreated = 0;
    page.on('worker', () => workersCreated++);
    cdp.on('Network.requestWillBeSent', (event) => {
      if (new URL(event.request.url).origin === new URL(baseURL!).origin) requests.add(event.requestId);
    });
    cdp.on('Network.loadingFinished', (event) => {
      if (requests.delete(event.requestId)) { encodedBytes += event.encodedDataLength; completedRequests++; }
    });
    cdp.on('Network.loadingFailed', (event) => requests.delete(event.requestId));

    try {
      await page.goto('./');
      await expectDecoded(shell.locator('img'), 2);
      await shell.click({ trial: true });
      const navigationToClickableMs = await page.evaluate(() => performance.now());
      const fixture = await page.evaluate((keys) => {
        const history = localStorage.getItem(keys.HISTORY) ?? '[]';
        return {
          historyRecordsBefore: JSON.parse(history).length, historyUtf16BytesBefore: history.length * 2,
          localStorageUtf16BytesBefore: Object.entries(localStorage).reduce((bytes, [key, value]) => bytes + 2 * (key.length + value.length), 0),
          nextNonceBefore: JSON.parse(localStorage.getItem('brainrot-player-v1')!).nextNonce,
        };
      }, STORAGE_KEYS);
      expect(fixture.historyRecordsBefore).toBe(historyCount);
      expect(fixture.nextNonceBefore).toBe(historyCount);
      await shell.focus();
      const openingStarted = await page.evaluate(() => performance.now());
      await page.keyboard.press('Space');
      await expect(page.locator('.card-reveal-area')).toBeVisible({ timeout: 15_000 });
      await page.locator('button.reveal-skip').click({ timeout: 15_000 });
      await expect(page.locator('.pack-summary')).toBeVisible({ timeout: 30_000 });
      await expectDecoded(page.locator('.summary-cards img'), 5);
      const openToResultMs = await page.evaluate((start) => performance.now() - start, openingStarted);
      const observed = await page.evaluate(() => window.baselineObservations);
      let memory: Measurement['memory'];
      try {
        const heap = await cdp.send('Runtime.getHeapUsage');
        memory = { supported: true, value: { scope: 'main-target-js-heap-only', usedBytes: heap.usedSize, totalBytes: heap.totalSize } };
      } catch {
        memory = { supported: false, reason: 'Runtime.getHeapUsage unavailable in selected browser/target' };
      }
      const measurement: Measurement = {
        browser: browser.version(), fixture, navigationToClickableMs, openToResultMs,
        transfer: { encodedBytes, completedRequests, inFlightRequests: requests.size }, workersCreated,
        longTasks: observed.longTasksSupported ? {
          supported: true, value: { count: observed.longTasks.length, totalMs: observed.longTasks.reduce((sum, n) => sum + n, 0), maxMs: Math.max(0, ...observed.longTasks) },
        } : { supported: false, reason: 'PerformanceObserver longtask unsupported' },
        frames: { count: observed.frames.length, medianIntervalMs: range(observed.frames).median ?? 0,
          maxIntervalMs: Math.max(0, ...observed.frames), intervalsOver50Ms: observed.frames.filter((n) => n > 50).length },
        memory,
      };
      // Preserve raw observations even if subsequent functional validation fails; the reporter
      // excludes failed runs from all timing summaries.
      await testInfo.attach('performance-measurement', { body: Buffer.from(JSON.stringify(measurement)), contentType: 'application/json' });
      if (process.env.PERF_INJECT_FUNCTIONAL_FAILURE === '1') {
        await page.evaluate((key) => localStorage.setItem(key, '{}'), STORAGE_KEYS.COLLECTION);
      }
      const before = await expectRecordedPack(page, historyCount, historyCount + 1);
      // Verify the existing context HTTP/WebSocket guard and observed Worker HTTP interception. These
      // reserved .invalid destinations cannot be public writes even if a guard regresses.
      expect(await page.evaluate(async () => (await fetch('https://baseline-egress.invalid/write', { method: 'POST', body: 'disposable-probe' })).status)).toBe(204);
      expect(await page.evaluate(() => new Promise<number>((resolve) => {
        const socket = new WebSocket('wss://baseline-egress.invalid');
        socket.onclose = () => resolve(socket.readyState);
      }))).toBe(3);
      expect(await page.evaluate(() => new Promise<number | string>((resolve) => {
        const url = URL.createObjectURL(new Blob([`fetch('https://baseline-egress.invalid/worker-write', {method:'POST',body:'disposable-probe'}).then(r=>postMessage(r.status)).catch(e=>postMessage(String(e)))`], { type: 'text/javascript' }));
        const worker = new Worker(url);
        worker.onmessage = (event) => { worker.terminate(); URL.revokeObjectURL(url); resolve(event.data); };
      }))).toBe(204);
      await page.reload();
      await page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('button', { name: 'My cards', exact: true }).click();
      await page.getByRole('navigation', { name: 'My cards', exact: true }).getByRole('button', { name: 'Best pulls', exact: true }).click();
      await expect(page.locator('.sheet')).toContainText(`All packs · ${historyCount + 1}`);
      expect(await snapshot(page)).toEqual(before);
      expect(errors).toEqual([]);
    } finally {
      await cdp.detach();
    }
  });
}
