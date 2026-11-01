import { test, expect, type Page, type Request, type TestInfo } from '@playwright/test';
import { expectDecoded, expectSummaryTakesClicks, holdTickets, monitor, releaseTickets, snapshot } from '../browser/support';
import {
  ARGON2_BYTES_PER_JOB, BUDGETS, CAPS, REPORT_NOTE, SEED, STORAGE_KEYS, TICKETS_PER_WORKER, capacityConfig, injectedFailure, mainHeap, originUsage,
  peakBusy, poolCap, readRecording, recordPage, recycling, reopenedPacksStored, sourceRevision, storageBytes, syntheticSave, writeReport,
  type CapacityReport, type RunFacts,
} from './capacity';

/**
 * Growing-save and long-session capacity (#709), in emulated Chromium on this host with nothing
 * throttled. Saves are seeded through Settings > Import (its own validation, backup and stamp), and
 * their history is synthetic shape data: never a verified history, a certified profile or a proof.
 * A few real packs per run exercise the ticket worker, Argon2 WASM and persistence. Sizes come from
 * CAPACITY_* (see docs/DEVELOPMENT.md) and are capped in capacity.ts.
 *
 * Asserted: what must hold at any size (exact records, counts, nonces, no lost or doubled pack, the
 * worker pool's cap and its recycling, storage that grows by a pack's records and no more, recovery after
 * a refused write). Timings, long tasks and heap are report-only (#709): they go in the report and are
 * never judged here; a hang is caught by each test's timeout.
 */

const config = capacityConfig();
/** Set by the functional-failure proof (docs/DEVELOPMENT.md > Capacity): the run must exit nonzero with no report. */
const injected = injectedFailure();
const openButton = (page: Page) => page.getByRole('button', { name: /^Open pack/ });

interface Measure {
  clickableMs: number;
  localStorageBytes: number;
  historyBytes: number;
  originUsageBytes: number | null;
  mainHeapUsedBytes: number | null;
  longTaskCount: number;
  longTaskTotalMs: number;
  workersCreated: number;
  peakBusyJobs: number;
}

/** A device the project emulates, as the page reports it (the pool size follows it). */
const deviceOf = (page: Page) => page.evaluate(() => ({
  hardwareConcurrency: navigator.hardwareConcurrency,
  deviceMemory: (navigator as { deviceMemory?: number }).deviceMemory ?? null,
  mobile: (navigator as { userAgentData?: { mobile?: boolean } }).userAgentData?.mobile === true,
}));

async function facts(page: Page, testInfo: TestInfo): Promise<RunFacts> {
  const { revision, dirty } = sourceRevision();
  return { revision, dirty, browser: page.context().browser()?.version() ?? 'unknown', project: testInfo.project.name, device: await deviceOf(page) };
}

/** The packs screen is drawn and its Open pack button can be pressed: ms since the page's navigation began. */
async function reachClickable(page: Page): Promise<number> {
  await expectDecoded(page.locator('.pack-shell img'), 2);
  await openButton(page).click({ trial: true });
  return page.evaluate(() => performance.now());
}

/** Waits for the ticket of `nonce` to finish mining in a worker (the app's own prefetch), not for a time. */
async function ticketReady(page: Page, nonce: number) {
  await page.waitForFunction((n) => window.capacity.jobs.some((job) => job.kind === 'done' && job.nonce === n), nonce, { timeout: 45_000 });
}

async function measure(page: Page, clickableMs: number): Promise<Measure> {
  const recording = await readRecording(page);
  const storage = await storageBytes(page);
  const heap = await mainHeap(page);
  return {
    clickableMs: Math.round(clickableMs),
    localStorageBytes: storage.total,
    historyBytes: storage.perKey[STORAGE_KEYS.HISTORY] ?? 0,
    originUsageBytes: await originUsage(page),
    mainHeapUsedBytes: heap?.usedBytes ?? null,
    longTaskCount: recording.longTasks.length,
    longTaskTotalMs: Math.round(recording.longTasks.reduce((sum, task) => sum + task.duration, 0)),
    workersCreated: recording.workersCreated,
    peakBusyJobs: peakBusy(recording.jobs),
  };
}

