// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://mounted.invalid/BrainrotTCG/"}
import { afterEach, expect, it, vi } from 'vitest';
import { mountedApp } from './mountedApp';
import { openAgain } from './summaryLabels';
import { STORAGE_KEYS } from '../constants/config';
import { DEFAULT_SET_ID, SETS } from '../content/sets';

// The landing's "Change pack · N available" (DESIGN.md "Flow", item 8): for a returning player who has not
// opened the Packs sheet, it opens that sheet, switches nothing by itself, and is gone once the sheet has
// been seen from anywhere, after a reload too.

let app: Awaited<ReturnType<typeof mountedApp>> | undefined;
afterEach(async () => {
  await app?.dispose();
  app = undefined;
  vi.restoreAllMocks();
});

const changePack = () => document.querySelector<HTMLButtonElement>('button.change-pack');
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].reverse()
  .find((el) => (el.getAttribute('aria-label') ?? el.textContent?.trim()) === label)!;
const pack = () => document.querySelector<HTMLElement>('[data-pack-open]');
const packLabel = () => pack()?.getAttribute('aria-label')?.match(/^Open pack, (.+)$/)?.[1] ?? null;
const sheetTiles = () => [...document.querySelectorAll<HTMLButtonElement>('.pack-shelf-grid .pack-tile')];
const escape = () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));

const PLAYER = { 'brainrot-player-v1': JSON.stringify({ secretKey: '01'.repeat(32), name: 'Change pack fixture', nextNonce: 0, createdAt: 1 }) };
const QUIET = { [STORAGE_KEYS.SETTINGS]: JSON.stringify({ effectsVolume: 0, particlesEnabled: false, pauseBigPulls: false }) };
const RETURNING = { [STORAGE_KEYS.STATS]: JSON.stringify({ packsOpened: 1, holoCards: {}, highestPackValue: 0, highestPackCards: [] }) };
const defaultName = SETS.find((s) => s.id === DEFAULT_SET_ID)!.name;

const openSheetFromControl = async () => {
  await app!.interact(() => {
    changePack()!.focus();
    changePack()!.click();
  });
  await app!.until('the Packs sheet opens', () => expect(document.querySelector('[role="dialog"] .pack-shelf-grid')).not.toBeNull());
};

it('is not shown to a new player, even with every page shown', async () => {
  app = await mountedApp({ ...PLAYER, [STORAGE_KEYS.SETTINGS]: JSON.stringify({ effectsVolume: 0, particlesEnabled: false, showAllPages: true }) });
  await app.mount();
  expect(pack()).not.toBeNull();
  expect(document.querySelector('.set-picker')).not.toBeNull();
  expect(changePack()).toBeNull();
});

it('names how many other packs the sheet lists, and comes right after the pack', async () => {
  app = await mountedApp({ ...PLAYER, ...QUIET, ...RETURNING });
  await app.mount();
  const control = changePack()!;
  expect(control).not.toBeNull();
  const [, n] = control.textContent!.match(/^Change pack · (\d+) available$/)!;
  expect(control.getAttribute('aria-label')).toBe(`Change pack, ${n} available`);
  expect(control.getAttribute('aria-haspopup')).toBe('dialog');
  // The next focusable thing after the pack in document order.
  const focusable = [...document.querySelectorAll<HTMLElement>('main [tabindex="0"], main button:not(:disabled), main a[href]')];
  expect(focusable[focusable.indexOf(pack()!) + 1]).toBe(control);
  await openSheetFromControl();
  // N is the sheet's own list, less the pack already chosen.
  expect(sheetTiles().length - 1).toBe(Number(n));
});

it('opens the Packs sheet with no switch; a pick there lands focus on the new pack, and the control stays gone after a reload', async () => {
  app = await mountedApp({ ...PLAYER, ...QUIET, ...RETURNING });
  await app.mount();
  const before = localStorage.getItem(STORAGE_KEYS.SELECTED_SET);
  await openSheetFromControl();
  expect(packLabel()).toBe(defaultName);
  expect(localStorage.getItem(STORAGE_KEYS.SELECTED_SET)).toBe(before);
  expect(sheetTiles().find((t) => t.getAttribute('aria-pressed') === 'true')!.textContent).toContain(defaultName);
  expect(localStorage.getItem(STORAGE_KEYS.PACKS_SHEET_SEEN)).toBe('1');

  const other = sheetTiles().find((t) => t.getAttribute('aria-pressed') === 'false')!;
  await app.interact(() => other.click());
  await app.until('the sheet closed and the other pack is waiting', () => {
    expect(document.querySelector('.pack-shelf-grid')).toBeNull();
    expect(packLabel()).not.toBe(defaultName);
  });
  expect(document.activeElement).toBe(pack());
  expect(changePack()).toBeNull();

  await app.reload();
  expect(pack()).not.toBeNull();
  expect(changePack()).toBeNull();
});

