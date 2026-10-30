// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://mounted.invalid/BrainrotTCG/"}
import { afterEach, expect, it, vi } from 'vitest';
import { mountedApp } from './mountedApp';
import { STORAGE_KEYS } from '../constants/config';

let app: Awaited<ReturnType<typeof mountedApp>> | undefined;
afterEach(async () => { await app?.dispose(); app = undefined; });

const PLAYER = { 'brainrot-player-v1': JSON.stringify({ secretKey: '01'.repeat(32), name: 'News fixture', nextNonce: 0, createdAt: 1 }) };
const QUIET = { 'brainrot-settings-v1': JSON.stringify({ effectsVolume: 0, particlesEnabled: false }) };
/** A player who has saved a pack (#222). */
const RETURNING = { 'brainrot-stats-v1': JSON.stringify({ packsOpened: 1, holoCards: {}, highestPackValue: 0, highestPackCards: [] }) };
const LONG = 'Static JSON is out. Fan tools can read every set and card without scraping, and this longer sentence is the part a one-line chip used to cut off.';
const NEWS = [
  { id: 'news-a', title: 'Open Card API', date: '2026-10-27', category: 'changelog', tag: 'Update', summary: LONG },
  { id: 'news-0', title: 'Player Profiles', date: '2026-10-25', summary: 'Share your profile.' },
];

const $ = (selector: string) => document.querySelector<HTMLElement>(selector);
const newsToast = () => [...document.querySelectorAll<HTMLElement>('.toast')].find((el) => el.textContent?.includes("What's new"));
const toastTexts = () => [...document.querySelectorAll('.toast')].map((el) => el.textContent ?? '');
const pageTitle = () => $('main.page h1')?.textContent ?? null;
const go = (hash: string) => app!.interact(() => { location.hash = hash; });
const press = (el: Element | null | undefined) => app!.interact(() => (el as HTMLElement).click());
const stored = () => localStorage.getItem(STORAGE_KEYS.DISMISSED_NEWS);

/** Opens the pack and leaves it early: it is put away, its own notice first in the queue. */
async function putPackAway() {
  const sealed = () => $('[data-pack-open]');
  await app!.interact(() => { sealed()!.focus(); sealed()!.click(); });
  await app!.until('the pack is open', () => expect($('.card-wrapper')).not.toBeNull());
  await app!.interact(() => (document.activeElement ?? document.body)
    .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })));
  await app!.until('the pack notice shows', () => expect(toastTexts().join()).toContain('Pack kept'));
}
/** A pack put away, its notice sent off, and the news toast that follows it on screen. */
async function newsToastAfterAPack() {
  await putPackAway();
  await press(document.querySelector('.toast-dismiss'));
  await app!.until('the news toast follows the pack notice', () => expect(newsToast()).toBeDefined(), 60_000);
}

it('shows no news toast before the first pack is saved, and does not read the news either (#58)', async () => {
  app = await mountedApp({ ...PLAYER, ...QUIET }, { news: NEWS });
  await app.mount();
  await app.settle(100);
  expect(newsToast()).toBeUndefined();
  expect(app.newsLoads()).toBe(0);
});

it('still shows none to a new player who only turned on Show every page', async () => {
  const settings = JSON.stringify({ effectsVolume: 0, showAllPages: true });
  app = await mountedApp({ ...PLAYER, 'brainrot-settings-v1': settings }, { news: NEWS });
  await app.mount();
  await app.settle(100);
  expect($('.app-nav')).not.toBeNull();
  expect(newsToast()).toBeUndefined();
  expect(app.newsLoads()).toBe(0);
});

it('shows a returning player no toast on a plain load or a route change, and does not read the news: only a pack put away asks for it', async () => {
  app = await mountedApp({ ...PLAYER, ...QUIET, ...RETURNING }, { news: NEWS });
  await app.mount();
  await app.settle(300);
  expect(newsToast()).toBeUndefined();
  expect(app.newsLoads()).toBe(0);
  await go('#/cards');
  await go('');
  await go('#/settings');
  await go('');
  await app.settle(300);
  expect(newsToast()).toBeUndefined();
  expect(app.newsLoads()).toBe(0);
  expect($('.news-banner')).toBeNull();
});

it('toasts the latest unread entry once a pack is put away, and the pack row carries no chip', async () => {
  app = await mountedApp({ ...PLAYER, ...QUIET, ...RETURNING }, { news: NEWS });
  await app.mount();
  await newsToastAfterAPack();
  expect(newsToast()?.textContent).toContain('Open Card API');
  expect(app.newsLoads()).toBe(1);
  expect($('.news-banner')).toBeNull();
  expect($('.card-guide-entry .card-guide-link')?.textContent?.trim()).toBe('Card guide');
  // Only the newest entry is toasted.
  expect(toastTexts().join()).not.toContain('Player Profiles');
});

it('opens What\'s new from the toast, reads the entry, and does not toast it again after a reload and another pack', async () => {
  app = await mountedApp({ ...PLAYER, ...QUIET, ...RETURNING }, { news: NEWS });
  await app.mount();
  await newsToastAfterAPack();
  await press(newsToast()!.querySelector('.toast-open'));
  await app.until('the page opens', () => expect($('.news-entry')).not.toBeNull());
  expect(pageTitle()).toBe("What's new");
  expect(location.hash).toBe('#/news');
  // Every entry, newest first, with the whole summary the chip used to cut off.
  const entries = [...document.querySelectorAll('.news-entry')];
  expect(entries.map((el) => el.querySelector('.news-entry-title')?.textContent)).toEqual(['Open Card API', 'Player Profiles']);
  expect(entries[0].textContent).toContain(LONG);
  await app.until('the toast has gone', () => expect(newsToast()).toBeUndefined());
  expect(stored()).toBe('news-a');

  await app.reload();
  await app.settle(100);
  expect(pageTitle()).toBe("What's new");
  await go('');
  await app.settle(500);
  await putPackAway();
  await app.settle(300);
  expect(newsToast()).toBeUndefined();
});

