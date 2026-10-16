import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getStoredPack, hydratePackStore, packStoreVersion, putStoredPacks, resetPackStore, readStoredPacks, PACK_READ_PAGE, type StoredPackRef,
} from './packStore';

// Control only the asynchronous request boundary: tests still exercise the exported cache API. With
// `manual`, read transactions wait for the test to complete, fail or abort them.
function database(entries: [string, string][] = [], manual = false) {
  const records = new Map(entries);
  const close = vi.fn();
  const reads: { keys: string[]; oncomplete: (() => void) | null; onerror: (() => void) | null; onabort: (() => void) | null; abort: () => void }[] = [];
  const handle = {
    close,
    onversionchange: null as (() => void) | null,
    createObjectStore: vi.fn(),
    transaction: vi.fn((_store: string, mode: string) => {
      const tx = {
        keys: [] as string[],
        oncomplete: null as (() => void) | null,
        onerror: null as (() => void) | null,
        onabort: null as (() => void) | null,
        abort: vi.fn(() => tx.onabort?.()),
        objectStore: () => ({
          get: (key: string) => {
            tx.keys.push(key);
            return { result: records.get(key) };
          },
          put: (value: string, key: string) => records.set(key, value),
        }),
      };
      expect(['readonly', 'readwrite']).toContain(mode);
      if (mode === 'readonly') reads.push(tx);
      if (!manual || mode === 'readwrite') queueMicrotask(() => tx.oncomplete?.());
      return tx;
    }),
  };
  return { handle, close, records, reads };
}

function openRequest() {
  return {
    result: undefined as unknown as IDBDatabase,
    onsuccess: null as (() => void) | null,
    onerror: null as (() => void) | null,
    onblocked: null as (() => void) | null,
    onupgradeneeded: null as (() => void) | null,
  };
}

const sample = { setKey: 'set@1', publicKeyHex: '0123456789abcdefextra', nonce: 7, cards: 'card*G' };
let requests: ReturnType<typeof openRequest>[];
let openDatabase: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetPackStore();
  requests = [];
  openDatabase = vi.fn(() => {
    const request = openRequest();
    requests.push(request);
    return request;
  });
  vi.stubGlobal('indexedDB', { open: openDatabase });
});

afterEach(async () => {
  resetPackStore();
  await Promise.resolve();
  vi.unstubAllGlobals();
});

function succeed(request: ReturnType<typeof openRequest>, value = database()) {
  request.result = value.handle as unknown as IDBDatabase;
  request.onsuccess?.();
  return value;
}

describe('pack store connection ownership', () => {
  it('preserves the database, store, key, and read/write cache contract', async () => {
    const loading = hydratePackStore([sample]);
    const value = succeed(requests[0], database([['set@1|0123456789abcdef|7', 'original']]));
    expect(await loading).toBe(true);
    expect(getStoredPack(sample.setKey, sample.publicKeyHex, sample.nonce)).toBe('original');
    await putStoredPacks([sample]);
    expect(value.records.get('set@1|0123456789abcdef|7')).toBe('card*G');
    expect(getStoredPack(sample.setKey, sample.publicKeyHex, sample.nonce)).toBe('card*G');
    expect(openDatabase).toHaveBeenCalledExactlyOnceWith('brainrot-packs', 1);
    expect(value.handle.transaction).toHaveBeenCalledWith('reopened', 'readonly');
    expect(value.handle.transaction).toHaveBeenCalledWith('reopened', 'readwrite');
    expect(value.close).not.toHaveBeenCalled();
  });

  it.each(['onblocked', 'onerror'] as const)('closes a late success after %s fallback', async (failure) => {
    const writing = putStoredPacks([sample]);
    requests[0][failure]?.();
    await writing;
    const late = succeed(requests[0]);
    expect(late.close).toHaveBeenCalledOnce();
    expect(late.handle.transaction).not.toHaveBeenCalled();
    await putStoredPacks([sample]);
    expect(getStoredPack(sample.setKey, sample.publicKeyHex, sample.nonce)).toBe(sample.cards);
    expect(openDatabase).toHaveBeenCalledTimes(1);
  });

  it('releases the current connection on version change and opens a new attempt', async () => {
    const writing = putStoredPacks([sample]);
    const first = succeed(requests[0]);
    await writing;
    first.handle.onversionchange?.();
    expect(first.close).toHaveBeenCalledOnce();
    expect(getStoredPack(sample.setKey, sample.publicKeyHex, sample.nonce)).toBe(sample.cards);
    const reading = readStoredPacks([sample]);
    const second = succeed(requests[1]);
    await reading;
    expect(openDatabase).toHaveBeenCalledTimes(2);
    expect(second.handle.transaction).toHaveBeenCalledOnce();
  });

  it('reset clears memory and releases an already-open handle', async () => {
    const writing = putStoredPacks([sample]);
    const value = succeed(requests[0]);
    await writing;
    resetPackStore();
    await Promise.resolve();
    expect(value.close).toHaveBeenCalledOnce();
    expect(getStoredPack(sample.setKey, sample.publicKeyHex, sample.nonce)).toBeUndefined();
  });

  it('closes an abandoned pending success without replacing a newer connection', async () => {
    const abandonedWrite = putStoredPacks([sample]);
    const abandonedRequest = requests[0];
    resetPackStore();
    const currentRead = readStoredPacks([sample]);
    const current = succeed(requests[1]);
    await currentRead;
    const abandoned = succeed(abandonedRequest);
    await abandonedWrite;
    await readStoredPacks([sample]);
    expect(abandoned.close).toHaveBeenCalledOnce();
    expect(abandoned.handle.transaction).not.toHaveBeenCalled();
    expect(current.close).not.toHaveBeenCalled();
    expect(openDatabase).toHaveBeenCalledTimes(2);
    expect(current.handle.transaction).toHaveBeenCalledTimes(2);
  });

  it('an old version-change event cannot invalidate a newer cached handle', async () => {
    const reading = readStoredPacks([sample]);
    const old = succeed(requests[0]);
    await reading;
    const oldVersionChange = old.handle.onversionchange;
    oldVersionChange?.();
    const currentRead = readStoredPacks([sample]);
    const current = succeed(requests[1]);
    await currentRead;
    oldVersionChange?.();
    await readStoredPacks([sample]);
    expect(openDatabase).toHaveBeenCalledTimes(2);
    expect(current.close).not.toHaveBeenCalled();
    expect(current.handle.transaction).toHaveBeenCalledTimes(2);
  });

  it('retains memory fallback when opening throws, and reports reads as unavailable', async () => {
    openDatabase.mockImplementation(() => { throw new Error('storage denied'); });
    await putStoredPacks([sample]);
    await expect(readStoredPacks([sample])).rejects.toThrow('unavailable');
    expect(getStoredPack(sample.setKey, sample.publicKeyHex, sample.nonce)).toBe(sample.cards);
    expect(openDatabase).toHaveBeenCalledTimes(1);
  });
});