it('closed with no pick, keeps the chosen pack and puts focus on it', async () => {
  app = await mountedApp({ ...PLAYER, ...QUIET, ...RETURNING });
  await app.mount();
  await openSheetFromControl();
  await app.interact(escape);
  await app.until('the sheet closed', () => expect(document.querySelector('.pack-shelf-grid')).toBeNull());
  expect(packLabel()).toBe(defaultName);
  expect(changePack()).toBeNull();
  expect(document.activeElement).toBe(pack());
});

it('picking the pack already chosen changes nothing and puts focus on it', async () => {
  app = await mountedApp({ ...PLAYER, ...QUIET, ...RETURNING });
  await app.mount();
  await openSheetFromControl();
  await app.interact(() => sheetTiles().find((t) => t.getAttribute('aria-pressed') === 'true')!.click());
  await app.until('the sheet closed', () => expect(document.querySelector('.pack-shelf-grid')).toBeNull());
  expect(packLabel()).toBe(defaultName);
  expect(document.activeElement).toBe(pack());
});

it('is gone once the era picker has opened the sheet, and the picker keeps its own focus', async () => {
  app = await mountedApp({ ...PLAYER, ...QUIET, ...RETURNING });
  await app.mount();
  expect(changePack()).not.toBeNull();
  const era = document.querySelector<HTMLButtonElement>('.set-current')!;
  await app.interact(() => { era.focus(); era.click(); });
  await app.until('the Packs sheet opens', () => expect(document.querySelector('.pack-shelf-grid')).not.toBeNull());
  await app.interact(escape);
  await app.until('the sheet closed', () => expect(document.querySelector('.pack-shelf-grid')).toBeNull());
  expect(changePack()).toBeNull();
  expect(document.activeElement).toBe(era);
  await app.reload();
  expect(changePack()).toBeNull();
});

it('when storage refuses the mark, is gone for the rest of the visit and back on the next load', async () => {
  app = await mountedApp({ ...PLAYER, ...QUIET, ...RETURNING });
  await app.mount();
  const setItem = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
    if (key === STORAGE_KEYS.PACKS_SHEET_SEEN) throw new DOMException('full', 'QuotaExceededError');
    setItem.call(this, key, value);
  });
  await openSheetFromControl();
  await app.interact(escape);
  await app.until('the sheet closed', () => expect(document.querySelector('.pack-shelf-grid')).toBeNull());
  expect(localStorage.getItem(STORAGE_KEYS.PACKS_SHEET_SEEN)).toBeNull();
  expect(changePack()).toBeNull();
  vi.restoreAllMocks();
  await app.reload();
  expect(changePack()).not.toBeNull();
});

it('is never mid-reveal or on the summary, and after the summary\'s own sheet it is gone from the landing', async () => {
  app = await mountedApp({ ...PLAYER, ...QUIET, ...RETURNING });
  await app.mount();
  expect(changePack()).not.toBeNull();
  await app.interact(() => { pack()!.focus(); pack()!.click(); });
  await app.until('the reveal has Skip', () => expect(document.querySelector('.reveal-skip')).not.toBeNull());
  expect(changePack()).toBeNull();
  await app.interact(() => button('Skip opening animation').click());
  await app.until('the summary has all five cards', () => expect(document.querySelectorAll('.summary-card')).toHaveLength(5));
  expect(changePack()).toBeNull();
  await app.until('the summary takes clicks', () => expect(document.querySelector('.summary-cards')!.hasAttribute('data-settling')).toBe(false));
  await app.interact(() => document.querySelector<HTMLButtonElement>('.summary-try-another')!.click());
  await app.until('the Packs sheet opens', () => expect(document.querySelector('.pack-shelf-grid')).not.toBeNull());
  await app.interact(escape);
  await app.until('the sheet closed', () => expect(document.querySelector('.pack-shelf-grid')).toBeNull());
  await app.interact(() => button(openAgain()).click());
  await app.until('the sealed pack is back', () => expect(document.querySelector('.card-guide-entry')).not.toBeNull());
  expect(changePack()).toBeNull();
});
