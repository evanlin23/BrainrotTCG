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
  for (const [index, exit] of ['Back to packs', 'click on empty space', 'press on empty space'].entries()) {
    await reveal();
    await app.interact(() => $('.card-wrapper')!.click());
    const area = $('.card-reveal-area')!;
    expect(area.classList).toContain('can-leave');
    // A fling that starts on the card and ends off it, or the reverse, clicks the area: neither leaves.
    await app.interact(() => press($('.card-wrapper')!, area, area));
    await app.interact(() => press(area, $('.card-wrapper')!, area));
    await app.settle(400);
    expect(sealed()).toBeNull();
    expect(button('Back to packs')).toBeDefined();
    expect(stats()?.packsOpened ?? 0).toBe(index);

    await app.interact(() => {
      if (exit === 'Back to packs') button('Back to packs').click();
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
  expect(button('Back to packs').disabled).toBe(true);
  expect(area.classList).not.toContain('can-leave');
  await app.interact(() => {
    button('Back to packs').click();
    area.click();
    press(area, area, area);
    press($('.active-card-container')!, area, area);
  });
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
