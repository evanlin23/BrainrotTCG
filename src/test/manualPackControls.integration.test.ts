// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://mounted.invalid/BrainrotTCG/"}
import { afterEach, expect, it, vi } from 'vitest';
import { mountedApp } from './mountedApp';
import { STORAGE_KEYS } from '../constants/config';
import type { Stats } from '../types';

let app: Awaited<ReturnType<typeof mountedApp>> | undefined;
afterEach(async () => { await app?.dispose(); app = undefined; });
const stats = (): Stats | null => JSON.parse(localStorage.getItem(STORAGE_KEYS.STATS) ?? 'null');
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')]
  .find((el) => (el.getAttribute('aria-label') ?? el.textContent?.trim()) === label)!;
const $ = (selector: string) => document.querySelector<HTMLElement>(selector);
const sealed = () => $('[aria-label^="Open a "]');
const progress = () => $('.reveal-progress')?.getAttribute('aria-valuenow');
// Nonce 22 of this key deals a special-reveal card, which a big-pull pause holds for its full reveal.
const preferences = ({ nextNonce = 0, pauseBigPulls = false } = {}) => ({
  'brainrot-player-v1': JSON.stringify({ secretKey: '01'.repeat(32), name: 'Manual fixture', nextNonce, createdAt: 1 }),
  [STORAGE_KEYS.SETTINGS]: JSON.stringify({ musicVolume: 0, effectsVolume: 0, particlesEnabled: false, pauseBigPulls }),
});

/** A mouse press from one element to another; the browser then clicks their nearest shared ancestor. */
function press(down: Element, up: Element, clicked: Element) {
  const Pointer = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
  const init = { bubbles: true, cancelable: true, button: 0, isPrimary: true, pointerType: 'mouse' };
  down.dispatchEvent(new Pointer('pointerdown', init));
  up.dispatchEvent(new Pointer('pointerup', init));
  clicked.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
}

async function reveal() {
  await app!.interact(() => {
    const shell = sealed()!;
    shell.focus();
    shell.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter', bubbles: true }));
    shell.dispatchEvent(new KeyboardEvent('keyup', { code: 'Enter', bubbles: true }));
  });
  await app!.until('manual Enter reveals the spent pack', () => expect(progress()).toBe('1'));
}

const pressA = () => app!.interact(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', key: 'a', bubbles: true })));
// From whatever has focus, as a real key press is: a sheet's own Escape handler sees it first.
const escape = () => app!.interact(() => (document.activeElement ?? document.body)
  .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })));
const toasts = () => [...document.querySelectorAll('.toast')].map((el) => el.textContent ?? '').join(' | ');
const openMyCards = () => app!.interact(() => [...document.querySelectorAll<HTMLButtonElement>('.app-nav button')].find((el) => el.textContent === 'My cards')!.click());

it('ignores the old auto-open key on the sealed pack and during a reveal', async () => {
  app = await mountedApp(preferences());
  await app.mount();
  await pressA();
  await app.settle(3000);
  expect(sealed()).not.toBeNull();
  expect($('.reveal-progress')).toBeNull();
  expect(stats()?.packsOpened ?? 0).toBe(0);

  await reveal();
  await pressA();
  await app.settle(3000);
  expect(progress()).toBe('1');
  expect($('.summary-card')).toBeNull();
  expect(stats()?.packsOpened ?? 0).toBe(0);
}, 30_000);

