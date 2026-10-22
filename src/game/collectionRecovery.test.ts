import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../constants';
import { ALL_CARDS } from '../data/cards';
import { hydrateCollection } from '../utils/migrations';
import {
  ARCHIVE_BUDGET, COLLECTION_RECOVERY_NOTES, collectionRecoveryDismissed, collectionRecoveryFile, collectionRecoveryNote,
  collectionRecoveryPrint, collectionRecoveryState, discardCollectionRecovery, dismissCollectionRecovery, downloadCollectionRecovery, hasCollectionRecovery,
  persistCollection,
} from './collectionRecovery';

const card = ALL_CARDS[0];
const item = { card, normalCount: 1, holoCount: 0 };
const ARCHIVE = STORAGE_KEYS.COLLECTION_RECOVERY;
const seed = (raw: string | null, fail?: (key: string, value: string) => boolean) => {
  const data = new Map<string, string>();
  if (raw !== null) data.set(STORAGE_KEYS.COLLECTION, raw);
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (fail?.(key, value)) throw new DOMException('full', 'QuotaExceededError');
      data.set(key, value);
    },
    removeItem: (key: string) => { data.delete(key); },
  });
  return data;
};
const archiveIn = (data: Map<string, string>) => JSON.parse(data.get(ARCHIVE)!);
let errors: ReturnType<typeof vi.spyOn>;
let warnings: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  // Forget anything this visit kept in memory (the module outlives each test), on storage that lets go.
  seed(null);
  expect(discardCollectionRecovery(collectionRecoveryPrint())).toBe('discarded');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const logged = () => errors.mock.calls.map((call: unknown[]) => String(call[0]));
const warned = () => warnings.mock.calls.map((call: unknown[]) => String(call[0]));

