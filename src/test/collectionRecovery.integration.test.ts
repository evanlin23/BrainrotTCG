// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://mounted.invalid/BrainrotTCG/"}
import { afterEach, expect, it, vi } from 'vitest';
import { mountedApp } from './mountedApp';
import { STORAGE_KEYS } from '../constants/config';
import { ALL_CARDS } from '../data/cards';
import { exportSaveFile } from '../game/saveFile';
import { CURRENT_DATA_VERSION, DATA_VERSION_KEY } from '../utils/migrations';
import type { CollectionItem } from '../types';

let app: Awaited<ReturnType<typeof mountedApp>> | undefined;
afterEach(async () => { await app?.dispose(); app = undefined; });

const SECRET = '01'.repeat(32);
const PLAYER = JSON.stringify({ secretKey: SECRET, name: 'Mounted fixture', nextNonce: 0, createdAt: 1 });
const readable = ALL_CARDS[0];
// One card the app can show, and two it can't: a partial unknown card and a null record.
const RAW = JSON.stringify({
  [readable.key]: { card: { id: readable.id, key: readable.key }, normalCount: 1, holoCount: 0 },
  'lost-set/ghost': { card: { id: 'ghost', key: 'lost-set/ghost' }, normalCount: 2, holoCount: 1 },
  'lost-set/null': null,
});
const SEED = {
  'brainrot-player-v1': PLAYER,
  [STORAGE_KEYS.SETTINGS]: JSON.stringify({ musicVolume: 0, effectsVolume: 0, particlesEnabled: false, pauseBigPulls: false }),
  [STORAGE_KEYS.SELECTED_SET]: 'right-now',
  [STORAGE_KEYS.COLLECTION]: RAW,
  // A current save: the v2 migration would rewrite the collection before the app reads it.
  [DATA_VERSION_KEY]: String(CURRENT_DATA_VERSION),
};

const button = (label: string) => {
  const element = [...document.querySelectorAll<HTMLElement>('button, [role="button"]')]
    .find((el) => (el.getAttribute('aria-label') ?? el.textContent?.trim()) === label);
  expect(element, `button ${label}`).toBeDefined();
  return element!;
};
const warnings = () => [...document.querySelectorAll('p[role="alert"].save-warning')].map((el) => el.textContent);
const stored = () => JSON.parse(localStorage.getItem(STORAGE_KEYS.COLLECTION)!) as Record<string, CollectionItem>;
const owned = (collection: Record<string, CollectionItem>) =>
  Object.values(collection).reduce((sum, item) => sum + item.normalCount + item.holoCount, 0);

async function openPack(current: NonNullable<typeof app>) {
  await current.until('the pack shell is ready', () => expect(document.querySelector('[aria-label^="Open a "]')).not.toBeNull());
  await current.interact(() => {
    const shell = document.querySelector<HTMLElement>('[aria-label^="Open a "]')!;
    shell.focus();
    shell.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    shell.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
  });
  await current.until('real ticket produces a reveal with Skip', () => expect(document.querySelector('.reveal-skip')).not.toBeNull());
  await current.interact(() => button('Skip opening animation').click());
  await current.until('Skip completes the summary', () => expect(document.querySelectorAll('.summary-card')).toHaveLength(5));
}

