import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getStoredPack, loadPackStore, putStoredPacks, resetPackStore, readStoredPacks, PACK_READ_PAGE } from './packStore';

// Control only the asynchronous request boundary: tests still exercise the exported cache API.
function database(entries: [string, string][] = []) {
  const records = new Map(entries);
  const close = vi.fn();
  const handle = {
    close,
    onversionchange: null as (() => void) | null,
    createObjectStore: vi.fn(),
    transaction: vi.fn((_store: string, mode: string) => {
      const tx = {
        oncomplete: null as (() => void) | null,
        objectStore: () => ({
          getAllKeys: () => ({ result: [...records.keys()] }),
          getAll: () => ({ result: [...records.values()] }),
          get: (key: string) => ({ result: records.get(key) }),
          put: (value: string, key: string) => records.set(key, value),
        }),
      };
      expect(['readonly', 'readwrite']).toContain(mode);
      queueMicrotask(() => tx.oncomplete?.());
      return tx;
    }),
  };
  return { handle, close, records };
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
    const loading = loadPackStore();
    const value = succeed(requests[0], database([['set@1|0123456789abcdef|7', 'original']]));
    await loading;
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
    const loading = loadPackStore();
    requests[0][failure]?.();
    await loading;
    const late = succeed(requests[0]);
    expect(late.close).toHaveBeenCalledOnce();
    expect(late.handle.transaction).not.toHaveBeenCalled();
    await putStoredPacks([sample]);
    expect(getStoredPack(sample.setKey, sample.publicKeyHex, sample.nonce)).toBe(sample.cards);
    expect(openDatabase).toHaveBeenCalledTimes(1);
  });

  it('releases the current connection on version change and opens a new attempt', async () => {
    const loading = loadPackStore();
    const first = succeed(requests[0]);
    await loading;
    await putStoredPacks([sample]);
    first.handle.onversionchange?.();
    expect(first.close).toHaveBeenCalledOnce();
    expect(getStoredPack(sample.setKey, sample.publicKeyHex, sample.nonce)).toBe(sample.cards);
    const reloading = loadPackStore();
    const second = succeed(requests[1]);
    await reloading;
    expect(openDatabase).toHaveBeenCalledTimes(2);
    expect(second.handle.transaction).toHaveBeenCalledOnce();
  });

  it('reset clears memory and releases an already-open handle', async () => {
    const loading = loadPackStore();
    const value = succeed(requests[0]);
    await loading;
    await putStoredPacks([sample]);
    resetPackStore();
    await Promise.resolve();
    expect(value.close).toHaveBeenCalledOnce();
    expect(getStoredPack(sample.setKey, sample.publicKeyHex, sample.nonce)).toBeUndefined();
  });

  it('closes an abandoned pending success without replacing a newer connection', async () => {
    const abandonedLoad = loadPackStore();
    const abandonedRequest = requests[0];
    resetPackStore();
    const currentLoad = loadPackStore();
    const current = succeed(requests[1]);
    await currentLoad;
    const abandoned = succeed(abandonedRequest);
    await abandonedLoad;
    await loadPackStore();
    expect(abandoned.close).toHaveBeenCalledOnce();
    expect(abandoned.handle.transaction).not.toHaveBeenCalled();
    expect(current.close).not.toHaveBeenCalled();
    expect(openDatabase).toHaveBeenCalledTimes(2);
    expect(current.handle.transaction).toHaveBeenCalledTimes(2);
  });

  it('an old version-change event cannot invalidate a newer cached handle', async () => {
    const loading = loadPackStore();
    const old = succeed(requests[0]);
    await loading;
    const oldVersionChange = old.handle.onversionchange;
    oldVersionChange?.();
    const currentLoad = loadPackStore();
    const current = succeed(requests[1]);
    await currentLoad;
    oldVersionChange?.();
    await loadPackStore();
    expect(openDatabase).toHaveBeenCalledTimes(2);
    expect(current.close).not.toHaveBeenCalled();
    expect(current.handle.transaction).toHaveBeenCalledTimes(2);
  });

  it('retains memory fallback when opening throws', async () => {
    openDatabase.mockImplementation(() => { throw new Error('storage denied'); });
    await putStoredPacks([sample]);
    await loadPackStore();
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