describe('collection recovery before a subsequent pack write', () => {
  it('preserves the exact original raw payload including a same-key unreadable card', () => {
    const raw = '{ "keep": ' + JSON.stringify(item) + ', "' + card.key + '":null, "bad": {"card":false} }';
    const data = seed(raw);
    const hydrated = hydrateCollection(JSON.parse(raw));
    const next = { ...hydrated, [card.key]: item };
    expect(hydrated).not.toHaveProperty(card.key);
    expect(persistCollection(next)).toBe('recovered');
    expect(JSON.parse(data.get(STORAGE_KEYS.COLLECTION_RECOVERY)!).raw).toBe(raw);
    expect(hasCollectionRecovery()).toBe(true);
    expect(JSON.parse(data.get(STORAGE_KEYS.COLLECTION)!)).toEqual(next);
    expect(persistCollection({ ...next, added: item })).toBe('saved');
    expect(JSON.parse(data.get(STORAGE_KEYS.COLLECTION_RECOVERY)!).raw).toBe(raw);
  });

  it.each(['{broken', 'null', '[]', '0', '"string"'])('preserves unreadable container/JSON bytes: %s', (raw) => {
    const data = seed(raw);
    expect(persistCollection({ [card.key]: item })).toBe('recovered');
    expect(JSON.parse(data.get(STORAGE_KEYS.COLLECTION_RECOVERY)!)).toEqual({ raw, player: null });
  });

  it('does not allocate a recovery archive for a new or fully readable collection', () => {
    for (const raw of [null, '{}', JSON.stringify({ [card.key]: item })]) {
      const data = seed(raw);
      expect(persistCollection({ [card.key]: item })).toBe('saved');
      expect(data.has(STORAGE_KEYS.COLLECTION_RECOVERY)).toBe(false);
      expect(hasCollectionRecovery()).toBe(false);
    }
    expect(logged()).toEqual([]);
  });

  it("still saves when the archive can't be written, keeping the payload for this visit to download", () => {
    const raw = '{"damaged":null}';
    const data = seed(raw, (key) => key === ARCHIVE);
    data.set('brainrot-player-v1', '{"secretKey":"now"}');
    expect(persistCollection({ [card.key]: item })).toBe('recovered');
    expect(JSON.parse(data.get(STORAGE_KEYS.COLLECTION)!)).toEqual({ [card.key]: item });
    expect(data.has(ARCHIVE)).toBe(false);
    expect(collectionRecoveryState()).toBe('unsaved');
    expect(hasCollectionRecovery()).toBe(true);
    expect(JSON.parse(collectionRecoveryFile()!.text)).toEqual({ raw, player: '{"secretKey":"now"}' });
    expect(warned()).toEqual([expect.stringMatching(/kept in this tab only/)]);
    expect(logged()).toEqual([]);
  });

  it('keeps both the original and archive when the final collection write fails, then retries safely', () => {
    const raw = '{"damaged":null}';
    let full = true;
    const data = seed(raw, (key) => full && key === STORAGE_KEYS.COLLECTION);
    expect(persistCollection({ [card.key]: item })).toBe('blocked');
    expect(data.get(STORAGE_KEYS.COLLECTION)).toBe(raw);
    expect(JSON.parse(data.get(STORAGE_KEYS.COLLECTION_RECOVERY)!).raw).toBe(raw);
    expect(logged()).toEqual([`Failed to save to localStorage key "${STORAGE_KEYS.COLLECTION}":`]);
    full = false;
    expect(persistCollection({ [card.key]: item })).toBe('recovered');
  });

  it('adds a different damaged payload beside the archived one instead of blocking saves', () => {
    const raw = '{"second":null}';
    const data = seed(raw);
    data.set('brainrot-player-v1', '{"secretKey":"now"}');
    const first = { raw: '{"first":null}', player: '{"secretKey":"then"}' };
    data.set(STORAGE_KEYS.COLLECTION_RECOVERY, JSON.stringify(first));
    expect(persistCollection({ [card.key]: item })).toBe('recovered');
    expect(JSON.parse(data.get(STORAGE_KEYS.COLLECTION)!)).toEqual({ [card.key]: item });
    const archive = JSON.parse(data.get(STORAGE_KEYS.COLLECTION_RECOVERY)!);
    expect(archive).toEqual({ ...first, later: [{ raw, player: '{"secretKey":"now"}' }] });
    // The same damaged bytes again (a retried write) aren't added twice.
    data.set(STORAGE_KEYS.COLLECTION, raw);
    expect(persistCollection({})).toBe('recovered');
    expect(JSON.parse(data.get(STORAGE_KEYS.COLLECTION_RECOVERY)!)).toEqual(archive);
    expect(logged()).toEqual([]);
  });

  it('keeps the first and the newest ten, counting the later payloads it lets go', () => {
    const data = seed(null);
    data.set(ARCHIVE, JSON.stringify({ raw: '{"0":null}', player: null }));
    for (let i = 1; i <= 10; i++) {
      data.set(STORAGE_KEYS.COLLECTION, `{"${i}":null}`);
      expect(persistCollection({})).toBe('recovered');
    }
    expect(archiveIn(data).later).toHaveLength(10);
    expect(warned()).toEqual([]);

    for (let i = 11; i <= 12; i++) {
      data.set(STORAGE_KEYS.COLLECTION, `{"${i}":null}`);
      expect(persistCollection({})).toBe('recovered');
      expect(data.get(STORAGE_KEYS.COLLECTION)).toBe('{}');
    }
    const archive = archiveIn(data);
    expect(archive.raw).toBe('{"0":null}');
    expect(archive.later.map((entry: { raw: string }) => entry.raw)).toEqual(
      Array.from({ length: 10 }, (_, i) => `{"${i + 3}":null}`));
    expect(archive.dropped).toBe(2);
    expect(warned()).toEqual([expect.stringMatching(/Let the 1 oldest later payload/), expect.stringMatching(/Let the 1 oldest/)]);
    expect(logged()).toEqual([]);
    // Bytes it already holds still count as kept, and a readable collection saves as before.
    data.set(STORAGE_KEYS.COLLECTION, '{"12":null}');
    expect(persistCollection({})).toBe('recovered');
    expect(archiveIn(data)).toEqual(archive);
    expect(persistCollection({ [card.key]: item })).toBe('saved');
  });

  it(`keeps the whole archive within ${ARCHIVE_BUDGET} characters, then keeps a payload too big for it in memory`, () => {
    const big = (name: string, size: number) => JSON.stringify({ [name]: 'x'.repeat(size) });
    const data = seed(big('a', 400_000));
    expect(persistCollection({})).toBe('recovered');
    data.set(STORAGE_KEYS.COLLECTION, big('b', 300_000));
    expect(persistCollection({})).toBe('recovered');
    data.set(STORAGE_KEYS.COLLECTION, big('c', 300_000));
    expect(persistCollection({})).toBe('recovered');
    const archive = archiveIn(data);
    expect(data.get(ARCHIVE)!.length).toBeLessThanOrEqual(ARCHIVE_BUDGET);
    expect(archive.raw).toBe(big('a', 400_000));
    expect(archive.later).toEqual([{ raw: big('c', 300_000), player: null }]);
    expect(archive.dropped).toBe(1);
    expect(collectionRecoveryState()).toBe('stored');

    // The first and this one together are over budget: the stored archive stays, the save goes on.
    const stored = data.get(ARCHIVE);
    data.set(STORAGE_KEYS.COLLECTION, big('d', 700_000));
    expect(persistCollection({ [card.key]: item })).toBe('recovered');
    expect(data.get(ARCHIVE)).toBe(stored);
    expect(JSON.parse(data.get(STORAGE_KEYS.COLLECTION)!)).toEqual({ [card.key]: item });
    expect(collectionRecoveryState()).toBe('unsaved');
    expect(JSON.parse(collectionRecoveryFile()!.text).later.map((entry: { raw: string }) => entry.raw))
      .toEqual([big('c', 300_000), big('d', 700_000)]);
    expect(warned().at(-1)).toMatch(/kept in this tab only/);
  });

  it('lets the oldest later payloads go when storage is full, then keeps the newest in memory and still saves', () => {
    let room = 2;
    const data = seed('{"4":null}', (key, value) => key === ARCHIVE && (JSON.parse(value).later?.length ?? 0) > room);
    const entry = (i: number) => ({ raw: `{"${i}":null}`, player: null });
    data.set(ARCHIVE, JSON.stringify({ ...entry(0), later: [entry(1), entry(2), entry(3)] }));
    expect(persistCollection({})).toBe('recovered');
    expect(archiveIn(data)).toEqual({ ...entry(0), later: [entry(3), entry(4)], dropped: 2 });
    expect(warned()).toEqual([expect.stringMatching(/Let the 2 oldest later payload/)]);

    room = 0;
    const stored = data.get(ARCHIVE);
    data.set(STORAGE_KEYS.COLLECTION, '{"5":null}');
    expect(persistCollection({ [card.key]: item })).toBe('recovered');
    expect(data.get(ARCHIVE)).toBe(stored);
    expect(JSON.parse(data.get(STORAGE_KEYS.COLLECTION)!)).toEqual({ [card.key]: item });
    expect(collectionRecoveryState()).toBe('unsaved');
    expect(warned().at(-1)).toMatch(/kept in this tab only/);
    // The same bytes again aren't kept twice.
    data.set(STORAGE_KEYS.COLLECTION, '{"5":null}');
    expect(persistCollection({})).toBe('recovered');
    expect(JSON.parse(collectionRecoveryFile()!.text)).toEqual({ ...entry(0), later: [entry(3), entry(4), entry(5)], dropped: 2 });
    expect(logged()).toEqual([]);
  });

  it.each(['{broken', '[]', '{"raw":"x","later":"y"}', '{"raw":"x","player":null,"dropped":-1}', '{"raw":"x","player":null,"kind":"other"}'])(
    'keeps an archive it cannot read as the first entry instead of blocking: %s', (originalArchive) => {
      const raw = '{"second":null}';
      const data = seed(raw);
      data.set(ARCHIVE, originalArchive);
      expect(persistCollection({})).toBe('recovered');
      expect(data.get(STORAGE_KEYS.COLLECTION)).toBe('{}');
      expect(archiveIn(data)).toEqual({ raw: originalArchive, player: null, kind: 'unparseable-archive', later: [{ raw, player: null }] });
      expect(warned()).toEqual([expect.stringMatching(/couldn't be read, so its exact text is kept as the first entry/)]);
      expect(logged()).toEqual([]);
    });

  it('does not write anything if the persisted collection cannot be read', () => {
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { getItem: () => { throw new DOMException('denied', 'SecurityError'); }, setItem });
    expect(persistCollection({})).toBe('blocked');
    expect(setItem).not.toHaveBeenCalled();
    expect(hasCollectionRecovery()).toBe(false);
  });
});


describe('downloading and discarding kept-aside data', () => {
  it('builds a dated JSON file of the stored archive and this visit\'s unsaved payloads', () => {
    const data = seed(null);
    const now = new Date('2026-10-16T12:00:00Z');
    expect(collectionRecoveryFile(now)).toBeNull();
    const stored = { raw: '{"0":null}', player: '{"secretKey":"then"}', later: [{ raw: '{"1":null}', player: null }], dropped: 3 };
    data.set(ARCHIVE, JSON.stringify(stored));
    expect(collectionRecoveryFile(now)).toEqual({ name: 'brainrot-collection-recovery-2026-10-16.json', text: JSON.stringify(stored, null, 2) });

    // Nothing stored, everything in memory: the first unsaved payload leads.
    const memory = seed('{"2":null}', (key) => key === ARCHIVE);
    memory.set('brainrot-player-v1', '{"secretKey":"now"}');
    expect(persistCollection({})).toBe('recovered');
    memory.set(STORAGE_KEYS.COLLECTION, '{"3":null}');
    expect(persistCollection({})).toBe('recovered');
    expect(JSON.parse(collectionRecoveryFile(now)!.text)).toEqual({
      raw: '{"2":null}', player: '{"secretKey":"now"}', later: [{ raw: '{"3":null}', player: '{"secretKey":"now"}' }],
    });
  });

  it('downloads an unreadable archive as its exact text', () => {
    const data = seed(null);
    data.set(ARCHIVE, '{broken');
    expect(JSON.parse(collectionRecoveryFile()!.text)).toEqual({ raw: '{broken', player: null, kind: 'unparseable-archive' });
  });

  it('distinguishes unavailable archive from missing archive when storage reads are denied', () => {
    const data = seed(null);
    data.set(ARCHIVE, JSON.stringify({ raw: '{"kept":1}', player: null }));
    expect(collectionRecoveryState()).toBe('stored');

    const getItem = localStorage.getItem;
    vi.spyOn(localStorage, 'getItem').mockImplementation((key: string) => {
      if (key === ARCHIVE) throw new DOMException('Storage read denied', 'SecurityError');
      return getItem(key);
    });

    // Not 'none': the archive may still be there. No note of its own (callers keep the one showing).
    expect(collectionRecoveryState()).toBe('unavailable');
    expect(hasCollectionRecovery()).toBe(false);
    expect(collectionRecoveryNote()).toBeUndefined();
    // No file at all rather than an empty or partial one, and the download says why.
    expect(() => collectionRecoveryFile()).toThrow('Storage read denied');
    expect(downloadCollectionRecovery()).toBe('unavailable');

    // Access back: the exact archive is what the file holds.
    vi.spyOn(localStorage, 'getItem').mockImplementation(getItem);
    expect(JSON.parse(collectionRecoveryFile()!.text)).toEqual({ raw: '{"kept":1}', player: null });
  });

  it('raises no kept-aside note when every storage read is denied and nothing is kept', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new DOMException('denied', 'SecurityError'); } });
    expect(collectionRecoveryState()).toBe('unavailable');
    expect(collectionRecoveryNote()).toBeUndefined();
    expect(hasCollectionRecovery()).toBe(false);
  });

  it('builds no partial file from this visit\'s unsaved payloads while the stored archive can\'t be read', () => {
    const data = seed('{"2":null}', (key) => key === ARCHIVE);
    expect(persistCollection({})).toBe('recovered');
    const stored = { raw: '{"0":null}', player: null };
    data.set(ARCHIVE, JSON.stringify(stored));
    const getItem = localStorage.getItem;
    vi.spyOn(localStorage, 'getItem').mockImplementation((key: string) => {
      if (key === ARCHIVE) throw new DOMException('Storage read denied', 'SecurityError');
      return getItem(key);
    });

    expect(collectionRecoveryState()).toBe('unsaved');
    expect(() => collectionRecoveryFile()).toThrow('Storage read denied');
    expect(downloadCollectionRecovery()).toBe('unavailable');
    expect(data.get(ARCHIVE)).toBe(JSON.stringify(stored));

    vi.spyOn(localStorage, 'getItem').mockImplementation(getItem);
    expect(JSON.parse(collectionRecoveryFile()!.text)).toEqual({ ...stored, later: [{ raw: '{"2":null}', player: null }] });
  });

  it('discards the stored archive, its hidden-note fingerprint and the unsaved payloads', () => {
    const data = seed('{"1":null}', (key) => key === ARCHIVE);
    expect(persistCollection({})).toBe('recovered');
    data.set(ARCHIVE, JSON.stringify({ raw: '{"0":null}', player: null }));
    expect(dismissCollectionRecovery()).toBe(true);
    expect(data.has(STORAGE_KEYS.COLLECTION_RECOVERY_SEEN)).toBe(true);
    expect(discardCollectionRecovery(collectionRecoveryPrint())).toBe('discarded');
    expect(data.has(ARCHIVE)).toBe(false);
    expect(data.has(STORAGE_KEYS.COLLECTION_RECOVERY_SEEN)).toBe(false);
    expect(collectionRecoveryState()).toBe('none');
    expect(hasCollectionRecovery()).toBe(false);
    expect(collectionRecoveryFile()).toBeNull();
  });

  it('reports a discard storage refused', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => '{"raw":"x","player":null}',
      removeItem: () => { throw new DOMException('denied', 'SecurityError'); },
    });
    expect(discardCollectionRecovery(collectionRecoveryPrint())).toBe('refused');
    expect(hasCollectionRecovery()).toBe(true);
    expect(logged()).toEqual([`Failed to remove localStorage key "${ARCHIVE}":`]);
  });

  it('reports the discard done when only the hidden-note fingerprint stays behind', () => {
    const data = seed('{"1":null}', (key) => key === ARCHIVE);
    expect(persistCollection({})).toBe('recovered');
    data.set(ARCHIVE, JSON.stringify({ raw: '{"0":null}', player: null }));
    expect(dismissCollectionRecovery()).toBe(true);
    const remove = localStorage.removeItem;
    vi.spyOn(localStorage, 'removeItem').mockImplementation((key: string) => {
      if (key === STORAGE_KEYS.COLLECTION_RECOVERY_SEEN) throw new DOMException('denied', 'SecurityError');
      remove(key);
    });
    expect(discardCollectionRecovery(collectionRecoveryPrint())).toBe('discarded');
    expect(data.has(ARCHIVE)).toBe(false);
    expect(data.has(STORAGE_KEYS.COLLECTION_RECOVERY_SEEN)).toBe(true);
    expect(collectionRecoveryState()).toBe('none');
    expect(logged()).toEqual([]);
    expect(warned()).toContain(`Failed to remove localStorage key "${STORAGE_KEYS.COLLECTION_RECOVERY_SEEN}":`);
  });

  it("keeps this visit's payloads when storage refuses the discard", () => {
    seed('{"1":null}', (key) => key === ARCHIVE);
    expect(persistCollection({})).toBe('recovered');
    const removeItem = vi.spyOn(localStorage, 'removeItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });
    expect(discardCollectionRecovery(collectionRecoveryPrint())).toBe('refused');
    expect(collectionRecoveryState()).toBe('unsaved');
    expect(JSON.parse(collectionRecoveryFile()!.text).raw).toBe('{"1":null}');
    removeItem.mockRestore();
    expect(discardCollectionRecovery(collectionRecoveryPrint())).toBe('discarded');
    expect(collectionRecoveryState()).toBe('none');
  });

  it('discards nothing when the kept-aside data changed since the player was asked', () => {
    const data = seed('{"2":null}', (key, value) => key === ARCHIVE && value.includes('"{\\"2\\":null}"'));
    data.set(ARCHIVE, JSON.stringify({ raw: '{"0":null}', player: null }));
    data.set(STORAGE_KEYS.COLLECTION_RECOVERY_SEEN, 'seen');
    let shown = collectionRecoveryPrint();
    // Another tab stored another payload meanwhile.
    const stored = JSON.stringify({ raw: '{"0":null}', player: null, later: [{ raw: '{"1":null}', player: null }] });
    data.set(ARCHIVE, stored);
    expect(discardCollectionRecovery(shown)).toBe('changed');
    expect(data.get(ARCHIVE)).toBe(stored);
    expect(data.get(STORAGE_KEYS.COLLECTION_RECOVERY_SEEN)).toBe('seen');

    // Or this tab kept one in memory.
    shown = collectionRecoveryPrint();
    expect(persistCollection({})).toBe('recovered');
    expect(collectionRecoveryState()).toBe('unsaved');
    expect(discardCollectionRecovery(shown)).toBe('changed');
    expect(data.get(ARCHIVE)).toBe(stored);
    expect(collectionRecoveryState()).toBe('unsaved');

    expect(discardCollectionRecovery(collectionRecoveryPrint())).toBe('discarded');
    expect(data.has(ARCHIVE)).toBe(false);
    expect(data.has(STORAGE_KEYS.COLLECTION_RECOVERY_SEEN)).toBe(false);
    expect(collectionRecoveryState()).toBe('none');
  });

  it('says how many older payloads were let go, stored and in memory, in the note and the file', () => {
    const data = seed(null);
    expect(collectionRecoveryNote()).toBeUndefined();
    data.set(ARCHIVE, JSON.stringify({ raw: '{"0":null}', player: null }));
    expect(collectionRecoveryNote()).toBe(COLLECTION_RECOVERY_NOTES.stored);
    data.set(ARCHIVE, JSON.stringify({ raw: '{"0":null}', player: null, dropped: 3 }));
    expect(collectionRecoveryNote()).toBe(`${COLLECTION_RECOVERY_NOTES.stored} 3 older unreadable saves were let go to make room.`);

    // Storage takes no archive: this visit keeps the first and the newest ten, counting the one let go.
    const memory = seed(null, (key) => key === ARCHIVE);
    for (let i = 0; i <= 11; i++) {
      memory.set(STORAGE_KEYS.COLLECTION, `{"${i}":null}`);
      expect(persistCollection({})).toBe('recovered');
    }
    expect(collectionRecoveryState()).toBe('unsaved');
    expect(collectionRecoveryNote()).toBe(`${COLLECTION_RECOVERY_NOTES.unsaved} 1 older unreadable save was let go to make room.`);
    const file = JSON.parse(collectionRecoveryFile()!.text);
    expect(file.raw).toBe('{"0":null}');
    expect(file.later.map((entry: { raw: string }) => entry.raw)).toEqual(Array.from({ length: 10 }, (_, i) => `{"${i + 2}":null}`));
    expect(file.dropped).toBe(1);
  });
});

