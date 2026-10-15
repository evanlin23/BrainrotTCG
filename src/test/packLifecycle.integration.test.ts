// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://mounted.invalid/BrainrotTCG/"}
import { afterEach, expect, it, vi } from 'vitest';
import { mountedApp } from './mountedApp';
import { STORAGE_KEYS } from '../constants/config';
import type { CollectionItem, Stats } from '../types';
import { getSet } from '../content/sets';
import { encodeCard } from '../game/cardCode';

let app: Awaited<ReturnType<typeof mountedApp>> | undefined;
afterEach(async () => { await app?.dispose(); app = undefined; });

const read = <T,>(key: string): T => JSON.parse(localStorage.getItem(key) ?? 'null');
type Shelved = { n: number; d?: number }[] | null;
/** Packs on the pending shelf (the list key; older builds' one-pack key is checked separately). */
const shelf = () => read<Shelved>(STORAGE_KEYS.PENDING_PACKS);
/** The pack in older builds' one-pack entry. */
const legacyEntry = () => read<{ n: number; d?: number } | null>(STORAGE_KEYS.PENDING_PACK);
const expectShelvesEmpty = () => {
  expect(localStorage.getItem(STORAGE_KEYS.PENDING_PACKS)).toBeNull();
  expect(localStorage.getItem(STORAGE_KEYS.PENDING_PACK)).toBeNull();
};
const button = (label: string) => {
  const element = [...document.querySelectorAll<HTMLElement>('button, [role="button"]')]
    .find((el) => (el.getAttribute('aria-label') ?? el.textContent?.trim()) === label);
  expect(element, `button ${label}`).toBeDefined();
  return element!;
};
const snapshot = () => Object.fromEntries([STORAGE_KEYS.COLLECTION, STORAGE_KEYS.STATS, STORAGE_KEYS.HISTORY,
  STORAGE_KEYS.PENDING_PACKS, STORAGE_KEYS.PENDING_PACK, 'brainrot-player-v1'].map((key) => [key, localStorage.getItem(key)]));