it('keeps unreadable collection entries through pack writes and offers them in the private export', async () => {
  app = await mountedApp(SEED);
  await app.mount();
  expect(warnings()).toEqual([]);

  await openPack(app);

  // The new collection has the readable card and the pack; the hidden entries left it, but not the browser.
  const afterFirst = stored();
  expect(afterFirst[readable.key]).toBeDefined();
  expect(afterFirst).not.toHaveProperty('lost-set/ghost');
  expect(owned(afterFirst)).toBe(1 + 5);
  const archive = localStorage.getItem(STORAGE_KEYS.COLLECTION_RECOVERY)!;
  const { raw, player } = JSON.parse(archive) as { raw: string; player: string };
  expect(raw).toBe(RAW);
  expect(JSON.parse(player).secretKey).toBe(SECRET);
  expect(JSON.parse(exportSaveFile()).collectionRecovery).toBe(archive);

  // One warning, in the banner and then in Save & restore while the banner steps aside.
  expect(warnings()).toEqual([expect.stringMatching(/Unreadable collection data was kept aside/)]);
  expect(warnings()[0]).not.toMatch(/couldn't be saved/);
  await app.interact(() => button('Player').click());
  await app.until('Player loads', () => expect(button('Save & restore')).toBeDefined());
  await app.interact(() => button('Save & restore').click());
  await app.until('Save & restore loads', () => expect(document.querySelector('.settings')).not.toBeNull());
  expect(document.querySelector('.settings p[role="alert"].save-warning')?.textContent).toMatch(/kept aside/);
  expect(warnings()).toHaveLength(1);
  await app.interact(() => button('Close').click());

  // Still offered after a reload; the next write keeps the archive as it was.
  await app.reload();
  expect(warnings()).toEqual([expect.stringMatching(/kept aside/)]);
  await openPack(app);
  expect(owned(stored())).toBe(1 + 10);
  expect(localStorage.getItem(STORAGE_KEYS.COLLECTION_RECOVERY)).toBe(archive);
}, 60_000);

it('keeps the stored collection unchanged, and warns once, when the archive cannot be written', async () => {
  app = await mountedApp(SEED);
  await app.mount();
  const setItem = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
    if (key === STORAGE_KEYS.COLLECTION_RECOVERY) throw new DOMException('Full', 'QuotaExceededError');
    setItem.call(this, key, value);
  });

  await openPack(app);

  expect(localStorage.getItem(STORAGE_KEYS.COLLECTION)).toBe(RAW);
  expect(localStorage.getItem(STORAGE_KEYS.COLLECTION_RECOVERY)).toBeNull();
  expect(app.takeErrors(/^Failed to save to localStorage key /))
    .toEqual([expect.stringContaining(`"${STORAGE_KEYS.COLLECTION_RECOVERY}"`)]);
  expect(warnings()).toEqual([expect.stringMatching(/couldn't be saved in this browser/)]);
  expect(warnings()[0]).not.toMatch(/kept aside/);
  // Other progress still saves.
  expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.STATS)!).packsOpened).toBe(1);
}, 60_000);

it('shows the kept-aside note at once, and keeps the pack waiting, when only the collection write fails', async () => {
  app = await mountedApp(SEED);
  await app.mount();
  const setItem = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
    if (key === STORAGE_KEYS.COLLECTION) throw new DOMException('Full', 'QuotaExceededError');
    setItem.call(this, key, value);
  });

  await openPack(app);

  expect(localStorage.getItem(STORAGE_KEYS.COLLECTION)).toBe(RAW);
  expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.COLLECTION_RECOVERY)!).raw).toBe(RAW);
  expect(localStorage.getItem(STORAGE_KEYS.PENDING_PACK)).not.toBeNull();
  expect(app.takeErrors(/^Failed to save to localStorage key /)).toEqual([expect.stringContaining(`"${STORAGE_KEYS.COLLECTION}"`)]);
  expect(warnings()).toEqual([expect.stringMatching(/couldn't be saved in this browser[\s\S]*kept aside/)]);
}, 60_000);

it('lets the player hide the kept-aside note until something new is kept aside; Settings still shows it', async () => {
  const archive = JSON.stringify({ raw: RAW, player: PLAYER });
  app = await mountedApp({ ...SEED, [STORAGE_KEYS.COLLECTION]: '{}', [STORAGE_KEYS.COLLECTION_RECOVERY]: archive });
  await app.mount();
  expect(warnings()).toEqual([expect.stringMatching(/kept aside/)]);

  await app.interact(() => button('Hide note').click());
  expect(warnings()).toEqual([]);
  await app.interact(() => button('Sound & display').click());
  await app.until('Sound & display loads', () => expect(document.querySelector('.settings')).not.toBeNull());
  expect(warnings()).toEqual([expect.stringMatching(/kept aside/)]);
  await app.interact(() => button('Close').click());

  await app.reload();
  expect(warnings()).toEqual([]);

  // Another damaged payload joins the archive: the note comes back.
  localStorage.setItem(STORAGE_KEYS.COLLECTION_RECOVERY, JSON.stringify({ ...JSON.parse(archive), later: [{ raw: '{"x":null}', player: PLAYER }] }));
  await app.reload();
  expect(warnings()).toEqual([expect.stringMatching(/kept aside/)]);
});