it('keeps the original private identity snapshot when later ticket counters change', () => {
  const raw = '{"damaged":null}';
  let full = true;
  const data = seed(raw, (key) => full && key === STORAGE_KEYS.COLLECTION);
  const originalPlayer = '{"secretKey":"original","nextNonce":4}';
  data.set('brainrot-player-v1', originalPlayer);
  expect(persistCollection({})).toBe('blocked');
  data.set('brainrot-player-v1', '{"secretKey":"original","nextNonce":5}');
  full = false;
  expect(persistCollection({})).toBe('recovered');
  expect(JSON.parse(data.get(STORAGE_KEYS.COLLECTION_RECOVERY)!)).toEqual({ raw, player: originalPlayer });
});

describe('hiding the kept-aside note', () => {
  it('stays hidden for the same archive and comes back when another payload is kept', () => {
    const data = seed('{"second":null}');
    expect(dismissCollectionRecovery()).toBe(false);
    expect(collectionRecoveryDismissed()).toBe(false);
    data.set(STORAGE_KEYS.COLLECTION_RECOVERY, JSON.stringify({ raw: '{"first":null}', player: null }));
    expect(collectionRecoveryDismissed()).toBe(false);
    expect(dismissCollectionRecovery()).toBe(true);
    expect(collectionRecoveryDismissed()).toBe(true);
    // Only a short fingerprint is stored, never a second copy of the archive.
    expect(data.get(STORAGE_KEYS.COLLECTION_RECOVERY_SEEN)!.length).toBeLessThan(20);
    expect(persistCollection({})).toBe('recovered');
    expect(collectionRecoveryDismissed()).toBe(false);
  });

  it('brings the note back when a payload is kept for this visit only, and hides that too', () => {
    const data = seed('{"1":null}', (key) => key === ARCHIVE);
    expect(persistCollection({})).toBe('recovered');
    expect(collectionRecoveryDismissed()).toBe(false);
    expect(dismissCollectionRecovery()).toBe(true);
    expect(collectionRecoveryDismissed()).toBe(true);
    data.set(STORAGE_KEYS.COLLECTION, '{"2":null}');
    expect(persistCollection({})).toBe('recovered');
    expect(collectionRecoveryDismissed()).toBe(false);
  });

  it('keeps the note hidden for this visit only when storage refuses to remember the choice', async () => {
    const data = seed(null, (key) => key === STORAGE_KEYS.COLLECTION_RECOVERY_SEEN);
    data.set(STORAGE_KEYS.COLLECTION_RECOVERY, '{"raw":"x","player":null}');
    expect(dismissCollectionRecovery()).toBe(false);
    expect(collectionRecoveryDismissed()).toBe(true);
    data.set(STORAGE_KEYS.COLLECTION_RECOVERY, '{"raw":"x","player":null,"later":[{"raw":"y","player":null}]}');
    expect(collectionRecoveryDismissed()).toBe(false);
    // The next visit doesn't know about it.
    data.set(STORAGE_KEYS.COLLECTION_RECOVERY, '{"raw":"x","player":null}');
    vi.resetModules();
    expect((await import('./collectionRecovery')).collectionRecoveryDismissed()).toBe(false);
  });

  it('shows the note when storage refuses to read the choice', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new DOMException('denied', 'SecurityError'); } });
    expect(collectionRecoveryDismissed()).toBe(false);
    expect(dismissCollectionRecovery()).toBe(false);
  });
});
