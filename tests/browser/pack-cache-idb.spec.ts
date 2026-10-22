import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { test, expect, type Page } from '@playwright/test';
import type * as PackStore from '../../src/game/packStore';
import { dropArt, expectDecoded, monitor, unexpectedArtErrors } from './support';

// The re-opened pack cache (src/game/packStore.ts) against Chromium's own IndexedDB, on the built
// site's origin (#742). The unit tests use a hand-built Map adapter that can't commit, abort or
// retire a connection; these run the real module source on real IDB events.
//
// Failures here are browser-API injections (an aborted transaction, a newer database version, a
// record of the wrong type), not evidence of real quota exhaustion on a device: nothing fills a disk.
// Every fixture is small and synthetic: generated player keys and placeholder card codes, never a
// real save, a re-derived pack or a verified profile.

type Store = typeof PackStore;
interface Harness {
  /** Abort a readwrite transaction right after a put, natively (an injected failure, not real quota). */
  abortWrites: boolean;
  /** Called once per readonly transaction, at its first get, while that read is still in flight. */
  onRead: ((tx: IDBTransaction) => void) | null;
  readTransactions: number;
  /** 'complete' or 'abort' of each readwrite transaction, interleaved with what the test logs. */
  log: string[];
  /** Settles when the last readwrite transaction completes or aborts. */
  lastWrite: Promise<void>;
  rawPut(entries: [string, unknown][]): Promise<void>;
  rawKeys(): Promise<string[]>;
  /** Open the database at `version`: 'success', or 'blocked' when an open connection didn't close. */
  upgrade(version: number): Promise<'success' | 'blocked'>;
  /** Settles once the last upgrade succeeded, even after it reported 'blocked'. */
  upgraded: Promise<void>;
}
declare global {
  interface Window {
    __idb: Harness;
    [store: `__store${string}`]: Store;
  }
}

const SOURCE = readFileSync(new URL('../../src/game/packStore.ts', import.meta.url), 'utf8');

/** The module's own source as a page script, with any edits (a deliberately broken variant). */
function storeScript(name: string, edits: [string, string][] = []): string {
  let code = SOURCE;
  for (const [from, to] of edits) {
    // A source change that removes the edited line must update the broken variant, not skip it.
    if (code.split(from).length !== 2) throw new Error(`packStore.ts changed: the ${name} edit no longer applies`);
    code = code.replace(from, to);
  }
  const js = ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return `(() => { const exports = {};\n${js}\nwindow[${JSON.stringify(`__store${name}`)}] = exports; })();`;
}

/** Healthy is the shipped module; each broken variant drops one guard the contract depends on. */
const STORES = {
  Healthy: [],
  // Reports a write as saved before its transaction commits.
  EarlySuccess: [['      tx.oncomplete = () => resolve(true);\n', '      resolve(true);\n']],
  // Lets a page read for a retired player land after the switch.
  StaleIdentity: [['    const values = await readStoredPacks(page, signal);\n    if (!keep()) return false;\n', '    const values = await readStoredPacks(page, signal);\n']],
  // Keeps its connection open when a newer version asks it to close.
  NoRetire: [['        database.onversionchange = () => {\n', '        database.onversionchange = () => {\n          return;\n']],
} satisfies Record<string, [string, string][]>;
type StoreName = keyof typeof STORES;
const SCRIPTS = Object.entries(STORES).map(([name, edits]) => storeScript(name, edits as [string, string][])).join('\n');

