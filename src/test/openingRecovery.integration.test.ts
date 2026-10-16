// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://mounted.invalid/BrainrotTCG/"}
import { afterEach, expect, it, vi } from 'vitest';
import { mountedApp } from './mountedApp';
import { STORAGE_KEYS } from '../constants/config';
import type { CollectionItem, Stats } from '../types';
import { PARTIAL_IMPORT_NOTE } from '../game/saveFile';

// Interrupted, slow and failed openings, and a failed restore, through the real App and real tickets.
let app: Awaited<ReturnType<typeof mountedApp>> | undefined;
afterEach(async () => { await app?.dispose(); app = undefined; });

const PLAYER_KEY = 'brainrot-player-v1';
const SEED = {
  [PLAYER_KEY]: JSON.stringify({ secretKey: '01'.repeat(32), name: 'Mounted fixture', nextNonce: 0, createdAt: 1 }),
  [STORAGE_KEYS.SETTINGS]: JSON.stringify({ musicVolume: 0, effectsVolume: 0, particlesEnabled: false, pauseBigPulls: false }),
  [STORAGE_KEYS.SELECTED_SET]: 'right-now',
};
/** The seed identity's first right-now v2 pack (as in packLifecycle), so a match proves whose key opened it. */
const GOLDEN_CARDS = ['bukangi', 'niu-laiG', 'bukangi', 'la-peace', 'verity'];
const SEED_KEY_PREFIX = '8a88e3dd7409f195';

const read = <T,>(key: string): T => JSON.parse(localStorage.getItem(key) ?? 'null');
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button, [role="button"]')]
  .find((el) => (el.getAttribute('aria-label') ?? el.textContent?.trim()) === label);
const storedCards = () => Object.values(read<Record<string, CollectionItem>>(STORAGE_KEYS.COLLECTION) ?? {})
  .reduce((sum, item) => sum + item.normalCount + item.holoCount, 0);
const expectShelvesEmpty = () => {
  expect(localStorage.getItem(STORAGE_KEYS.PENDING_PACKS)).toBeNull();
  expect(localStorage.getItem(STORAGE_KEYS.PENDING_PACK)).toBeNull();
};
const history = async () => (await import('../game/history')).getHistory();
const historyCodes = async (index = 0) => {
  const { encodeCard } = await import('../game/cardCode');
  return (await history())[index].cards!.map(encodeCard);
};
const expectNothingRecorded = async () => {
  expect(await history()).toEqual([]);
  expect(localStorage.getItem(STORAGE_KEYS.COLLECTION)).toBeNull();
  expect(read<Stats | null>(STORAGE_KEYS.STATS)?.packsOpened ?? 0).toBe(0);
  expectShelvesEmpty();
};

const pressPack = async () => {
  await app!.until('the pack shell is ready', () => expect(document.querySelector('[aria-label^="Open a "]')).not.toBeNull());
  await app!.interact(() => {
    const shell = document.querySelector<HTMLElement>('[aria-label^="Open a "]')!;
    shell.focus();
    shell.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    shell.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
  });
};
const finishReveal = async () => {
  await app!.until('the ticket produces a reveal with Skip', () => expect(document.querySelector('.reveal-skip')).not.toBeNull());
  await app!.interact(() => button('Skip opening animation')!.click());
  await app!.until('Skip completes the summary', () => expect(document.querySelectorAll('.summary-card')).toHaveLength(5));
};

it('adds a pack left mid-reveal by a reload once, from the pending shelf', async () => {
  app = await mountedApp(SEED);
  await app.mount();
  await pressPack();
  await app.until('the reveal starts', () => expect(document.querySelector('.reveal-skip')).not.toBeNull());
  // Recorded at open; the collection and stats take it when the reveal ends, or on the next load.
  expect((await history()).map((pack) => pack.nonce)).toEqual([0]);
  expect(read<{ n: number }[]>(STORAGE_KEYS.PENDING_PACKS)?.map((pack) => pack.n)).toEqual([0]);
  expect(localStorage.getItem(STORAGE_KEYS.COLLECTION)).toBeNull();

  await app.reload();
  await app.until('the waiting pack reaches the collection', () => expect(storedCards()).toBe(5));
  expect(read<Stats>(STORAGE_KEYS.STATS).packsOpened).toBe(1);
  expect(read<{ nextNonce: number }>(PLAYER_KEY).nextNonce).toBe(1);
  expect(await historyCodes()).toEqual(GOLDEN_CARDS);
  expectShelvesEmpty();
  const settled = Object.entries(localStorage);
  await app.reload();
  expect(Object.entries(localStorage)).toEqual(settled);
}, 60_000);

