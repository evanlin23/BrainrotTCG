// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://mounted.invalid/BrainrotTCG/"}
import { afterEach, expect, it } from 'vitest';
import { mountedApp } from './mountedApp';
import { STORAGE_KEYS } from '../constants/config';
import { STATS_REBUILT_NOTE } from '../game/collectionRecovery';
import { exportSaveFile, isValidSaveValue } from '../game/saveFile';
import { CURRENT_DATA_VERSION, DATA_VERSION_KEY } from '../utils/migrations';
import type { Stats } from '../types';
import { shelfKeys, shelvedPacks } from './pendingShelf';

let app: Awaited<ReturnType<typeof mountedApp>> | undefined;
afterEach(async () => { await app?.dispose(); app = undefined; });

const SECRET = '02'.repeat(32);
const SEED = {
  'brainrot-player-v1': JSON.stringify({ secretKey: SECRET, name: 'Mounted fixture', nextNonce: 0, createdAt: 1 }),
  [STORAGE_KEYS.SETTINGS]: JSON.stringify({ effectsVolume: 0, particlesEnabled: false, pauseBigPulls: false }),
  [STORAGE_KEYS.SELECTED_SET]: 'right-now',
  [DATA_VERSION_KEY]: String(CURRENT_DATA_VERSION),
};

const button = (label: string) => {
  const element = [...document.querySelectorAll<HTMLElement>('button, [role="button"]')]
    .find((el) => (el.getAttribute('aria-label') ?? el.textContent?.trim()) === label);
  expect(element, `button ${label}`).toBeDefined();
  return element!;
};
const warnings = () => [...document.querySelectorAll('p[role="alert"].save-warning')].map((el) => el.textContent);
const storedStats = () => JSON.parse(localStorage.getItem(STORAGE_KEYS.STATS)!) as Stats;

const historyNonces = async () => (await import('../game/history')).getHistory().map((entry) => entry.nonce).sort((a, b) => a - b);

/** Opens a pack and leaves it mid-reveal: its ticket is in the history, and the pack waits on the shelf. */
async function startPack(current: NonNullable<typeof app>) {
  await current.until('the pack shell is ready', () => expect(document.querySelector('[data-pack-open]')).not.toBeNull());
  await current.interact(() => {
    const open = document.querySelector<HTMLButtonElement>('[data-pack-open]')!;
    open.focus();
    open.click();
  });
  await current.until('real ticket produces a reveal with Skip', () => expect(document.querySelector('.reveal-skip')).not.toBeNull());
}

async function openPack(current: NonNullable<typeof app>) {
  await startPack(current);
  await current.interact(() => button('Skip opening animation').click());
  await current.until('Skip completes the summary', () => expect(document.querySelectorAll('.summary-card')).toHaveLength(5));
  await current.interact(() => button('Next pack').click());
}

it.each([
  ['unparseable bytes', '\u0000ÿ{not json'],
  ['the wrong shape', '[1,2,3]'],
])('keeps stats stored as %s aside, rebuilds them from the history, and never counts from zero again (#1053)', async (_, damaged) => {
  app = await mountedApp(SEED);
  await app.mount();
  await openPack(app);
  await openPack(app);
  const before = storedStats();
  expect(before.packsOpened).toBe(2);

  localStorage.setItem(STORAGE_KEYS.STATS, damaged);
  await app.reload();
  // The damaged bytes are kept aside exactly as they were, then the rebuilt stats replace them at once.
  const archive = localStorage.getItem(STORAGE_KEYS.COLLECTION_RECOVERY)!;
  const kept = JSON.parse(archive) as { raw: string; player: string; key: string };
  expect([kept.raw, kept.key, JSON.parse(kept.player).secretKey]).toEqual([damaged, STORAGE_KEYS.STATS, SECRET]);
  const rebuilt = storedStats();
  expect([rebuilt.packsOpened, rebuilt.highestPackFlexValue, rebuilt.holoCards]).toEqual([2, before.highestPackFlexValue, before.holoCards]);
  // A backup holds the copy and stats it can import again.
  const file = JSON.parse(exportSaveFile()) as { collectionRecovery: string; stats: string };
  expect(file.collectionRecovery).toBe(archive);
  expect(JSON.parse(file.stats)).toEqual(rebuilt);
  expect(isValidSaveValue(STORAGE_KEYS.STATS, file.stats, CURRENT_DATA_VERSION)).toBe(true);
  expect(warnings()).toEqual([expect.stringMatching(/^Unreadable stats data was kept aside in this browser\. Download a copy/)]);
  expect(warnings()[0]).toContain(STATS_REBUILT_NOTE);
  expect(button('Download')).toBeDefined();

  await openPack(app);
  const after = storedStats();
  expect(after.packsOpened).toBe(3);
  // The best pack of the two before still stands (or this one beat it), and no holo card is forgotten.
  expect(after.highestPackFlexValue).toBeGreaterThanOrEqual(before.highestPackFlexValue!);
  expect(Object.keys(after.holoCards)).toEqual(expect.arrayContaining(Object.keys(before.holoCards)));
  // Kept once: the write found the bytes kept already.
  expect(localStorage.getItem(STORAGE_KEYS.COLLECTION_RECOVERY)).toBe(archive);
});

it('discards kept-aside stats for good: neither the next pack nor a reload keeps them aside again (#1053)', async () => {
  app = await mountedApp(SEED);
  await app.mount();
  await openPack(app);
  localStorage.setItem(STORAGE_KEYS.STATS, '\u0000ÿ{not json');
  await app.reload();
  expect(warnings()).toEqual([expect.stringMatching(/^Unreadable stats data was kept aside/)]);

  await app.interact(() => button('Discard').click());
  await app.interact(() => button('Discard for good').click());
  expect(localStorage.getItem(STORAGE_KEYS.COLLECTION_RECOVERY)).toBeNull();
  expect(warnings()).toEqual([]);

  await openPack(app);
  expect(storedStats().packsOpened).toBe(2);
  expect(localStorage.getItem(STORAGE_KEYS.COLLECTION_RECOVERY)).toBeNull();
  await app.reload();
  expect(warnings()).toEqual([]);
  expect(localStorage.getItem(STORAGE_KEYS.COLLECTION_RECOVERY)).toBeNull();
  expect(storedStats().packsOpened).toBe(2);
});

it('counts a pack waiting on the shelf once when the stats it was owed to are rebuilt from the history (#1053)', async () => {
  app = await mountedApp(SEED);
  await app.mount();
  await openPack(app);
  await openPack(app);
  // The third pack's ticket is in the history; the pack itself waits on the shelf for the next load.
  await startPack(app);
  expect(await historyNonces()).toEqual([0, 1, 2]);
  expect(shelvedPacks().map((pack) => pack.n)).toEqual([2]);
  expect(storedStats().packsOpened).toBe(2);

  localStorage.setItem(STORAGE_KEYS.STATS, '[1,2,3]');
  await app.reload();
  await app.until('the shelved pack reaches the collection', () => expect(shelfKeys()).toEqual([]));
  // The rebuilt count already has the shelved pack's ticket, so taking the pack adds only its cards.
  expect(storedStats().packsOpened).toBe(3);
  const settled = storedStats();
  await app.reload();
  expect(storedStats()).toEqual(settled);
  expect(storedStats().packsOpened).toBe((await historyNonces()).length);
});
