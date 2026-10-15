// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://mounted.invalid/BrainrotTCG/"}
import { afterEach, expect, it, vi } from 'vitest';
import { mountedApp } from './mountedApp';
import { STORAGE_KEYS } from '../constants/config';
import { getAchievementById } from '../data/achievements';
import type { AchievementData, CollectionItem, Stats } from '../types';

let app: Awaited<ReturnType<typeof mountedApp>> | undefined;
afterEach(async () => { await app?.dispose(); app = undefined; });

// The progress App persists from its effect. Everything else (player, history, pending pack) still saves.
const PROGRESS: string[] = [STORAGE_KEYS.COLLECTION, STORAGE_KEYS.ACHIEVEMENTS, STORAGE_KEYS.STATS,
  STORAGE_KEYS.HALL_OF_FAME, STORAGE_KEYS.SETTINGS];
const SEED = {
  // Same disposable seed as the pack lifecycle test; only identity and preferences.
  'brainrot-player-v1': JSON.stringify({ secretKey: '01'.repeat(32), name: 'Mounted fixture', nextNonce: 0, createdAt: 1 }),
  [STORAGE_KEYS.SETTINGS]: JSON.stringify({ musicVolume: 0, effectsVolume: 0, particlesEnabled: false, pauseBigPulls: false }),
  [STORAGE_KEYS.SELECTED_SET]: 'right-now',
};

const button = (label: string) => {
  const element = [...document.querySelectorAll<HTMLElement>('button, [role="button"]')]
    .find((el) => (el.getAttribute('aria-label') ?? el.textContent?.trim()) === label);
  expect(element, `button ${label}`).toBeDefined();
  return element!;
};
const banner = () => document.querySelector('.app > p[role="alert"].save-warning');
const expectAppShown = () => {
  expect(document.querySelector('.app .app-header .app-logo')?.getAttribute('aria-label')).toBe('Brainrot TCG');
  expect(document.querySelectorAll('.app-nav .app-nav-item')).toHaveLength(5);
  expect(document.querySelector('.app-main')).not.toBeNull();
};
const ownedTotal = () => [...document.querySelectorAll('.collection [aria-label$=" owned"], .collection [aria-label*=" owned,"]')]
  .reduce((sum, el) => sum + Number(/, (\d+) owned/.exec(el.getAttribute('aria-label')!)![1]), 0);

async function openPack(current: NonNullable<typeof app>) {
  await current.until('the pack shell is ready', () => expect(document.querySelector('[aria-label^="Open a "]')).not.toBeNull());
  await current.interact(() => {
    const shell = document.querySelector<HTMLElement>('[aria-label^="Open a "]')!;
    shell.focus();
    shell.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    shell.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
  });
  await current.until('real ticket produces a reveal with Skip', () => expect(document.querySelector('.reveal-skip')).not.toBeNull());
  await current.interact(() => button('Skip opening animation').click());
  await current.until('Skip completes the summary', () => expect(document.querySelectorAll('.summary-card')).toHaveLength(5));
}

/** Waits for the toast queue to drain, returning every toast title shown on the way. */
async function drainToasts(current: NonNullable<typeof app>) {
  const seen = new Set<string>();
  await current.until('achievement toasts drain', () => {
    const title = document.querySelector('.toast .toast-title')?.textContent;
    if (title) seen.add(title);
    expect(document.querySelector('.toast')).toBeNull();
  });
  return [...seen];
}

