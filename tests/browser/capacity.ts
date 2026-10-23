import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { STORAGE_KEYS } from '../../src/constants/config';
import { scorePack } from '../../src/engine/scoring';
import type { Rarity } from '../../src/engine/types';
import { TICKET_PARAMS } from '../../src/engine/ticket';

/**
 * Helpers for capacity.spec.ts (#709): bounded, synthetic growing saves and the page-side recording
 * that spec reports from. Everything seeded here is shape data for sizing storage and the UI. It
 * isn't a verified history, never certifies a profile, and never leaves the owned preview.
 */

/** Which generator made the seeded records; recorded in every report. */
export const SEED = 'capacity-shape-v1';

/** The fixture player support.ts seeds (secret 01 x32). */
export const PLAYER_SECRET = '01'.repeat(32);
export const PLAYER_KEY_PREFIX = '8a88e3dd7409f195';
export const PLAYER_PUBLIC_KEY = '8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c';

/** Argon2id memory one ticket job allocates, for the estimate. Never a measurement. */
export const ARGON2_BYTES_PER_JOB = TICKET_PARAMS.memorySize * 1024;

/** Hard caps on what an environment variable can ask for, so no PR or manual run becomes an unbounded soak. */
export const CAPS = { history: 20_000, packs: 10, sessionPacks: 20, uncached: 12 } as const;

export interface CapacityConfig {
  /** Synthetic history sizes the growing-save test imports, one after another. */
  history: number[];
  /** Real packs opened at each size. */
  packs: number;
  /** History size and real packs of the bounded long session. */
  sessionHistory: number;
  sessionPacks: number;
  /** Records the reconstruction test leaves without cached cards, so the app re-opens them. */
  uncached: number;
}

const DEFAULTS = { CAPACITY_HISTORY: '0,500,3000', CAPACITY_PACKS: '2', CAPACITY_SESSION_HISTORY: '500', CAPACITY_SESSION_PACKS: '6', CAPACITY_UNCACHED: '4' };

/** Digits only (Number() alone would take "1e3" or " 80 "); anything else or over its cap throws. */
const whole = (name: string, value: string, max: number): number => {
  if (!/^\d+$/.test(value) || Number(value) > max) throw new Error(`${name} must be digits only and at most ${max}, got "${value}"`);
  return Number(value);
};

export function capacityConfig(env: Record<string, string | undefined> = process.env): CapacityConfig {
  const read = (name: keyof typeof DEFAULTS) => env[name]?.trim() || DEFAULTS[name];
  return {
    history: read('CAPACITY_HISTORY').split(',').map((part) => whole('CAPACITY_HISTORY', part.trim(), CAPS.history)),
    packs: whole('CAPACITY_PACKS', read('CAPACITY_PACKS'), CAPS.packs),
    sessionHistory: whole('CAPACITY_SESSION_HISTORY', read('CAPACITY_SESSION_HISTORY'), CAPS.history),
    sessionPacks: whole('CAPACITY_SESSION_PACKS', read('CAPACITY_SESSION_PACKS'), CAPS.sessionPacks),
    uncached: whole('CAPACITY_UNCACHED', read('CAPACITY_UNCACHED'), CAPS.uncached),
  };
}

interface SetShape { id: string; version: number; cards: { id: string; rarity: Rarity }[] }
const setsDir = new URL('../../src/content/sets/', import.meta.url);
/** Every released set's id, version and card ids, read from the content files (the UI modules need Vite). */
const SETS: SetShape[] = readdirSync(setsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => JSON.parse(readFileSync(new URL(`${entry.name}/set.json`, setsDir), 'utf8')) as SetShape)
  .sort((a, b) => a.id.localeCompare(b.id));
const CARDS = SETS.flatMap((set) => set.cards.map((card) => ({ setId: set.id, id: card.id, rarity: card.rarity })));

export interface SyntheticSave {
  /** The backup file's text, as Settings > Import takes it. */
  file: string;
  /** What the app should hold once it has imported the file. */
  expected: { packs: number; cards: number; nextNonce: number; uncached: number };
}

/**
 * A backup file whose history holds `packs` synthetic records (cached card codes cycling through
 * every set, nonces 0..packs-1, at the fixture player's key), and a collection whose counts add up to
 * 5 per record. The last `uncached` records have no cached cards. It's imported, never written to
 * storage directly, so Settings' own validation, backup and stamp rules run on it.
 */
