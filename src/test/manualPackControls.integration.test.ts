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
const preferences = {
  'brainrot-player-v1': JSON.stringify({ secretKey: '01'.repeat(32), name: 'Manual fixture', nextNonce: 0, createdAt: 1 }),
  [STORAGE_KEYS.SETTINGS]: JSON.stringify({ musicVolume: 0, effectsVolume: 0, particlesEnabled: false, pauseBigPulls: false }),
};

async function reveal() {
  await app!.interact(() => {
    const shell = document.querySelector<HTMLElement>('[aria-label^="Open a "]')!;
    shell.focus();
    shell.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter', bubbles: true }));
    shell.dispatchEvent(new KeyboardEvent('keyup', { code: 'Enter', bubbles: true }));
  });
  await app!.until('manual Enter reveals the spent pack', () => expect(button('Back to packs')).toBeDefined());
}

it('keeps opening manual, exits spent reveals exactly once, and puts summary actions above cards', async () => {
  app = await mountedApp(preferences);
  await app.mount();
  await app.interact(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', bubbles: true })));
  expect(document.querySelector('.reveal-skip')).toBeNull();
  expect(stats()?.packsOpened ?? 0).toBe(0);
  for (const [index, exit] of ['Back to packs', 'empty space'].entries()) {
    await reveal();
    await app.interact(() => document.querySelector<HTMLElement>('.card-wrapper')!.click());
    expect(button('Back to packs')).toBeDefined();
    expect(stats()?.packsOpened ?? 0).toBe(index);
    await app.interact(() => {
      if (exit === 'empty space') document.querySelector<HTMLElement>('.active-card-container')!.click();
      else button('Back to packs').click();
    });
    await app.until('sealed pack is available again', () => expect(document.querySelector('[aria-label^="Open a "]')).not.toBeNull());
    expect(stats()?.packsOpened).toBe(index + 1);
    expect(stats()?.highestPackCards).toHaveLength(5);
    await app.interact(() => {
      window.dispatchEvent(new Event('blur'));
      window.dispatchEvent(new Event('resize'));
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', bubbles: true }));
      vi.advanceTimersByTime(1000);
    });
    expect(stats()?.packsOpened).toBe(index + 1);
  }
  await reveal();
  await app.interact(() => button('Skip opening animation').click());
  await app.until('summary has all cards', () => expect(document.querySelectorAll('.summary-card')).toHaveLength(5));
  const actions = document.querySelector('.summary-actions')!;
  const cards = document.querySelector('.summary-cards')!;
  expect(actions.compareDocumentPosition(cards) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(button('Open another pack')).toBeDefined();
  expect(stats()?.packsOpened).toBe(3);
  const before = localStorage.getItem(STORAGE_KEYS.STATS);
  await app.reload();
  expect(localStorage.getItem(STORAGE_KEYS.STATS)).toBe(before);
  expect(document.querySelector('[aria-label^="Open a "]')).not.toBeNull();
}, 30_000);