/** Presses Open pack with the keyboard and goes through reveal to the decoded summary: ms from press to result. */
async function openPack(page: Page): Promise<number> {
  await openButton(page).focus();
  const pressed = await page.evaluate(() => performance.now());
  await page.keyboard.press('Space');
  await expect(page.locator('.card-reveal-area')).toBeVisible({ timeout: 15_000 });
  await page.locator('button.reveal-skip').click({ timeout: 15_000 });
  await expect(page.locator('.pack-summary')).toBeVisible({ timeout: 30_000 });
  await expectDecoded(page.locator('.summary-cards img'), 5);
  return page.evaluate((from) => performance.now() - from, pressed);
}

const cardsIn = (collection: Awaited<ReturnType<typeof snapshot>>['collection']) =>
  Object.values(collection ?? {}).reduce((total, entry) => total + entry.normalCount + entry.holoCount, 0);

const player = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('brainrot-player-v1')!) as { secretKey: string; nextNonce: number });

/** The pending shelf: one entry per owed pack, plus earlier builds' list. */
const shelf = (page: Page) => page.evaluate(([list, prefix]) => [
  ...JSON.parse(localStorage.getItem(list) ?? '[]') as unknown[],
  ...Object.keys(localStorage).filter((key) => key.startsWith(prefix)),
], [STORAGE_KEYS.PENDING_PACKS, STORAGE_KEYS.PENDING_PACK_PREFIX] as const);

/** Imports a synthetic save through Settings and waits for the app's own reload. */
async function importSave(page: Page, file: string) {
  await page.goto('./#/settings');
  const main = page.getByRole('main', { name: 'Settings', exact: true });
  await expect(main).toBeVisible();
  // The import ends in the app's own reload, which would cut off a pack prefetch still in flight (net::ERR_ABORTED). This
  // document's own prefetch, for the empty player's first pack, finishes first; anything started after it is never mined.
  await ticketReady(page, 0);
  await page.evaluate(async () => {
    await window.capacity.imagesSettled();
    (window as unknown as { beforeImport: boolean }).beforeImport = true;
    Worker.prototype.postMessage = () => undefined;
  });
  await main.locator('input[type="file"]').setInputFiles({ name: 'capacity.json', mimeType: 'application/json', buffer: Buffer.from(file) });
  // The reload drops the marker; the new document's own state is what the test reads next.
  await page.waitForFunction(() => !(window as unknown as { beforeImport?: boolean }).beforeImport);
  await expect(page.locator('.app-logo')).toBeVisible();
}


type Snapshot = Awaited<ReturnType<typeof snapshot>>;

/** What a finished scenario writes: one report, attached only after every assertion above it passed. */
async function finish(page: Page, testInfo: TestInfo, scenario: string, sizes: number[], realPacks: number, results: CapacityReport['results']) {
  const report: CapacityReport = {
    schema: 1, scenario, note: REPORT_NOTE, seed: SEED, facts: await facts(page, testInfo),
    setup: { throttling: 'none', httpCache: 'bypassed by the network guard', indexedDbAtStart: 'empty' },
    samples: { sizes, realPacks }, results,
  };
  await testInfo.attach(`capacity-${scenario}`, { path: writeReport(report), contentType: 'application/json' });
}

/**
 * Resolves once the app's image prefetches have settled and no request of the page is in flight. Event-driven (the page's own request
 * events), so a reload that follows cuts nothing off: the app's lazy chunks and card art have finished.
 */
function networkQuiet(page: Page) {
  const inflight = new Set<Request>();
  const waiting: (() => void)[] = [];
  const changed = () => { if (inflight.size === 0) waiting.splice(0).forEach((resolve) => resolve()); };
  page.on('request', (request) => inflight.add(request));
  const settle = (request: Request) => { inflight.delete(request); changed(); };
  page.on('requestfinished', settle);
  page.on('requestfailed', settle);
  // Art the app prefetches through an image nobody holds starts loading after its ticket: wait for those first.
  return async () => {
    await page.evaluate(() => window.capacity.imagesSettled());
    await new Promise<void>((resolve) => { if (inflight.size === 0) resolve(); else waiting.push(resolve); });
  };
}

/**
 * A page of a fresh disposable player that has imported `size` synthetic records and is back on the
 * packs screen, loaded cold: the import's own reload and the app's prefetches are finished before the
 * page is loaded again, so the timings start from a quiet page. `held` keeps every ticket job back
 * until releaseTickets, for a pack that is still mining.
 */
