import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../constants';
import { ALL_CARDS } from '../data/cards';
import { hydrateCollection } from '../utils/migrations';
import { hasCollectionRecovery, persistCollection } from './collectionRecovery';

const card = ALL_CARDS[0];
const item = { card, normalCount: 1, holoCount: 0 };
const seed = (raw: string | null, fail?: (key: string) => boolean) => {
  const data = new Map<string, string>();
  if (raw !== null) data.set(STORAGE_KEYS.COLLECTION, raw);
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (fail?.(key)) throw new DOMException('full', 'QuotaExceededError');
      data.set(key, value);
    },
  });
  return data;
};
let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => { errors = vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const logged = () => errors.mock.calls.map((call: unknown[]) => String(call[0]));

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

  it('rejects the collection write when archiving fails; original raw bytes survive', () => {
    const raw = '{"damaged":null}';
    const data = seed(raw, (key) => key === STORAGE_KEYS.COLLECTION_RECOVERY);
    expect(persistCollection({ [card.key]: item })).toBe('blocked');
    expect(data.get(STORAGE_KEYS.COLLECTION)).toBe(raw);
    expect(data.has(STORAGE_KEYS.COLLECTION_RECOVERY)).toBe(false);
    expect(logged()).toEqual([`Failed to save to localStorage key "${STORAGE_KEYS.COLLECTION_RECOVERY}":`]);
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

  it.each(['{broken', '[]', '{"raw":"x","later":"y"}'])('never overwrites an archive it cannot read: %s', (originalArchive) => {
    const raw = '{"second":null}';
    const data = seed(raw);
    data.set(STORAGE_KEYS.COLLECTION_RECOVERY, originalArchive);
    expect(persistCollection({})).toBe('blocked');
    expect(data.get(STORAGE_KEYS.COLLECTION)).toBe(raw);
    expect(data.get(STORAGE_KEYS.COLLECTION_RECOVERY)).toBe(originalArchive);
    expect(logged()).toHaveLength(1);
  });

  it('does not write anything if the persisted collection cannot be read', () => {
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { getItem: () => { throw new DOMException('denied', 'SecurityError'); }, setItem });
    expect(persistCollection({})).toBe('blocked');
    expect(setItem).not.toHaveBeenCalled();
    expect(hasCollectionRecovery()).toBe(false);
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
