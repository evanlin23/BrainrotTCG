// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://mounted.invalid/BrainrotTCG/"}
import { afterEach, expect, it } from 'vitest';
import { mountedApp } from './mountedApp';
import { STORAGE_KEYS } from '../constants/config';

let app: Awaited<ReturnType<typeof mountedApp>> | undefined;
afterEach(async () => { await app?.dispose(); app = undefined; });

const PLAYER = { 'brainrot-player-v1': JSON.stringify({ secretKey: '01'.repeat(32), name: 'News fixture', nextNonce: 0, createdAt: 1 }) };
const QUIET = { 'brainrot-settings-v1': JSON.stringify({ effectsVolume: 0 }) };
/** A player who has saved a pack (#222). */
const RETURNING = { 'brainrot-stats-v1': JSON.stringify({ packsOpened: 1, holoCards: {}, highestPackValue: 0, highestPackCards: [] }) };
const NEWS = [{ id: 'news-a', title: 'Open Card API', date: '2026-10-27', category: 'changelog', summary: 'Static JSON is out.' }];

const banner = () => document.querySelector('.news-banner');
it('shows no news before the first pack is saved, and does not read it either (#58)', async () => {
  app = await mountedApp({ ...PLAYER, ...QUIET }, { news: NEWS });
  await app.mount();
  await app.settle(100);
  expect(banner()).toBeNull();
  expect(app.newsLoads()).toBe(0);
});

it('still shows no news to a new player who only turned on Show every page', async () => {
  const settings = JSON.stringify({ effectsVolume: 0, showAllPages: true });
  app = await mountedApp({ ...PLAYER, 'brainrot-settings-v1': settings }, { news: NEWS });
  await app.mount();
  await app.settle(100);
  expect(document.querySelector('.app-nav')).not.toBeNull();
  expect(banner()).toBeNull();
  expect(app.newsLoads()).toBe(0);
});

it('shows the latest unread news once a pack is saved, and dismissing moves focus to the logo', async () => {
  app = await mountedApp({ ...PLAYER, ...QUIET, ...RETURNING }, { news: NEWS });
  await app.mount();
  await app.until('the news shows', () => expect(banner()?.textContent).toContain('Open Card API'));
  expect(app.newsLoads()).toBe(1);

  const dismiss = banner()!.querySelector<HTMLButtonElement>('.news-banner-dismiss')!;
  dismiss.focus();
  expect(document.activeElement).toBe(dismiss);
  await app.interact(() => dismiss.click());
  expect(banner()).toBeNull();
  // The focused button left the page: focus lands on the logo heading, not on <body>.
  expect(document.activeElement).toBe(document.querySelector('h1.app-logo'));
  expect(localStorage.getItem(STORAGE_KEYS.DISMISSED_NEWS)).toBe('news-a');

  await app.reload();
  await app.settle(100);
  expect(banner()).toBeNull();
});

it('shows nothing when there is no news', async () => {
  app = await mountedApp({ ...PLAYER, ...QUIET, ...RETURNING });
  await app.mount();
  await app.settle(100);
  expect(app.newsLoads()).toBe(1);
  expect(banner()).toBeNull();
});

it('makes way for a save warning instead of stacking on the pack, and is not dismissed by it', async () => {
  app = await mountedApp({ ...PLAYER, ...QUIET, ...RETURNING }, { news: NEWS });
  await app.mount();
  await app.until('the news shows', () => expect(banner()?.textContent).toContain('Open Card API'));
  expect(document.querySelector('.app > p[role="alert"].save-warning')).toBeNull();

  // Another tab loads a different player: this tab's save is stale, which the warning banner says.
  localStorage.setItem('brainrot-player-v1', JSON.stringify({ secretKey: '02'.repeat(32), name: 'Other tab', nextNonce: 0, createdAt: 1 }));
  await app.interact(() => window.dispatchEvent(new StorageEvent('storage', { key: 'brainrot-player-v1' })));
  expect(document.querySelector('.app > p[role="alert"].save-warning')?.textContent).toContain('This save changed in another tab');
  expect(banner()).toBeNull();
  expect(localStorage.getItem(STORAGE_KEYS.DISMISSED_NEWS)).toBeNull();
});