async function startWith(page: Page, baseURL: string, size: number, { uncached = 0, held = false } = {}) {
  const errors = await monitor(page, baseURL);
  const quiet = networkQuiet(page);
  await recordPage(page);
  const save = syntheticSave(size, uncached);
  // The import starts on the Settings route: loading the packs screen first would have its art prefetch
  // cut off by the import's own reload.
  if (size > 0) await importSave(page, save.file);
  if (held) await holdTickets(page);
  await page.goto('./#/');
  await reachClickable(page);
  if (!held) await ticketReady(page, size);
  await quiet();
  await page.reload();
  return { errors, save, quiet };
}

/** Every record, count and counter a stored pack must leave behind, against the state before it: nothing lost, nothing doubled. */
async function expectPackStored(page: Page, size: number, pack: number, previous: Snapshot): Promise<Snapshot> {
  const after = await snapshot(page);
  expect(after.history).toHaveLength(size + pack);
  expect(after.history[0]).toMatchObject({ n: size + pack - 1 });
  expect(after.history.slice(1)).toEqual(previous.history ?? []);
  expect(after.stats.packsOpened).toBe(size + pack);
  expect(cardsIn(after.collection)).toBe(5 * (size + pack));
  expect((await player(page)).nextNonce).toBe(size + pack);
  expect(await shelf(page)).toEqual([]);
  return after;
}

/**
 * The functional-failure proof: the one stored thing CAPACITY_INJECT_FAILURE names is corrupted behind the
 * app's back after the last pack, so the check on that thing in expectPackStored must fail the run.
 */
async function breakLastPack(page: Page) {
  if (!injected) return;
  await page.evaluate(([kind, keys]) => {
    const read = (key: string) => JSON.parse(localStorage.getItem(key) ?? 'null');
    const write = (key: string, value: unknown) => localStorage.setItem(key, JSON.stringify(value));
    if (kind === 'stats') write(keys.stats, { packsOpened: 0 });
    else if (kind === 'history') write(keys.history, read(keys.history).slice(1));
    else if (kind === 'collection') {
      const collection = read(keys.collection) as Record<string, { normalCount: number }>;
      const first = Object.values(collection)[0];
      first.normalCount += 1;
      write(keys.collection, collection);
    } else if (kind === 'nonce') write(keys.player, { ...read(keys.player), nextNonce: read(keys.player).nextNonce - 1 });
    else write(keys.pending, [{ nonce: 0 }]);
  }, [injected, { stats: STORAGE_KEYS.STATS, history: STORAGE_KEYS.HISTORY, collection: STORAGE_KEYS.COLLECTION, player: 'brainrot-player-v1', pending: STORAGE_KEYS.PENDING_PACKS }] as const);
}

/** Storage a session adds, against the bounds: the shape of a record is fixed, so this is exact enough to assert. */
function expectGrowthWithin(first: Measure, last: Measure, packs: number) {
  expect(last.localStorageBytes - first.localStorageBytes).toBeLessThanOrEqual(BUDGETS.storageOnce + BUDGETS.storagePerPack * packs);
  const historyPerPack = (last.historyBytes - first.historyBytes) / packs;
  expect(historyPerPack).toBeGreaterThanOrEqual(BUDGETS.historyGrowthPerPack.min);
  expect(historyPerPack).toBeLessThanOrEqual(BUDGETS.historyGrowthPerPack.max);
}

/** Folds a page's recording into a session total: a reload starts a new recording, so the spec keeps the sum. */
function totals() {
  const sum = { longTasks: 0, longTaskMs: 0, workersCreated: 0, workersTerminated: 0, peakBusy: 0, jobsDone: 0, recycled: 0, mostOnAWorker: 0, documents: 0 };
  return {
    sum,
    async fold(page: Page) {
      const recording = await readRecording(page);
      sum.documents += 1;
      sum.longTasks += recording.longTasks.length;
      sum.longTaskMs += Math.round(recording.longTasks.reduce((total, task) => total + task.duration, 0));
      sum.workersCreated += recording.workersCreated;
      sum.workersTerminated += recording.workersTerminated;
      sum.peakBusy = Math.max(sum.peakBusy, peakBusy(recording.jobs));
      sum.jobsDone += recording.jobs.filter((job) => job.kind === 'done').length;
      const { recycled, mostOnAWorker } = recycling(recording.jobs);
      sum.recycled += recycled;
      sum.mostOnAWorker = Math.max(sum.mostOnAWorker, mostOnAWorker);
    },
  };
}

