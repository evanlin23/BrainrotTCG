import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { monitor, PLAYER_KEY_PREFIX, scaleText, tapSpace } from './support';

/**
 * The pack-level summary takeover (#1293 c): as the last card gives way to the summary, a Full House or better, or
 * a new best, takes the whole screen with a banner, and when it settles the score counts up. Points alone never do.
 * The fixture key's packs (right-now, 5 cards, shown least valuable first), none with a card-level takeover:
 *   178 a Full House (la-peace x3, steal-an-egg x2);
 *   1   five different Commons and Uncommons, 160 points, which only a history can make a new best;
 *   0   a Pair, 1,020 points, a first pack with nothing to beat.
 * Every wait is on the page's clock, so the takeover's own end and the count-up are read to the millisecond.
 */
const SET = JSON.parse(readFileSync(new URL('../../src/content/sets/right-now/set.json', import.meta.url), 'utf8')) as { id: string; version: number };
/** TAKEOVER_DURATION_MS, COUNT_UP_MS and STAGE_CLICK_GUARD_MS: the product's own, written out so this spec runs without its modules. */
const TAKEOVER_MS = 4500;
const COUNT_UP_MS = 1200;
const GUARD_MS = 400;
const PHONE = { width: 390, height: 844 };

/** Seeds the fixture player at `nonce` (before monitor's own seed, which leaves a seeded player alone), with earlier packs scoring `earlier` by ticket. */
async function start(page: Page, baseURL: string, { nonce, earlier = [], settings }: { nonce: number; earlier?: number[]; settings?: object }) {
  await page.addInitScript(({ origin, nonce, settings, earlier, set, prefix }) => {
    if (window.location.origin !== origin || localStorage.getItem('brainrot-player-v1')) return;
    localStorage.setItem('brainrot-player-v1', JSON.stringify({ secretKey: '01'.repeat(32), name: 'Browser smoke fixture', nextNonce: nonce, createdAt: 1 }));
    localStorage.setItem('brainrot-settings-v1', JSON.stringify({ effectsVolume: 0, ...settings }));
    if (earlier.length) {
      localStorage.setItem('brainrot-history-v1', JSON.stringify(earlier.map((x, n) => ({ s: set.id, v: set.version, n, k: prefix, h: 'Pair', x, t: 1_000 + n })).reverse()));
    }
  }, { origin: new URL(baseURL).origin, nonce, settings, earlier, set: SET, prefix: PLAYER_KEY_PREFIX });
  const errors = await monitor(page, baseURL);
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  return errors;
}

/** Tears the pack, reveals four cards, then freezes the page's clock and flips and passes the fifth: the summary is up. */
async function toSummary(page: Page) {
  await page.getByRole('button', { name: /^Open pack/ }).focus();
  await page.keyboard.press('Space');
  await expect(page.locator('.pack-top-count')).toHaveText('Card 1 of 5', { timeout: 15000 });
  const card = page.locator('.reveal-card:focus');
  for (let i = 1; i <= 5; i++) {
    await expect(card).toHaveAttribute('aria-label', `Flip card ${i} of 5`, { timeout: 10000 });
    if (i === 5) await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 2000));
    await tapSpace(page);
    await expect(card).toHaveAttribute('aria-label', i < 5 ? /^Next card\. / : /^See the pack summary\. /);
    await tapSpace(page);
  }
  await expect(page.locator('.pack-summary')).toBeVisible();
}

interface Look {
  reason: string | null; kicker: string; name: string; statuses: number;
  layer: { x: number; y: number; width: number; height: number } | null;
  viewport: { width: number; height: number };
  banner: { x: number; y: number; width: number; height: number } | null;
  closeOnTop: boolean; inert: boolean; skipFocused: boolean; skipLabel: string;
  animations: Record<string, string>; motion: string | null; heading: string;
}

