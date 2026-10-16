// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://mounted.invalid/BrainrotTCG/"}
import { afterEach, expect, it } from 'vitest';
import { mountedApp } from './mountedApp';

let app: Awaited<ReturnType<typeof mountedApp>> | undefined;
afterEach(async () => { await app?.dispose(); app = undefined; });
const currentTab = () => document.querySelector('.app-nav [aria-current="page"]')?.textContent ?? null;
const tab = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.app-nav button')].find((el) => el.textContent === label)!;
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].reverse()
  .find((el) => (el.getAttribute('aria-label') ?? el.textContent?.trim()) === label)!;
const pageTitle = () => document.querySelector('main.page h1')?.textContent ?? null;
const packsHidden = () => document.querySelector<HTMLElement>('main.app-main')!.hidden;

const PLAYER = { 'brainrot-player-v1': JSON.stringify({ secretKey: '01'.repeat(32), name: 'Navigation fixture', nextNonce: 0, createdAt: 1 }) };
const QUIET = { 'brainrot-settings-v1': JSON.stringify({ musicVolume: 0, effectsVolume: 0 }) };
/** A player who has saved a pack, so the tabs show (#222). */
const RETURNING = { 'brainrot-stats-v1': JSON.stringify({ packsOpened: 1, holoCards: {}, highestPackValue: 0, highestPackCards: [] }) };

it('shows a new player only the packs screen and Settings until their first pack is saved', async () => {
  app = await mountedApp({ ...PLAYER, ...QUIET });
  await app.mount();
  expect(document.querySelector('.app-nav')).toBeNull();
  expect(document.querySelector('.app')!.classList).toContain('no-nav');
  expect(button('Settings')).toBeDefined();
  expect(button('Player')).toBeUndefined();
}, 30_000);

it('gives Open, Cards, Rankings and Profile a page each, with an address, a title and Back between them', async () => {
  app = await mountedApp({ ...PLAYER, ...QUIET, ...RETURNING });
  await app.mount();
  const openTitle = document.title;
  expect([...document.querySelectorAll('.app-nav-label')].map((el) => el.textContent)).toEqual(['Open', 'Cards', 'Rankings', 'Profile']);
  expect(currentTab()).toBe('Open');
  expect(location.hash).toBe('');

  await app.interact(() => tab('Cards').click());
  expect(location.hash).toBe('#/cards');
  expect(document.title).toBe('Cards - Brainrot TCG');
  expect(document.activeElement).toBe(document.querySelector('main.page h1'));
  // The packs screen stays mounted under the page, hidden and inert, so a pack in progress survives.
  expect(packsHidden()).toBe(true);
  expect(document.querySelector('main.app-main')!.hasAttribute('inert')).toBe(true);
  await app.until('Cards loads', () => expect(document.querySelector('.collection')).not.toBeNull());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(currentTab()).toBe('Cards');

  await app.interact(() => tab('Profile').click());
  expect(location.hash).toBe('#/profile');
  await app.until('Profile loads', () => expect(document.querySelector('input[autocomplete="nickname"]')).not.toBeNull());
  expect(pageTitle()).toBe('Profile');
  expect(currentTab()).toBe('Profile');
  expect(document.body.textContent).toContain('saved in this browser');
  // Achievements is a section of Profile, under its own name.
  expect(document.querySelector('#achievements h2')?.textContent).toBe('Achievements');
  await app.interact(() => {
    const input = document.querySelector<HTMLInputElement>('input[autocomplete="nickname"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Changed name');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await app.interact(() => button('Save name').click());
  expect(JSON.parse(localStorage.getItem('brainrot-player-v1')!).name).toBe('Changed name');

  // Profile's save note opens Settings at Save & backup; Settings is none of the tabs.
  await app.interact(() => button('Save & backup').click());
  expect(location.hash).toBe('#/settings');
  await app.until('Save & backup loads', () => expect(button('Import')).toBeDefined());
  expect(document.activeElement?.textContent).toBe('Save & backup');
  expect(button('Export')).toBeDefined();
  expect(document.querySelectorAll('input[type="range"]')).toHaveLength(2);
  expect(currentTab()).toBeNull();
  expect(button('Settings').getAttribute('aria-current')).toBe('page');

  await app.interact(() => history.back());
  await app.until('Back returns to Profile', () => expect(document.querySelector<HTMLInputElement>('input[autocomplete="nickname"]')?.value).toBe('Changed name'));
  expect(location.hash).toBe('#/profile');
  await app.interact(() => history.back());
  await app.until('Back returns to Cards', () => expect(pageTitle()).toBe('Cards'));

  // Closing a page goes to Open, back over the entries it sat on.
  await app.interact(() => button('Close Cards').click());
  await app.until('Open shows again', () => expect(packsHidden()).toBe(false));
  expect(location.hash).toBe('');
  expect(document.title).toBe(openTitle);
  expect(currentTab()).toBe('Open');
  expect(document.activeElement).toBe(document.querySelector('.app-logo'));
  expect(JSON.parse(localStorage.getItem('brainrot-player-v1')!).nextNonce).toBe(0);
}, 30_000);

it('opens the gear as the Settings page with its three sections', async () => {
  app = await mountedApp({ ...PLAYER, ...QUIET, ...RETURNING });
  await app.mount();
  await app.interact(() => button('Settings').click());
  expect(location.hash).toBe('#/settings');
  expect(document.title).toBe('Settings - Brainrot TCG');
  await app.until('Settings loads', () => expect(document.querySelector('.settings-group')).not.toBeNull());
  expect([...document.querySelectorAll('main.page h2')].map((el) => el.textContent)).toEqual(['Sound & display', 'Save & backup', 'Help']);
  expect(document.activeElement).toBe(document.querySelector('main.page h1'));
}, 30_000);

it('leaves no tab current while a shared link sits on top of Cards, and closing it returns to Cards', async () => {
  app = await mountedApp({ ...PLAYER, ...QUIET, ...RETURNING });
  await app.mount();
  await app.interact(() => tab('Cards').click());
  await app.until('Cards loads', () => expect(document.querySelector('.collection')).not.toBeNull());
  expect(currentTab()).toBe('Cards');
  // A shared link opened while Cards is up: its sheet goes on top, the page stays behind it.
  await app.interact(() => { location.hash = '#/pull/cut-off'; });
  await app.until('broken link sheet opens', () => expect(
    [...document.querySelectorAll('[role="dialog"]')].map((dialog) => document.getElementById(dialog.getAttribute('aria-labelledby') ?? '')?.textContent),
  ).toContain("This link doesn't work"));
  expect(document.querySelector('.collection')).not.toBeNull();
  expect(currentTab()).toBeNull();
  await app.interact(() => button('Close').click());
  await app.until('broken link sheet closes', () => expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(0));
  expect(location.hash).toBe('#/cards');
  expect(currentTab()).toBe('Cards');
}, 30_000);

it('treats a bare #/profile as your own Profile page and #/profile/<id> as a shared one', async () => {
  app = await mountedApp({ ...PLAYER, ...QUIET, ...RETURNING });
  history.replaceState(null, '', '/BrainrotTCG/#/profile');
  await app.mount();
  expect(pageTitle()).toBe('Profile');
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await app.until('Profile loads', () => expect(document.querySelector('input[autocomplete="nickname"]')).not.toBeNull());
  // Loaded directly: focus stays where the browser put it, and closing swaps in Open.
  expect(document.activeElement).toBe(document.body);
  await app.interact(() => button('Close Profile').click());
  expect(location.hash).toBe('');
  expect(packsHidden()).toBe(false);
}, 30_000);