export function syntheticSave(packs: number, uncached = 0): SyntheticSave {
  const history = Array.from({ length: packs }, (_, n) => {
    const set = SETS[n % SETS.length];
    const picked = Array.from({ length: 5 }, (_, slot) => set.cards[(n + slot * 3) % set.cards.length]);
    // The hand and score the engine gives these cards: the app re-scores a record's cards and treats a
    // different stored score as an unknown pack, so shape data must still be self-consistent.
    const { hand, score } = scorePack(picked.map((card) => ({ cardId: `${set.id}/${card.id}`, rarity: card.rarity, isHolo: false, finish: null, misprint: false })));
    return {
      s: set.id, v: set.version, n, k: PLAYER_KEY_PREFIX,
      ...(n < packs - uncached ? { c: picked.map((card) => card.id).join(',') } : {}),
      h: hand.name, x: score, t: 1_700_000_000_000 + n * 60_000,
    };
  });
  const total = packs * 5;
  const collection = total === 0 ? {} : Object.fromEntries(CARDS.map((card, i) => {
    const count = Math.floor(total / CARDS.length) + (i < total % CARDS.length ? 1 : 0);
    return [`${card.setId}/${card.id}`, {
      card: { key: `${card.setId}/${card.id}`, setId: card.setId, id: card.id, name: card.id, rarity: card.rarity, image: '' },
      normalCount: count, holoCount: 0,
    }];
  }));
  const file = JSON.stringify({
    version: 2,
    exportedAt: '2026-01-01T00:00:00.000Z',
    dataVersion: 3,
    player: JSON.stringify({ secretKey: PLAYER_SECRET, name: 'Capacity fixture', nextNonce: packs, createdAt: 1 }),
    history: JSON.stringify(history),
    collection: JSON.stringify(collection),
    stats: JSON.stringify({ packsOpened: packs, holoCards: {}, highestPackValue: 0, highestPackCards: [] }),
  });
  return { file, expected: { packs, cards: total, nextNonce: packs, uncached } };
}

/** How the test project's browser reports itself, for the pool-size cap (mirrors poolSize in ticketPool.ts). */
export const poolCap = (device: { hardwareConcurrency: number; deviceMemory: number | null; mobile: boolean }): number => {
  const cap = device.deviceMemory === null || device.deviceMemory < 4 ? 2 : device.deviceMemory >= 8 && !device.mobile ? 8 : 4;
  return Math.max(1, Math.min(cap, (device.hardwareConcurrency || 2) - 1));
};

export interface PageRecording {
  longTasks: { start: number; duration: number }[];
  workersCreated: number;
  workersTerminated: number;
  /** `cancelled`: the worker was terminated with the job unfinished. */
  jobs: { t: number; kind: 'start' | 'done' | 'cancelled'; worker: number; nonce: number }[];
  hidden: boolean;
}
declare global {
  interface Window {
    capacity: PageRecording & { setHidden(hidden: boolean): void; flush(): void; imagesSettled(): Promise<void> };
  }
}

/**
 * Records, from before the app starts: long tasks, every ticket worker created and terminated, and
 * every ticket job each worker was given and its answer. Also gives the spec `setHidden`, which
 * makes the page report hidden or visible and fires visibilitychange: a stand-in for a backgrounded
 * tab (headless Chromium never hides), not a measurement of a real one.
 */
export async function recordPage(page: Page) {
  await page.addInitScript(() => {
    const recording = { longTasks: [], workersCreated: 0, workersTerminated: 0, jobs: [], hidden: false } as PageRecording;
    let flush = () => {};
    try {
      const observer = new PerformanceObserver((list) => { for (const e of list.getEntries()) recording.longTasks.push({ start: e.startTime, duration: e.duration }); });
      observer.observe({ type: 'longtask', buffered: true });
      flush = () => { for (const e of observer.takeRecords()) recording.longTasks.push({ start: e.startTime, duration: e.duration }); };
    } catch { /* no Long Tasks API: the count stays 0 */ }
    const setHidden = (hidden: boolean) => {
      recording.hidden = hidden;
      document.dispatchEvent(new Event('visibilitychange'));
    };
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (recording.hidden ? 'hidden' : 'visible') });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => recording.hidden });
    // The app's art prefetch sets `src` on an image nobody else holds, and a collection cancels a load
    // still in flight. Keep those images referenced until they settle, so a measurement's forced
    // collection (mainHeap) can wait for them instead of aborting card art the app asked for.
    const loading = new Set<HTMLImageElement>();
    const idle: (() => void)[] = [];
    const src = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')!;
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      ...src,
      set(this: HTMLImageElement, value: string) {
        src.set!.call(this, value);
        if (this.isConnected || loading.has(this)) return;
        loading.add(this);
        const settle = () => {
          loading.delete(this);
          if (loading.size === 0) idle.splice(0).forEach((resolve) => resolve());
        };
        this.addEventListener('load', settle, { once: true });
        this.addEventListener('error', settle, { once: true });
      },
    });
    const imagesSettled = () => new Promise<void>((resolve) => { if (loading.size === 0) resolve(); else idle.push(resolve); });
    window.capacity = Object.assign(recording, { setHidden, flush, imagesSettled });

    const Native = window.Worker;
    let created = 0;
    window.Worker = class extends Native {
      private index = created++;
      private pending = new Map<unknown, number>();
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        recording.workersCreated += 1;
        this.addEventListener('message', (event: MessageEvent<{ id?: unknown }>) => {
          const nonce = this.pending.get(event.data?.id);
          if (nonce === undefined) return;
          this.pending.delete(event.data.id);
          recording.jobs.push({ t: performance.now(), kind: 'done', worker: this.index, nonce });
        });
      }
      postMessage(message: unknown, options?: StructuredSerializeOptions | Transferable[]) {
        const job = message as { id?: unknown; nonce?: unknown };
        if (typeof job?.nonce === 'number') {
          this.pending.set(job.id, job.nonce);
          recording.jobs.push({ t: performance.now(), kind: 'start', worker: this.index, nonce: job.nonce });
        }
        super.postMessage(message, options as StructuredSerializeOptions);
      }
      terminate() {
        recording.workersTerminated += 1;
        for (const nonce of this.pending.values()) recording.jobs.push({ t: performance.now(), kind: 'cancelled', worker: this.index, nonce });
        this.pending.clear();
        super.terminate();
      }
    };
  });
}

