// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://mounted.invalid/BrainrotTCG/"}
import { afterEach, expect, it } from 'vitest';
import { mountedApp } from './mountedApp';
import { STORAGE_KEYS } from '../constants/config';
import { getSetCards } from '../data/cards';
import { getLatestSet, DEFAULT_SET_ID } from '../content/sets';

import { CURRENT_DATA_VERSION, DATA_VERSION_KEY } from '../utils/migrations';

let app: Awaited<ReturnType<typeof mountedApp>> | undefined;
afterEach(async () => {
  await app?.dispose();
  app = undefined;
});

const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].reverse()
    .find((el) => (el.getAttribute('aria-label') ?? el.textContent?.trim()) === label)!;

it('never invents extra owned copies or two separate chips when combined modifier history is uncached (issue #655)', async () => {
  const set = getLatestSet(DEFAULT_SET_ID)!;
  const targetCard = getSetCards(DEFAULT_SET_ID)[0];
  const cardId = targetCard.key.split('/')[1];
  const playerKey = '01'.repeat(32);
  const keyPrefix = playerKey.slice(0, 16);

  // 1 owned copy with combined modifiers: Gold finish + Misprint
  const collection = {
    [targetCard.key]: {
      card: targetCard,
      normalCount: 1,
      holoCount: 0,
      finishes: { GOLD: 1 },
      misprints: 1,
      modifierPoints: 100,
    },
  };

  // History has quota fallback applied: ticket mapping is preserved, but cached cards (c) are stripped
  const history = [
    {
      s: set.id,
      v: set.version,
      n: 1,
      k: keyPrefix,
      // c is omitted (stripped under quota eviction)
      h: 'Pair',
      x: 100,
      t: 1000,
    },
  ];

  app = await mountedApp({
    'brainrot-player-v1': JSON.stringify({ secretKey: playerKey, name: 'Tester', nextNonce: 2, createdAt: 1 }),
    [STORAGE_KEYS.SETTINGS]: JSON.stringify({ effectsVolume: 0, particlesEnabled: false, pauseBigPulls: false }),
    [STORAGE_KEYS.SELECTED_SET]: set.id,
    [STORAGE_KEYS.COLLECTION]: JSON.stringify(collection),
    [STORAGE_KEYS.HISTORY]: JSON.stringify(history),
    [DATA_VERSION_KEY]: String(CURRENT_DATA_VERSION),
  });

  await app.mount();

  // Navigate to Collection via 'Cards' tab
  await app.interact(() => button('Cards').click());
  await app.until('collection page mounts', () => expect(document.querySelector('.collection')).not.toBeNull());

  // Click the target card tile to open CardViewerModal
  const tile = document.querySelector<HTMLButtonElement>(`button.collection-item[aria-label*="${targetCard.name}"]`)!;
  expect(tile).not.toBeNull();
  await app.interact(() => tile.click());

  await app.until('card close-up modal mounts', () => expect(document.querySelector('.card-viewer')).not.toBeNull());

  // 1. One uncached Gold Misprint copy never appears as two owned copies or two falsely exact versions
  // It does NOT present multiple version chips (e.g. Gold x1 and Misprint x1)
  expect(document.querySelector('.card-viewer-versions')).toBeNull();
  // It presents the actual combined Gold Misprint version
  expect(document.querySelector('.card-viewer-version')?.textContent).toBe('Gold · Misprint');

  // Close the modal
  await app.interact(() => button('Close').click());
  await app.until('modal closes', () => expect(document.querySelector('.card-viewer')).toBeNull());

  // Now restore exact history (packStore hydration)
  const exactCode = `${cardId}*GM`; // Gold Misprint code
  localStorage.setItem(
    STORAGE_KEYS.HISTORY,
    JSON.stringify([
      {
        s: set.id,
        v: set.version,
        n: 1,
        k: keyPrefix,
        c: exactCode,
        h: 'Pair',
        x: 100,
        t: 1000,
      },
    ]),
  );

  // Reopen the card viewer
  await app.interact(() => tile.click());
  await app.until('card modal re-mounts', () => expect(document.querySelector('.card-viewer')).not.toBeNull());

  // Once exact history is available, correct combined version returns identically
  expect(document.querySelector('.card-viewer-versions')).toBeNull();
  expect(document.querySelector('.card-viewer-version')?.textContent).toBe('Gold · Misprint');
});