/** Hooks on the native IDB prototypes; they only observe or abort, never fire events themselves. */
function installHarness() {
  const DB = 'brainrot-packs';
  const STORE = 'reopened';
  const request = <T,>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const done = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
  const connect = () => {
    const open = indexedDB.open(DB);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE);
    };
    return request(open);
  };
  const harness: Harness = {
    abortWrites: false,
    onRead: null,
    readTransactions: 0,
    log: [],
    lastWrite: Promise.resolve(),
    async rawPut(entries) {
      const db = await connect();
      const tx = db.transaction(STORE, 'readwrite');
      for (const [key, value] of entries) tx.objectStore(STORE).put(value, key);
      await done(tx);
      db.close();
    },
    async rawKeys() {
      const db = await connect();
      const keys = await request(db.transaction(STORE).objectStore(STORE).getAllKeys());
      db.close();
      return keys.map(String);
    },
    upgrade(version) {
      const open = indexedDB.open(DB, version);
      const success = request(open).then((db) => db.close());
      harness.upgraded = success;
      return new Promise((resolve, reject) => {
        open.onblocked = () => resolve('blocked');
        success.then(() => resolve('success'), reject);
      });
    },
    upgraded: Promise.resolve(),
  };
  const transaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (this: IDBDatabase, ...args: Parameters<IDBDatabase['transaction']>) {
    const tx = transaction.apply(this, args);
    if (tx.mode === 'readwrite') {
      harness.lastWrite = new Promise((resolve) => {
        tx.addEventListener('complete', () => { harness.log.push('complete'); resolve(); });
        tx.addEventListener('abort', () => { harness.log.push('abort'); resolve(); });
      });
    }
    return tx;
  };
  const tracked = new WeakSet<IDBTransaction>();
  const get = IDBObjectStore.prototype.get;
  IDBObjectStore.prototype.get = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['get']>) {
    const result = get.apply(this, args);
    if (!tracked.has(this.transaction)) {
      tracked.add(this.transaction);
      harness.readTransactions++;
      harness.onRead?.(this.transaction);
    }
    return result;
  };
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
    const result = put.apply(this, args);
    if (harness.abortWrites) this.transaction.abort();
    return result;
  };
  window.__idb = harness;
}

// Generated identities: hex keys no secret produces, on a set key no released set uses.
const PLAYER_A = 'a1'.repeat(32);
const PLAYER_B = 'b2'.repeat(32);
const SET = 'idb-fixture@3';
const fixture = (publicKeyHex: string, nonce: number) => ({ setKey: SET, publicKeyHex, nonce, cards: `fixture-${publicKeyHex.slice(0, 2)}-${nonce},fixture-card*G` });
const keyOf = (pack: { setKey: string; publicKeyHex: string; nonce: number }) => `${pack.setKey}|${pack.publicKeyHex.slice(0, 16)}|${pack.nonce}`;
/** Write records straight to the database, as an earlier visit would have left them. */
const rawPut = (page: Page, entries: [string, unknown][]) => page.evaluate((entries) => window.__idb.rawPut(entries), entries);

/** The packs screen is up, its pack art decoded (so a reload aborts none of it). */
async function settled(page: Page) {
  await expect(page.locator('.app-logo')).toBeVisible();
  await expectDecoded(page.locator('.pack-shell img'), 2);
}

/** Reload, which drops the module's memory: what it reads next comes from disk. */
async function reload(page: Page) {
  await page.reload();
  await settled(page);
}

async function harnessed(page: Page, baseURL: string) {
  const errors = await monitor(page, baseURL);
  // Card art plays no part here: failing it at once keeps a reload from racing its loads.
  await dropArt(page);
  await page.addInitScript(installHarness);
  await page.addInitScript({ content: SCRIPTS });
  await page.goto('./');
  await settled(page);
  return errors;
}

/** A pack written natively, read back on a fresh load: absent stays absent, never a failure. */
const readFresh = (page: Page, refs: object[]) => page.evaluate((refs) => window.__storeHealthy.readStoredPacks(refs as PackStore.StoredPackRef[]), refs);

