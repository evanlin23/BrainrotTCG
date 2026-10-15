// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://mounted.invalid/BrainrotTCG/"}
import { afterEach, expect, it } from 'vitest';
import { mountedApp } from './mountedApp';
import { STORAGE_KEYS } from '../constants/config';
import type { CollectionItem, Stats } from '../types';

let app: Awaited<ReturnType<typeof mountedApp>> | undefined;
afterEach(async () => { await app?.dispose(); app = undefined; });

const read = <T,>(key: string): T => JSON.parse(localStorage.getItem(key) ?? 'null');
const button = (label: string) => {
  const element = [...document.querySelectorAll<HTMLElement>('button, [role="button"]')]
    .find((el) => (el.getAttribute('aria-label') ?? el.textContent?.trim()) === label);
  expect(element, `button ${label}`).toBeDefined();
  return element!;
};
const snapshot = () => Object.fromEntries([STORAGE_KEYS.COLLECTION, STORAGE_KEYS.STATS, STORAGE_KEYS.HISTORY,
  STORAGE_KEYS.PENDING_PACK, 'brainrot-player-v1'].map((key) => [key, localStorage.getItem(key)]));

it('records and awards one real pack, preserving exact cards/modifiers/ticket after reconstructed reload', async () => {
  app = await mountedApp({
    // Same disposable seed as #304; never import a developer's save. Only identity/preferences are seeded.
    'brainrot-player-v1': JSON.stringify({ secretKey: '01'.repeat(32), name: 'Mounted fixture', nextNonce: 0, createdAt: 1 }),
    [STORAGE_KEYS.SETTINGS]: JSON.stringify({ musicVolume: 0, effectsVolume: 0, particlesEnabled: false, pauseBigPulls: false }),
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
  expect(localStorage.getItem(STORAGE_KEYS.PENDING_PACK)).toBeNull();
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
  await app.interact(() => button('Profile').click());
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
