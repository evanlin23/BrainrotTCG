import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_CARDS, type Card } from '../data/cards';
import type { CollectionItem } from '../types';
import { hydrateCard, hydrateCollection, runMigrations } from '../utils/migrations';
import { importSave } from './move';
import { SAVE_STAMP_KEY } from './player';

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
const BACKUP = 'brainrot-before-move-v1';
const PENDING = 'brainrot-before-move-pending-v1';
/** Every copy a move keeps: never more than BACKUP and PENDING. */
const moveCopies = () => [...store.keys()].filter((key) => key.startsWith('brainrot-before-move')).sort();
/** Everything here but the copies. */
const currentSave = () => Object.fromEntries([...store].filter(([key]) => !key.startsWith('brainrot-before-')));
/** A player who has opened `packs` packs. */
const playerAt = (hex: string, packs: number) => JSON.stringify({ ...JSON.parse(player(hex)), nextNonce: packs });
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
      { id: amogus.id, key: amogus.key, isHolo: true, caption: null, name: null, rarity: 'MYTHIC' }, // the registry's fields win
      { id: 'image2', isHolo: null }, // `!!c.isHolo` reads it as no holo
      { id: 'image2', isHolo: false },
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
    ['a holo flag that is a number', '1', [{ id: amogus.id, key: amogus.key, isHolo: 1 }]],
    ['a holo flag of 0', '2', [{ id: 'image2', isHolo: 0 }]],
    ['a holo flag that is text', '2', [{ id: amogus.id, key: amogus.key, isHolo: 'yes' }]],
    ['a holo flag that is a record', '1', [{ id: 'image2', isHolo: {} }]],
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
    ['a recovery archive with a negative let-go count', { 'brainrot-collection-recovery-v1': '{"raw":"opaque","player":null,"dropped":-1}' }],
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

  it.each([['no stamp', {}], ['its own stamp', { [SAVE_STAMP_KEY]: 'old address' }]])(
    'writes a fresh stamp over an earlier import\'s when the moved save has %s', (_name, stamp) => {
      store.set('brainrot-player-v1', player('bb'));
      store.set('brainrot-stats-v1', '{"packsOpened":4}');
      store.set(SAVE_STAMP_KEY, 'earlier import');
      expect(importSave({ ...OLD, ...stamp }, () => true)).toBe('saved');
      expect(store.get(SAVE_STAMP_KEY)).toMatch(/\S/);
      expect(['earlier import', 'old address']).not.toContain(store.get(SAVE_STAMP_KEY));
    });

  it('changes the stamp, first, when a save without a player key comes into a visited browser', () => {
    const visitor = JSON.stringify({ secretKey: 'cc', name: 'Visitor', nextNonce: 0, createdAt: 2 });
    store.set('brainrot-player-v1', visitor);
    const write = vi.spyOn(localStorage, 'setItem');
    expect(importSave({ 'brainrot-found-collection-v1': OLD['brainrot-found-collection-v1'] })).toBe('saved');
    expect(store.get('brainrot-player-v1')).toBe(visitor);
    expect(write.mock.calls[0][0]).toBe(SAVE_STAMP_KEY);
    expect(store.get(SAVE_STAMP_KEY)).toMatch(/\S/);
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

  it('removes the replaced player and stamp before its other keys', () => {
    store.set('brainrot-stats-v1', '{"packsOpened":4}');
    store.set(SAVE_STAMP_KEY, 'earlier import');
    store.set('brainrot-player-v1', player('bb'));
    const removed: string[] = [];
    vi.spyOn(localStorage, 'removeItem').mockImplementation((key) => { removed.push(key); store.delete(key); });
    expect(importSave(OLD, () => true)).toBe('saved');
    expect(removed).toEqual(['brainrot-player-v1', SAVE_STAMP_KEY, 'brainrot-stats-v1']);
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
    if (previousBackup) store.set(BACKUP, '{"previous":"backup"}');
    const original = new Map(store);
    const remove = vi.spyOn(localStorage, 'removeItem');
    const write = vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key.startsWith('brainrot-before-move')) throw new DOMException('Injected backup failure', error);
      store.set(key, value);
    });

    expect(importSave(OLD, () => true)).toBe(result);
    expect(store).toEqual(original);
    expect(remove).not.toHaveBeenCalled();
    // Earlier copies are never written over before the move succeeds.
    expect(write).toHaveBeenCalledExactlyOnceWith(previousBackup ? PENDING : BACKUP, JSON.stringify({
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
    if (previousBackup) store.set(BACKUP, '{"previous":"backup"}');
    store.set('unrelated-key', 'leave alone');
    const original = new Map(store);
    const backups: string[] = [];
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === 'brainrot-found-collection-v1') throw new DOMException('Injected quota failure', 'QuotaExceededError');
      if (key.startsWith('brainrot-before-move')) backups.push(value);
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

  it("never writes over an earlier move's backup when the move fails, even with no room to write it again", () => {
    store.set('brainrot-player-v1', player('bb'));
    store.set('brainrot-stats-v1', '{"packsOpened":4}');
    store.set(BACKUP, '{"previous":"backup"}');
    const original = new Map(store);
    const pending: string[] = [];
    const write = vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === 'brainrot-found-collection-v1' || key === BACKUP) throw new DOMException('Injected quota failure', 'QuotaExceededError');
      if (key === PENDING) pending.push(value);
      store.set(key, value);
    });

    expect(importSave(OLD, () => true)).toBe('full');
    expect(store).toEqual(original);
    expect(write).not.toHaveBeenCalledWith(BACKUP, expect.anything());
    // The copy it took first is the save that is back in place, so dropping it loses nothing.
    expect(pending.map((value) => JSON.parse(value))).toEqual([{ 'brainrot-player-v1': player('bb'), 'brainrot-stats-v1': '{"packsOpened":4}' }]);
  });

  it.each([false, true])("says so when a failed write can't be undone, and keeps the replaced save as a backup (earlier backup: %s)", (previousBackup) => {
    store.set('brainrot-player-v1', player('bb'));
    store.set('brainrot-found-collection-v1', '{"original":{"normalCount":2}}');
    const original = Object.fromEntries(store);
    if (previousBackup) store.set(BACKUP, '{"previous":"backup"}');
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === 'brainrot-found-collection-v1') throw new DOMException('Injected quota failure', 'QuotaExceededError');
      store.set(key, value);
    });

    expect(importSave(OLD, () => true)).toBe('partial');
    // Both copies stay: the save that was here, and an earlier move's.
    expect(JSON.parse(store.get(previousBackup ? PENDING : BACKUP)!)).toEqual(original);
    if (previousBackup) expect(store.get(BACKUP)).toBe('{"previous":"backup"}');
  });

  it('moves a pending copy into place before backing up a later save with progress, never holding more than two', () => {
    store.set('brainrot-player-v1', player('bb'));
    store.set('brainrot-stats-v1', '{"packsOpened":9}'); // played on since the move that left a copy pending
    const here = JSON.stringify(Object.fromEntries(store));
    store.set(BACKUP, '{"copy":1}');
    store.set(PENDING, '{"copy":2}');
    const events: string[] = [];
    let most = moveCopies().length;
    const track = (event: string) => {
      events.push(event);
      most = Math.max(most, moveCopies().length);
    };
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      store.set(key, value);
      if (key.startsWith('brainrot-before-')) track(`${key} = ${value === here ? 'here' : value}`);
    });
    vi.spyOn(localStorage, 'removeItem').mockImplementation((key) => {
      store.delete(key);
      if (key.startsWith('brainrot-before-')) track(`drop ${key}`);
    });

    expect(importSave(OLD, () => true)).toBe('saved');
    expect(events).toEqual([
      `${BACKUP} = {"copy":2}`, `drop ${PENDING}`, // the pending copy takes the oldest one's place
      `${PENDING} = here`, // so this save is backed up too
      `${BACKUP} = here`, `drop ${PENDING}`, // and, once moved, takes the earlier one's place
    ]);
    expect(most).toBe(2);
    expect(moveCopies()).toEqual([BACKUP]);
    expect(store.get('brainrot-player-v1')).toBe(OLD['brainrot-player-v1']);
    expect(store.has('brainrot-stats-v1')).toBe(false);
  });

  it.each([
    { error: 'QuotaExceededError', result: 'full' },
    { error: 'SecurityError', result: 'invalid' },
  ])("changes nothing when a pending copy can't take the earlier one's place first: $error", ({ error, result }) => {
    store.set('brainrot-player-v1', player('bb'));
    store.set('brainrot-stats-v1', '{"packsOpened":9}');
    store.set(BACKUP, '{"copy":1}');
    store.set(PENDING, '{"copy":2}');
    const original = new Map(store);
    const write = vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === BACKUP) throw new DOMException('Injected failure', error);
      store.set(key, value);
    });
    const remove = vi.spyOn(localStorage, 'removeItem');

    expect(importSave(OLD, () => true)).toBe(result);
    // Both copies and the save here stay; the move doesn't go on without a copy of it.
    expect(store).toEqual(original);
    expect(write).toHaveBeenCalledExactlyOnceWith(BACKUP, '{"copy":2}');
    expect(remove).not.toHaveBeenCalled();
  });

  it('drops only the copy it took when the incoming save then fails, keeping the pending one it moved into place', () => {
    store.set('brainrot-player-v1', player('bb'));
    store.set('brainrot-stats-v1', '{"packsOpened":9}');
    const here = new Map(store);
    store.set(BACKUP, '{"copy":1}');
    store.set(PENDING, '{"copy":2}');
    const dropped: string[] = [];
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === 'brainrot-found-collection-v1') throw new DOMException('Injected quota failure', 'QuotaExceededError');
      store.set(key, value);
    });
    vi.spyOn(localStorage, 'removeItem').mockImplementation((key) => {
      if (key.startsWith('brainrot-before-')) dropped.push(key);
      store.delete(key);
    });

    expect(importSave(OLD, () => true)).toBe('full');
    expect(store).toEqual(new Map([...here, [BACKUP, '{"copy":2}']]));
    // Once as the pending copy moved into place, then the copy just taken.
    expect(dropped).toEqual([PENDING, PENDING]);
  });

  it("stops the next move rather than drop a copy when a pending one can't take the earlier one's place", () => {
    store.set('brainrot-player-v1', player('bb'));
    store.set('brainrot-stats-v1', '{"packsOpened":4}');
    store.set(BACKUP, '{"previous":"backup"}');
    const here = Object.fromEntries([...store].filter(([key]) => key !== BACKUP));
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === BACKUP) throw new DOMException('Injected quota failure', 'QuotaExceededError');
      store.set(key, value);
    });

    // Moved, but its copy can't take BACKUP's place, so it stays pending.
    expect(importSave(OLD, () => true)).toBe('saved');
    expect(store.get('brainrot-player-v1')).toBe(OLD['brainrot-player-v1']);
    expect(store.get(BACKUP)).toBe('{"previous":"backup"}');
    expect(JSON.parse(store.get(PENDING)!)).toEqual(here);
    const afterMove = new Map(store);

    // The next move replaces progress too, and with no room to make way for its copy it changes nothing.
    expect(importSave({ ...OLD, 'brainrot-player-v1': player('cc') }, () => true)).toBe('full');
    expect(store).toEqual(afterMove);

    // With room again it backs up the save it replaces, and keeps only that copy once moved.
    vi.restoreAllMocks();
    const moved = Object.fromEntries([...store].filter(([key]) => !key.startsWith('brainrot-before-')));
    expect(importSave({ ...OLD, 'brainrot-player-v1': player('cc') }, () => true)).toBe('saved');
    expect(store.get('brainrot-player-v1')).toBe(player('cc'));
    expect(moveCopies()).toEqual([BACKUP]);
    expect(JSON.parse(store.get(BACKUP)!)).toEqual(moved);
  });

  it('keeps both copies, and the save a partial move left here, when a retry fails again', () => {
    store.set('brainrot-player-v1', player('bb'));
    store.set('brainrot-found-collection-v1', '{"original":{"normalCount":2}}');
    const copy2 = Object.fromEntries(store);
    store.set(BACKUP, '{"previous":"backup"}'); // copy1
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === 'brainrot-found-collection-v1') throw new DOMException('Injected quota failure', 'QuotaExceededError');
      store.set(key, value);
    });
    const saveHere = () => Object.fromEntries([...store].filter(([key]) => !key.startsWith('brainrot-before-')));

    expect(importSave(OLD, () => true)).toBe('partial');
    expect(store.get(BACKUP)).toBe('{"previous":"backup"}');
    expect(JSON.parse(store.get(PENDING)!)).toEqual(copy2);
    const left = saveHere();

    // The retry runs out of room too, and changes nothing: both copies and what the partial move left here stay.
    expect(importSave(OLD, () => true)).toBe('full');
    expect(store.get(BACKUP)).toBe('{"previous":"backup"}');
    expect(JSON.parse(store.get(PENDING)!)).toEqual(copy2);
    expect(saveHere()).toEqual(left);
  });

  it('keeps the whole save from before two partial moves in a row, never a copy of what they left, once a retry works', () => {
    const original = {
      'brainrot-player-v1': player('bb'),
      'brainrot-found-collection-v1': '{"original":{"normalCount":2}}',
      'brainrot-history-v1': '[{"nonce":0}]',
      'brainrot-achievements-v1': '{"first-pack":1}',
      'brainrot-stats-v1': '{"packsOpened":4}',
    };
    for (const [key, value] of Object.entries(original)) store.set(key, value);
    store.set(BACKUP, '{"previous":"backup"}');
    // Each attempt's incoming save runs out of room, and so does putting back one more key.
    const lost = ['brainrot-history-v1', 'brainrot-achievements-v1'];
    let attempt = 0;
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === 'brainrot-found-collection-v1' || key === lost[attempt]) throw new DOMException('Injected quota failure', 'QuotaExceededError');
      store.set(key, value);
    });
    const saveHere = () => Object.fromEntries([...store].filter(([key]) => !key.startsWith('brainrot-before-')));

    for (attempt = 0; attempt < lost.length; attempt++) {
      expect(importSave(OLD, () => true)).toBe('partial');
      expect(saveHere()).not.toHaveProperty(lost[attempt]);
      // The earlier copy and the whole save from before the first partial move, unchanged by the second.
      expect(moveCopies()).toEqual([PENDING, BACKUP]);
      expect(store.get(BACKUP)).toBe('{"previous":"backup"}');
      expect(JSON.parse(store.get(PENDING)!)).toEqual(original);
    }

    vi.restoreAllMocks();
    expect(importSave(OLD, () => true)).toBe('saved');
    expect(store.get('brainrot-player-v1')).toBe(OLD['brainrot-player-v1']);
    expect(moveCopies()).toEqual([BACKUP]);
    expect(JSON.parse(store.get(BACKUP)!)).toEqual(original);
  });

  /**
   * A move that ends 'partial' with `original` here: its player can't be put back, and the incoming
   * collection it wrote can't be taken away. Then the page reloads.
   */
  const partialWithoutPlayer = (original: Record<string, string>) => {
    for (const [key, value] of Object.entries(original)) store.set(key, value);
    store.set(BACKUP, '{"previous":"backup"}');
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === 'brainrot-data-version' || (key === 'brainrot-player-v1' && value !== OLD['brainrot-player-v1'])) {
        throw new DOMException('Injected quota failure', 'QuotaExceededError');
      }
      store.set(key, value);
    });
    vi.spyOn(localStorage, 'removeItem').mockImplementation((key) => {
      if (key === 'brainrot-found-collection-v1') throw new DOMException('Injected failure', 'SecurityError');
      store.delete(key);
    });
    expect(importSave(OLD, () => true)).toBe('partial');
    expect(store.has('brainrot-player-v1')).toBe(false);
    expect(store.get(SAVE_STAMP_KEY)).toBe(original[SAVE_STAMP_KEY]);
    expect(store.get('brainrot-found-collection-v1')).toBe(OLD['brainrot-found-collection-v1']);
    expect(JSON.parse(store.get(PENDING)!)).toEqual(original);
    vi.restoreAllMocks();
  };

  it.each([
    ['with', { [SAVE_STAMP_KEY]: 'earlier import' }],
    ['without', {}],
  ])("keeps the whole copy a partial move left, %s a stamp, when the guest made since its player couldn't be put back has nothing", (_name, stamp) => {
    const original = { ...stamp, 'brainrot-player-v1': player('bb'), 'brainrot-stats-v1': '{"packsOpened":4}' };
    partialWithoutPlayer(original);
    // The reload made a new guest who hasn't opened a pack; the other keys are the copy's or the incoming save's.
    store.set('brainrot-player-v1', playerAt('dd', 0));
    store.set('brainrot-data-version', '3');
    store.set('brainrot-settings-v1', '{"soundEnabled":false}');
    store.set('brainrot-history-v1', '[]');

    expect(importSave(OLD, () => true)).toBe('saved');
    expect(store.get('brainrot-player-v1')).toBe(OLD['brainrot-player-v1']);
    expect(moveCopies()).toEqual([BACKUP]);
    expect(JSON.parse(store.get(BACKUP)!)).toEqual(original);
  });

  it("backs up a pack the guest made since a partial move opened, though the stamp it put back matches the copy", () => {
    partialWithoutPlayer({ [SAVE_STAMP_KEY]: 'earlier import', 'brainrot-player-v1': player('bb'), 'brainrot-stats-v1': '{"packsOpened":4}' });
    // The reload made a new guest, who opens a pack before the retry.
    store.set('brainrot-player-v1', playerAt('dd', 1));
    store.set('brainrot-history-v1', '[{"nonce":0}]');
    store.set('brainrot-stats-v1', '{"packsOpened":5}');
    const here = currentSave();

    // As with any copy pending: the save here is copied, and that copy is the one kept once moved.
    expect(importSave(OLD, () => true)).toBe('saved');
    expect(moveCopies()).toEqual([BACKUP]);
    expect(JSON.parse(store.get(BACKUP)!)).toEqual(here);
  });

  it.each([
    ['with', { [SAVE_STAMP_KEY]: 'earlier import' }],
    ['without', {}],
  ])('backs up packs opened since a partial move put the player back, %s a stamp', (_name, stamp) => {
    const original = {
      ...stamp,
      'brainrot-player-v1': player('bb'),
      'brainrot-found-collection-v1': '{"original":{"normalCount":2}}',
      'brainrot-history-v1': '[{"nonce":2}]',
      'brainrot-stats-v1': '{"packsOpened":3}',
    };
    for (const [key, value] of Object.entries(original)) store.set(key, value);
    store.set(BACKUP, '{"previous":"backup"}');
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === 'brainrot-found-collection-v1') throw new DOMException('Injected quota failure', 'QuotaExceededError');
      store.set(key, value);
    });
    expect(importSave(OLD, () => true)).toBe('partial');
    expect(store.get('brainrot-player-v1')).toBe(player('bb'));
    expect(JSON.parse(store.get(PENDING)!)).toEqual(original);
    vi.restoreAllMocks();

    // The same player, with the same stamp, opens a pack before the retry.
    store.set('brainrot-player-v1', playerAt('bb', 4));
    store.set('brainrot-history-v1', '[{"nonce":2},{"nonce":3}]');
    store.set('brainrot-stats-v1', '{"packsOpened":4}');
    const here = currentSave();

    expect(importSave(OLD, () => true)).toBe('saved');
    expect(moveCopies()).toEqual([BACKUP]);
    expect(JSON.parse(store.get(BACKUP)!)).toEqual(here);
  });

  it.each([
    ['unreadable', '{not json'],
    ['not a copy of a save', JSON.stringify({ 'brainrot-player-v1': JSON.parse(player('bb')), 'brainrot-stats-v1': { packsOpened: 4 } })],
  ])('backs up the save here as usual when the pending copy is %s', (_name, pending) => {
    store.set('brainrot-player-v1', player('bb'));
    store.set('brainrot-stats-v1', '{"packsOpened":4}');
    const here = currentSave();
    store.set(BACKUP, '{"previous":"backup"}');
    store.set(PENDING, pending);

    expect(importSave(OLD, () => true)).toBe('saved');
    expect(moveCopies()).toEqual([BACKUP]);
    expect(JSON.parse(store.get(BACKUP)!)).toEqual(here);
  });

  it.each([
    ['another player', player('cc'), 'moved'],
    ['the same player, brought back by an import', player('bb'), 'imported'],
  ])('still backs up the save here when the pending copy is of an earlier save: %s', (_name, here, stamp) => {
    // A move that worked but couldn't move its copy into place, then play (or an import) since.
    store.set(SAVE_STAMP_KEY, stamp);
    store.set('brainrot-player-v1', here);
    store.set('brainrot-stats-v1', '{"packsOpened":9}');
    const saved = Object.fromEntries(store);
    store.set(BACKUP, '{"previous":"backup"}');
    store.set(PENDING, JSON.stringify({ [SAVE_STAMP_KEY]: 'earlier', 'brainrot-player-v1': player('bb'), 'brainrot-stats-v1': '{"packsOpened":4}' }));

    expect(importSave(OLD, () => true)).toBe('saved');
    expect(moveCopies()).toEqual([BACKUP]);
    expect(JSON.parse(store.get(BACKUP)!)).toEqual(saved);
  });

  it('persists the complete replaced save before any key is removed', () => {
    const original = {
      'brainrot-player-v1': player('bb'),
      'brainrot-stats-v1': '{"packsOpened":4}',
      'brainrot-found-collection-v1': '{"original":{"normalCount":2}}',
      'brainrot-custom-cache': 'retained in backup',
    };
    for (const [key, value] of Object.entries(original)) store.set(key, value);
    store.set(BACKUP, '{"previous":"backup"}');
    store.set('brainrot-before-import-v1', '{"file":"backup"}');
    store.set('unrelated-key', 'leave alone');
    const events: string[] = [];
    vi.spyOn(localStorage, 'setItem').mockImplementation((key, value) => {
      events.push(key.startsWith('brainrot-before-') ? `backup ${key}` : 'incoming');
      store.set(key, value);
    });
    const remove = vi.spyOn(localStorage, 'removeItem').mockImplementation((key) => {
      if (key.startsWith('brainrot-before-')) events.push(`drop ${key}`);
      else {
        // The earlier move's copy is still there too, until the move has succeeded.
        expect(JSON.parse(store.get(PENDING)!)).toEqual(original);
        expect(store.get(BACKUP)).toBe('{"previous":"backup"}');
        events.push('remove');
      }
      store.delete(key);
    });

    expect(importSave({
      ...OLD,
      'brainrot-before-move-v1': 'incoming must not replace backup',
      'brainrot-before-import-v1': 'nor the file import backup',
    }, () => true)).toBe('saved');
    expect(events).toEqual([
      `backup ${PENDING}`,
      ...Object.keys(original).map(() => 'remove'),
      'incoming', // the fresh stamp
      ...Object.keys(OLD).map(() => 'incoming'),
      // Moved, so the new copy takes the earlier one's place in one write.
      `backup ${BACKUP}`, `drop ${PENDING}`,
    ]);
    expect(remove).toHaveBeenCalledTimes(Object.keys(original).length + 1);
    expect(store.get(BACKUP)).toBe(JSON.stringify(original));
    expect(store.has(PENDING)).toBe(false);
    expect(store.get('brainrot-player-v1')).toBe(OLD['brainrot-player-v1']);
    expect(store.get('brainrot-found-collection-v1')).toBe(OLD['brainrot-found-collection-v1']);
    expect(store.get('brainrot-stats-v1')).toBeUndefined();
    expect(store.get('brainrot-before-import-v1')).toBe('{"file":"backup"}');
    expect(store.get('unrelated-key')).toBe('leave alone');
  });
});
