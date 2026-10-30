// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://mounted.invalid/BrainrotTCG/"}
import { afterEach, expect, it, vi } from 'vitest';
import { mountedApp } from './mountedApp';
import { STORAGE_KEYS } from '../constants/config';
import { getSetCards } from '../data/cards';
import { SETS } from '../content/sets';
import { CURRENT_DATA_VERSION, DATA_VERSION_KEY } from '../utils/migrations';

let app: Awaited<ReturnType<typeof mountedApp>> | undefined;
afterEach(async () => { await app?.dispose(); app = undefined; });
const currentTab = () => document.querySelector('.app-nav [aria-current="page"]')?.textContent ?? null;
const tab = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('.app-nav button')].find((el) => el.textContent === label)!;
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].reverse()
  .find((el) => (el.getAttribute('aria-label') ?? el.textContent?.trim()) === label)!;
const pageTitle = () => document.querySelector('main.page h1')?.textContent ?? null;
const packsHidden = () => document.querySelector<HTMLElement>('main.app-main')!.hidden;

const PLAYER = { 'brainrot-player-v1': JSON.stringify({ secretKey: '01'.repeat(32), name: 'Navigation fixture', nextNonce: 0, createdAt: 1 }) };
const QUIET = { 'brainrot-settings-v1': JSON.stringify({ effectsVolume: 0 }) };
/** A player who has saved a pack, so the tabs show (#222). */
const RETURNING = { 'brainrot-stats-v1': JSON.stringify({ packsOpened: 1, holoCards: {}, highestPackValue: 0, highestPackCards: [] }) };

it('shows a new player only the packs screen and Settings until their first pack is saved', async () => {
  app = await mountedApp({ ...PLAYER, ...QUIET });
  await app.mount();
  expect(document.querySelector('.app-nav')).toBeNull();
  expect(document.querySelector('.app')!.classList).toContain('no-nav');
  expect(button('Settings')).toBeDefined();
  expect(button('Profile')).toBeUndefined();
});

const picker = () => document.querySelector('nav.set-picker[aria-label="Choose a pack"]');
const showEveryPage = () => [...document.querySelectorAll<HTMLButtonElement>('[role="switch"]')]
  .find((el) => document.getElementById(el.getAttribute('aria-labelledby') ?? '')?.textContent === 'Show every page');

// #222: gating is only for people who haven't opened a pack; someone who knows the game can skip it.
it('lets an experienced player show every page and the pack picker before saving a pack, and keeps the choice across a reload', async () => {
  app = await mountedApp({ ...PLAYER, ...QUIET });
  await app.mount();
  expect(document.querySelector('.app-nav')).toBeNull();
  expect(picker()).toBeNull();

  // The gear is always there; its Show every page switch is off for a new player.
  await app.interact(() => button('Settings').click());
  await app.until('Settings loads', () => expect(showEveryPage()).toBeTruthy());
  expect(showEveryPage()!.getAttribute('aria-checked')).toBe('false');
  expect(document.querySelector('.app-nav')).toBeNull();
  await app.interact(() => showEveryPage()!.click());
  await app.until('the tabs show', () => expect(document.querySelector('.app-nav')).not.toBeNull());
  expect(document.querySelector('.app')!.classList).not.toContain('no-nav');
  expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.SETTINGS)!).showAllPages).toBe(true);
  // No pack was saved, so this is only the setting: the player is still a new one.
  expect(localStorage.getItem(STORAGE_KEYS.STATS)).toBeNull();

  // Every page opens from the tabs; the packs screen shows the set picker again.
  for (const [label, hash] of [['Cards', '#/cards'], ['Rankings', '#/rankings'], ['Profile', '#/profile']] as const) {
    await app.interact(() => tab(label).click());
    expect(location.hash).toBe(hash);
    expect(currentTab()).toBe(label);
    expect(pageTitle()).toBe(label);
  }
  await app.interact(() => tab('Open').click());
  await app.until('Open shows again', () => expect(packsHidden()).toBe(false));
  expect(picker()).not.toBeNull();

  await app.reload();
  await app.until('the tabs return after a reload', () => expect(document.querySelector('.app-nav')).not.toBeNull());
  expect(picker()).not.toBeNull();

  // Switching it off puts a player with no saved pack back to the packs screen alone.
  await app.interact(() => button('Settings').click());
  await app.until('Settings loads', () => expect(showEveryPage()!.getAttribute('aria-checked')).toBe('true'));
  await app.interact(() => showEveryPage()!.click());
  await app.until('the tabs hide again', () => expect(document.querySelector('.app-nav')).toBeNull());
});
/** The set the sealed pack names for a screen reader ("Open pack, <name>"), or null when no pack is ready. */
const packLabel = () => document.querySelector('[data-pack-open]')?.getAttribute('aria-label')?.match(/^Open pack, (.+)$/)?.[1] ?? null;
/** An old save, or one whose stats couldn't be read: cards but no pack count. */
const CARDS_ONLY = {
  [STORAGE_KEYS.COLLECTION]: JSON.stringify(Object.fromEntries([getSetCards(SETS[0].id)[0]].map((card) => [card.key, { card, normalCount: 1, holoCount: 0 }]))),
  [DATA_VERSION_KEY]: String(CURRENT_DATA_VERSION),
};