it('waits for a slow ticket with the app held on the pack, then records the late pack once', async () => {
  app = await mountedApp(SEED, { tickets: () => ({ delayMs: 4000 }) });
  await app.mount();
  await pressPack();
  await app.until('a slow ticket says so', () => expect(document.querySelector('.pack-hint.is-waiting[role="status"]')?.textContent).toBe('Opening…'));
  // Nothing may swap the set or open over the pack meanwhile. Its number is claimed once the ticket is
  // in hand, in the same step that records the pack, so a number is never spent without its mapping.
  expect(button('Settings')!.disabled).toBe(true);
  expect(read<{ nextNonce: number }>(PLAYER_KEY).nextNonce).toBe(0);
  await expectNothingRecorded();

  await finishReveal();
  expect(read<{ nextNonce: number }>(PLAYER_KEY).nextNonce).toBe(1);
  expect(await historyCodes()).toEqual(GOLDEN_CARDS);
  expect(await history()).toHaveLength(1);
  expect(read<Stats>(STORAGE_KEYS.STATS).packsOpened).toBe(1);
  expect(storedCards()).toBe(5);
  expectShelvesEmpty();
  expect(document.querySelector('.pack-hint.is-waiting')).toBeNull();
}, 60_000);

it('spends nothing for a pack whose ticket was still mining at a reload, and opens that nonce once later', async () => {
  let delayMs = 60_000;
  app = await mountedApp(SEED, { tickets: () => ({ delayMs }) });
  await app.mount();
  await pressPack();
  await app.until('a slow ticket says so', () => expect(document.querySelector('.pack-hint.is-waiting')).not.toBeNull());
  delayMs = 0;
  await app.reload();
  // The ticket never arrived, so its number was never claimed: nothing is half-recorded, and no number is
  // left without the set it opened in (which would keep the profile link from ever being made).
  expect(read<{ nextNonce: number }>(PLAYER_KEY).nextNonce).toBe(0);
  await expectNothingRecorded();

  await pressPack();
  await finishReveal();
  expect((await history()).map((pack) => pack.nonce)).toEqual([0]);
  expect(await historyCodes()).toEqual(GOLDEN_CARDS);
  expect(read<{ nextNonce: number }>(PLAYER_KEY).nextNonce).toBe(1);
  expect((await import('../game/profiles')).myProfileInfo()).toMatchObject({ packs: 1, filled: 0 });
  expect(read<Stats>(STORAGE_KEYS.STATS).packsOpened).toBe(1);
  expect(storedCards()).toBe(5);
  expectShelvesEmpty();
}, 60_000);

it('shows a failed ticket as an alert, records nothing, and records exactly one pack on retry', async () => {
  let failing = true;
  app = await mountedApp(SEED, { tickets: () => (failing ? { error: 'Simulated ticket failure' } : undefined) });
  await app.mount();
  await pressPack();
  await app.until('the failure is announced', () => expect(document.querySelector('.pack-hint.is-error[role="alert"]')?.textContent)
    .toBe('This pack refused to open. Try again!'));
  expect(app.takeErrors(/^Could not open pack/)).toEqual([expect.stringContaining('Simulated ticket failure')]);
  await expectNothingRecorded();
  await app.until('the app is free again', () => expect(button('Settings')!.disabled).toBe(false));

  failing = false;
  await pressPack();
  await finishReveal();
  const packs = await history();
  expect(packs).toHaveLength(1);
  expect(packs[0].nonce).toBe(read<{ nextNonce: number }>(PLAYER_KEY).nextNonce - 1);
  expect(read<Stats>(STORAGE_KEYS.STATS).packsOpened).toBe(1);
  expect(storedCards()).toBe(5);
  expectShelvesEmpty();
}, 60_000);

it('never retries a failed ticket by itself: each press asks once more, and a second failure is shown like the first', async () => {
  app = await mountedApp(SEED, { tickets: () => ({ error: 'Simulated ticket failure' }) });
  await app.mount();
  for (const press of [1, 2]) {
    const asked = app.ticketRequests.length;
    await pressPack();
    await app.until(`press ${press} asks for a ticket`, () => expect(app!.ticketRequests.length).toBeGreaterThan(asked));
    await app.until(`failure ${press} is announced`, () => expect(document.querySelector('.pack-hint.is-error[role="alert"]')?.textContent)
      .toBe('This pack refused to open. Try again!'));
    await app.until('the app is free again', () => expect(button('Settings')!.disabled).toBe(false));
    expect(app.takeErrors(/^Could not open pack/)).toEqual([expect.stringContaining('Simulated ticket failure')]);
    expect(app.ticketRequests).toHaveLength(asked + 1);
    await app.settle(10_000);
    expect(app.ticketRequests).toHaveLength(asked + 1); // nothing asks again until the next press
  }
  // A failed ticket spends no number (it has no pack to map it to): both presses asked for ticket 0, and
  // neither recorded anything.
  expect(app.ticketRequests.slice(-2).map((request) => request.nonce)).toEqual([0, 0]);
  expect(read<{ nextNonce: number }>(PLAYER_KEY).nextNonce).toBe(0);
  await expectNothingRecorded();
}, 60_000);