/**
 * Pool and worker bounds over the page loads in `sum`: never more busy than the pool allows, every worker
 * accounted for. A worker is ended after TICKETS_PER_WORKER tickets and replaced (ticketPool.ts), so beyond
 * the ticket miner's worker and a pool of at most `cap` per page, only `replacements` spawns are allowed:
 * the most that `tickets` answered tickets can cause, not a raised cap.
 */
function expectPoolWithin(sum: ReturnType<typeof totals>['sum'], cap: number, tickets: number) {
  const replacements = Math.ceil(tickets / TICKETS_PER_WORKER);
  expect(sum.peakBusy).toBeLessThanOrEqual(cap);
  expect(sum.mostOnAWorker, 'a worker answered more tickets than it is allowed before it is replaced').toBeLessThanOrEqual(TICKETS_PER_WORKER);
  expect(sum.recycled).toBeLessThanOrEqual(replacements);
  expect(sum.workersCreated).toBeLessThanOrEqual((cap + 1) * sum.documents + replacements);
  // Each page keeps at most the ticket miner's worker; the pool's and every recycled one were terminated.
  expect(sum.workersCreated - sum.workersTerminated).toBeLessThanOrEqual(sum.documents);
}

const STORAGE_FULL = /QuotaExceeded|Storage is full|Could not save pack history/;

/** Writes fail as if the browser's storage were full; only the named keys, and with `above` only values longer than that (a restore of what was there still fits). The page counts the writes it refused. */
const refuseWrites = (page: Page, keys: string[], above = -1) => page.evaluate(({ blocked, limit }) => {
  const set = new Set(blocked);
  const write = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key: string, value: string) {
    if (set.has(key) && value.length > limit) {
      (window as unknown as { refusedWrites: number }).refusedWrites = ((window as unknown as { refusedWrites?: number }).refusedWrites ?? 0) + 1;
      throw new DOMException('Storage is full', 'QuotaExceededError');
    }
    return write.call(this, key, value);
  };
}, { blocked: keys, limit: above });

const refusedWrites = (page: Page) => page.evaluate(() => (window as unknown as { refusedWrites?: number }).refusedWrites ?? 0);

test.describe('growing saves', () => {
  for (const size of config.history) {
    test(`a save of ${size} synthetic records imports, loads and keeps growing exactly`, async ({ page, baseURL }, testInfo) => {
      test.setTimeout(180_000);
      const { errors, save: { expected } } = await startWith(page, baseURL!, size);
      if (size > 0) {
        const imported = await snapshot(page);
        expect(imported.history).toHaveLength(expected.packs);
        expect(imported.stats.packsOpened).toBe(expected.packs);
        expect(cardsIn(imported.collection)).toBe(expected.cards);
        expect((await player(page)).nextNonce).toBe(expected.nextNonce);
        expect(await shelf(page)).toEqual([]);
      }

      // Baseline: the packs screen over this save after a cold reload, before any real pack.
      const clickableMs = await reachClickable(page);
      // The app's own prefetch of the next pack (ticket, then its art) is done before anything is measured.
      await ticketReady(page, size);
      const baseline = await measure(page, clickableMs);
      const device = await deviceOf(page);
      const rows: CapacityReport['results'] = [{ phase: 'baseline', size, pack: 0, ...baseline }];

      let previous = await snapshot(page);
      let previousHistoryBytes = baseline.historyBytes;
      for (let pack = 1; pack <= config.packs; pack++) {
        const openMs = Math.round(await openPack(page));
        if (pack === config.packs) await breakLastPack(page);
        previous = await expectPackStored(page, size, pack, previous);
        const bytes = await storageBytes(page);
        const historyBytes = bytes.perKey[STORAGE_KEYS.HISTORY] ?? 0;
        rows.push({ phase: 'pack', size, pack, openToResultMs: openMs, localStorageBytes: bytes.total, historyBytes, historyGrowthBytes: historyBytes - previousHistoryBytes });
        previousHistoryBytes = historyBytes;
        if (pack < config.packs) {
          await page.getByRole('button', { name: /^Open .+ again$/ }).click();
          await expect(openButton(page)).toBeVisible();
          await ticketReady(page, size + pack);
        }
      }

      await ticketReady(page, size + config.packs);
      const after = await measure(page, 0);
      expectGrowthWithin(baseline, after, config.packs);
      // A fresh page: the ticket miner's worker, replaced after TICKETS_PER_WORKER tickets, and no pool.
      const recorded = totals();
      await recorded.fold(page);
      expectPoolWithin(recorded.sum, poolCap(device), recorded.sum.jobsDone);
      expect(errors).toEqual([]);

      rows.push({
        phase: 'after-session', size, pack: config.packs, ...after,
        localStorageGrowthBytes: after.localStorageBytes - baseline.localStorageBytes,
        mainHeapGrowthBytes: after.mainHeapUsedBytes === null || baseline.mainHeapUsedBytes === null ? null : after.mainHeapUsedBytes - baseline.mainHeapUsedBytes,
        workersRecycled: recorded.sum.recycled, argon2EstimateBytes: after.peakBusyJobs * ARGON2_BYTES_PER_JOB,
      });
      await finish(page, testInfo, `growing-save-${size}`, [size], config.packs, rows);
    });
  }
});

