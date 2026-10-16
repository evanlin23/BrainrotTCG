// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://mounted.invalid/BrainrotTCG/"}
import { afterEach, expect, it } from 'vitest';
import { mountedApp } from './mountedApp';

let app: Awaited<ReturnType<typeof mountedApp>> | undefined;
afterEach(async () => { await app?.dispose(); app = undefined; });
const currentTab = () => document.querySelector('.app-nav [aria-current="page"]')?.textContent ?? null;
const dialogName = () => {
  const dialog = document.querySelector('[role="dialog"]');
  return dialog && document.getElementById(dialog.getAttribute('aria-labelledby') ?? '')?.textContent;
};
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].reverse()
  .find((el) => (el.getAttribute('aria-label') ?? el.textContent?.trim()) === label)!;

it('keeps three primary destinations and gives identity, goals, sound and recovery predictable owners', async () => {
  app = await mountedApp({
    'brainrot-player-v1': JSON.stringify({ secretKey: '01'.repeat(32), name: 'Navigation fixture', nextNonce: 0, createdAt: 1 }),
    'brainrot-settings-v1': JSON.stringify({ musicVolume: 0, effectsVolume: 0 }),
  });
  await app.mount();
  expect([...document.querySelectorAll('.app-nav-label')].map((el) => el.textContent)).toEqual(['Open packs', 'My cards', 'Rankings']);
  expect(currentTab()).toBe('Open packs');
  await app.interact(() => button('My cards').click());
  await app.until('cards destination loads', () => expect(document.querySelector('.collection')).not.toBeNull());
  expect(document.querySelector('.personal-nav [aria-current="page"]')?.textContent).toBe('Cards');
  expect(currentTab()).toBe('My cards');
  await app.interact(() => button('Best pulls').click());
  await app.until('best pulls destination loads', () => expect(document.querySelector('.pulls-page')).not.toBeNull());
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  expect(document.querySelector('.personal-nav [aria-current="page"]')?.textContent).toBe('Best pulls');
  expect(document.body.textContent).toContain('No packs yet');
  await app.interact(() => button('Close').click());
  await app.interact(() => button('Player').click());
  await app.until('identity editor loads', () => expect(document.querySelector('input[autocomplete="nickname"]')).not.toBeNull());
  expect(document.body.textContent).toContain('saved in this browser');
  // A sheet that is none of the tabs leaves no tab current, rather than the page tab behind it.
  expect(currentTab()).toBeNull();
  await app.interact(() => {
    const input = document.querySelector<HTMLInputElement>('input[autocomplete="nickname"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Changed name');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
  });
  await app.interact(() => button('Save name').click());
  expect(JSON.parse(localStorage.getItem('brainrot-player-v1')!).name).toBe('Changed name');
  expect(document.querySelector('.pack-shell.is-cut')).toBeNull();
  await app.interact(() => button('Save & restore').click());
  await app.until('recovery controls load', () => expect(button('Import')).toBeDefined());
  expect(button('Export')).toBeDefined();
  expect(document.querySelector('input[autocomplete="nickname"]')).toBeNull();
  expect(document.querySelector('input[type="range"]')).toBeNull();
  await app.interact(() => button('Close').click());
  await app.interact(() => button('Sound & display').click());
  await app.until('sound controls load', () => expect(document.querySelectorAll('input[type="range"]')).toHaveLength(2));
  expect(button('Import')).toBeUndefined();
  await app.interact(() => button('Close').click());
  await app.interact(() => button('Player').click());
  await app.until('player reopens with saved name', () => expect(document.querySelector<HTMLInputElement>('input[autocomplete="nickname"]')?.value).toBe('Changed name'));
  await app.interact(() => button('Achievements').click());
  // The sheet keeps the button's name while its chunk loads and once it has loaded.
  expect(dialogName()).toBe('Achievements');
  await app.until('goals load', () => expect(document.querySelector('.achievements')).not.toBeNull());
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  expect(dialogName()).toBe('Achievements');
  expect(currentTab()).toBeNull();
  expect(JSON.parse(localStorage.getItem('brainrot-player-v1')!).nextNonce).toBe(0);
}, 30_000);

it('leaves no tab current while a sheet that is not a tab sits on top of My cards', async () => {
  app = await mountedApp({
    'brainrot-player-v1': JSON.stringify({ secretKey: '01'.repeat(32), name: 'Navigation fixture', nextNonce: 0, createdAt: 1 }),
    'brainrot-settings-v1': JSON.stringify({ musicVolume: 0, effectsVolume: 0 }),
  });
  await app.mount();
  await app.interact(() => button('My cards').click());
  await app.until('cards destination loads', () => expect(document.querySelector('.collection')).not.toBeNull());
  expect(currentTab()).toBe('My cards');
  // A shared link opened while My cards is up: its sheet goes on top without closing the tab's sheet.
  await app.interact(() => {
    history.replaceState(null, '', '#/pull/cut-off');
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  await app.until('broken link sheet opens', () => expect(
    [...document.querySelectorAll('[role="dialog"]')].map((dialog) => document.getElementById(dialog.getAttribute('aria-labelledby') ?? '')?.textContent),
  ).toContain("This link doesn't work"));
  expect(document.querySelector('.collection')).not.toBeNull();
  expect(currentTab()).toBeNull();
  await app.interact(() => button('Close').click());
  await app.until('broken link sheet closes', () => expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1));
  expect(window.location.hash).toBe('');
  expect(currentTab()).toBe('My cards');
}, 30_000);