describe('bounded demand reads', () => {
  it('reads only the requested identity/set/ticket page and distinguishes missing entries', async () => {
    const page = readStoredPacks([sample, { ...sample, nonce: 8 }]);
    const value = succeed(requests[0], database([
      ['set@1|0123456789abcdef|7', 'original'], ['set@1|another-identity|7', 'unrelated'],
    ]));
    expect(await page).toEqual(['original', undefined]);
    expect(value.records.size).toBe(2);
    expect(getStoredPack(sample.setKey, sample.publicKeyHex, sample.nonce)).toBeUndefined();
  });

  it('rejects oversized pages before opening a database', async () => {
    await expect(readStoredPacks(Array.from({ length: PACK_READ_PAGE + 1 }, () => sample))).rejects.toThrow(RangeError);
    expect(openDatabase).not.toHaveBeenCalled();
  });

  it('keeps storage unavailability distinct from a missing cache record, and retries explicitly', async () => {
    const first = readStoredPacks([sample]);
    requests[0].onblocked?.();
    await expect(first).rejects.toThrow('unavailable');
    const retry = readStoredPacks([sample]);
    succeed(requests[1], database([['set@1|0123456789abcdef|7', 'preserved']]));
    expect(await retry).toEqual(['preserved']);
    const late = succeed(requests[0]);
    expect(late.close).toHaveBeenCalledOnce();
  });

  it('cancels a pending open without starting reads or suppressing a later retry', async () => {
    const controller = new AbortController();
    const reading = readStoredPacks([sample], controller.signal);
    controller.abort(new Error('retired identity'));
    await expect(reading).rejects.toThrow('retired identity');
    const value = succeed(requests[0], database([['set@1|0123456789abcdef|7', 'preserved']]));
    expect(await readStoredPacks([sample])).toEqual(['preserved']);
    expect(value.handle.transaction).toHaveBeenCalledOnce();
  });

  it('bounds concurrent pages while the database is pending', async () => {
    const first = readStoredPacks([sample]);
    const second = readStoredPacks([sample]);
    await expect(readStoredPacks([sample])).rejects.toThrow('busy');
    succeed(requests[0]);
    await Promise.all([first, second]);
  });
});


it('snapshots the bounded page and identities before waiting for a database', async () => {
  const ref = { ...sample };
  const refs = [ref];
  const reading = readStoredPacks(refs);
  ref.nonce = 999;
  refs.push(...Array.from({ length: PACK_READ_PAGE + 1 }, () => ref));
  succeed(requests[0], database([
    ['set@1|0123456789abcdef|7', 'original'], ['set@1|0123456789abcdef|999', 'changed'],
  ]));
  expect(await reading).toEqual(['original']);
});