test.describe('long session', () => {
  test(`${config.sessionPacks} packs on ${config.sessionHistory} synthetic records, with reloads, pages, dialogs and hide/show`, async ({ page, baseURL }, testInfo) => {
    test.setTimeout(240_000);
    const size = config.sessionHistory;
    const { errors, quiet } = await startWith(page, baseURL!, size);
    const recorded = totals();
    const clickableMs = await reachClickable(page);
    await ticketReady(page, size);
    const baseline = await measure(page, clickableMs);
    const device = await deviceOf(page);
    const rows: CapacityReport['results'] = [{ phase: 'baseline', size, pack: 0, ...baseline }];
    let previous = await snapshot(page);
    let previousHistoryBytes = baseline.historyBytes;

    for (let pack = 1; pack <= config.sessionPacks; pack++) {
      const openMs = Math.round(await openPack(page));
      if (pack === config.sessionPacks) await breakLastPack(page);
      previous = await expectPackStored(page, size, pack, previous);

      // A dialog opened over the summary and closed again.
      await expectSummaryTakesClicks(page);
      await page.locator('.summary-card').first().click();
      const viewer = page.locator('.card-viewer .card-viewer-card');
      await expect(viewer).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(viewer).toHaveCount(0);

      const bytes = await storageBytes(page);
      const historyBytes = bytes.perKey[STORAGE_KEYS.HISTORY] ?? 0;
      rows.push({ phase: 'pack', size, pack, openToResultMs: openMs, localStorageBytes: bytes.total, historyBytes, historyGrowthBytes: historyBytes - previousHistoryBytes });
      expect(historyBytes - previousHistoryBytes).toBeGreaterThanOrEqual(BUDGETS.historyGrowthPerPack.min);
      expect(historyBytes - previousHistoryBytes).toBeLessThanOrEqual(BUDGETS.historyGrowthPerPack.max);
      previousHistoryBytes = historyBytes;

      await page.getByRole('button', { name: /^Open .+ again$/ }).click();
      await expect(openButton(page)).toBeVisible();
      const tabs = page.getByRole('navigation', { name: 'Main', exact: true });
      // Pages opened and closed between packs.
      if (pack % 2 === 1) {
        await tabs.getByRole('button', { name: 'Cards', exact: true }).click();
        await expect(page.locator('.collection-set').first()).toBeVisible();
        await page.getByRole('button', { name: 'Close Cards', exact: true }).click();
      } else {
        await tabs.getByRole('button', { name: 'Profile', exact: true }).click();
        await expect(page.getByRole('main', { name: 'Profile', exact: true })).toContainText(`All packs · ${size + pack}`);
        await page.goBack();
      }
      await expect(openButton(page)).toBeVisible();
      // A backgrounded tab and back.
      await page.evaluate(() => window.capacity.setHidden(true));
      await page.evaluate(() => window.capacity.setHidden(false));

      if (pack < config.sessionPacks) await ticketReady(page, size + pack);
      if (pack === Math.ceil(config.sessionPacks / 2) && pack < config.sessionPacks) {
        // Reload with the page quiet, so the saved state is all that carries over.
        await quiet();
        await recorded.fold(page);
        await page.reload();
        await reachClickable(page);
        expect(await snapshot(page)).toEqual(previous);
        await ticketReady(page, size + pack);
      }
    }

    await ticketReady(page, size + config.sessionPacks);
    await recorded.fold(page);
    const final = await measure(page, 0);
    expectGrowthWithin(baseline, final, config.sessionPacks);
    expectPoolWithin(recorded.sum, poolCap(device), recorded.sum.jobsDone);
    expect(errors).toEqual([]);

    rows.push({
      phase: 'after-session', size, pack: config.sessionPacks, ...final,
      localStorageGrowthBytes: final.localStorageBytes - baseline.localStorageBytes,
      mainHeapGrowthBytes: final.mainHeapUsedBytes === null || baseline.mainHeapUsedBytes === null ? null : final.mainHeapUsedBytes - baseline.mainHeapUsedBytes,
      workersCreatedAllDocuments: recorded.sum.workersCreated, workersTerminatedAllDocuments: recorded.sum.workersTerminated, workersRecycledAllDocuments: recorded.sum.recycled,
      peakBusyAllDocuments: recorded.sum.peakBusy, longTaskMsAllDocuments: recorded.sum.longTaskMs,
      argon2EstimateBytes: recorded.sum.peakBusy * ARGON2_BYTES_PER_JOB,
    });
    await finish(page, testInfo, 'long-session', [size], config.sessionPacks, rows);
  });
});