it('records and awards one real pack, preserving exact cards/modifiers and keeping the save byte-identical after reconstructed reload', async () => {
  app = await mountedApp({
    // Same disposable seed as #304; never import a developer's save. Only identity/preferences are seeded.
    'brainrot-player-v1': JSON.stringify({ secretKey: '01'.repeat(32), name: 'Mounted fixture', nextNonce: 0, createdAt: 1 }),
    [STORAGE_KEYS.SETTINGS]: JSON.stringify({ musicVolume: 0, effectsVolume: 0, particlesEnabled: false, pauseBigPulls: false }),
    // Pin the set the golden values below come from, so a new release (DEFAULT_SET_ID) cannot change them.
    [STORAGE_KEYS.SELECTED_SET]: 'right-now',
  });
  await app.mount();
  await app.interact(() => {
    const shell = document.querySelector<HTMLElement>('[aria-label^="Open a "]')!;
    expect(shell).not.toBeNull();
    shell.focus();
    shell.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    shell.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
  });
  await app.until('real ticket produces a reveal with Skip', () => expect(document.querySelector('.reveal-skip')).not.toBeNull());
  await app.interact(() => button('Skip opening animation').click());
  await app.until('Skip completes the production summary', () => expect(document.querySelectorAll('.summary-card')).toHaveLength(5));

  const stats = read<Stats>(STORAGE_KEYS.STATS);
  expect(stats.packsOpened).toBe(1);
  expect(stats.highestPackHandName).toBe('Pair');
  expect(stats.highestPackFlexValue).toBe(1020);
  expect(stats.highestPackRef).toEqual({
    setId: 'right-now', setVersion: 2, nonce: 0,
    publicKeyHex: '8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c',
  });
  const { encodeCard } = await import('../game/cardCode');
  const codes = stats.highestPackCards!.map((c) => encodeCard({ id: c.id, holo: c.isHolo, finish: c.finish, misprint: c.misprint }));
  expect(codes).toEqual(['bukangi', 'niu-laiG', 'bukangi', 'la-peace', 'verity']);
  expect(read<{ nextNonce: number }>('brainrot-player-v1').nextNonce).toBe(1);
  expectShelvesEmpty();
  const { getHistory } = await import('../game/history');
  expect(getHistory()).toHaveLength(1);
  expect(getHistory()[0]).toMatchObject({ setId: 'right-now', setVersion: 2, nonce: 0,
    key: stats.highestPackRef!.publicKeyHex!.slice(0, 16), hand: stats.highestPackHandName, score: stats.highestPackFlexValue });
  expect(getHistory()[0].cards!.map(encodeCard)).toEqual(codes);

  const expected: Record<string, CollectionItem> = {};
  const { cardPoints } = await import('../engine/scoring');
  for (const card of stats.highestPackCards!) {
    const item = expected[card.key] ??= {
      card: { key: card.key, setId: card.setId, id: card.id, name: card.name, rarity: card.rarity, image: card.image },
      normalCount: 0, holoCount: 0,
    };
    if (card.isHolo) item.holoCount++; else item.normalCount++;
    if (card.finish) {
      item.finishes ??= {};
      item.finishes[card.finish] = (item.finishes[card.finish] ?? 0) + 1;
    }
    if (card.misprint) item.misprints = (item.misprints ?? 0) + 1;
    const extra = cardPoints(card.rarity, card.isHolo, card.finish, card.misprint) - cardPoints(card.rarity, card.isHolo);
    if (extra) item.modifierPoints = (item.modifierPoints ?? 0) + extra;
  }
  expect(read(STORAGE_KEYS.COLLECTION)).toEqual(expected);
  expect([...document.querySelectorAll('.summary-card')].map((el) => el.getAttribute('aria-label'))).toEqual([
    'Bukangi, Common, new', 'Bukangi, Common', 'La Peace, Uncommon, new',
    'Verity, Epic, new', 'Niu Lai, Common, Gold, new',
  ]);

  const before = snapshot();
  await app.reload();
  await app.interact(() => button('My cards').click());
  await app.until('personal destination opens', () => expect(button('Best pulls')).toBeDefined());
  await app.interact(() => button('Best pulls').click());
  await app.until('new App graph hydrates the recorded profile', () => {
    expect(document.querySelector('.pulls-history-title')?.textContent).toBe('All packs · 1');
    const images = [...document.querySelectorAll<HTMLImageElement>('.pulls-history .pull-row-thumbs img')];
    expect(images.map((image) => new URL(image.src).pathname.split('/').pop())).toEqual([
      'bukangi.webp', 'niu-lai.webp', 'bukangi.webp', 'la-peace.webp', 'verity.webp',
    ]);
    expect(images.map((image) => image.className.trim())).toEqual(['', 'finish-gold', '', '', '']);
  });
  expect(snapshot()).toEqual(before);
}, 30_000);

const SEED = {
  'brainrot-player-v1': JSON.stringify({ secretKey: '01'.repeat(32), name: 'Mounted fixture', nextNonce: 0, createdAt: 1 }),
  [STORAGE_KEYS.SETTINGS]: JSON.stringify({ musicVolume: 0, effectsVolume: 0, particlesEnabled: false, pauseBigPulls: false }),
  [STORAGE_KEYS.SELECTED_SET]: 'right-now',
};
const packsOpened = (packs: number) => JSON.stringify({ packsOpened: packs, holoCards: {}, highestPackValue: 0, highestPackCards: [] });
/** Storage too full for the collection (or the given keys); everything else still fits. */
const fillStorage = (keys: string[] = [STORAGE_KEYS.COLLECTION]) => {
  const setItem = Storage.prototype.setItem;
  return vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
    if (keys.includes(key)) throw new DOMException('Full', 'QuotaExceededError');
    setItem.call(this, key, value);
  });
};
const openOnePack = async () => {
  await app!.until('the pack shell is ready', () => expect(document.querySelector('[aria-label^="Open a "]')).not.toBeNull());
  await app!.interact(() => {
    const shell = document.querySelector<HTMLElement>('[aria-label^="Open a "]')!;
    shell.focus();
    shell.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    shell.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
  });
  await app!.until('real ticket produces a reveal with Skip', () => expect(document.querySelector('.reveal-skip')).not.toBeNull());
  await app!.interact(() => button('Skip opening animation').click());
  await app!.until('Skip completes the production summary', () => expect(document.querySelectorAll('.summary-card')).toHaveLength(5));
};
const storedCards = () => Object.values(read<Record<string, CollectionItem>>(STORAGE_KEYS.COLLECTION) ?? {})
  .reduce((sum, item) => sum + item.normalCount + item.holoCount, 0);