/** The takeover in one read of the page, so nothing can end it between two measurements. */
const look = (page: Page) => page.evaluate((): Look => {
  const box = (el: Element | null | undefined) => {
    if (!el) return null;
    const { x, y, width, height } = el.getBoundingClientRect();
    return { x, y, width, height };
  };
  const layer = document.querySelector('.pack-takeover');
  const banner = document.querySelector('.pack-takeover .takeover-banner');
  const close = document.querySelector('.pack-close');
  const at = close ? close.getBoundingClientRect() : null;
  const top = at ? document.elementFromPoint(at.x + at.width / 2, at.y + at.height / 2) : null;
  const animation = (selector: string) => {
    const el = document.querySelector(selector);
    return el ? getComputedStyle(el).animationName : 'missing';
  };
  return {
    reason: layer?.getAttribute('data-reason') ?? null,
    kicker: banner?.querySelector('.takeover-banner-kicker')?.textContent ?? '',
    name: banner?.querySelector('.takeover-banner-name')?.textContent ?? '',
    statuses: document.querySelectorAll('.pack-takeover [role="status"]').length,
    layer: box(layer),
    viewport: { width: window.innerWidth, height: window.innerHeight },
    banner: box(banner),
    closeOnTop: !!close && !!top && close.contains(top),
    inert: document.querySelector('.summary-content')?.hasAttribute('inert') ?? false,
    skipFocused: document.activeElement === document.querySelector('.pack-takeover-skip'),
    skipLabel: document.querySelector('.pack-takeover-skip')?.textContent ?? '',
    animations: { overlay: animation('.takeover-overlay'), art: animation('.takeover-art'), rays: animation('.takeover-rays'), banner: animation('.pack-takeover .takeover-banner') },
    motion: document.documentElement.getAttribute('data-motion'),
    heading: document.querySelector('.pack-summary h2')?.textContent ?? '',
  };
});

/** The figure the summary's heading shows right now, as a number (the counting one while it climbs). */
const figure = (page: Page) => page.evaluate(() => {
  const heading = document.querySelector('.pack-summary h2');
  const live = heading?.querySelector('.pack-headline-count > [aria-hidden]');
  return Number((live ?? heading?.querySelector('.tabular'))?.textContent?.replace(/,/g, ''));
});

/** What a takeover owes the player, whatever the screen: the whole screen covered, the banner on it, the X above it. */
function expectCoversAndStaysReachable(shot: Look) {
  const { x, y, width, height } = shot.layer!;
  expect(x <= 0 && y <= 0 && x + width >= shot.viewport.width && y + height >= shot.viewport.height, 'the takeover leaves part of the screen uncovered').toBe(true);
  const b = shot.banner!;
  expect(b.x >= 0 && b.y >= 0 && b.x + b.width <= shot.viewport.width && b.y + b.height <= shot.viewport.height, 'the banner is cut off').toBe(true);
  expect(shot.closeOnTop, 'the pack\'s X is covered by the takeover').toBe(true);
  expect(shot.inert, 'the summary under the takeover can take focus').toBe(true);
  expect(shot.skipFocused, 'the keyboard is not on Skip').toBe(true);
  expect(shot.skipLabel).toBe('Skip');
  expect(shot.statuses, 'the takeover announces more than once').toBe(1);
}

/** The summary's own controls take presses again once the takeover is gone, and the keyboard is on its heading. */
async function expectSummaryReachable(page: Page) {
  await expect(page.locator('.pack-takeover')).toHaveCount(0);
  await expect(page.locator('.pack-summary h2')).toBeFocused();
  const covered = await page.evaluate(() => ['.pack-close', '.summary-actions .btn--primary', '.summary-card'].filter((selector) => {
    const control = document.querySelector(selector);
    if (!control) return true;
    control.scrollIntoView({ block: 'center' });
    const { x, y, width, height } = control.getBoundingClientRect();
    const top = document.elementFromPoint(x + width / 2, y + height / 2);
    return !top || !control.contains(top);
  }));
  expect(covered, 'a summary control is still covered').toEqual([]);
  expect(await page.evaluate(() => document.querySelector('.summary-content')?.hasAttribute('inert'))).toBe(false);
}

test('a Full House takes over the summary, ends by itself, and its score counts up to the total at 200% text', async ({ page, baseURL }) => {
  test.setTimeout(90000);
  await page.setViewportSize(PHONE);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.clock.install();
  const errors = await start(page, baseURL!, { nonce: 178 });
  await scaleText(page, 200);
  await toSummary(page);
  await expect(page.locator('.pack-takeover-skip')).toBeFocused();

  const shot = await look(page);
  expect(shot.reason).toBe('FULL_HOUSE');
  expect(shot.kicker).toBe('Full House');
  expect(shot.name.length).toBeGreaterThan(0);
  expectCoversAndStaysReachable(shot);
  // With motion, the backdrop does move (the reduced-motion test holds it still).
  expect(shot.animations.overlay).not.toBe('none');
  expect(shot.animations.banner).not.toBe('none');
  // The score waits at 0 under it, with the total still in the heading's text for a screen reader.
  expect(await figure(page)).toBe(0);
  expect(shot.heading).toContain('46,500');

  // It ends by itself, to the millisecond, and nothing is held meanwhile.
  await page.clock.runFor(TAKEOVER_MS - 1);
  await expect(page.locator('.pack-takeover')).toHaveCount(1);
  await page.clock.runFor(1);
  await expectSummaryReachable(page);
  // Then the score counts up: partway, then the total, and the heading is plain text again.
  expect(await figure(page)).toBe(0);
  await page.clock.runFor(COUNT_UP_MS / 2);
  const middle = await figure(page);
  expect(middle).toBeGreaterThan(0);
  expect(middle).toBeLessThan(46500);
  await page.clock.runFor(COUNT_UP_MS / 2 + 32);
  await expect(page.locator('.pack-summary h2')).toHaveText('46,500 Brainrot Score');
  await expect(page.locator('.pack-headline-count')).toHaveCount(0);
  await page.clock.resume();
  expect(errors).toEqual([]);
});

