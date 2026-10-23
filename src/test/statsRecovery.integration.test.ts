// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://mounted.invalid/BrainrotTCG/"}
import { afterEach, expect, it } from 'vitest';
import { mountedApp } from './mountedApp';
import { STORAGE_KEYS } from '../constants/config';
import { STATS_REBUILT_NOTE } from '../game/collectionRecovery';
import { exportSaveFile } from '../game/saveFile';
import { CURRENT_DATA_VERSION, DATA_VERSION_KEY } from '../utils/migrations';
import type { Stats } from '../types';

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

async function openPack(current: NonNullable<typeof app>) {
  await current.until('the pack shell is ready', () => expect(document.querySelector('.pack-open-button')).not.toBeNull());
  await current.interact(() => {
    const open = document.querySelector<HTMLButtonElement>('.pack-open-button')!;
    open.focus();
    open.click();
  });
  await current.until('real ticket produces a reveal with Skip', () => expect(document.querySelector('.reveal-skip')).not.toBeNull());
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
  // Told at once, before anything replaces the damaged bytes, which are kept aside exactly as they were.
  expect(localStorage.getItem(STORAGE_KEYS.STATS)).toBe(damaged);
  const archive = localStorage.getItem(STORAGE_KEYS.COLLECTION_RECOVERY)!;
  const kept = JSON.parse(archive) as { raw: string; player: string; key: string };
  expect([kept.raw, kept.key, JSON.parse(kept.player).secretKey]).toEqual([damaged, STORAGE_KEYS.STATS, SECRET]);
  expect(JSON.parse(exportSaveFile()).collectionRecovery).toBe(archive);
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