it('keeps an opened pack on the pending shelf until a collection holding it is stored, counting it once', async () => {
  app = await mountedApp({ ...SEED, [STORAGE_KEYS.STATS]: packsOpened(8) });
  await app.mount();
  const full = fillStorage();
  await app.until('the pack shell is ready', () => expect(document.querySelector('[aria-label^="Open a "]')).not.toBeNull());
  await app.interact(() => {
    const shell = document.querySelector<HTMLElement>('[aria-label^="Open a "]')!;
    shell.focus();
    shell.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    shell.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
  });
  await app.until('real ticket produces a reveal with Skip', () => expect(document.querySelector('.reveal-skip')).not.toBeNull());
  await app.interact(() => button('Skip opening animation').click());
  await app.until('Skip completes the production summary', () => expect(document.querySelectorAll('.summary-card')).toHaveLength(5));

  // The collection couldn't take the pack, so the pack still waits for the next load.
  expect(localStorage.getItem(STORAGE_KEYS.COLLECTION)).toBeNull();
  expect(shelf()?.map((p) => p.n)).toEqual([0]);
  expect(localStorage.getItem(STORAGE_KEYS.PENDING_PACK)).toBeNull();
  expect(app.takeErrors(/^Failed to save to localStorage key /)).toEqual([expect.stringContaining(`"${STORAGE_KEYS.COLLECTION}"`)]);
  expect(read<Stats>(STORAGE_KEYS.STATS).packsOpened).toBe(9);

  // Each load while the collection still can't be stored hands the pack back without counting it again.
  for (let load = 0; load < 3; load++) {
    await app.reload();
    expect(shelf()?.map((p) => p.n)).toEqual([0]);
  }
  expect(app.takeErrors(/^Failed to save to localStorage key /)).toHaveLength(3);
  expect(localStorage.getItem(STORAGE_KEYS.COLLECTION)).toBeNull();
  expect(read<Stats>(STORAGE_KEYS.STATS).packsOpened).toBe(9);
  expect(read<Record<string, unknown>>(STORAGE_KEYS.ACHIEVEMENTS)).not.toHaveProperty('packs_10');

  full.mockRestore();
  await app.reload();
  await app.until('the waiting pack reaches the stored collection', () => expect(localStorage.getItem(STORAGE_KEYS.COLLECTION)).not.toBeNull());
  expect(storedCards()).toBe(5);
  expectShelvesEmpty();
  await app.reload();
  expect(storedCards()).toBe(5);
  expect(read<Stats>(STORAGE_KEYS.STATS).packsOpened).toBe(9);
  expect(read<Record<string, unknown>>(STORAGE_KEYS.ACHIEVEMENTS)).not.toHaveProperty('packs_10');
}, 60_000);