test('a committed pack survives a reload and a relaunched profile, with its exact key and cards', async ({ playwright, browserName, launchOptions, headless, baseURL }) => {
  test.setTimeout(60000);
  // One disposable profile, launched twice: the second browser only has what the first left on disk.
  const profile = await mkdtemp(join(tmpdir(), 'brainrot-idb-'));
  try {
    const launch = async () => {
      const context = await playwright[browserName].launchPersistentContext(profile, { ...launchOptions, headless, baseURL, serviceWorkers: 'block' });
      const page = context.pages()[0] ?? await context.newPage();
      return { context, page, errors: await harnessed(page, baseURL!) };
    };
    const pack = fixture(PLAYER_A, 7);
    const missing = { setKey: SET, publicKeyHex: PLAYER_A, nonce: 8 };
    const other = { setKey: 'idb-fixture@4', publicKeyHex: PLAYER_A, nonce: 7 };

    const first = await launch();
    const order = await first.page.evaluate(async (pack) => {
      const saved = await window.__storeHealthy.putStoredPacks([pack]);
      window.__idb.log.push(`resolved ${saved}`);
      return window.__idb.log;
    }, pack);
    expect(order).toEqual(['complete', 'resolved true']);

    await reload(first.page);
    expect(await first.page.evaluate((pack) => window.__storeHealthy.getStoredPack(pack.setKey, pack.publicKeyHex, pack.nonce), pack)).toBeUndefined();
    expect(await readFresh(first.page, [pack, missing, other])).toEqual([pack.cards, undefined, undefined]);
    expect(unexpectedArtErrors(first.errors)).toEqual([]);
    await first.context.close();

    // A new browser on the same profile: the record is on disk under exactly one key.
    const second = await launch();
    expect(await second.page.evaluate(() => window.__idb.rawKeys())).toEqual([keyOf(pack)]);
    expect(await readFresh(second.page, [pack, missing, other])).toEqual([pack.cards, undefined, undefined]);
    expect(await second.page.evaluate(async (pack) => {
      const store = window.__storeHealthy;
      const ready = await store.hydratePackStore([pack]);
      return [ready, store.getStoredPack(pack.setKey, pack.publicKeyHex, pack.nonce)];
    }, pack)).toEqual([true, pack.cards]);
    expect(unexpectedArtErrors(second.errors)).toEqual([]);
    await second.context.close();
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});

test('a missing pack reads as absent; a failed open or a corrupt record rejects instead', async ({ page, baseURL }) => {
  const errors = await harnessed(page, baseURL!);
  const pack = fixture(PLAYER_A, 1);
  const missing = { setKey: SET, publicKeyHex: PLAYER_A, nonce: 2 };
  await rawPut(page, [[keyOf(pack), pack.cards]]);
  expect(await readFresh(page, [pack, missing])).toEqual([pack.cards, undefined]);

  // From a fresh connection and empty memory: what the call settles with, and what reached memory.
  const outcome = (fn: 'read' | 'hydrate') => page.evaluate(async ({ fn, refs }) => {
    const store = window.__storeHealthy;
    store.resetPackStore();
    const memory = () => store.getStoredPack(refs[0].setKey, refs[0].publicKeyHex, refs[0].nonce) ?? null;
    try {
      const values = fn === 'read' ? await store.readStoredPacks(refs) : await store.hydratePackStore(refs);
      return { values, memory: memory() };
    } catch (error) {
      return { error: (error as Error).message, memory: memory() };
    }
  }, { fn, refs: [pack, missing] as PackStore.StoredPackRef[] });

  // A record of the wrong type: unreadable, not absent, and nothing reaches memory.
  await rawPut(page, [[keyOf(missing), { cards: 'not a card code' }]]);
  expect(await outcome('read')).toEqual({ error: 'Saved pack cache contains an unreadable entry', memory: null });
  expect(await outcome('hydrate')).toEqual({ error: 'Saved pack cache contains an unreadable entry', memory: null });

  // A newer database version makes the module's open fail natively (VersionError).
  expect(await page.evaluate(() => window.__idb.upgrade(2))).toBe('success');
  expect(await outcome('read')).toEqual({ error: 'Saved pack cache is unavailable; retry before restoring profile totals', memory: null });
  expect(await outcome('hydrate')).toEqual({ error: 'Saved pack cache is unavailable; retry before restoring profile totals', memory: null });
  expect(unexpectedArtErrors(errors)).toEqual([]);
});

test('a read whose transaction fails rejects rather than reading as absent, and a retry reads it', async ({ page, baseURL }) => {
  const errors = await harnessed(page, baseURL!);
  const pack = fixture(PLAYER_A, 3);
  await rawPut(page, [[keyOf(pack), pack.cards]]);
  const failed = await page.evaluate(async (pack) => {
    const store = window.__storeHealthy;
    // Injected failure: the read's own transaction aborts natively while its get is in flight.
    window.__idb.onRead = (tx) => {
      window.__idb.onRead = null;
      tx.abort();
    };
    try {
      return { ready: await store.hydratePackStore([pack]) };
    } catch (error) {
      return { error: (error as Error).message, memory: store.getStoredPack(pack.setKey, pack.publicKeyHex, pack.nonce) ?? null };
    }
  }, pack);
  expect(failed).toEqual({ error: 'Saved pack cache read failed; retry before restoring profile totals', memory: null });
  // Nothing was lost: the same connection reads the pack once the failure has passed.
  expect(await page.evaluate(async (pack) => {
    const store = window.__storeHealthy;
    return [await store.hydratePackStore([pack]), store.getStoredPack(pack.setKey, pack.publicKeyHex, pack.nonce)];
  }, pack)).toEqual([true, pack.cards]);
  expect(unexpectedArtErrors(errors)).toEqual([]);
});

/** Reports the write's outcome, the order against its native transaction, and what is on disk after a reload. */
async function writeContract(page: Page, store: StoreName, abort: boolean) {
  const pack = fixture(PLAYER_A, abort ? 11 : 10);
  const reported = await page.evaluate(async ([store, pack, abort]) => {
    window.__idb.abortWrites = abort;
    const saved = await window[`__store${store}`].putStoredPacks([pack]);
    window.__idb.log.push(`resolved ${saved}`);
    await window.__idb.lastWrite;
    return { saved, order: window.__idb.log };
  }, [store, pack, abort] as const);
  await reload(page);
  const [onDisk] = await readFresh(page, [pack]);
  return { ...reported, onDisk: onDisk === pack.cards };
}

for (const store of ['Healthy', 'EarlySuccess'] as const) {
  const broken = store !== 'Healthy';
  test(`${broken ? 'deliberately broken: success before commit fails' : 'healthy'}: a write reports saved only after its transaction commits`, async ({ page, baseURL }) => {
    const errors = await harnessed(page, baseURL!);
    const committed = await writeContract(page, store, false);
    const aborted = await writeContract(page, store, true);
    // Reported saved exactly when the pack is on disk, and never before its transaction committed.
    const holds = committed.saved === committed.onDisk && aborted.saved === aborted.onDisk
      && committed.order.join() === 'complete,resolved true';
    if (broken) {
      // The contract catches it: success was reported before the commit, and for a pack never stored.
      expect(committed.order).toEqual(['resolved true', 'complete']);
      expect(aborted).toEqual({ saved: true, onDisk: false, order: ['resolved true', 'abort'] });
      expect(holds).toBe(false);
    } else {
      expect(committed).toEqual({ saved: true, onDisk: true, order: ['complete', 'resolved true'] });
      expect(aborted).toMatchObject({ saved: false, onDisk: false });
      expect(aborted.order).toContain('abort');
      expect(holds).toBe(true);
    }
    expect(unexpectedArtErrors(errors)).toEqual([]);
  });
}

for (const store of ['Healthy', 'NoRetire'] as const) {
  const broken = store !== 'Healthy';
  test(`${broken ? 'deliberately broken: a kept connection fails' : 'healthy'}: a newer version retires the open connection without blocking`, async ({ page, baseURL }) => {
    const errors = await harnessed(page, baseURL!);
    const pack = fixture(PLAYER_A, 20);
    await rawPut(page, [[keyOf(pack), pack.cards]]);
    const result = await page.evaluate(async ([store, pack]) => {
      const module = window[`__store${store}`];
      // An open, cached connection from a first read.
      const before = await module.readStoredPacks([pack]);
      const upgrade = await window.__idb.upgrade(2);
      // Release a kept connection so the upgrade can finish either way.
      if (upgrade === 'blocked') module.resetPackStore();
      await window.__idb.upgraded;
      let after: string;
      try {
        after = JSON.stringify(await module.readStoredPacks([pack]));
      } catch (error) {
        after = (error as Error).message;
      }
      return { before, upgrade, after };
    }, [store, pack] as const);
    expect(result.before).toEqual([pack.cards]);
    // Retired, the old version reads as unavailable, never as a cache miss.
    expect(result.after).toBe('Saved pack cache is unavailable; retry before restoring profile totals');
    expect(result.upgrade).toBe(broken ? 'blocked' : 'success');
    expect(unexpectedArtErrors(errors)).toEqual([]);
  });
}

for (const store of ['Healthy', 'StaleIdentity'] as const) {
  const broken = store !== 'Healthy';
  test(`${broken ? 'deliberately broken: a stale page fails' : 'healthy'}: paged hydration, and a player switch mid-read drops the retired player's page`, async ({ page, baseURL }) => {
    test.setTimeout(60000);
    const errors = await harnessed(page, baseURL!);
    const PAGE = await page.evaluate(() => window.__storeHealthy.PACK_READ_PAGE);
    // One past a page boundary for A, a few for B: small, synthetic, and nothing re-derived.
    const packsA = Array.from({ length: PAGE + 1 }, (_, n) => fixture(PLAYER_A, n));
    const packsB = Array.from({ length: 3 }, (_, n) => fixture(PLAYER_B, n));
    await rawPut(page, [...packsA, ...packsB].map((p) => [keyOf(p), p.cards]));
    const refs = (packs: PackStore.StoredPack[]) => packs.map(({ setKey, publicKeyHex, nonce }) => ({ setKey, publicKeyHex, nonce }));

    const result = await page.evaluate(async ([store, refsA, refsB]) => {
      const module = window[`__store${store}`];
      const inMemory = (refs: PackStore.StoredPackRef[]) => refs.filter((r) => module.getStoredPack(r.setKey, r.publicKeyHex, r.nonce) !== undefined).length;
      let oversized: string | null = null;
      try {
        await module.readStoredPacks(refsA);
      } catch (error) {
        oversized = (error as Error).name;
      }
      // Control: every one of A's packs, in two page reads.
      window.__idb.readTransactions = 0;
      const control = { ready: await module.hydratePackStore(refsA), pages: window.__idb.readTransactions, loaded: inMemory(refsA) };

      // The player switches to B while A's first page is still being read.
      module.resetPackStore();
      window.__idb.readTransactions = 0;
      let player = 'A';
      window.__idb.onRead = () => {
        window.__idb.onRead = null;
        player = 'B';
      };
      const retired = await module.hydratePackStore(refsA, undefined, () => player === 'A');
      const leaked = inMemory(refsA);
      const replacement = await module.hydratePackStore(refsB, undefined, () => player === 'B');
      return { oversized, control, retired, leaked, replacement, loadedB: inMemory(refsB), leakedAfter: inMemory(refsA), pages: window.__idb.readTransactions };
    }, [store, refs(packsA), refs(packsB)] as const);

    expect(result.oversized).toBe('RangeError');
    expect(result.control).toEqual({ ready: true, pages: 2, loaded: PAGE + 1 });
    expect(result.retired).toBe(false);
    expect(result.replacement).toBe(true);
    expect(result.loadedB).toBe(packsB.length);
    // A's first page was read before the switch; the contract is that none of it lands.
    expect(result.pages).toBe(2);
    if (broken) {
      expect(result.leaked).toBe(PAGE);
      expect(result.leakedAfter).toBe(PAGE);
    } else {
      expect(result.leaked).toBe(0);
      expect(result.leakedAfter).toBe(0);
    }
    expect(unexpectedArtErrors(errors)).toEqual([]);
  });
}