it.each(['QuotaExceededError', 'SecurityError'])(
  'keeps the game mounted and progress in memory, and warns, when foreground progress writes throw %s',
  async (name) => {
    app = await mountedApp(SEED);
    await app.mount();
    expectAppShown();
    expect(banner()).toBeNull();

    const saved = Object.fromEntries(PROGRESS.map((key) => [key, localStorage.getItem(key)]));
    const attempts: { key: string; value: string }[] = [];
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (PROGRESS.includes(key)) {
        attempts.push({ key, value });
        throw new DOMException('Denied', name);
      }
      setItem.call(this, key, value);
    });
    const lastAttempt = <T,>(key: string): T => {
    const tried = attempts.filter((a) => a.key === key);
    return JSON.parse(tried[tried.length - 1].value);
  };

    await openPack(app);

    // The persistence effect tried, failed and contained it: nothing thrown out of React, nothing saved.
    expect(new Set(attempts.map((a) => a.key))).toEqual(
      new Set([STORAGE_KEYS.COLLECTION, STORAGE_KEYS.STATS, STORAGE_KEYS.ACHIEVEMENTS, STORAGE_KEYS.HALL_OF_FAME]),
    );
    const logged = app.takeErrors(/^Failed to save to localStorage key /);
    expect(logged.length).toBe(attempts.length);
    expect(logged.every((line) => line.includes(name))).toBe(true);
    expect(Object.fromEntries(PROGRESS.map((key) => [key, localStorage.getItem(key)]))).toEqual(saved);

    // Still a working app, not a blank screen, with the warning shown.
    expectAppShown();
    expect(document.querySelectorAll('.summary-card')).toHaveLength(5);
    expect(banner()?.textContent).toMatch(/couldn't be saved in this browser/);

    // Achievements from the first pack, recorded once in memory.
    const first = lastAttempt<Record<string, AchievementData>>(STORAGE_KEYS.ACHIEVEMENTS);
    const firstNames = Object.keys(first).map((id) => getAchievementById(id)!.name);
    expect(Object.keys(first)).toContain('first_pack');
    const toastsAfterFirst = await drainToasts(app);
    expect(toastsAfterFirst.join(' ')).toContain('Baby Steps');

    // Settings shows the same warning; the banner steps aside while it is open.
    await app.interact(() => button('Settings').click());
    await app.until('Settings loads', () => expect(document.querySelector('.settings')).not.toBeNull());
    expect(document.querySelector('.settings p[role="alert"].save-warning')?.textContent).toMatch(/couldn't be saved in this browser/);
    expect(banner()).toBeNull();
    await app.interact(() => button('Close').click());
    expect(banner()).not.toBeNull();

    // A second pack while writes keep failing: progress keeps adding up in memory.
    await app.interact(() => button('Open another pack').click());
    await openPack(app);
    expectAppShown();
    expect(banner()).not.toBeNull();
    expect(lastAttempt<Stats>(STORAGE_KEYS.STATS).packsOpened).toBe(2);
    const collection = lastAttempt<Record<string, CollectionItem>>(STORAGE_KEYS.COLLECTION);
    expect(Object.values(collection).reduce((sum, item) => sum + item.normalCount + item.holoCount, 0)).toBe(10);

    // No achievement from the first pack is awarded again: same unlock record, no second toast.
    const second = lastAttempt<Record<string, AchievementData>>(STORAGE_KEYS.ACHIEVEMENTS);
    for (const id of Object.keys(first)) expect(second[id], id).toEqual(first[id]);
    const toastsAfterSecond = await drainToasts(app);
    for (const title of toastsAfterSecond) {
      for (const earlier of firstNames) expect(title, 'toast repeats an earlier unlock').not.toContain(earlier);
    }

    // The collection browser shows both packs from memory.
    await app.interact(() => button('Collection').click());
    await app.until('Collection loads', () => expect(document.querySelector('.collection')).not.toBeNull());
    expect(ownedTotal()).toBe(10);
    expect(document.querySelector('.collection-empty')).toBeNull();

    app.takeErrors(/^Failed to save to localStorage key /);
    expect(Object.fromEntries(PROGRESS.map((key) => [key, localStorage.getItem(key)]))).toEqual(saved);
  },
  60_000,
);

it('starts on the default set when reading the remembered set throws SecurityError', async () => {
  app = await mountedApp(SEED);
  const getItem = Storage.prototype.getItem;
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
    if (key === STORAGE_KEYS.SELECTED_SET) throw new DOMException('Denied', 'SecurityError');
    return getItem.call(this, key);
  });
  await app.mount();
  expectAppShown();
  expect(document.querySelector('[aria-label^="Open a "]')).not.toBeNull();
});