it('counts a pack left on the shelf in the old format once, however many loads it waits', async () => {
  const set = getSet('right-now', 2)!;
  const cards = set.cards.slice(0, 5).map((c) => encodeCard({ id: c.id, holo: false })).join(',');
  app = await mountedApp({
    ...SEED,
    [STORAGE_KEYS.STATS]: packsOpened(9),
    [STORAGE_KEYS.PENDING_PACK]: JSON.stringify({ s: set.id, v: set.version, n: 4, c: cards, t: 1 }),
  });
  const full = fillStorage();
  await app.mount();
  for (let load = 0; load < 2; load++) await app.reload();
  expect(app.takeErrors(/^Failed to save to localStorage key /)).toHaveLength(3);
  expect(read<Stats>(STORAGE_KEYS.STATS).packsOpened).toBe(10);
  expect(read<Record<string, unknown>>(STORAGE_KEYS.ACHIEVEMENTS)).toHaveProperty('packs_10');
  // The pack still waits in the older build's entry (where an older tab's clear reaches it), marked counted.
  expect(legacyEntry()).toEqual(expect.objectContaining({ n: 4, d: 1 }));
  expect(shelf()).toBeNull();

  full.mockRestore();
  await app.reload();
  await app.reload();
  expect(storedCards()).toBe(5);
  expectShelvesEmpty();
  expect(read<Stats>(STORAGE_KEYS.STATS).packsOpened).toBe(10);
}, 60_000);

it('keeps a pack still owed when another opens, and adds each once', async () => {
  const set = getSet('right-now', 2)!;
  const cards = set.cards.slice(0, 5).map((c) => encodeCard({ id: c.id, holo: false })).join(',');
  app = await mountedApp({
    ...SEED,
    [STORAGE_KEYS.STATS]: packsOpened(8),
    [STORAGE_KEYS.PENDING_PACK]: JSON.stringify({ s: set.id, v: set.version, n: 4, c: cards, t: 1 }),
  });
  const full = fillStorage();
  await app.mount();
  await openOnePack();

  // The owed pack and the new one both wait, each counted once: the older build's in its own entry.
  expect(legacyEntry()).toEqual(expect.objectContaining({ n: 4, d: 1 }));
  expect(shelf()).toEqual([expect.objectContaining({ n: 0, d: 1 })]);
  expect(read<Stats>(STORAGE_KEYS.STATS).packsOpened).toBe(10);
  expect(app.takeErrors(/^Failed to save to localStorage key /)).toHaveLength(2);

  full.mockRestore();
  await app.reload();
  await app.until('both waiting packs reach the stored collection', () => expect(storedCards()).toBe(10));
  expectShelvesEmpty();
  await app.reload();
  expect(storedCards()).toBe(10);
  expect(read<Stats>(STORAGE_KEYS.STATS).packsOpened).toBe(10);
}, 60_000);

it('counts a pack on the next load when the stats counting it could not be stored', async () => {
  app = await mountedApp({ ...SEED, [STORAGE_KEYS.STATS]: packsOpened(8) });
  await app.mount();
  const full = fillStorage([STORAGE_KEYS.COLLECTION, STORAGE_KEYS.STATS]);
  await openOnePack();

  // Neither its cards nor its count are stored, so the shelf says it still has to count.
  expect(shelf()).toEqual([expect.objectContaining({ n: 0 })]);
  expect(shelf()![0]).not.toHaveProperty('d');
  expect(localStorage.getItem(STORAGE_KEYS.PENDING_PACK)).toBeNull();
  expect(read<Stats>(STORAGE_KEYS.STATS).packsOpened).toBe(8);
  expect(app.takeErrors(/^Failed to save to localStorage key /)).toEqual([
    expect.stringContaining(`"${STORAGE_KEYS.COLLECTION}"`), expect.stringContaining(`"${STORAGE_KEYS.STATS}"`),
  ]);

  full.mockRestore();
  await app.reload();
  await app.until('the waiting pack reaches the stored collection', () => expect(storedCards()).toBe(5));
  expect(read<Stats>(STORAGE_KEYS.STATS).packsOpened).toBe(9);
  expectShelvesEmpty();
  await app.reload();
  expect(read<Stats>(STORAGE_KEYS.STATS).packsOpened).toBe(9);
}, 60_000);

