// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://mounted.invalid/BrainrotTCG/"}
import { afterEach, expect, it } from 'vitest';
import { mountedApp } from './mountedApp';
import { STORAGE_KEYS } from '../constants/config';
import { getSet } from '../content/sets';
import { encodeCard } from '../game/cardCode';
import { computeTicket, fromHex, generatePack, packSeedFromTicket, publicKeyFromSecret, setKey, toHex } from '../engine';
import type { CollectionItem } from '../types';

let app: Awaited<ReturnType<typeof mountedApp>> | undefined;
afterEach(async () => { await app?.dispose(); app = undefined; });

const SECRET = '01'.repeat(32);
const PUBLIC = toHex(publicKeyFromSecret(fromHex(SECRET)));
const SEED = {
  'brainrot-player-v1': JSON.stringify({ secretKey: SECRET, name: 'Mounted fixture', nextNonce: 0, createdAt: 1 }),
  [STORAGE_KEYS.SETTINGS]: JSON.stringify({ musicVolume: 0, effectsVolume: 0, particlesEnabled: false, pauseBigPulls: false }),
  [STORAGE_KEYS.SELECTED_SET]: 'right-now',
};

const button = (label: string) => {
  const element = [...document.querySelectorAll<HTMLButtonElement>('button')]
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

async function openPack(current: NonNullable<typeof app>, name: string) {
  await current.until(`the ${name} pack shell is ready`, () => expect(document.querySelector('[aria-label^="Open a "]')?.getAttribute('aria-label')).toContain(name));
  await current.interact(() => {
    const shell = document.querySelector<HTMLElement>('[aria-label^="Open a "]')!;
    shell.focus();
    shell.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    shell.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
  });
  await current.until('the ticket produces a reveal with Skip', () => expect(document.querySelector('.reveal-skip')).not.toBeNull());
  await current.interact(() => button('Skip opening animation').click());
  await current.until('Skip completes the summary', () => expect(document.querySelectorAll('.summary-card')).toHaveLength(5));
}

it('opens the set the player switched to while the previous set\'s ticket was still mining, and records only that pack', async () => {
  // The next-pack prefetch for the default set mines slowly, so it finishes after the player has left that set.
  app = await mountedApp(SEED, { tickets: (r) => (r.setKey === 'right-now@2' && r.nonce === 0 ? { delayMs: 4000 } : undefined) });
  await app.mount();
  await app.until('the default set prefetches its next ticket', () =>
    expect(app!.ticketRequests).toContainEqual(expect.objectContaining({ setKey: 'right-now@2', nonce: 0 })));

  await app.interact(() => button('Older pack: Spring Breakdown').click());
  await openPack(app, 'Spring Breakdown');
  expect(app.ticketRequests).toContainEqual(expect.objectContaining({ setKey: 'spring-breakdown@1', nonce: 0, publicKeyHex: PUBLIC }));
  await app.until('the pack is recorded', async () => expect(await history()).toHaveLength(1));
  const [spring] = await history();
  expect(spring).toMatchObject({ setId: 'spring-breakdown', setVersion: 1, nonce: 0, key: PUBLIC.slice(0, 16) });
  expect(spring.cards?.map((c) => encodeCard(c))).toEqual(await expectedCodes('spring-breakdown', 1, 0));
  await app.until('the collection takes the opened pack', () => {
    const collection = stored<Record<string, CollectionItem>>(STORAGE_KEYS.COLLECTION);
    expect(Object.values(collection).reduce((sum, item) => sum + item.normalCount + item.holoCount, 0)).toBe(5);
    expect(Object.keys(collection).filter((key) => !key.startsWith('spring-breakdown/'))).toEqual([]);
  });
  expect(stored<{ nextNonce: number }>('brainrot-player-v1').nextNonce).toBe(1);

  // Back on the default set, the next pack takes the next nonce; the stale nonce-0 ticket is not reused.
  await app.interact(() => button('Newer pack: Summer of Slop').click());
  await openPack(app, 'Summer of Slop');
  await app.until('the second pack is recorded', async () => expect(await history()).toHaveLength(2));
  const [latest] = await history();
  expect(latest).toMatchObject({ setId: 'right-now', setVersion: 2, nonce: 1 });
  expect(latest.cards?.map((c) => encodeCard(c))).toEqual(await expectedCodes('right-now', 2, 1));
  expect((await history()).map((entry) => `${entry.setId}#${entry.nonce}`)).toEqual(['right-now#1', 'spring-breakdown#0']);
}, 60_000);
