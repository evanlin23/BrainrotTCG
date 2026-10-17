// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://mounted.invalid/BrainrotTCG/"}
import { afterEach, expect, it } from 'vitest';
import { mountedApp } from './mountedApp';
import { STORAGE_KEYS } from '../constants/config';
import { getSet } from '../content/sets';
import { encodeCard } from '../game/cardCode';
import { computeTicket, fromHex, generatePack, packSeedFromTicket, publicKeyFromSecret, setKey, toHex } from '../engine';
import { CURRENT_DATA_VERSION, DATA_VERSION_KEY } from '../utils/migrations';
import type { CollectionItem, Stats } from '../types';

let app: Awaited<ReturnType<typeof mountedApp>> | undefined;
afterEach(async () => { await app?.dispose(); app = undefined; });

const SECRET = '01'.repeat(32);
const PUBLIC = toHex(publicKeyFromSecret(fromHex(SECRET)));
const OPENED = Date.UTC(2025, 5, 1);

// A save from before sets and verifiable pulls: no data version, cards keyed by their old image names,
// a best pack with no proof, the old notable-pulls log holding one pack this key opened, and settings
// with the removed music slider.
const LEGACY_SAVE = {
  'brainrot-player-v1': JSON.stringify({ secretKey: SECRET, name: 'Legacy fixture', nextNonce: 1, createdAt: 1 }),
  [STORAGE_KEYS.SETTINGS]: JSON.stringify({ musicVolume: 0.5, effectsVolume: 0, particlesEnabled: false, pauseBigPulls: false }),
  [STORAGE_KEYS.SELECTED_SET]: 'right-now',
  [STORAGE_KEYS.COLLECTION]: JSON.stringify({
    image: { card: { id: 'image' }, normalCount: 2, holoCount: 1 },
    image2: { card: { id: 'image2' }, count: 3 },
  }),
  [STORAGE_KEYS.STATS]: JSON.stringify({
    packsOpened: 1,
    holoCards: { image: true },
    highestPackValue: 50,
    highestPackCards: [{ id: 'image', isHolo: true }, { id: 'image2' }, { id: 'image3' }, { id: 'unnamed' }, { id: 'image copy' }],
  }),
  [STORAGE_KEYS.PULLS]: JSON.stringify([
    { setId: 'right-now', setVersion: 2, nonce: 0, publicKeyHex: PUBLIC, hand: 'Pair', score: 200, openedAt: OPENED },
  ]),
};

const button = (label: string) => {
  const element = [...document.querySelectorAll<HTMLButtonElement>('button')].reverse()
    .find((el) => (el.getAttribute('aria-label') ?? el.textContent?.trim()) === label);
  expect(element, `button ${label}`).toBeDefined();
  return element!;
};
const stored = <T,>(key: string) => JSON.parse(localStorage.getItem(key) ?? 'null') as T;
const history = async () => (await import('../game/history')).getHistory();
const expectedCodes = async (setId: string, version: number, nonce: number) => {
  const set = getSet(setId, version)!;
  const ticket = await computeTicket(setKey(set), fromHex(PUBLIC), nonce);
  return generatePack(set, packSeedFromTicket(ticket))
    .map((p) => encodeCard({ id: p.cardId, holo: p.isHolo, finish: p.finish, misprint: p.misprint }));
};
const counts = (collection: Record<string, CollectionItem>, key: string) =>
  collection[key] && { normal: collection[key].normalCount, holo: collection[key].holoCount };

async function openPack(current: NonNullable<typeof app>) {
  await current.until('the pack shell is ready', () => expect(document.querySelector('.pack-open-button')).not.toBeNull());
  await current.interact(() => {
    // The Open pack button under the pack: the same opening as a finished swipe (#312).
    const open = document.querySelector<HTMLButtonElement>('.pack-open-button')!;
    expect(open).not.toBeNull();
    open.focus();
    open.click();
  });
  await current.until('the ticket produces a reveal with Skip', () => expect(document.querySelector('.reveal-skip')).not.toBeNull());
  await current.interact(() => button('Skip opening animation').click());
  await current.until('Skip completes the summary', () => expect(document.querySelectorAll('.summary-card')).toHaveLength(5));
}