it('shows a new player the set picker only once their first pack is saved, and never mid-reveal', async () => {
  app = await mountedApp({ ...PLAYER, [STORAGE_KEYS.SETTINGS]: JSON.stringify({ effectsVolume: 0, particlesEnabled: false, pauseBigPulls: false }) });
  await app.mount();
  const first = packLabel();
  expect(first).not.toBeNull();
  expect(picker()).toBeNull();

  await app.interact(() => {
    // The Open pack button under the pack: the same opening as a finished swipe (#312).
    const open = document.querySelector<HTMLElement>('[data-pack-open]')!;
    expect(open).not.toBeNull();
    open.focus();
    open.click();
  });
  await app.until('the ticket produces a reveal with Skip', () => expect(document.querySelector('.reveal-skip')).not.toBeNull());
  expect(picker()).toBeNull();
  await app.interact(() => button('Skip opening animation').click());
  await app.until('Skip completes the summary', () => expect(document.querySelectorAll('.summary-card')).toHaveLength(5));
  // Saved at the summary, which is still focus mode: its CSS keeps the picker and tabs out of the way.
  expect(document.querySelector('.app')!.classList).toContain('is-focus');

  await app.interact(() => button('Next pack').click());
  await app.until('the picker shows once the pack is left', () => expect(picker()).not.toBeNull());
  expect(document.querySelector('.app')!.classList).not.toContain('is-focus');
  expect(document.querySelector('.app-nav')).not.toBeNull();
  expect(packLabel()).toBe(first);
});

it('brings a new player the set picker and tabs as they leave a first pack whose ticket is still on its way, not when it lands (#464)', async () => {
  app = await mountedApp({ ...PLAYER, [STORAGE_KEYS.SETTINGS]: JSON.stringify({ effectsVolume: 0, particlesEnabled: false, pauseBigPulls: false }) },
    { tickets: () => ({ delayMs: 4000 }) });
  await app.mount();
  await app.interact(() => {
    // The Open pack button under the pack: the same opening as a finished swipe (#312).
    const open = document.querySelector<HTMLElement>('[data-pack-open]')!;
    expect(open).not.toBeNull();
    open.focus();
    open.click();
  });
  await app.until('the slow ticket says so', () => expect(document.querySelector('.pack-hint.is-waiting')).not.toBeNull());
  expect(picker()).toBeNull();

  await app.interact(() => button('Back to packs').click());
  expect(document.querySelector('.app')!.classList).not.toContain('is-focus');
  expect(localStorage.getItem(STORAGE_KEYS.STATS), 'the pack was saved before its ticket landed').toBeNull();
  expect(picker(), 'the picker waited for the ticket').not.toBeNull();
  expect(document.querySelector('.app-nav'), 'the tabs waited for the ticket').not.toBeNull();
  expect(document.querySelector('.app')!.classList).not.toContain('no-nav');

  await app.until('the late pack is recorded', () => expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.STATS) ?? 'null')?.packsOpened).toBe(1));
  expect(picker()).not.toBeNull();
  expect(document.querySelector('.app-nav')).not.toBeNull();
});

it.each([['a saved pack', RETURNING], ['cards but no pack count', CARDS_ONLY]])('shows the set picker to a player with %s', async (_, save) => {
  app = await mountedApp({ ...PLAYER, ...QUIET, ...save });
  await app.mount();
  expect(picker()).not.toBeNull();
  expect(document.querySelector('.app-nav')).not.toBeNull();
});