/** The recording so far, with pending long tasks flushed. */
export const readRecording = (page: Page): Promise<PageRecording> => page.evaluate(() => {
  window.capacity.flush();
  const { longTasks, workersCreated, workersTerminated, jobs, hidden } = window.capacity;
  return { longTasks, workersCreated, workersTerminated, jobs, hidden };
});

/** The most ticket jobs running at once, from a recording's start and done events. */
export function peakBusy(jobs: PageRecording['jobs']): number {
  const open = new Map<string, number>();
  let peak = 0;
  for (const job of jobs) {
    const key = `${job.worker}:${job.nonce}`;
    open.set(key, (open.get(key) ?? 0) + (job.kind === 'start' ? 1 : -1));
    peak = Math.max(peak, [...open.values()].filter((n) => n > 0).length);
  }
  return peak;
}

export interface StorageBytes {
  /** Characters of key + value in each app key, which is how browsers count localStorage against the quota. */
  perKey: Record<string, number>;
  total: number;
}

/** What the app's localStorage keys hold now. */
export const storageBytes = (page: Page): Promise<StorageBytes> => page.evaluate(() => {
  const perKey: Record<string, number> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)!;
    if (key.startsWith('brainrot-')) perKey[key] = key.length + (localStorage.getItem(key) ?? '').length;
  }
  return { perKey, total: Object.values(perKey).reduce((sum, n) => sum + n, 0) };
});

export interface HeapReading { usedBytes: number; totalBytes: number }

/**
 * The page's main JS heap after a forced collection, so a figure compares with another taken the same
 * way. Main target only: workers and their Argon2 memory are not in it. A high-water mark is not a leak.
 */
export async function mainHeap(page: Page): Promise<HeapReading | null> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await page.evaluate(() => window.capacity.imagesSettled());
    await cdp.send('HeapProfiler.collectGarbage');
    const heap = await cdp.send('Runtime.getHeapUsage');
    return { usedBytes: heap.usedSize, totalBytes: heap.totalSize };
  } catch {
    return null;
  } finally {
    await cdp.detach();
  }
}

/** Origin storage the browser reports in use (localStorage, IndexedDB, caches), which is an estimate. */
export const originUsage = (page: Page): Promise<number | null> => page.evaluate(async () => {
  try { return (await navigator.storage.estimate()).usage ?? null; } catch { return null; }
});

/** Records in the pack cache's IndexedDB store (read-only), or null where it can't be read. */
export const reopenedPacksStored = (page: Page): Promise<number | null> => page.evaluate(() => new Promise<number | null>((resolve) => {
  const request = indexedDB.open('brainrot-packs');
  request.onerror = () => resolve(null);
  request.onsuccess = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains('reopened')) { db.close(); resolve(0); return; }
    const count = db.transaction('reopened', 'readonly').objectStore('reopened').count();
    count.onsuccess = () => { db.close(); resolve(count.result); };
    count.onerror = () => { db.close(); resolve(null); };
  };
}));

export interface RunFacts {
  revision: string;
  dirty: boolean;
  browser: string;
  project: string;
  device: { hardwareConcurrency: number; deviceMemory: number | null; mobile: boolean };
}