test('a new best, under the Reduced motion setting, holds still, settles on Space without closing the summary, and shows the total at once', async ({ page, baseURL }) => {
  test.setTimeout(90000);
  await page.setViewportSize(PHONE);
  // The device says nothing; the app's own Motion setting is what holds it still (data-motion on the page).
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.clock.install();
  // Ticket 0 scored 100 and this pack, ticket 1, scores 160: a new best, with a hand (No Matches) that earns nothing alone.
  const errors = await start(page, baseURL!, { nonce: 1, earlier: [100], settings: { motion: 'reduced' } });
  await toSummary(page);
  await expect(page.locator('.pack-takeover-skip')).toBeFocused();

  const shot = await look(page);
  expect(shot.motion).toBe('reduced');
  expect(shot.reason).toBe('NEW_BEST');
  expect(shot.kicker).toBe('New best');
  expectCoversAndStaysReachable(shot);
  expect(shot.animations).toEqual({ overlay: 'none', art: 'none', rays: 'none', banner: 'none' });

  // Inside the summary's settle window a key does nothing yet; it is still kept from the pack's own keys.
  // (Focus is off Skip, so the key is the page's, as for a player who clicked elsewhere.)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Space');
  await expect(page.locator('.pack-takeover')).toHaveCount(1);
  await page.clock.runFor(GUARD_MS);
  await page.keyboard.press('Space');
  await expect(page.locator('.pack-takeover')).toHaveCount(0);
  // The same key did not close the summary, and the total is there at once, no climb.
  await expect(page.locator('.pack-summary')).toBeVisible();
  await expect(page.locator('.pack-summary h2')).toHaveText('NEW BEST:160 Brainrot Score');
  await expect(page.locator('.pack-headline-count')).toHaveCount(0);
  await expect(page.locator('.pack-summary h2')).toBeFocused();
  await page.clock.resume();
  expect(errors).toEqual([]);
});

test('a tap anywhere settles a takeover, leaving every summary control reachable', async ({ page, baseURL }) => {
  test.setTimeout(90000);
  await page.setViewportSize(PHONE);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.clock.install();
  const errors = await start(page, baseURL!, { nonce: 178 });
  await toSummary(page);
  // A tap meant for the last card lands in the settle window and skips nothing.
  await page.mouse.click(PHONE.width / 2, PHONE.height / 3);
  await expect(page.locator('.pack-takeover')).toHaveCount(1);
  await page.clock.runFor(GUARD_MS);
  await page.mouse.click(PHONE.width / 2, PHONE.height / 3);
  await expectSummaryReachable(page);
  await page.clock.runFor(COUNT_UP_MS + 32);
  await expect(page.locator('.pack-summary h2')).toHaveText('46,500 Brainrot Score');
  await page.clock.resume();
  expect(errors).toEqual([]);
});

test('a Pair that beats nothing, however many points, gets the summary alone', async ({ page, baseURL }) => {
  test.setTimeout(90000);
  await page.setViewportSize(PHONE);
  await page.clock.install();
  // A first pack: no earlier best to beat, and a Pair is no Full House.
  const errors = await start(page, baseURL!, { nonce: 0 });
  await toSummary(page);
  await expect(page.locator('.pack-summary h2')).toBeFocused();
  await expect(page.locator('.pack-takeover')).toHaveCount(0);
  await expect(page.locator('.pack-summary h2')).toHaveText('1,020 Brainrot Score');
  await expect(page.locator('.pack-headline-count')).toHaveCount(0);
  expect(await page.evaluate(() => document.querySelector('.summary-content')?.hasAttribute('inert'))).toBe(false);
  await page.clock.resume();
  expect(errors).toEqual([]);
});