// #902: the switch only matters before the pages show up on their own; after that it would change nothing.
it.each([['a saved pack', RETURNING], ['cards but no pack count', CARDS_ONLY]])('leaves the Show every page switch out of Settings for a player with %s, and keeps every page', async (_, save) => {
  app = await mountedApp({ ...PLAYER, ...QUIET, ...save });
  await app.mount();
  await app.interact(() => button('Settings').click());
  await app.until('Settings loads', () => expect(document.querySelector('[role="switch"]')).not.toBeNull());
  expect(showEveryPage()).toBeUndefined();
  // The rest of the section is untouched, and the pages are still there.
  expect([...document.querySelectorAll('[role="switch"]')].map((el) => document.getElementById(el.getAttribute('aria-labelledby') ?? '')?.textContent))
    .toEqual(['Particles', 'Pause on good pulls', 'Preview upcoming sets']);
  expect(document.querySelector('.app-nav')).not.toBeNull();
});

it('keeps a stored Show every page choice, and its tabs, when the switch is out of Settings', async () => {
  const stored = JSON.stringify({ effectsVolume: 0, showAllPages: true });
  app = await mountedApp({ ...PLAYER, 'brainrot-settings-v1': stored, ...RETURNING });
  await app.mount();
  await app.interact(() => button('Settings').click());
  await app.until('Settings loads', () => expect(document.querySelector('[role="switch"]')).not.toBeNull());
  expect(showEveryPage()).toBeUndefined();
  expect(document.querySelector('.app-nav')).not.toBeNull();
  expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.SETTINGS)!).showAllPages).toBe(true);
});

it('shows the switch again to a new player who has stored the choice, so they can reverse it', async () => {
  app = await mountedApp({ ...PLAYER, 'brainrot-settings-v1': JSON.stringify({ effectsVolume: 0, showAllPages: true }) });
  await app.mount();
  await app.interact(() => button('Settings').click());
  await app.until('Settings loads', () => expect(showEveryPage()).toBeTruthy());
  expect(showEveryPage()!.getAttribute('aria-checked')).toBe('true');
});

it('removes the Show every page switch from Settings when an imported save unlocks pages', async () => {
  app = await mountedApp({ ...PLAYER, ...QUIET });
  await app.mount();
  await app.interact(() => button('Settings').click());
  await app.until('Settings loads', () => expect(showEveryPage()).toBeTruthy());
  expect(showEveryPage()!.getAttribute('aria-checked')).toBe('false');

  const reload = vi.spyOn(await import('../game/reload'), 'reloadPage').mockImplementation(() => {});
  const save = JSON.stringify({
    version: 2,
    exportedAt: '2026-10-14T00:00:00.000Z',
    dataVersion: CURRENT_DATA_VERSION,
    player: JSON.stringify({ secretKey: '03'.repeat(32), name: 'Imported Player', nextNonce: 1, createdAt: 1 }),
    stats: JSON.stringify({ packsOpened: 1, holoCards: {} }),
    collection: '{}',
    achievements: '{}',
    hallOfFame: '{}',
    settings: JSON.stringify({ effectsVolume: 0 }),
    history: '[]',
  });
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { value: [new File([save], 'save.json', { type: 'application/json' })], configurable: true });
  await app.interact(() => input.dispatchEvent(new Event('change', { bubbles: true })));
  await app.until('import reloads the page', () => expect(reload).toHaveBeenCalled());

  await app.reload();
  await app.until('the tabs show after importing an unlocked save', () => expect(document.querySelector('.app-nav')).not.toBeNull());
  await app.interact(() => button('Settings').click());
  await app.until('Settings loads', () => expect(document.querySelector('.settings-group')).not.toBeNull());
  expect(showEveryPage()).toBeUndefined();
});