it('leaves a spent reveal by its button or empty space exactly once, but not after a fling off the card', async () => {
  app = await mountedApp(preferences());
  await app.mount();
  for (const [index, exit] of ['Close pack', 'click on empty space', 'press on empty space'].entries()) {
    await reveal();
    await app.interact(() => $('.card-wrapper')!.click());
    const area = $('.card-reveal-area')!;
    expect(area.classList).toContain('can-leave');
    // A fling that starts on the card and ends off it, or the reverse, clicks the area: neither leaves.
    await app.interact(() => press($('.card-wrapper')!, area, area));
    await app.interact(() => press(area, $('.card-wrapper')!, area));
    await app.settle(400);
    const round = `round ${index + 1} (${exit})`;
    expect(sealed(), `a fling between the card and empty space left the reveal in ${round}`).toBeNull();
    expect(button('Close pack'), `the reveal lost its Close pack button after a fling in ${round}`).toBeDefined();
    expect(stats()?.packsOpened ?? 0, `a fling between the card and empty space recorded the pack in ${round}`).toBe(index);

    await app.interact(() => {
      if (exit === 'Close pack') button('Close pack').click();
      // A click with no pointer press, as from assistive tech.
      else if (exit === 'click on empty space') area.click();
      else press($('.active-card-container')!, area, area);
    });
    await app.until('sealed pack is available again', () => expect(sealed()).not.toBeNull());
    expect(stats()?.packsOpened).toBe(index + 1);
    expect(stats()?.highestPackCards).toHaveLength(5);
    await app.interact(() => {
      window.dispatchEvent(new Event('blur'));
      window.dispatchEvent(new Event('resize'));
      window.dispatchEvent(new Event('focus'));
    });
    await pressA();
    await app.settle(1000);
    expect($('.reveal-progress')).toBeNull();
    expect(stats()?.packsOpened).toBe(index + 1);
  }
}, 30_000);