describe('paged hydration', () => {
  const refs = (count: number): StoredPackRef[] =>
    Array.from({ length: count }, (_, nonce) => ({ setKey: 'set@1', publicKeyHex: sample.publicKeyHex, nonce }));
  const keyFor = (ref: StoredPackRef) => `set@1|0123456789abcdef|${ref.nonce}`;
  const saved = (packs: StoredPackRef[], manual = false) =>
    database(packs.map(ref => [keyFor(ref), `cards-${ref.nonce}`]), manual);
  const cached = (ref: StoredPackRef) => getStoredPack(ref.setKey, ref.publicKeyHex, ref.nonce);

  it('reads every requested pack in bounded pages, one page at a time', async () => {
    const packs = refs(2 * PACK_READ_PAGE + 5);
    const stored = saved(packs, true);
    const hydrating = hydratePackStore(packs);
    succeed(requests[0], stored);
    for (let page = 0; page < 3; page++) {
      await vi.waitFor(() => expect(stored.reads).toHaveLength(page + 1));
      await Promise.resolve();
      expect(stored.reads).toHaveLength(page + 1);
      stored.reads[page].oncomplete?.();
    }
    expect(await hydrating).toBe(true);
    expect(stored.reads.map(tx => tx.keys.length)).toEqual([PACK_READ_PAGE, PACK_READ_PAGE, 5]);
    expect(packs.every(ref => cached(ref) === `cards-${ref.nonce}`)).toBe(true);
  });

  it('stops on abort mid-read, keeping finished pages and dropping the cancelled one', async () => {
    const packs = refs(PACK_READ_PAGE + 1);
    const stored = saved(packs, true);
    const controller = new AbortController();
    const hydrating = hydratePackStore(packs, controller.signal);
    succeed(requests[0], stored);
    await vi.waitFor(() => expect(stored.reads).toHaveLength(1));
    stored.reads[0].oncomplete?.();
    await vi.waitFor(() => expect(stored.reads).toHaveLength(2));
    controller.abort(new Error('unmounted'));
    await expect(hydrating).rejects.toThrow('unmounted');
    expect(stored.reads[1].abort).toHaveBeenCalledOnce();
    expect(cached(packs[0])).toBe('cards-0');
    expect(cached(packs[PACK_READ_PAGE])).toBeUndefined();
  });

  it('rejects a failed page read instead of reporting the packs as missing', async () => {
    const packs = refs(PACK_READ_PAGE + 1);
    const stored = saved(packs, true);
    const hydrating = hydratePackStore(packs);
    succeed(requests[0], stored);
    await vi.waitFor(() => expect(stored.reads).toHaveLength(1));
    stored.reads[0].oncomplete?.();
    await vi.waitFor(() => expect(stored.reads).toHaveLength(2));
    stored.reads[1].onerror?.();
    await expect(hydrating).rejects.toThrow('read failed');
    expect(cached(packs[0])).toBe('cards-0');
    expect(cached(packs[PACK_READ_PAGE])).toBeUndefined();
  });

  it('rejects when storage is unavailable', async () => {
    const hydrating = hydratePackStore([sample]);
    requests[0].onerror?.();
    await expect(hydrating).rejects.toThrow('unavailable');
  });

  it('drops a page that lands after its owner is retired', async () => {
    const packs = refs(PACK_READ_PAGE + 1);
    const stored = saved(packs, true);
    let current = true;
    const hydrating = hydratePackStore(packs, undefined, () => current);
    succeed(requests[0], stored);
    await vi.waitFor(() => expect(stored.reads).toHaveLength(1));
    current = false;
    stored.reads[0].oncomplete?.();
    expect(await hydrating).toBe(false);
    expect(cached(packs[0])).toBeUndefined();
    expect(stored.reads).toHaveLength(1);
  });

  it('skips packs already in memory and never overwrites one re-opened during the read', async () => {
    const packs = refs(3);
    const stored = saved(packs, true);
    const writing = putStoredPacks([{ ...packs[0], cards: 'fresh-0' }]);
    succeed(requests[0], stored);
    await writing;
    const hydrating = hydratePackStore(packs);
    await vi.waitFor(() => expect(stored.reads).toHaveLength(1));
    expect(stored.reads[0].keys).toEqual([keyFor(packs[1]), keyFor(packs[2])]);
    void putStoredPacks([{ ...packs[1], cards: 'fresh-1' }]);
    stored.reads[0].oncomplete?.();
    expect(await hydrating).toBe(true);
    expect(packs.map(cached)).toEqual(['fresh-0', 'fresh-1', 'cards-2']);
  });

  it('moves the store version when a read adds packs, and only then', async () => {
    const packs = refs(2);
    const stored = database([[keyFor(packs[0]), 'cards-0']]);
    const before = packStoreVersion();
    const hydrating = hydratePackStore(packs);
    succeed(requests[0], stored);
    expect(await hydrating).toBe(true);
    const after = packStoreVersion();
    expect(after).not.toBe(before);
    // Nothing new: pack 0 is in memory and pack 1 is missing from the store.
    expect(await hydratePackStore(packs)).toBe(true);
    expect(packStoreVersion()).toBe(after);
  });

  it('has nothing to read without IndexedDB', async () => {
    vi.unstubAllGlobals();
    expect(await hydratePackStore([sample])).toBe(true);
    expect(openDatabase).not.toHaveBeenCalled();
    expect(await hydratePackStore([])).toBe(true);
  });
});