it('restores the Show every page switch to Settings when resetting to a fresh player', async () => {
  app = await mountedApp({ ...RETURNING, ...QUIET, 'brainrot-player-v1': 'not-json' });
  await app.mount();
  await app.interact(() => button('Settings').click());
  await app.until('Settings loads', () => expect(document.querySelector('.settings-group')).not.toBeNull());
  expect(showEveryPage()).toBeUndefined();

  const startBtn = button('Start a new player');
  expect(startBtn).toBeDefined();
  const reload = vi.spyOn(await import('../game/reload'), 'reloadPage').mockImplementation(() => {});
  await app.interact(() => startBtn.click());
  await app.until('confirmation question appears', () => expect(document.querySelector('.btn--danger')).not.toBeNull());
  await app.interact(() => document.querySelector<HTMLButtonElement>('.btn--danger')!.click());
  expect(reload).toHaveBeenCalled();

  await app.reload();
  expect(document.querySelector('.app-nav')).toBeNull();
  await app.interact(() => button('Settings').click());
  await app.until('Settings loads', () => expect(showEveryPage()).toBeTruthy());
  expect(showEveryPage()!.getAttribute('aria-checked')).toBe('false');
});

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
  // One h1 per view: on a page it is the page's title, and the logo is a link home instead.
  expect(document.querySelectorAll('h1')).toHaveLength(1);
  expect(document.querySelector('.app-logo')!.tagName).toBe('A');
  expect(document.querySelector('.app-logo')!.getAttribute('aria-label')).toBe('Brainrot TCG, home');
  // The packs screen stays mounted under the page, hidden and inert, so a pack in progress survives.
  expect(packsHidden()).toBe(true);
  expect(document.querySelector('main.app-main')!.hasAttribute('inert')).toBe(true);
  await app.until('Cards loads', () => expect(document.querySelector('.collection')).not.toBeNull());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(currentTab()).toBe('Cards');

  await app.interact(() => tab('Profile').click());
  expect(location.hash).toBe('#/profile');
  await app.until('Profile loads', () => expect(button('Edit name')).toBeDefined());
  expect(pageTitle()).toBe('Profile');
  expect(currentTab()).toBe('Profile');
  expect(document.body.textContent).toContain('Saved in this browser');
  // Achievements is a section of Profile, under its own name.
  expect(document.querySelector('#achievements h2')?.textContent).toBe('Achievements');
  await app.interact(() => button('Edit name').click());
  await app.interact(() => {
    const input = document.querySelector<HTMLInputElement>('input[autocomplete="nickname"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Changed name');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await app.interact(() => button('Save').click());
  expect(JSON.parse(localStorage.getItem('brainrot-player-v1')!).name).toBe('Changed name');

  // Profile's save note opens Settings at Save & backup; Settings is none of the tabs.
  await app.interact(() => button('Back up').click());
  expect(location.hash).toBe('#/settings');
  await app.until('Save & backup loads', () => expect(button('Import')).toBeDefined());
  expect(document.activeElement?.textContent).toBe('Save & backup');
  expect(button('Export')).toBeDefined();
  expect(document.querySelectorAll('input[type="range"]')).toHaveLength(1);
  expect(currentTab()).toBeNull();
  expect(button('Settings').getAttribute('aria-current')).toBe('page');

  await app.interact(() => history.back());
  await app.until('Back returns to Profile', () => expect(document.querySelector('#player h2')?.textContent).toBe('Changed name'));
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
  expect(document.querySelectorAll('h1')).toHaveLength(1);
  expect(document.querySelector('.app-logo')!.tagName).toBe('H1');
  expect(JSON.parse(localStorage.getItem('brainrot-player-v1')!).nextNonce).toBe(0);
});

it('opens the gear as the Settings page with its three sections', async () => {
  app = await mountedApp({ ...PLAYER, ...QUIET, ...RETURNING });
  await app.mount();
  await app.interact(() => button('Settings').click());
  expect(location.hash).toBe('#/settings');
  expect(document.title).toBe('Settings - Brainrot TCG');
  await app.until('Settings loads', () => expect(document.querySelector('.settings-group')).not.toBeNull());
  expect([...document.querySelectorAll('main.page h2')].map((el) => el.textContent)).toEqual(['Sound & display', 'Save & backup', 'Help']);
  expect(document.activeElement).toBe(document.querySelector('main.page h1'));
});

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
});

it('treats a bare #/profile as your own Profile page and #/profile/<id> as a shared one', async () => {
  app = await mountedApp({ ...PLAYER, ...QUIET, ...RETURNING });
  history.replaceState(null, '', '/BrainrotTCG/#/profile');
  await app.mount();
  expect(pageTitle()).toBe('Profile');
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await app.until('Profile loads', () => expect(button('Edit name')).toBeDefined());
  // Loaded directly: focus stays where the browser put it, and closing swaps in Open.
  expect(document.activeElement).toBe(document.body);
  await app.interact(() => button('Close Profile').click());
  expect(location.hash).toBe('');
  expect(packsHidden()).toBe(false);
});