it('dismissing the toast with its X reads it: it does not come back after another pack or a reload', async () => {
  app = await mountedApp({ ...PLAYER, ...QUIET, ...RETURNING }, { news: NEWS });
  await app.mount();
  await newsToastAfterAPack();
  await press(newsToast()!.querySelector('.toast-dismiss'));
  await app.until('the toast goes', () => expect(newsToast()).toBeUndefined());
  expect(stored()).toBe('news-a');
  // Away to a page and back, and another pack put away: still no toast.
  await go('#/cards');
  await go('');
  await putPackAway();
  await app.settle(200);
  expect(newsToast()).toBeUndefined();

  await app.reload();
  await app.settle(200);
  expect(newsToast()).toBeUndefined();
});

it('a toast that timed out was seen, so it is read too', async () => {
  app = await mountedApp({ ...PLAYER, ...QUIET, ...RETURNING }, { news: NEWS });
  await app.mount();
  await newsToastAfterAPack();
  await app.until('it times out', () => expect(newsToast()).toBeUndefined(), 15_000);
  expect(stored()).toBe('news-a');
});

it('a player who already dismissed the entry is not toasted after a pack', async () => {
  const mounted = await mountedApp({ ...PLAYER, ...QUIET, ...RETURNING, [STORAGE_KEYS.DISMISSED_NEWS]: 'news-a' }, { news: NEWS });
  app = mounted;
  await app.mount();
  await putPackAway();
  await press(document.querySelector('.toast-dismiss'));
  await app.until('the news was asked for', () => expect(mounted.newsLoads()).toBe(1));
  await app.settle(200);
  expect(newsToast()).toBeUndefined();
});

it('holds for the visit when storage refuses the dismissal (a full or blocked store)', async () => {
  app = await mountedApp({ ...PLAYER, ...QUIET, ...RETURNING }, { news: NEWS });
  await app.mount();
  await newsToastAfterAPack();
  const write = Storage.prototype.setItem;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
    if (key === STORAGE_KEYS.DISMISSED_NEWS) throw new DOMException('Injected quota failure', 'QuotaExceededError');
    write.call(this, key, value);
  });
  await press(newsToast()!.querySelector('.toast-dismiss'));
  await app.until('the toast goes', () => expect(newsToast()).toBeUndefined());
  expect(stored()).toBeNull();
  await go('#/cards');
  await go('');
  await putPackAway();
  await app.settle(200);
  expect(newsToast()).toBeUndefined();
});

it('opening the page by its address reads the entry and takes a waiting toast out of the queue', async () => {
  app = await mountedApp({ ...PLAYER, ...QUIET, ...RETURNING }, { news: NEWS });
  await app.mount();
  await newsToastAfterAPack();
  await go('#/news');
  await app.until('the page opens', () => expect($('.news-entry')).not.toBeNull());
  await app.until('the toast is out of the queue', () => expect(newsToast()).toBeUndefined());
  expect(stored()).toBe('news-a');
  await go('');
  await app.settle(200);
  expect(newsToast()).toBeUndefined();
});

it('is a page for a first-time visitor with no save, and reading it asks for no pack', async () => {
  app = await mountedApp({ ...QUIET }, { news: NEWS });
  location.hash = '#/news';
  await app.mount();
  await app.until('the page opens', () => expect(pageTitle()).toBe("What's new"));
  expect(document.title).toBe("What's new - Brainrot TCG");
  expect(document.querySelectorAll('.news-entry')).toHaveLength(2);
  expect($('.app-nav')).toBeNull();
});

it('is reachable from Settings', async () => {
  app = await mountedApp({ ...PLAYER, ...QUIET, ...RETURNING, [STORAGE_KEYS.DISMISSED_NEWS]: 'news-a' }, { news: NEWS });
  await app.mount();
  await go('#/settings');
  await app.until('Settings opens', () => expect(pageTitle()).toBe('Settings'));
  const link = await vi.waitFor(() => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('.settings-help-actions button')].find((el) => el.textContent === "What's new");
    expect(button).toBeDefined();
    return button!;
  });
  await press(link);
  await app.until('What\'s new opens', () => expect(pageTitle()).toBe("What's new"));
  expect(location.hash).toBe('#/news');
});

it('waits for a pack to be put away: nothing is read or shown over the tear and reveal, then it comes after the pack notice, one toast at a time', async () => {
  const mounted = await mountedApp({ ...PLAYER, ...QUIET }, { news: NEWS });
  app = mounted;
  await app.mount();
  const sealed = () => $('[data-pack-open]');
  await app.interact(() => { sealed()!.focus(); sealed()!.click(); });
  await app.until('the pack is open', () => expect($('.card-wrapper')).not.toBeNull());
  expect(mounted.newsLoads()).toBe(0);
  expect(newsToast()).toBeUndefined();

  // Leaving the reveal puts the pack away: its notice is first in the queue, the news behind it.
  await app.interact(() => (document.activeElement ?? document.body)
    .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true })));
  await app.until('the pack notice shows', () => expect(toastTexts().join()).toContain('Pack kept'));
  expect(newsToast()).toBeUndefined();
  await app.until('the news was asked for once the pack was away', () => expect(mounted.newsLoads()).toBe(1));
  await press(document.querySelector('.toast-dismiss'));
  await app.until('the news toast follows', () => expect(toastTexts().join(' | ')).toContain('Open Card API'), 60_000);
  expect(document.querySelectorAll('.toast')).toHaveLength(1);
});