it('keeps a pack taken off the shelf in this tab, and says so, when neither the collection nor the shelf can take it', async () => {
  const set = getSet('right-now', 2)!;
  const cards = set.cards.slice(0, 5).map((c) => encodeCard({ id: c.id, holo: false })).join(',');
  app = await mountedApp({
    ...SEED,
    [STORAGE_KEYS.STATS]: packsOpened(8),
    [STORAGE_KEYS.PENDING_PACKS]: JSON.stringify([{ s: set.id, v: set.version, n: 4, c: cards, t: 1 }]),
  });
  // Storage is near full: the shelf can be emptied, but nothing can be put back on it.
  const full = fillStorage([STORAGE_KEYS.COLLECTION, STORAGE_KEYS.PENDING_PACKS]);
  await app.mount();
  await app.until('the blocked collection reports the pack it could not shelve', () =>
    expect(app!.takeErrors(/couldn't be put back on the pending shelf/)).toHaveLength(1));
  expect(app.takeErrors(/^Failed to save to localStorage key /)).toEqual([expect.stringContaining(`"${STORAGE_KEYS.COLLECTION}"`)]);
  expect(shelf()).toBeNull();
  expect(read<Stats>(STORAGE_KEYS.STATS).packsOpened).toBe(8);

  // Space frees up: the next collection write stores it with the new pack, each counted once.
  full.mockRestore();
  await openOnePack();
  expect(storedCards()).toBe(10);
  expect(read<Stats>(STORAGE_KEYS.STATS).packsOpened).toBe(10);
  expectShelvesEmpty();
  await app.reload();
  expect(storedCards()).toBe(10);
  expect(read<Stats>(STORAGE_KEYS.STATS).packsOpened).toBe(10);
}, 60_000);

it('says the shelf holds a counted copy when the stats counting it, and then the uncounted copy, could not be stored', async () => {
  const set = getSet('right-now', 2)!;
  const cards = set.cards.slice(0, 5).map((c) => encodeCard({ id: c.id, holo: false })).join(',');
  app = await mountedApp({
    ...SEED,
    [STORAGE_KEYS.STATS]: packsOpened(8),
    [STORAGE_KEYS.PENDING_PACKS]: JSON.stringify([{ s: set.id, v: set.version, n: 4, c: cards, t: 1 }]),
  });
  // The shelf takes the marked copy, then storage fills: neither the stats nor the unmarked copy fit.
  const setItem = Storage.prototype.setItem;
  let shelfWrites = 0;
  const full = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
    if (key === STORAGE_KEYS.COLLECTION || key === STORAGE_KEYS.STATS) throw new DOMException('Full', 'QuotaExceededError');
    if (key === STORAGE_KEYS.PENDING_PACKS && shelfWrites++ > 0) throw new DOMException('Full', 'QuotaExceededError');
    setItem.call(this, key, value);
  });
  await app.mount();
  await app.until('the blocked collection reports the counted copy left on the shelf', () =>
    expect(app!.takeErrors(/are on the pending shelf marked as counted, but the stats counting them couldn't be stored/)).toHaveLength(1));
  expect(app.takeErrors(/couldn't be put back on the pending shelf/)).toEqual([]);
  app.takeErrors(/^(Failed to save to localStorage key|Migration could not write) /);
  expect(shelf()).toEqual([expect.objectContaining({ n: 4, d: 1 })]);
  expect(read<Stats>(STORAGE_KEYS.STATS).packsOpened).toBe(8);

  // This tab still owes it: once space frees up, the next collection write stores it, counted once.
  full.mockRestore();
  await openOnePack();
  expect(storedCards()).toBe(10);
  expect(read<Stats>(STORAGE_KEYS.STATS).packsOpened).toBe(10);
  expectShelvesEmpty();
}, 60_000);

it('adds every unmarked pack waiting at load, from both shelf forms, counting each once', async () => {
  const set = getSet('right-now', 2)!;
  const cards = set.cards.slice(0, 5).map((c) => encodeCard({ id: c.id, holo: false })).join(',');
  const pack = (n: number) => ({ s: set.id, v: set.version, n, c: cards, t: 1 });
  app = await mountedApp({
    ...SEED,
    [STORAGE_KEYS.STATS]: packsOpened(7),
    // An older build's one-pack entry beside this build's list: none of the three counted yet.
    [STORAGE_KEYS.PENDING_PACK]: JSON.stringify(pack(3)),
    [STORAGE_KEYS.PENDING_PACKS]: JSON.stringify([pack(4), pack(5)]),
  });
  await app.mount();
  await app.until('all three waiting packs reach the stored collection', () => expect(storedCards()).toBe(15));

  // Each pack's count builds on the last one's, so the third crosses the 10-pack achievement.
  expect(read<Stats>(STORAGE_KEYS.STATS).packsOpened).toBe(10);
  expect(read<Record<string, unknown>>(STORAGE_KEYS.ACHIEVEMENTS)).toHaveProperty('packs_10');
  expectShelvesEmpty();

  await app.reload();
  expect(storedCards()).toBe(15);
  expect(read<Stats>(STORAGE_KEYS.STATS).packsOpened).toBe(10);
}, 60_000);

it("adds an older tab's pack once when that tab stores it while this tab's collection is blocked", async () => {
  const set = getSet('right-now', 2)!;
  const cards = set.cards.slice(0, 5).map((c) => encodeCard({ id: c.id, holo: false })).join(',');
  // An older tab opened pack 4 and is still revealing it.
  app = await mountedApp({
    ...SEED,
    [STORAGE_KEYS.STATS]: packsOpened(9),
    [STORAGE_KEYS.PENDING_PACK]: JSON.stringify({ s: set.id, v: set.version, n: 4, c: cards, t: 1 }),
  });
  // This tab loads and adds it, but can't store the collection holding it.
  const setItem = Storage.prototype.setItem;
  let attempted: string | undefined;
  const full = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
    if (key !== STORAGE_KEYS.COLLECTION) return setItem.call(this, key, value);
    attempted = value;
    throw new DOMException('Full', 'QuotaExceededError');
  });
  await app.mount();
  await app.until('the blocked collection puts the pack back', () => expect(legacyEntry()).toEqual(expect.objectContaining({ n: 4, d: 1 })));
  expect(shelf()).toBeNull();
  expect(read<Stats>(STORAGE_KEYS.STATS).packsOpened).toBe(10);
  expect(app.takeErrors(/^Failed to save to localStorage key /)).toHaveLength(1);

  // The older tab stores a collection holding the pack, then clears its entry as older builds do.
  full.mockRestore();
  localStorage.setItem(STORAGE_KEYS.COLLECTION, attempted!);
  if (legacyEntry()?.n === 4) localStorage.removeItem(STORAGE_KEYS.PENDING_PACK);
  expect(storedCards()).toBe(5);

  await app.reload();
  await app.reload();
  expect(storedCards()).toBe(5);
  expect(read<Stats>(STORAGE_KEYS.STATS).packsOpened).toBe(10);
  expectShelvesEmpty();
}, 60_000);

it("adds a pack in both shelf forms once, in one load", async () => {
  const set = getSet('right-now', 2)!;
  const cards = set.cards.slice(0, 5).map((c) => encodeCard({ id: c.id, holo: false })).join(',');
  const pack = { s: set.id, v: set.version, n: 4, c: cards, t: 1 };
  app = await mountedApp({
    ...SEED,
    [STORAGE_KEYS.STATS]: packsOpened(9),
    [STORAGE_KEYS.PENDING_PACK]: JSON.stringify(pack),
    [STORAGE_KEYS.PENDING_PACKS]: JSON.stringify([pack]),
  });
  await app.mount();
  await app.until('the waiting pack reaches the stored collection', () => expect(storedCards()).toBe(5));
  expect(read<Stats>(STORAGE_KEYS.STATS).packsOpened).toBe(10);
  expectShelvesEmpty();

  await app.reload();
  expect(storedCards()).toBe(5);
  expect(read<Stats>(STORAGE_KEYS.STATS).packsOpened).toBe(10);
}, 60_000);