it('finishes on the main thread when the ticket worker crashes, with the same pack', async () => {
  app = await mountedApp(SEED, { tickets: () => 'crash' });
  await app.mount();
  await pressPack();
  await finishReveal();
  expect(app.takeErrors(/^Ticket worker failed; mining on the main thread/)).toHaveLength(1);
  expect(app.ticketRequests).toHaveLength(1); // Later tickets, the next-pack prefetch included, skip the worker.
  expect(await historyCodes()).toEqual(GOLDEN_CARDS);
  expect(read<Stats>(STORAGE_KEYS.STATS).packsOpened).toBe(1);
  expectShelvesEmpty();
}, 60_000);

it("restores this player's save when storage fills mid-import, then keeps opening packs as this player", async () => {
  const incomingStats = JSON.stringify({ packsOpened: 5, holoCards: {} });
  const save = JSON.stringify({
    version: 2, exportedAt: '2026-01-01T00:00:00Z', collection: '{}', achievements: '{"first_pack":1}', stats: incomingStats,
    player: JSON.stringify({ secretKey: '02'.repeat(32), name: 'Other player', nextNonce: 5, createdAt: 2 }),
  });
  app = await mountedApp({ ...SEED, [STORAGE_KEYS.STATS]: JSON.stringify({ packsOpened: 3, holoCards: {} }) });
  await app.mount();
  await app.interact(() => button('Settings')!.click());
  await app.until('Save & backup loads', () => expect(button('Import')).toBeDefined());
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { value: [new File([save], 'save.json', { type: 'application/json' })] });
  await app.interact(() => input.dispatchEvent(new Event('change', { bubbles: true })));
  await app.until('a different player asks first', () => expect(button('Replace')).toBeDefined());

  const before = Object.fromEntries(Object.entries(localStorage));
  // The incoming stats don't fit; the original, smaller value can still be put back.
  const setItem = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
    if (key === STORAGE_KEYS.STATS && value === incomingStats) throw new DOMException('Full', 'QuotaExceededError');
    setItem.call(this, key, value);
  });
  await app.interact(() => button('Replace')!.click());
  await app.until('the failure is explained', () => expect(document.body.textContent)
    .toContain('Import failed. Your previous save data was restored.'));
  const after = Object.fromEntries(Object.entries(localStorage));
  expect(JSON.parse(after['brainrot-before-import-v1'])).toEqual(before);
  delete after['brainrot-before-import-v1'];
  expect(after).toEqual(before);

  // The identity in memory never switched, so the next pack is this player's nonce-0 pack.
  await app.interact(() => button('Close Settings')!.click());
  await app.until('Open shows again', () => expect(document.querySelector<HTMLElement>('main.app-main')!.hidden).toBe(false));
  await pressPack();
  await finishReveal();
  expect(await historyCodes()).toEqual(GOLDEN_CARDS);
  expect((await history())[0].key).toBe(SEED_KEY_PREFIX);
  expect(read<Stats>(STORAGE_KEYS.STATS).packsOpened).toBe(4);
  expect(read<{ secretKey: string }>(PLAYER_KEY).secretKey).toBe('01'.repeat(32));
}, 60_000);

it("says so and then reloads when a failed import can't be undone, so the app doesn't keep showing the old save", async () => {
  const save = JSON.stringify({
    version: 2, exportedAt: '2026-01-01T00:00:00Z', collection: '{}', achievements: '{"first_pack":1}',
    stats: JSON.stringify({ packsOpened: 5, holoCards: {} }),
    player: JSON.stringify({ secretKey: '02'.repeat(32), name: 'Other player', nextNonce: 5, createdAt: 2 }),
  });
  app = await mountedApp({ ...SEED, [STORAGE_KEYS.STATS]: JSON.stringify({ packsOpened: 3, holoCards: {} }) });
  await app.mount();
  const reload = vi.spyOn(await import('../game/reload'), 'reloadPage').mockImplementation(() => {});
  const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
  await app.interact(() => button('Settings')!.click());
  await app.until('Save & backup loads', () => expect(button('Import')).toBeDefined());
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { value: [new File([save], 'save.json', { type: 'application/json' })] });
  await app.interact(() => input.dispatchEvent(new Event('change', { bubbles: true })));
  await app.until('a different player asks first', () => expect(button('Replace')).toBeDefined());

  // The incoming stats don't fit, and then neither do the original achievements put back.
  const achievements = localStorage.getItem(STORAGE_KEYS.ACHIEVEMENTS);
  const setItem = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
    if (key === STORAGE_KEYS.STATS || (key === STORAGE_KEYS.ACHIEVEMENTS && value === achievements)) throw new DOMException('Full', 'QuotaExceededError');
    setItem.call(this, key, value);
  });
  await app.interact(() => button('Replace')!.click());
  await app.until('the player is told, then the page reloads', () => expect(reload).toHaveBeenCalledOnce());
  expect(alert).toHaveBeenCalledOnce();
  expect(alert.mock.calls[0][0]).toContain(PARTIAL_IMPORT_NOTE);
  expect(alert.mock.invocationCallOrder[0]).toBeLessThan(reload.mock.invocationCallOrder[0]);
}, 60_000);