it('does not leave or record a reveal from behind an open sheet', async () => {
  app = await mountedApp(preferences());
  await app.mount();
  await reveal();
  await app.interact(() => $('.card-wrapper')!.click());
  const area = $('.card-reveal-area')!;
  expect(area.classList).toContain('can-leave');
  await app.interact(() => [...document.querySelectorAll<HTMLButtonElement>('.app-nav button')].find((el) => el.textContent === 'My cards')!.click());
  await app.until('a sheet opens over the reveal', () => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
  expect(area.classList, 'the area still offers leaving while a sheet covers it').not.toContain('can-leave');
  await app.interact(() => button('Close pack').click());
  await app.interact(() => area.click());
  await app.settle(400);
  expect(sealed(), 'a press behind the sheet left the reveal').toBeNull();
  expect(stats()?.packsOpened ?? 0, 'a press behind the sheet recorded the pack').toBe(0);
  await app.interact(() => button('Close').click());
  await app.until('the sheet closes', () => expect(document.querySelector('[role="dialog"]')).toBeNull());
  await app.interact(() => button('Close pack').click());
  await app.until('sealed pack is available again', () => expect(sealed()).not.toBeNull());
  expect(stats()?.packsOpened).toBe(1);
}, 30_000);

it('closes a reveal with Escape as Close pack does, and says the face-down cards were kept', async () => {
  app = await mountedApp(preferences());
  await app.mount();
  await reveal();
  await app.interact(() => $('.card-wrapper')!.click());
  expect(toasts()).not.toContain('Pack kept');
  await escape();
  await app.until('Escape closes the reveal', () => expect(sealed()).not.toBeNull());
  expect(stats()?.packsOpened).toBe(1);
  expect(stats()?.highestPackCards).toHaveLength(5);
  await app.until('a notice says the pack was kept', () => expect(toasts()).toContain('Pack kept'));
  expect(toasts()).toContain('Its cards are in My cards');
  // Tapping the notice opens the cards it names.
  await app.interact(() => [...document.querySelectorAll<HTMLButtonElement>('.toast')].find((el) => el.textContent?.includes('Pack kept'))!.click());
  await app.until('My cards opens from the notice', () => expect(document.querySelector('[role="dialog"]')?.textContent).toContain('My cards'));

  // With no reveal open, Escape only closes the sheet and opens or records nothing.
  await escape();
  await app.until('Escape closes the sheet', () => expect(document.querySelector('[role="dialog"]')).toBeNull());
  await escape();
  await app.settle(1000);
  expect($('.reveal-progress')).toBeNull();
  expect(stats()?.packsOpened).toBe(1);
}, 30_000);

it('does not say a pack was kept when its save failed', async () => {
  app = await mountedApp(preferences());
  await app.mount();
  // The progress writes App makes after a pack lands are refused, as a full browser storage would.
  const refused: string[] = [STORAGE_KEYS.COLLECTION, STORAGE_KEYS.ACHIEVEMENTS, STORAGE_KEYS.STATS, STORAGE_KEYS.HALL_OF_FAME];
  const setItem = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
    if (refused.includes(key)) throw new DOMException('Full', 'QuotaExceededError');
    setItem.call(this, key, value);
  });
  await reveal();
  await app.interact(() => $('.card-wrapper')!.click());
  await escape();
  await app.until('Escape closes the reveal', () => expect(sealed()).not.toBeNull());
  await app.until('the save warning shows', () => expect($('.app > p[role="alert"].save-warning')?.textContent).toMatch(/couldn't be saved/));
  await app.settle(1000);
  expect(toasts(), 'a pack whose save failed was said to be kept').not.toContain('Pack kept');
  expect(app.takeErrors(/^Failed to save to localStorage key /).length).toBeGreaterThan(0);
}, 30_000);

it('lets Escape close a sheet over the reveal without closing the reveal', async () => {
  app = await mountedApp(preferences());
  await app.mount();
  await reveal();
  await openMyCards();
  await app.until('a sheet opens over the reveal', () => expect(document.querySelector('[role="dialog"]')).not.toBeNull());
  await escape();
  await app.until('Escape closes the sheet', () => expect(document.querySelector('[role="dialog"]')).toBeNull());
  await app.settle(400);
  expect(progress(), 'Escape under a sheet also closed the reveal').toBe('1');
  expect(sealed()).toBeNull();
  expect(stats()?.packsOpened ?? 0, 'Escape under a sheet recorded the pack').toBe(0);
  expect(toasts()).not.toContain('Pack kept');
  await escape();
  await app.until('the next Escape closes the reveal', () => expect(sealed()).not.toBeNull());
  expect(stats()?.packsOpened).toBe(1);
}, 30_000);

it('shares from the summary, which puts its actions above the cards', async () => {
  app = await mountedApp(preferences());
  await app.mount(async () => {
    const graphics = await import('../game/bragImage');
    vi.spyOn(graphics, 'renderPoster').mockResolvedValue(new Blob(['pack'], { type: 'image/png' }));
    // Graphics/URL boundary only: jsdom can't draw the poster.
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL() { return 'blob:mounted-fixture'; }
      static revokeObjectURL() {}
    });
    return import('../App');
  });
  await reveal();
  await app.interact(() => button('Skip opening animation').click());
  await app.until('summary has all cards', () => expect(document.querySelectorAll('.summary-card')).toHaveLength(5));
  const actions = $('.summary-actions')!;
  expect(actions.compareDocumentPosition($('.summary-cards')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(button('Open another pack')).toBeDefined();
  expect(stats()?.packsOpened).toBe(1);
  expect(toasts(), 'a pack seen to the end said it was kept').not.toContain('Pack kept');

  await app.interact(() => button('Share').click());
  await app.until('share sheet opens for this pack', () => expect(button('Copy link')).toBeDefined());
  expect([...document.querySelectorAll('[role="dialog"]')].some((dialog) => dialog.textContent?.includes('Share your pull'))).toBe(true);
  expect(stats()?.packsOpened).toBe(1);
}, 30_000);

it('blocks every way out while a big pull holds the reveal', async () => {
  app = await mountedApp(preferences({ nextNonce: 22, pauseBigPulls: true }));
  await app.mount();
  await reveal();
  await app.interact(() => button('Skip opening animation').click());
  await app.until('skip stops on the big pull', () => expect($('.active-card-container')?.getAttribute('aria-busy')).toBe('true'));
  const area = $('.card-reveal-area')!;
  expect(button('Close pack').disabled).toBe(true);
  expect(area.classList).not.toContain('can-leave');
  await app.interact(() => {
    button('Close pack').click();
    area.click();
    press(area, area, area);
    press($('.active-card-container')!, area, area);
  });
  await escape();
  expect($('.active-card-container')?.getAttribute('aria-busy')).toBe('true');
  expect(sealed()).toBeNull();
  expect(stats()?.packsOpened ?? 0).toBe(0);

  await app.until('skip finishes after the hold', () => expect(document.querySelectorAll('.summary-card')).toHaveLength(5));
  expect(stats()?.packsOpened).toBe(1);
  const before = localStorage.getItem(STORAGE_KEYS.STATS);
  await app.reload();
  expect(localStorage.getItem(STORAGE_KEYS.STATS)).toBe(before);
  expect(sealed()).not.toBeNull();
}, 30_000);