test.describe('reconstruction', () => {
  test('re-opening records without cached cards uses the pool within its cap and stores each exactly once', async ({ page, baseURL }, testInfo) => {
    test.setTimeout(180_000);
    const size = config.sessionHistory;
    const { errors, quiet } = await startWith(page, baseURL!, size, { uncached: config.uncached });
    const recorded = totals();
    await reachClickable(page);
    await ticketReady(page, size);
    const device = await deviceOf(page);
    const uncachedNonces = Array.from({ length: config.uncached }, (_, i) => size - config.uncached + i);
    const doneFor = (jobs: Awaited<ReturnType<typeof readRecording>>['jobs'], nonce: number) => jobs.filter((job) => job.kind === 'done' && job.nonce === nonce).length;

    // Idle: the profile says what is missing, and nothing re-mines on its own.
    await page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('button', { name: 'Profile', exact: true }).click();
    const profile = page.getByRole('main', { name: 'Profile', exact: true });
    await expect(profile).toContainText(`${config.uncached} packs in your history don't have their cards on this device`);
    const idle = await readRecording(page);
    for (const nonce of uncachedNonces) expect(doneFor(idle.jobs, nonce)).toBe(0);
    expect(await reopenedPacksStored(page)).toBe(0);
    const idleStorage = await storageBytes(page);
    const historyBefore = (await snapshot(page)).history;

    // Active: the player asks for them.
    await profile.locator('.profile-fold-toggle').filter({ hasText: 'Level, stats and collection' }).click();
    await profile.getByRole('button', { name: 'Re-open them', exact: true }).click();
    await page.waitForFunction((nonces) => nonces.every((n) => window.capacity.jobs.some((job) => job.kind === 'done' && job.nonce === n)), uncachedNonces, { timeout: 90_000 });
    await expect(profile).not.toContainText("don't have their cards on this device");
    await expect.poll(() => reopenedPacksStored(page)).toBe(config.uncached);
    const active = await readRecording(page);
    const activeStorage = await storageBytes(page);
    for (const nonce of uncachedNonces) expect(doneFor(active.jobs, nonce)).toBe(1);
    expect((await snapshot(page)).history).toEqual(historyBefore);
    expect(activeStorage.total - idleStorage.total).toBeLessThanOrEqual(BUDGETS.reopenStorageBytes);
    await recorded.fold(page);
    expectPoolWithin(recorded.sum, poolCap(device), config.uncached);
    expect(active.jobs.filter((job) => job.kind === 'cancelled')).toEqual([]);

    // The stored packs outlive the visit: a reload still finds them.
    await quiet();
    await page.reload();
    await page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('button', { name: 'Profile', exact: true }).click();
    await expect(profile).toContainText(`All packs · ${size}`);
    await expect(profile).not.toContainText("don't have their cards on this device");
    expect(await reopenedPacksStored(page)).toBe(config.uncached);
    expect(errors).toEqual([]);

    await finish(page, testInfo, 'reconstruction', [size], config.uncached, [
      { phase: 'idle', size, uncached: config.uncached, workersCreated: idle.workersCreated, peakBusyJobs: peakBusy(idle.jobs), localStorageBytes: idleStorage.total, reopenedStored: 0 },
      {
        phase: 'active', size, uncached: config.uncached, workersCreated: active.workersCreated, workersTerminated: active.workersTerminated, workersRecycled: recycling(active.jobs).recycled,
        peakBusyJobs: peakBusy(active.jobs), longTasks: active.longTasks.length, localStorageBytes: activeStorage.total,
        reopenedStored: config.uncached, originUsageBytes: await originUsage(page), argon2EstimateBytes: peakBusy(active.jobs) * ARGON2_BYTES_PER_JOB,
      },
    ]);
  });
});