let revision: { revision: string; dirty: boolean } | undefined;
/** The checked-out commit and whether tracked files differ from it. */
export function sourceRevision() {
  if (!revision) {
    const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
    revision = { revision: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain', '--untracked-files=no') !== '' };
  }
  return revision;
}

export const REPORT_NOTE = 'Synthetic shape data in emulated Chromium on this host, with no throttling: not a verified history, a certified profile or a physical phone.';

/**
 * Ceilings the spec asserts. Each is several times the largest figure measured (docs/DEVELOPMENT.md >
 * Capacity), so a 2-core CI runner passes, and only a hang or a blow-up trips it. Ordinary timing
 * variation is for the report to show, not for these to judge.
 */
export const BUDGETS = {
  /** Page start to a pressable Open pack, and Open pack press to a decoded result (measured about 1.2-1.8 s each). */
  interactiveMs: 15_000,
  /** One record a pack adds to the history key, in key + value characters (measured 149-177, 321 for the first of an empty history). */
  historyGrowthPerPack: { min: 100, max: 600 },
  /** Everything the app stores, over a session: a one-off for the first pack (the collection gains its art paths) plus a bound per pack (measured +26-33 KB in all). */
  storageOnce: 64_000,
  storagePerPack: 8_000,
  /** Main-thread JS heap after a collection, session start to end (measured +1.5-2.1 MB); worker and Argon2 memory are not in it. */
  heapGrowthBytes: 24_000_000,
  /** Long-task time over a session (measured 0.1-0.5 s). */
  longTaskMs: 8_000,
  /** The re-open pass's own storage (measured +6 KB for 4 packs) and the packs it may store per record. */
  reopenStorageBytes: 32_000,
} as const;

/** One scenario's report, attached to the test only after every functional assertion passed. */
export interface CapacityReport {
  schema: 1;
  scenario: string;
  note: typeof REPORT_NOTE;
  seed: typeof SEED;
  facts: RunFacts;
  /** How the run was set up: nothing is throttled, the network guard answers every request itself, and IndexedDB starts empty. */
  setup: { throttling: 'none'; httpCache: 'bypassed by the network guard'; indexedDbAtStart: 'empty' };
  /** Synthetic history sizes and real packs opened: what each figure below is a sample of. */
  samples: { sizes: number[]; realPacks: number };
  /** One entry per size (or per pack for a session): the figures a test records. */
  results: Record<string, number | string | boolean | null>[];
}

/** Why a report isn't well formed: an empty list means it is. */
export function validateCapacityReport(report: unknown): string[] {
  const problems: string[] = [];
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
  if (!object(report)) return ['not an object'];
  if (report.schema !== 1) problems.push('schema must be 1');
  if (report.note !== REPORT_NOTE) problems.push('note must label the data as synthetic emulation');
  if (report.seed !== SEED) problems.push('seed missing');
  if (typeof report.scenario !== 'string' || !report.scenario) problems.push('scenario missing');
  const facts = report.facts;
  if (!object(facts) || !/^[0-9a-f]{40}$/.test(String(facts.revision)) || typeof facts.dirty !== 'boolean'
    || typeof facts.browser !== 'string' || typeof facts.project !== 'string' || !object(facts.device)) problems.push('facts incomplete');
  if (!object(report.setup) || report.setup.throttling !== 'none') problems.push('setup incomplete');
  const samples = report.samples;
  if (!object(samples) || !Array.isArray(samples.sizes) || !samples.sizes.every((n) => Number.isSafeInteger(n) && n >= 0)
    || !Number.isSafeInteger(samples.realPacks) || (samples.realPacks as number) < 1) problems.push('samples incomplete');
  const results = report.results;
  if (!Array.isArray(results) || results.length === 0) problems.push('a report with no results is not a successful run');
  else {
    results.forEach((row, i) => {
      if (!object(row)) problems.push(`results[${i}] is not an object`);
      else for (const [key, value] of Object.entries(row)) {
        if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) problems.push(`results[${i}].${key} is not a non-negative finite number`);
      }
    });
  }
  return problems;
}

/**
 * Writes a finished report to test-results/capacity/. Throws when it isn't well formed, so a run that
 * measured nothing can't leave a file that looks like a result. Call it last, after every assertion.
 */
export function writeReport(report: CapacityReport): string {
  const problems = validateCapacityReport(report);
  if (problems.length > 0) throw new Error(`capacity report is not valid: ${problems.join('; ')}`);
  const dir = new URL('../../test-results/capacity/', import.meta.url);
  mkdirSync(dir, { recursive: true });
  const file = new URL(`${report.facts.project}-${report.scenario}.json`, dir);
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  return file.pathname;
}

/** Keys the app stores a pack's progress under, so a test can name them. */
export { STORAGE_KEYS };
