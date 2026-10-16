import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_CARDS, type Card } from '../data/cards';
import type { CollectionItem } from '../types';
import { hydrateCard, hydrateCollection, runMigrations } from '../utils/migrations';
import { importSave } from './move';

/** Just enough of localStorage and window for importSave. */
const store = new Map<string, string>();
const confirm = vi.fn(() => true);
Object.assign(globalThis, {
  localStorage: {
    get length() {
      return store.size;
    },
    key: (i: number) => [...store.keys()][i] ?? null,
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
  window: { confirm, location: { origin: 'https://new.example' } },
});

const player = (hex: string) => JSON.stringify({ secretKey: hex.repeat(32), name: 'Combo Miner', nextNonce: 3, createdAt: 1 });
const amogus = ALL_CARDS.find((c) => c.key === 'genesis/amogus')!;
const OLD = {
  'brainrot-player-v1': player('aa'),
  'brainrot-found-collection-v1': JSON.stringify({ [amogus.key]: { card: { id: amogus.id, key: amogus.key }, normalCount: 1, holoCount: 0 } }),
  'brainrot-settings-v1': '{}',
  'brainrot-data-version': '3',
};

describe('bringing a save over', () => {
  beforeEach(() => {
    store.clear();
    confirm.mockClear();
    confirm.mockReturnValue(true);
  });
  afterEach(() => vi.restoreAllMocks());

  it('takes a save into an empty address without asking', () => {
    expect(importSave(OLD)).toBe('saved');
    expect(store.get('brainrot-player-v1')).toBe(OLD['brainrot-player-v1']);
    expect(store.get('brainrot-found-collection-v1')).toBe(OLD['brainrot-found-collection-v1']);
    expect(store.get('brainrot-data-version')).toBe('3');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('takes an old save from before player keys', () => {
    expect(importSave({ 'brainrot-found-collection-v1': '{}', 'brainrot-stats-v1': '{}' })).toBe('saved');
    expect(store.has('brainrot-stats-v1')).toBe(true);
  });

  it('moves a save from before data versions with legacy card IDs, which migrations then upgrade', () => {
    store.set('brainrot-data-version', '3'); // this browser only visited
    expect(importSave({
      'brainrot-found-collection-v1': JSON.stringify({ image2: { card: { id: 'image2' }, count: 2 } }),
      'brainrot-stats-v1': '{"packsOpened":2,"holoCards":{}}',
      'brainrot-achievements-v1': '{"first_pack":1}',
    })).toBe('saved');
    // This browser's version must not stand in for the older save's, or its migrations never run.
    expect(store.get('brainrot-data-version')).toBe('1');
    runMigrations();
    const hydrated = hydrateCollection(JSON.parse(store.get('brainrot-found-collection-v1')!) as Record<string, CollectionItem>);
    expect(hydrated[amogus.key].card.id).toBe(amogus.id);
    expect(hydrated[amogus.key].normalCount).toBe(2);
  });

  it('moves a first-format save with entries migrations rebuild: no card, not a record, holo flags that are not booleans', () => {
    expect(importSave({
      'brainrot-found-collection-v1': JSON.stringify({ image2: { count: 2 }, odd: 'lost' }),
      'brainrot-stats-v1': '{"packsOpened":2,"holoCards":{"image2":1}}',
    })).toBe('saved');
    runMigrations();
    const collection = JSON.parse(store.get('brainrot-found-collection-v1')!) as Record<string, unknown>;
    expect(hydrateCollection(collection as Record<string, CollectionItem>)[amogus.key].normalCount).toBe(2);
    expect(collection.odd).toBe('lost');
    expect(JSON.parse(store.get('brainrot-stats-v1')!).holoCards).toEqual({ [amogus.key]: true });
  });

  it.each(['1', '2'])('moves version %s best-pack cards its migrations and profile read, however loosely stored', (version) => {
    const best = [
      { id: amogus.id, key: amogus.key, isHolo: 1, caption: null, name: null, rarity: 'MYTHIC' }, // the registry's fields win
      { id: 'image2', isHolo: null },
      ...(version === '1' ? [{ id: 5, key: amogus.key }] : []), // migrateV2 stores the id as text
    ];
    const stats = JSON.stringify({ packsOpened: 1, holoCards: {}, highestPackCards: best });
    expect(importSave({ 'brainrot-stats-v1': stats, 'brainrot-data-version': version })).toBe('saved');
    expect(store.get('brainrot-stats-v1')).toBe(stats);
    runMigrations();
    const moved = JSON.parse(store.get('brainrot-stats-v1')!) as { highestPackCards: Card[]; highestPackFlexValue: number };
    // Every one is amogus ('image2' is its first-format id), as the profile shows it.
    expect(moved.highestPackCards.map((c) => hydrateCard(c).name)).toEqual(best.map(() => amogus.name));
    expect(moved.highestPackFlexValue).toBeGreaterThan(0);
  });

  it.each([
    ['an empty slot', '1', [null]],
    ['a card no registry knows, without its own fields', '2', [{ id: 'nope-nope' }]],
    ['a finish that does not exist', '2', [{ id: amogus.id, key: amogus.key, finish: 'bogus' }]],
    ['a revealed flag that is not a boolean', '1', [{ id: amogus.id, key: amogus.key, isRevealed: null }]],
    ['a key that is not text', '1', [{ id: 'image2', key: 5 }]],
    ['a numeric id after version 1', '2', [{ id: 5, key: amogus.key }]],
    ['a holo flag that is not a boolean at version 3', '3', [{ id: amogus.id, key: amogus.key, isHolo: 1 }]],
  ])('still refuses best-pack cards with %s (version %s)', (_name, version, best) => {
    expect(importSave({ 'brainrot-stats-v1': JSON.stringify({ highestPackCards: best }), 'brainrot-data-version': version })).toBe('invalid');
    expect(importSave({ 'brainrot-stats-v1': JSON.stringify({ highestPackCards: {} }), 'brainrot-data-version': version })).toBe('invalid');
    expect(store.size).toBe(0);
  });

  it("moves collection entries the old address keeps but can't show, so recovery there still has them here", () => {
    const collection = JSON.stringify({
      [amogus.key]: { card: { id: amogus.id, key: amogus.key }, normalCount: 1, holoCount: null }, // a count migrations couldn't read
      'genesis/x': 'lost',
      'genesis/x#unreadable': { normal: 1 },
    });
    expect(importSave({ ...OLD, 'brainrot-found-collection-v1': collection })).toBe('saved');
    expect(store.get('brainrot-found-collection-v1')).toBe(collection);
  });

  it.each([
    ['a player key that is not hex', { 'brainrot-player-v1': player('zz') }],
    ['a negative pack counter', { 'brainrot-player-v1': JSON.stringify({ secretKey: 'aa'.repeat(32), name: 'Combo Miner', nextNonce: -1, createdAt: 1 }) }],
    ['an unreadable player', { 'brainrot-player-v1': '{not json' }],
    ['a collection that is a list', { 'brainrot-found-collection-v1': '[]' }],
    ['a readable card with a text count', { 'brainrot-found-collection-v1': JSON.stringify({ [amogus.key]: { card: { id: amogus.id, key: amogus.key }, normalCount: 'lots' } }) }],
    ['a pack count that is text', { 'brainrot-stats-v1': '{"packsOpened":"lots"}' }],
    ['history that is not a list', { 'brainrot-history-v1': '{}' }],
    ['a settings switch that is text', { 'brainrot-settings-v1': '{"soundEnabled":"yes"}' }],
    ['unreadable achievements', { 'brainrot-achievements-v1': '{not json' }],
    ['a newer data version', { 'brainrot-data-version': '4' }],
    ['a data version that is not a number', { 'brainrot-data-version': 'three' }],
  ])('refuses %s before asking or writing anything', (_name, bad) => {
    store.set('brainrot-player-v1', player('bb'));
    store.set('brainrot-stats-v1', '{"packsOpened":4}');
    const original = new Map(store);
    expect(importSave({ ...OLD, ...bad })).toBe('invalid');
    expect(store).toEqual(original);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('ignores anything that is not a save', () => {
    expect(importSave(null)).toBe('invalid');
    expect(importSave('brainrot')).toBe('invalid');
    expect(importSave({ 'brainrot-settings-v1': '{}' })).toBe('invalid'); // no progress in it
    expect(importSave({ 'brainrot-player-v1': 5, other: 'x' })).toBe('invalid');
    expect(store.size).toBe(0);
  });

  it('only writes brainrot keys with string values', () => {
    importSave({ ...OLD, 'unrelated-key': 'x', 'brainrot-stats-v1': 7 });
    expect(store.has('unrelated-key')).toBe(false);
    expect(store.has('brainrot-stats-v1')).toBe(false);
  });

  it('does nothing when the same player is already here', () => {
    store.set('brainrot-player-v1', player('aa'));
    store.set('brainrot-found-collection-v1', '{"newer":{"normal":9}}');
    expect(importSave(OLD)).toBe('same');
    expect(store.get('brainrot-found-collection-v1')).toBe('{"newer":{"normal":9}}');
    expect(confirm).not.toHaveBeenCalled();
  });

  it('asks before replacing a different save, and keeps it as a backup', () => {
    store.set('brainrot-player-v1', player('bb'));
    store.set('brainrot-stats-v1', '{"packsOpened":4}');
    confirm.mockReturnValue(false);
    expect(importSave(OLD)).toBe('kept');
    expect(store.get('brainrot-player-v1')).toBe(player('bb'));

    confirm.mockReturnValue(true);
    expect(importSave(OLD)).toBe('saved');
    expect(store.get('brainrot-player-v1')).toBe(player('aa'));
    expect(store.has('brainrot-stats-v1')).toBe(false); // nothing of the old save mixed in
    const backup = JSON.parse(store.get('brainrot-before-move-v1')!) as Record<string, string>;
    expect(backup['brainrot-player-v1']).toBe(player('bb'));
    expect(backup['brainrot-stats-v1']).toBe('{"packsOpened":4}');
  });

  it("doesn't ask when this browser only visited (a player key with no packs)", () => {
    store.set('brainrot-player-v1', JSON.stringify({ secretKey: 'cc', name: 'Visitor', nextNonce: 0, createdAt: 2 }));
    store.set('brainrot-stats-v1', '{"packsOpened":0,"holoCards":{}}');
    store.set('brainrot-achievements-v1', '{}');
    expect(importSave(OLD)).toBe('saved');
    expect(store.get('brainrot-player-v1')).toBe(player('aa'));
    expect(confirm).not.toHaveBeenCalled();
  });

  it('lets the caller decide instead of asking (Settings asks in the page)', () => {
    store.set('brainrot-player-v1', player('bb'));
    expect(importSave(OLD, () => false)).toBe('kept');
    expect(store.get('brainrot-player-v1')).toBe(player('bb'));
    expect(importSave(OLD, () => true)).toBe('saved');
    expect(store.get('brainrot-player-v1')).toBe(player('aa'));
    expect(confirm).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'quota exhausted, no previous backup', error: 'QuotaExceededError', previousBackup: false, result: 'full' },
    { name: 'quota exhausted, previous backup', error: 'QuotaExceededError', previousBackup: true, result: 'full' },
    { name: 'storage denied, no previous backup', error: 'SecurityError', previousBackup: false, result: 'invalid' },
    { name: 'storage denied, previous backup', error: 'SecurityError', previousBackup: true, result: 'invalid' },
  ])('keeps all current data when backing up fails: $name', ({ error, previousBackup, result }) => {
    store.set('brainrot-player-v1', player('bb'));
    store.set('brainrot-stats-v1', '{"packsOpened":4}');
    store.set('brainrot-found-collection-v1', '{"original":{"normalCount":2}}');
    store.set('unrelated-key', 'leave alone');
    if (previousBackup) store.set('brainrot-before-move-v1', '{"previous":"backup"}');
    const original = new Map(store);
    const remove = vi.spyOn(localStorage, 'removeItem');
    const write = vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === 'brainrot-before-move-v1') throw new DOMException('Injected backup failure', error);
      store.set(key, value);
    });

    expect(importSave(OLD, () => true)).toBe(result);
    expect(store).toEqual(original);
    expect(remove).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledExactlyOnceWith('brainrot-before-move-v1', JSON.stringify({
      'brainrot-player-v1': original.get('brainrot-player-v1'),
      'brainrot-stats-v1': original.get('brainrot-stats-v1'),
      'brainrot-found-collection-v1': original.get('brainrot-found-collection-v1'),
    }));
  });

  it.each([
    { name: 'replacing a save', progress: true, previousBackup: false },
    { name: 'replacing a save, after an earlier move', progress: true, previousBackup: true },
    { name: 'into a visited browser', progress: false, previousBackup: false },
    { name: 'into a visited browser, after an earlier move', progress: false, previousBackup: true },
  ])('reports full and puts back what was here when the incoming save runs out of space: $name', ({ progress, previousBackup }) => {
    store.set('brainrot-player-v1', progress ? player('bb') : JSON.stringify({ secretKey: 'cc', name: 'Visitor', nextNonce: 0, createdAt: 2 }));
    store.set('brainrot-settings-v1', '{"musicVolume":0.2}');
    if (progress) store.set('brainrot-stats-v1', '{"packsOpened":4}');
    if (previousBackup) store.set('brainrot-before-move-v1', '{"previous":"backup"}');
    store.set('unrelated-key', 'leave alone');
    const original = new Map(store);
    const backups: string[] = [];
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === 'brainrot-found-collection-v1') throw new DOMException('Injected quota failure', 'QuotaExceededError');
      if (key === 'brainrot-before-move-v1') backups.push(value);
      store.set(key, value);
    });

    expect(importSave(OLD, () => true)).toBe('full');
    // Nothing changed, an earlier move's backup included.
    expect(store).toEqual(original);
    // Replacing progress first copied the save that was here (what a failed restore would leave).
    if (progress) {
      expect(JSON.parse(backups[0])).toEqual(Object.fromEntries([...original].filter(([key]) => key.startsWith('brainrot-') && key !== 'brainrot-before-move-v1')));
    } else expect(backups).toEqual([]);
  });

  it('reports invalid, not full, when storage refuses the incoming save for another reason', () => {
    store.set('brainrot-player-v1', player('bb'));
    store.set('brainrot-stats-v1', '{"packsOpened":4}');
    store.set('brainrot-before-move-v1', '{"previous":"backup"}');
    const original = new Map(store);
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === 'brainrot-found-collection-v1') throw new DOMException('Injected denial', 'SecurityError');
      store.set(key, value);
    });

    expect(importSave(OLD, () => true)).toBe('invalid');
    expect(store).toEqual(original);
  });

  it('keeps the copy it just took when the earlier backup cannot be put back', () => {
    store.set('brainrot-player-v1', player('bb'));
    store.set('brainrot-stats-v1', '{"packsOpened":4}');
    store.set('brainrot-before-move-v1', '{"previous":"backup"}');
    const here = { 'brainrot-player-v1': player('bb'), 'brainrot-stats-v1': '{"packsOpened":4}' };
    let backupWrites = 0;
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === 'brainrot-found-collection-v1') throw new DOMException('Injected quota failure', 'QuotaExceededError');
      if (key === 'brainrot-before-move-v1' && ++backupWrites > 1) throw new DOMException('Injected quota failure', 'QuotaExceededError');
      store.set(key, value);
    });

    expect(importSave(OLD, () => true)).toBe('full');
    expect(store.get('brainrot-player-v1')).toBe(here['brainrot-player-v1']);
    expect(store.get('brainrot-stats-v1')).toBe(here['brainrot-stats-v1']);
    expect(JSON.parse(store.get('brainrot-before-move-v1')!)).toEqual(here);
  });

  it("says so when a failed write can't be undone, and keeps the replaced save as a backup", () => {
    store.set('brainrot-player-v1', player('bb'));
    store.set('brainrot-found-collection-v1', '{"original":{"normalCount":2}}');
    const original = Object.fromEntries(store);
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === 'brainrot-found-collection-v1') throw new DOMException('Injected quota failure', 'QuotaExceededError');
      store.set(key, value);
    });

    expect(importSave(OLD, () => true)).toBe('partial');
    expect(JSON.parse(store.get('brainrot-before-move-v1')!)).toEqual(original);
  });

  it('persists the complete replaced save before any key is removed', () => {
    const original = {
      'brainrot-player-v1': player('bb'),
      'brainrot-stats-v1': '{"packsOpened":4}',
      'brainrot-found-collection-v1': '{"original":{"normalCount":2}}',
      'brainrot-custom-cache': 'retained in backup',
    };
    for (const [key, value] of Object.entries(original)) store.set(key, value);
    store.set('brainrot-before-move-v1', '{"previous":"backup"}');
    store.set('brainrot-before-import-v1', '{"file":"backup"}');
    store.set('unrelated-key', 'leave alone');
    const events: string[] = [];
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      events.push(key === 'brainrot-before-move-v1' ? 'backup' : 'incoming');
      store.set(key, value);
    });
    const remove = vi.spyOn(localStorage, 'removeItem').mockImplementation((key) => {
      expect(JSON.parse(store.get('brainrot-before-move-v1')!)).toEqual(original);
      events.push('remove');
      store.delete(key);
    });

    expect(importSave({
      ...OLD,
      'brainrot-before-move-v1': 'incoming must not replace backup',
      'brainrot-before-import-v1': 'nor the file import backup',
    }, () => true)).toBe('saved');
    expect(events).toEqual(['backup', ...Object.keys(original).map(() => 'remove'), ...Object.keys(OLD).map(() => 'incoming')]);
    expect(remove).toHaveBeenCalledTimes(Object.keys(original).length);
    expect(store.get('brainrot-before-move-v1')).toBe(JSON.stringify(original));
    expect(store.get('brainrot-player-v1')).toBe(OLD['brainrot-player-v1']);
    expect(store.get('brainrot-found-collection-v1')).toBe(OLD['brainrot-found-collection-v1']);
    expect(store.get('brainrot-stats-v1')).toBeUndefined();
    expect(store.get('brainrot-before-import-v1')).toBe('{"file":"backup"}');
    expect(store.get('unrelated-key')).toBe('leave alone');
  });
});