it('migrates a pre-versioning save on load without losing its cards or pulls, then keeps opening packs on it', async () => {
  app = await mountedApp(LEGACY_SAVE);
  await app.mount();

  // Storage is upgraded once, before the App reads it.
  expect(localStorage.getItem(DATA_VERSION_KEY)).toBe(String(CURRENT_DATA_VERSION));
  const collection = stored<Record<string, CollectionItem>>(STORAGE_KEYS.COLLECTION);
  expect(Object.keys(collection).sort()).toEqual(['genesis/amogus', 'genesis/chimpanzini-bananini']);
  expect(counts(collection, 'genesis/chimpanzini-bananini')).toEqual({ normal: 2, holo: 1 });
  expect(counts(collection, 'genesis/amogus')).toEqual({ normal: 3, holo: 0 });
  const stats = stored<Stats & { highestPackValue?: number }>(STORAGE_KEYS.STATS);
  expect(stats.holoCards).toEqual({ 'genesis/chimpanzini-bananini': true });
  expect(stats.highestPackLegacy).toBe(true);
  expect(stats.highestPackCards?.map((c) => c.key)).toEqual(['genesis/chimpanzini-bananini', 'genesis/amogus', 'genesis/gigachad',
    'genesis/boneca-ambalabu', 'genesis/locked-in-alien']);
  expect(stats.highestPackFlexValue).toEqual(expect.any(Number));
  expect(stats.highestPackValue).toBeUndefined();
  // The old pull log moved into history as this key's ticket (no cards yet), and only then went away.
  expect(localStorage.getItem(STORAGE_KEYS.PULLS)).toBeNull();
  expect(await history()).toEqual([expect.objectContaining({
    setId: 'right-now', setVersion: 2, nonce: 0, key: PUBLIC.slice(0, 16), cards: null, hand: 'Pair', score: 200, openedAt: OPENED,
  })]);

  // Best pulls, on the Profile page, shows the migrated pull and the unproven best pack.
  await app.interact(() => button('Profile').click());
  await app.until('Best pulls lists the migrated pull', () => {
    expect(document.querySelector('.pulls-history-title#pulls-history-title')?.textContent).toBe('All packs · 1');
  });
  const rows = [...document.querySelectorAll<HTMLButtonElement>('.pulls-page .pull-row')];
  expect(rows).toHaveLength(1);
  expect(rows[0].querySelector('.pull-row-hand')?.textContent).toContain('Pair');
  expect(rows[0].querySelector('.pull-row-setname')?.textContent).toContain('Summer of Slop');
  expect(rows[0].disabled, 'a migrated pull has no cards to show yet').toBe(true);
  expect([...document.querySelectorAll('.pulls-page .pulls-legacy h2')].map((h) => h.textContent)).toEqual(['Best before verifiable pulls']);
  await app.interact(() => button('Close Profile').click());
  await app.until('Open shows again', () => expect(document.querySelector<HTMLElement>('main.app-main')!.hidden).toBe(false));

  // The next pack takes the next nonce and adds to the migrated save instead of replacing it.
  await openPack(app);
  await app.until('the new pack is recorded', async () => expect(await history()).toHaveLength(2));
  const [latest, migrated] = await history();
  expect(latest).toMatchObject({ setId: 'right-now', setVersion: 2, nonce: 1, key: PUBLIC.slice(0, 16) });
  expect(latest.cards?.map((c) => encodeCard(c))).toEqual(await expectedCodes('right-now', 2, 1));
  expect(migrated).toMatchObject({ nonce: 0, cards: null, hand: 'Pair', score: 200 });
  expect(stored<{ nextNonce: number; secretKey: string }>('brainrot-player-v1')).toMatchObject({ nextNonce: 2, secretKey: SECRET });
  await app.until('the collection saves the new cards', () => {
    const after = stored<Record<string, CollectionItem>>(STORAGE_KEYS.COLLECTION);
    const total = Object.values(after).reduce((sum, item) => sum + item.normalCount + item.holoCount, 0);
    expect(total).toBe(2 + 1 + 3 + 5);
    expect(counts(after, 'genesis/chimpanzini-bananini')).toEqual({ normal: 2, holo: 1 });
    expect(counts(after, 'genesis/amogus')).toEqual({ normal: 3, holo: 0 });
  });
  expect(stored<Stats>(STORAGE_KEYS.STATS).packsOpened).toBe(2);

  // A reload neither migrates again nor loses anything.
  const saved = JSON.stringify(Object.entries(localStorage).sort());
  await app.reload();
  expect(await history()).toHaveLength(2);
  expect(JSON.stringify(Object.entries(localStorage).sort())).toBe(saved);
}, 60_000);