test.describe('failure and interruption', () => {
  test('a refused storage write warns without asking to clear data, and the pack is recovered exactly', async ({ page, baseURL }, testInfo) => {
    test.setTimeout(180_000);
    const size = config.sessionHistory;
    const { errors, quiet } = await startWith(page, baseURL!, size);
    await reachClickable(page);
    await ticketReady(page, size);
    const before = await snapshot(page);

    await refuseWrites(page, [STORAGE_KEYS.STATS, STORAGE_KEYS.COLLECTION, STORAGE_KEYS.HISTORY]);
    const openMs = Math.round(await openPack(page));
    const warning = page.locator('.save-warning');
    await expect(warning).toContainText("Some changes couldn't be saved");
    await expect(warning).not.toContainText(/clear|delete|wipe|reset/i);
    await expect(page.locator('.summary-cards img')).toHaveCount(5);
    // Nothing half-written: what was stored is what was stored before, and the number is spent.
    const refused = await snapshot(page);
    expect(refused).toEqual(before);
    expect((await player(page)).nextNonce).toBe(size + 1);

    // A reload (storage works again) brings the pack back, once.
    await ticketReady(page, size + 1);
    await quiet();
    await page.reload();
    await expect.poll(async () => (await snapshot(page)).stats.packsOpened, { timeout: 30_000 }).toBe(size + 1);
    const recovered = await expectPackStored(page, size, 1, before);
    expect(recovered.history[0]).toMatchObject({ n: size, s: expect.any(String) });
    // The only errors are the refused writes themselves.
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.filter((error) => !STORAGE_FULL.test(error))).toEqual([]);
    const bytes = await storageBytes(page);

    await finish(page, testInfo, 'quota-denial', [size], 1, [
      { phase: 'refused', size, openToResultMs: openMs, historyRecords: refused.history.length, nextNonce: size + 1, errorsFromRefusedWrites: errors.length },
      { phase: 'recovered', size, historyRecords: recovered.history.length, packsOpened: recovered.stats.packsOpened, localStorageBytes: bytes.total },
    ]);
  });

  test('a reload while a pack is still mining spends nothing, and the next pack opens exactly once', async ({ page, baseURL }, testInfo) => {
    test.setTimeout(180_000);
    const size = config.sessionHistory;
    const { errors, quiet } = await startWith(page, baseURL!, size, { held: true });
    await reachClickable(page);
    const before = await snapshot(page);

    // The tear waits on a ticket that never arrives; the page is left there.
    await openButton(page).focus();
    await page.keyboard.press('Space');
    await expect(page.locator('.pack-hint.is-waiting')).toBeVisible({ timeout: 15_000 });
    await quiet();
    await page.reload();
    await reachClickable(page);
    const reloaded = await snapshot(page);
    expect(reloaded).toEqual(before);
    expect((await player(page)).nextNonce).toBe(size);
    expect(await shelf(page)).toEqual([]);

    await releaseTickets(page);
    await ticketReady(page, size);
    const openMs = Math.round(await openPack(page));
    const opened = await expectPackStored(page, size, 1, before);
    expect(errors).toEqual([]);

    await finish(page, testInfo, 'interrupted-mining', [size], 1, [
      { phase: 'after-reload', size, historyRecords: reloaded.history.length, nextNonce: size },
      { phase: 'next-pack', size, openToResultMs: openMs, historyRecords: opened.history.length, nextNonce: size + 1 },
    ]);
  });

  test('a reload mid-reveal keeps the pack stored exactly once, and the next pack takes the next number', async ({ page, baseURL }, testInfo) => {
    test.setTimeout(180_000);
    const size = config.sessionHistory;
    const { errors, quiet } = await startWith(page, baseURL!, size);
    await reachClickable(page);
    await ticketReady(page, size);
    const before = await snapshot(page);

    await openButton(page).focus();
    await page.keyboard.press('Space');
    await expect(page.locator('.pack-top-count')).toHaveText('Card 1 of 5', { timeout: 15_000 });
    await ticketReady(page, size + 1);
    await quiet();
    await page.reload();
    await reachClickable(page);
    const stored = await expectPackStored(page, size, 1, before);

    await ticketReady(page, size + 1);
    const openMs = Math.round(await openPack(page));
    const next = await expectPackStored(page, size, 2, stored);
    expect(next.history[0]).toMatchObject({ n: size + 1 });
    expect(errors).toEqual([]);

    await finish(page, testInfo, 'interrupted-reveal', [size], 2, [
      { phase: 'after-reload', size, historyRecords: stored.history.length, nextNonce: size + 1 },
      { phase: 'next-pack', size, openToResultMs: openMs, historyRecords: next.history.length, nextNonce: size + 2 },
    ]);
  });

  test('an import the browser cannot finish is rolled back exactly, and the save keeps working', async ({ page, baseURL }, testInfo) => {
    test.setTimeout(180_000);
    const size = config.sessionHistory;
    const bigger = Math.min(CAPS.history, Math.max(size * 2, ...config.history));
    const { errors, quiet } = await startWith(page, baseURL!, size);
    await reachClickable(page);
    await ticketReady(page, size);
    const before = await snapshot(page);
    const playerBefore = await player(page);
    const bytesBefore = await storageBytes(page);

    // The browser takes the copy of this save and then refuses the imported history.
    await quiet();
    await page.goto('./#/settings');
    await refuseWrites(page, [STORAGE_KEYS.HISTORY], await page.evaluate((key) => (localStorage.getItem(key) ?? '').length, STORAGE_KEYS.HISTORY));
    const main = page.getByRole('main', { name: 'Settings', exact: true });
    await expect(main).toBeVisible();
    await main.locator('input[type="file"]').setInputFiles({ name: 'capacity.json', mimeType: 'application/json', buffer: Buffer.from(syntheticSave(bigger).file) });
    // A save with a different history asks before replacing this one; the answer is Replace.
    await main.getByRole('button', { name: 'Replace', exact: true }).click();
    const note = main.locator('.settings-desc').filter({ hasText: /no room|too big/i });
    await expect(note).toContainText(/Your previous save data was restored|Nothing changed/);
    await expect(main).not.toContainText(/clear (your )?(site|browser)? ?data/i);
    expect(await refusedWrites(page), 'the browser never refused the imported history').toBeGreaterThan(0);
    expect(await snapshot(page)).toEqual(before);
    expect(await player(page)).toEqual(playerBefore);
    const bytesAfter = await storageBytes(page);
    expect(bytesAfter.perKey[STORAGE_KEYS.HISTORY]).toBe(bytesBefore.perKey[STORAGE_KEYS.HISTORY]);

    // The save is whole: a reload loads it, and a real pack opens on it.
    await page.goto('./#/');
    await reachClickable(page);
    await ticketReady(page, size);
    await quiet();
    await page.reload();
    await reachClickable(page);
    await ticketReady(page, size);
    expect(await snapshot(page)).toEqual(before);
    const openMs = Math.round(await openPack(page));
    await expectPackStored(page, size, 1, before);
    // The refusal was counted above; the app may log it, and anything else logged is a failure.
    expect(errors.filter((error) => !STORAGE_FULL.test(error))).toEqual([]);

    await finish(page, testInfo, 'import-rollback', [size, bigger], 1, [
      { phase: 'refused-import', size, attemptedRecords: bigger, historyBytes: bytesAfter.perKey[STORAGE_KEYS.HISTORY] ?? 0, localStorageBytes: bytesAfter.total },
      { phase: 'next-pack', size, openToResultMs: openMs },
    ]);
  });
});
