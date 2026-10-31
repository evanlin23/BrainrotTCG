// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://mounted.invalid/BrainrotTCG/"}
import { afterEach, expect, it } from 'vitest';
import { mountedApp } from './mountedApp';
import { openAgain } from './summaryLabels';
import { STORAGE_KEYS } from '../constants/config';
import { DEFAULT_SET_ID, SETS, isOpenable } from '../content/sets';

let app: Awaited<ReturnType<typeof mountedApp>> | undefined;
afterEach(async () => { await app?.dispose(); app = undefined; });

const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].reverse()
  .find((el) => (el.getAttribute('aria-label') ?? el.textContent?.trim()) === label)!;
const tryAnother = () => [...document.querySelectorAll<HTMLButtonElement>('.summary-try-another')].find((el) => el.textContent?.startsWith('Try another pack'));
const packLabel = () => document.querySelector('[data-pack-open]')?.getAttribute('aria-label')?.match(/^Open pack, (.+)$/)?.[1] ?? null;
const PLAYER = { 'brainrot-player-v1': JSON.stringify({ secretKey: '01'.repeat(32), name: 'Try another fixture', nextNonce: 0, createdAt: 1 }) };
const QUIET = { [STORAGE_KEYS.SETTINGS]: JSON.stringify({ effectsVolume: 0, particlesEnabled: false, pauseBigPulls: false }) };

const toSummary = async () => {
  await app!.mount();
  await app!.interact(() => {
    const open = document.querySelector<HTMLElement>('[data-pack-open]')!;
    open.focus();
    open.click();
  });
  await app!.until('the reveal has Skip', () => expect(document.querySelector('.reveal-skip')).not.toBeNull());
  await app!.interact(() => button('Skip opening animation').click());
  await app!.until('the summary has all five cards', () => expect(document.querySelectorAll('.summary-card')).toHaveLength(5));
};

it('is not on the sealed pack or mid-reveal, only on the summary of a finished pack', async () => {
  app = await mountedApp({ ...PLAYER, ...QUIET });
  await app.mount();
  expect(tryAnother()).toBeUndefined();
  await app.interact(() => {
    const open = document.querySelector<HTMLElement>('[data-pack-open]')!;
    open.focus();
    open.click();
  });
  await app.until('the reveal has Skip', () => expect(document.querySelector('.reveal-skip')).not.toBeNull());
  expect(tryAnother()).toBeUndefined();
  await app.interact(() => button('Skip opening animation').click());
  await app.until('the summary shows Try another pack', () => expect(tryAnother()).toBeDefined());
});

it('opens the Packs sheet from the summary with the selection unchanged, and a pick there is the picker\'s pick', async () => {
  expect(SETS.filter(isOpenable).length).toBeGreaterThan(1);
  app = await mountedApp({ ...PLAYER, ...QUIET });
  await toSummary();
  await app.until('Try another pack shows', () => expect(tryAnother()).toBeDefined());
  expect(button(openAgain())).toBeDefined();
  const before = localStorage.getItem(STORAGE_KEYS.SELECTED_SET);
  await app.until('the summary takes clicks', () => expect(document.querySelector('.summary-cards')!.hasAttribute('data-settling')).toBe(false));
  await app.interact(() => tryAnother()!.click());
  await app.until('the Packs sheet opens', () => expect(document.querySelector('.pack-shelf-grid')).not.toBeNull());
  expect(document.querySelector('[role="dialog"] .pack-shelf-grid')).not.toBeNull();
  expect(localStorage.getItem(STORAGE_KEYS.SELECTED_SET)).toBe(before);
  const tiles = [...document.querySelectorAll<HTMLButtonElement>('.pack-shelf-grid .pack-tile')];
  expect(tiles.filter((t) => t.getAttribute('aria-pressed') === 'true')).toHaveLength(1);
  expect(tiles.find((t) => t.getAttribute('aria-pressed') === 'true')!.textContent).toContain(SETS.find((s) => s.id === DEFAULT_SET_ID)!.name);

  // Choosing another set: the same select the landing picker makes, so the packs screen is that set's.
  const other = tiles.find((t) => t.getAttribute('aria-pressed') === 'false')!;
  await app.interact(() => other.click());
  await app.until('the sheet closed and the other pack is waiting', () => {
    expect(document.querySelector('.pack-shelf-grid')).toBeNull();
    expect(packLabel()).not.toBeNull();
  });
  expect(packLabel()).not.toBe(SETS.find((s) => s.id === DEFAULT_SET_ID)!.name);
  // The summary and the control that opened the sheet are gone: the new sealed pack takes focus, not the page.
  expect(document.activeElement).toBe(document.querySelector('[data-pack-open]'));
  expect(localStorage.getItem(STORAGE_KEYS.SELECTED_SET)).not.toBe(before);
});

it('forgets that the summary opened the sheet when it closes with no pick: a later pick by another way does not pull focus onto the pack', async () => {
  app = await mountedApp({ ...PLAYER, ...QUIET });
  await toSummary();
  await app.until('Try another pack shows and takes clicks', () => {
    expect(tryAnother()).toBeDefined();
    expect(document.querySelector('.summary-cards')!.hasAttribute('data-settling')).toBe(false);
  });
  await app.interact(() => tryAnother()!.click());
  await app.until('the Packs sheet opens', () => expect(document.querySelector('.pack-shelf-grid')).not.toBeNull());
  // Escape from whatever has focus, as a real key press is.
  await app.interact(() => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })));
  await app.until('the sheet closed', () => expect(document.querySelector('.pack-shelf-grid')).toBeNull());
  expect(tryAnother()).toBeDefined();
  // Back to the packs screen, then the picker's older/newer step (a pick that never opens the sheet, like a set link).
  await app.interact(() => button(openAgain()).click());
  await app.until('the packs screen is back', () => expect(document.querySelector('.set-step:not(:disabled)')).not.toBeNull());
  const before = packLabel();
  const step = document.querySelector<HTMLButtonElement>('.set-step:not(:disabled)')!;
  // Nothing holds focus (a set link lands like this), the one case where a pack mounting takes it.
  await app.interact(() => { (document.activeElement as HTMLElement | null)?.blur(); step.click(); });
  await app.until('the other pack is waiting', () => expect(packLabel()).not.toBe(before));
  // The old flag would have put focus on the new pack; this pick was not from the summary's sheet, so nothing moves focus.
  expect(document.activeElement).not.toBe(document.querySelector('[data-pack-open]'));
});
