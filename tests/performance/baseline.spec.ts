import { test, expect } from '@playwright/test';
import { monitor, expectDecoded, expectRecordedPack, snapshot } from '../browser/support';
import { STORAGE_KEYS } from '../../src/constants/config';
import { PROFILE, REPETITIONS, SCENARIOS, cacheOf, historyRecordsOf, range, type Measurement } from './report';

declare global {
  interface Window {
    baselineObservations: { longTasksSupported: boolean; longTasks: number[]; frames: number[] };
  }
}

for (const scenario of SCENARIOS) for (let repetition = 1; repetition <= REPETITIONS; repetition++) {
  test(`${scenario} / ${repetition}`, async ({ page, context, browser, baseURL }, testInfo) => {
    const historyCount = historyRecordsOf(scenario);
    const warm = cacheOf(scenario) === 'warm';
    // A warm run loads the app twice (priming, then measured).
    if (warm) test.setTimeout(2 * testInfo.timeout);
    const origin = new URL(baseURL!).origin;
    const cdp = await context.newCDPSession(page);
    const errors = await monitor(page, baseURL!, historyCount, { routeHttp: !warm });
    if (warm) {
      // Same HTTP guard as the context route, but through CDP Fetch so the HTTP cache stays on.
      // It covers this page only, so any other page is an error.
      context.on('page', (other) => errors.push(`unguarded page ${other.url()}`));
      cdp.on('Fetch.requestPaused', ({ requestId, request }) => {
        (new URL(request.url).origin === origin ? cdp.send('Fetch.continueRequest', { requestId })
          : cdp.send('Fetch.fulfillRequest', { requestId, responseCode: 204, responseHeaders: [{ name: 'Access-Control-Allow-Origin', value: '*' }] }))
          .catch((error) => errors.push(`HTTP guard: ${String(error)}`));
      });
      await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    }

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
    // Cold runs keep #304 routing/isolation unchanged; routing disables HTTP cache, so they make
    // no warm/browser-cache performance claim. Warm runs keep the cache and measure its reuse.
    if (!warm) await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Network.clearBrowserCache');
    const throttle = async () => {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: PROFILE.cpuSlowdown });
      await cdp.send('Network.emulateNetworkConditions', PROFILE.network);
    };
    // Priming only fills caches, so it runs unthrottled to keep the warm run short.
    if (!warm) await throttle();
    const shell = page.locator('.pack-shell');
    const openButton = page.getByRole('button', { name: 'Open pack', exact: true });
    let encodedBytes = 0;
    let completedRequests = 0;
    const requests = new Set<string>();
    // Same-origin ids are kept after loading finishes because the wire status can arrive later.
    const sameOrigin = new Set<string>();
    const servedFromCache = new Set<string>();
    const notModified = new Set<string>();
    let workersCreated = 0;
    page.on('worker', () => workersCreated++);
    cdp.on('Network.requestWillBeSent', (event) => {
      if (new URL(event.request.url).origin === origin) { requests.add(event.requestId); sameOrigin.add(event.requestId); }
    });
    cdp.on('Network.requestServedFromCache', (event) => {
      if (requests.has(event.requestId)) servedFromCache.add(event.requestId);
    });
    cdp.on('Network.responseReceived', ({ requestId, response }) => {
      if (!requests.has(requestId)) return;
      if (response.fromDiskCache || response.fromPrefetchCache) servedFromCache.add(requestId);
      if (response.status === 304) notModified.add(requestId);
    });
    // A revalidation from the HTTP cache reports the cached 200 to the page; only the extra info
    // carries the 304 that came over the wire.
    cdp.on('Network.responseReceivedExtraInfo', (event) => {
      if (sameOrigin.has(event.requestId) && event.statusCode === 304) notModified.add(event.requestId);
    });
    cdp.on('Network.loadingFinished', (event) => {
      if (requests.delete(event.requestId)) { encodedBytes += event.encodedDataLength; completedRequests++; }
    });
    cdp.on('Network.loadingFailed', (event) => requests.delete(event.requestId));

    const journey = async () => {
      await page.goto('./');
      await expectDecoded(shell.locator('img'), 2);
      await openButton.click({ trial: true });
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
      await openButton.focus();
      const openingStarted = await page.evaluate(() => performance.now());
      await page.keyboard.press('Space');
      await expect(page.locator('.card-reveal-area')).toBeVisible({ timeout: 15_000 });
      await page.locator('button.reveal-skip').click({ timeout: 15_000 });
      await expect(page.locator('.pack-summary')).toBeVisible({ timeout: 30_000 });
      await expectDecoded(page.locator('.summary-cards img'), 5);
      const openToResultMs = await page.evaluate((start) => performance.now() - start, openingStarted);
      return { navigationToClickableMs, fixture, openToResultMs };
    };

    try {
      let warmDetails: Measurement['warm'];
      if (warm) {
        await journey();
        const indexedDBDatabases = await page.evaluate(async () => (await indexedDB.databases()).map((db) => db.name ?? ''));
        // Leave the origin, then reset only localStorage: the seeded identity comes back at the same
        // nonce, so the measured load mines the same ticket as the cold run. The HTTP cache and
        // IndexedDB stay from the priming load.
        await page.goto('about:blank');
        await cdp.send('Storage.clearDataForOrigin', { origin, storageTypes: 'local_storage' });
        // The priming page's heap would otherwise inflate the measured heap until V8 collects it.
        await cdp.send('HeapProfiler.collectGarbage');
        encodedBytes = 0; completedRequests = 0; workersCreated = 0;
        requests.clear(); sameOrigin.clear(); servedFromCache.clear(); notModified.clear();
        await throttle();
        warmDetails = { indexedDBDatabases, servedFromCache: 0, notModified: 0 };
      }
      const { navigationToClickableMs, fixture, openToResultMs } = await journey();
      if (warmDetails) Object.assign(warmDetails, { servedFromCache: servedFromCache.size, notModified: notModified.size });
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
        ...(warmDetails ? { warm: warmDetails } : {}),
      };
      // Preserve raw observations even if subsequent functional validation fails; the reporter
      // excludes failed runs from all timing summaries.
      await testInfo.attach('performance-measurement', { body: Buffer.from(JSON.stringify(measurement)), contentType: 'application/json' });
      if (process.env.PERF_INJECT_FUNCTIONAL_FAILURE === '1') {
        await page.evaluate((key) => localStorage.setItem(key, '{}'), STORAGE_KEYS.COLLECTION);
      }
      const before = await expectRecordedPack(page, historyCount, historyCount + 1);
      // Verify the HTTP guard (context route, or CDP Fetch when warm), the WebSocket guard and Worker
      // HTTP interception. These reserved .invalid destinations cannot be public writes even if a guard regresses.
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
      await page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('button', { name: 'Profile', exact: true }).click();
      await expect(page.getByRole('main', { name: 'Profile', exact: true })).toContainText(`All packs · ${historyCount + 1}`);
      expect(await snapshot(page)).toEqual(before);
      expect(errors).toEqual([]);
    } finally {
      await cdp.detach();
    }
  });
}
