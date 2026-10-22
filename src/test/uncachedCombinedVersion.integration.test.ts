// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://mounted.invalid/BrainrotTCG/"}
import { afterEach, expect, it } from 'vitest';
import { mountedApp } from './mountedApp';
import { STORAGE_KEYS } from '../constants/config';
import { getSetCards } from '../data/cards';
import { getLatestSet, DEFAULT_SET_ID } from '../content/sets';
import { encodeCard } from '../game/cardCode';

import { CURRENT_DATA_VERSION, DATA_VERSION_KEY } from '../utils/migrations';

let app: Awaited<ReturnType<typeof mountedApp>> | undefined;
afterEach(async () => {
  await app?.dispose();
  app = undefined;
});

const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].reverse()
    .find((el) => (el.getAttribute('aria-label') ?? el.textContent?.trim()) === label)!;

const set = getLatestSet(DEFAULT_SET_ID)!;
const targetCard = getSetCards(DEFAULT_SET_ID)[0];
const cardId = targetCard.key.split('/')[1];
const playerKey = '01'.repeat(32);
const keyPrefix = playerKey.slice(0, 16);

/** A history entry for the pack, with its cards (`c`) or without them, as the quota fallback in history.ts stores it. */
const historyEntry = (cards?: string) => ({ s: set.id, v: set.version, n: 1, k: keyPrefix, ...(cards ? { c: cards } : {}), h: 'Pair', x: 100, t: 1000 });

/** Mounts the app with this collection tally for the card and a history whose cards are stripped, then opens its close-up. */
const openCloseUp = async (tally: { normalCount: number; finishes: { GOLD: number }; misprints: number }) => {
  app = await mountedApp({
    'brainrot-player-v1': JSON.stringify({ secretKey: playerKey, name: 'Tester', nextNonce: 2, createdAt: 1 }),
    [STORAGE_KEYS.SETTINGS]: JSON.stringify({ effectsVolume: 0, particlesEnabled: false, pauseBigPulls: false }),
    [STORAGE_KEYS.SELECTED_SET]: set.id,
    [STORAGE_KEYS.COLLECTION]: JSON.stringify({ [targetCard.key]: { card: targetCard, holoCount: 0, modifierPoints: 100, ...tally } }),
    [STORAGE_KEYS.HISTORY]: JSON.stringify([historyEntry()]),
    [DATA_VERSION_KEY]: String(CURRENT_DATA_VERSION),
  });
  await app.mount();
  await app.interact(() => button('Cards').click());
  await app.until('collection page mounts', () => expect(document.querySelector('.collection')).not.toBeNull());
  const tile = document.querySelector<HTMLButtonElement>(`button.collection-item[aria-label*="${targetCard.name}"]`)!;
  expect(tile).not.toBeNull();
  await app.interact(() => tile.click());
  await app.until('card close-up mounts', () => expect(document.querySelector('.card-viewer')).not.toBeNull());
  return tile;
};

const chips = () => [...document.querySelectorAll<HTMLButtonElement>('.version-chip')];

it('shows one uncached Gold Misprint copy as that one version, never two (issue #655)', async () => {
  await openCloseUp({ normalCount: 1, finishes: { GOLD: 1 }, misprints: 1 });

  // One copy carrying both modifiers: no Gold ×1 and Misprint ×1 chips, and it isn't marked uncertain.
  expect(document.querySelector('.card-viewer-versions')).toBeNull();
  expect(document.querySelector('.card-viewer-version')?.textContent).toBe('Gold · Misprint');
});

it('marks a guessed combination uncertain, then shows the exact versions once the history has the cards (issue #655)', async () => {
  // Two copies, one Gold and one Misprint: Gold Misprint + Plain or Gold + Misprint, the tallies can't say.
  const tile = await openCloseUp({ normalCount: 2, finishes: { GOLD: 1 }, misprints: 1 });
  // No combined version is invented, and neither guess is shown as exact.
  expect(chips().map((c) => c.textContent)).toEqual([expect.stringMatching(/^Misprint \(uncertain\) ×1/), expect.stringMatching(/^Gold \(uncertain\) ×1/)]);
  expect(chips().every((c) => c.classList.contains('uncertain-chip'))).toBe(true);
  expect(button('Share card')).toBeUndefined();

  await app!.interact(() => button('Close').click());
  await app!.until('close-up closes', () => expect(document.querySelector('.card-viewer')).toBeNull());

  // The pack's cards come back (a re-open caches them): one Gold Misprint and a plain copy.
  const exactCards = [encodeCard({ id: cardId, holo: false, finish: 'GOLD', misprint: true }), encodeCard({ id: cardId, holo: false })].join(',');
  localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify([historyEntry(exactCards)]));

  await app!.interact(() => tile.click());
  await app!.until('close-up reopens', () => expect(document.querySelector('.card-viewer')).not.toBeNull());
  expect(chips().map((c) => c.textContent)).toEqual([expect.stringMatching(/^Gold · Misprint ×1/), expect.stringMatching(/^Plain ×1/)]);
  expect(chips().some((c) => c.classList.contains('uncertain-chip'))).toBe(false);
  expect(button('Share card')).toBeDefined();
});
