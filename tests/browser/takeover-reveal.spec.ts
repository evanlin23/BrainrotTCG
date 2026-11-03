import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { monitor, scaleText, tapSpace } from './support';

/**
 * The card-reveal takeover (#1293 b): a new card that completes a set, or a Brainrot, takes the whole screen
 * with a name banner. Points alone never do. The fixture key's packs, by nonce (right-now, 5 cards, shown least
 * valuable first):
 *   8   a Brainrot (jimothy) as its last card;
 *   23  pirate-gaster, huss-valley, huss-valley, la-peace, chile-memes, so with every other card owned,
 *       its second card (the first huss-valley) is a Common that completes the set;
 *   411 a 10,000-point Diamond bukangi last, which with the whole set owned is a duplicate.
 * Few tests, each with a pack of its own: burn-in repeats a changed spec many times.
 */
const SET = JSON.parse(readFileSync(new URL('../../src/content/sets/right-now/set.json', import.meta.url), 'utf8')) as { id: string; cards: { id: string; name: string; rarity: string }[] };
const LOCK_MS = 3000;

/** A collection holding one of every card of the set but `missing`. Disposable fixture data. */
const collectionWithout = (missing: string[]) => Object.fromEntries(SET.cards.filter((card) => !missing.includes(card.id)).map((card) => [
  `${SET.id}/${card.id}`,
  { card: { id: card.id, key: `${SET.id}/${card.id}`, setId: SET.id, name: card.name, rarity: card.rarity, image: '' }, normalCount: 1, holoCount: 0 },
]));

/** Seeds the fixture player at `nonce` (before monitor's own seed, which leaves a seeded player alone), then loads the app. */
async function start(page: Page, baseURL: string, { nonce, collection, settings }: { nonce: number; collection?: object; settings?: object }) {
  await page.addInitScript(({ origin, nonce, collection, settings }) => {
    if (window.location.origin !== origin || localStorage.getItem('brainrot-player-v1')) return;
    localStorage.setItem('brainrot-player-v1', JSON.stringify({ secretKey: '01'.repeat(32), name: 'Browser smoke fixture', nextNonce: nonce, createdAt: 1 }));
    localStorage.setItem('brainrot-settings-v1', JSON.stringify({ effectsVolume: 0, ...settings }));
    if (collection) localStorage.setItem('brainrot-found-collection-v1', JSON.stringify(collection));
  }, { origin: new URL(baseURL).origin, nonce, collection, settings });
  const errors = await monitor(page, baseURL);
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  return errors;
}

/** Tears the pack and reveals the cards before card `n` (1-based), leaving card `n` face down. */
async function toCard(page: Page, n: number) {
  await page.getByRole('button', { name: /^Open pack/ }).focus();
  await page.keyboard.press('Space');
  await expect(page.locator('.pack-top-count')).toHaveText('Card 1 of 5', { timeout: 15000 });
  const card = page.locator('.reveal-card:focus');
  for (let i = 1; i < n; i++) {
    await expect(card).toHaveAttribute('aria-label', `Flip card ${i} of 5`, { timeout: 10000 });
    await tapSpace(page);
    await expect(card).toHaveAttribute('aria-label', /^Next card\. /);
    await tapSpace(page);
  }
  await expect(card).toHaveAttribute('aria-label', `Flip card ${n} of 5`, { timeout: 10000 });
}

type Box = { x: number; y: number; width: number; height: number };
interface Look {
  statuses: number; banners: number; ribbons: number; kicker: string; name: string; reason: string | null;
  overlay: Box | null; viewport: { width: number; height: number };
  banner: Box; card: Box; art: Box;
  fonts: number[]; truncated: string[];
  covered: string[]; animations: Record<string, string>;
  motion: string | null;
}

/** Everything about the takeover in one frame in the page, so a timer can't end it between measurements. */
const look = (page: Page) => page.evaluate(() => new Promise<Look>((resolve, reject) => {
  const started = performance.now();
  const box = (el: Element | null | undefined) => {
    if (!el) throw new Error('the takeover ended before it was measured');
    const { x, y, width, height } = el.getBoundingClientRect();
    return { x, y, width, height };
  };
  const frame = () => {
    try {
      const banner = document.querySelector('.pack-top-bar .takeover-banner');
      const card = document.querySelector('.reveal-card.is-celebrating');
      if (!banner || !card) {
        if (performance.now() - started > 10000) throw new Error('no takeover came up');
        requestAnimationFrame(frame);
        return;
      }
      const overlay = document.querySelector('.takeover-overlay');
      // Controls that must stay reachable: nothing of the takeover may sit over them.
      const area = document.querySelector('.card-reveal-area');
      const scrolled = area?.scrollTop ?? 0;
      const covered = ['.pack-close', '.reveal-skip', '.reveal-card.is-celebrating'].filter((selector) => {
        const control = document.querySelector(selector);
        if (!control) return false;
        // The reveal scrolls at large text: a control below the fold is reached by scrolling to it.
        control.scrollIntoView({ block: 'center' });
        const { x, y, width, height } = control.getBoundingClientRect();
        const top = document.elementFromPoint(x + width / 2, y + height / 2);
        return !top || !control.contains(top);
      });
      if (area) area.scrollTop = scrolled;
      const texts = Array.from(banner.querySelectorAll('.takeover-banner-kicker, .takeover-banner-name'));
      const animation = (selector: string) => {
        const el = document.querySelector(selector);
        return el ? getComputedStyle(el).animationName : 'missing';
      };
      resolve({
        statuses: document.querySelectorAll('.card-reveal-area [role="status"]').length,
        banners: document.querySelectorAll('.takeover-banner[role="status"]').length,
        ribbons: document.querySelectorAll('.showcase-ribbon').length,
        kicker: banner.querySelector('.takeover-banner-kicker')?.textContent ?? '',
        name: banner.querySelector('.takeover-banner-name')?.textContent ?? '',
        reason: banner.getAttribute('data-reason'),
        overlay: overlay ? box(overlay) : null,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        banner: box(banner),
        card: box(card),
        art: box(card.querySelector('.card-full-image')),
        fonts: texts.map((el) => parseFloat(getComputedStyle(el).fontSize)),
        truncated: texts.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent ?? ''),
        covered,
        animations: {
          overlay: animation('.takeover-overlay'), art: animation('.takeover-art'), rays: animation('.takeover-rays'), banner: animation('.takeover-banner'),
        },
        motion: document.documentElement.getAttribute('data-motion'),
      });
    } catch (error) {
      reject(error);
    }
  };
  frame();
}));

/**
 * Where the card and its stage sit in the reveal area, from layout alone (offsets and scroll, so a flip's transform
 * can't move it): the takeover may add a banner and a backdrop, but must never push the card.
 */
const placement = (page: Page) => page.evaluate(() => {
  const area = document.querySelector<HTMLElement>('.card-reveal-area');
  const at = (el: HTMLElement | null) => {
    if (!el || !area) throw new Error('the reveal is not up');
    let x = 0;
    let y = 0;
    for (let node: HTMLElement | null = el; node && node !== area; node = node.offsetParent as HTMLElement | null) {
      x += node.offsetLeft;
      y += node.offsetTop;
    }
    return { x, y, width: el.offsetWidth, height: el.offsetHeight };
  };
  return {
    stage: at(document.querySelector('.active-card-container')),
    card: at(document.querySelector('.active-card-container .reveal-card')),
    padding: area ? getComputedStyle(area).paddingTop : '',
    scroll: area?.scrollTop ?? 0,
  };
});

/** A phone: the narrow layout is the one that reserves a band for the banner. */
const PHONE = { width: 390, height: 844 };

const overlaps = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** What every takeover owes the player, whatever the screen and text size. */
function expectFitsAndAnnounces(shot: Look) {
  // One announcement, by the banner: not the ribbon, and not the overlay.
  expect(shot.banners).toBe(1);
  expect(shot.ribbons, 'the Big pull! ribbon is up with the takeover').toBe(0);
  expect(shot.statuses, 'the reveal announces the pull too').toBe(0);
  // The backdrop covers the screen; the banner and the whole card are on it, off each other.
  expect(shot.overlay, 'the backdrop is missing').not.toBeNull();
  const { x, y, width, height } = shot.overlay!;
  expect(x <= 0 && y <= 0 && x + width >= shot.viewport.width && y + height >= shot.viewport.height, 'the backdrop leaves part of the screen uncovered').toBe(true);
  for (const [name, b] of [['banner', shot.banner], ['card', shot.card]] as const) {
    expect(b.x >= 0 && b.y >= 0 && b.x + b.width <= shot.viewport.width && b.y + b.height <= shot.viewport.height, `the ${name} is cut off`).toBe(true);
  }
  expect(overlaps(shot.banner, shot.art), 'the banner covers the card art').toBe(false);
  expect(shot.truncated, 'banner text is cut off').toEqual([]);
  expect(shot.covered, 'the takeover covers a control').toEqual([]);
  for (const px of shot.fonts) expect(px, 'banner text is under 12px').toBeGreaterThanOrEqual(12);
}

test('a Common that completes the set takes over with its banner, settles on a tap at once, and holds still under reduced motion', async ({ page, baseURL }) => {
  test.setTimeout(90000);
  await page.setViewportSize(PHONE);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // The page's clock, so the takeover's own 4.5 s end is never raced.
  await page.clock.install();
  // Every card but huss-valley is owned, so the pack's first huss-valley completes the set. The pause is on (the default).
  const errors = await start(page, baseURL!, { nonce: 23, collection: collectionWithout(['huss-valley']) });
  await toCard(page, 2);
  // Cards before it are duplicates: no takeover so far.
  await expect(page.locator('.takeover-banner')).toHaveCount(0);
  const before = await placement(page);
  await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 2000));
  await tapSpace(page);

  const shot = await look(page);
  expect(await placement(page), 'the takeover moved the card').toEqual(before);
  expect(shot.reason).toBe('SET');
  expect(shot.kicker).toBe('Set complete');
  expect(shot.name.length).toBeGreaterThan(0);
  expectFitsAndAnnounces(shot);
  // The static variant: the media query alone turns every animation off.
  expect(shot.animations).toEqual({ overlay: 'none', art: 'none', rays: 'none', banner: 'none' });

  // A Common is no card the Settings copy names, so the pause does not hold it: a tap ends the takeover on the spot,
  // leaving the same card settled, and the next one moves on.
  await tapSpace(page);
  await expect(page.locator('.takeover-banner')).toHaveCount(0);
  await expect(page.locator('.takeover-overlay')).toHaveCount(0);
  await expect(page.locator('.pack-top-count')).toHaveText('Card 2 of 5');
  expect(await placement(page), 'settling the takeover moved the card').toEqual(before);
  await tapSpace(page);
  await page.clock.resume();
  await expect(page.locator('.pack-top-count')).toHaveText('Card 3 of 5');
  expect(errors).toEqual([]);
});

test('a Brainrot takes over, keeps its 3 s hold, and at 200% text fits with every control reachable', async ({ page, baseURL }) => {
  test.setTimeout(90000);
  await page.setViewportSize(PHONE);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  // The page's clock, so the hold and the takeover's own end are read to the millisecond, not raced.
  await page.clock.install();
  const errors = await start(page, baseURL!, { nonce: 8 });
  await scaleText(page, 200);
  await toCard(page, 5);
  const before = await placement(page);
  // Frozen from here: the flip happens at one instant, and nothing ends until the test says so.
  await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 2000));
  await tapSpace(page);
  await expect(page.locator('.pack-top-bar .takeover-banner')).toBeVisible();

  const shot = await look(page);
  expect(await placement(page), 'the takeover moved the card, at 200% text on a phone').toEqual(before);
  expect(shot.reason).toBe('BRAINROT');
  expect(shot.kicker).toBe('Brainrot');
  expectFitsAndAnnounces(shot);
  // With motion, the backdrop does move (the reduced-motion tests hold it still).
  expect(shot.animations.overlay).not.toBe('none');
  expect(shot.animations.art).not.toBe('none');

  // The hold: a tap during it does nothing, up to its last millisecond.
  const stage = page.locator('.active-card-container');
  await expect(stage).toHaveAttribute('aria-busy', 'true');
  await tapSpace(page);
  await page.clock.runFor(LOCK_MS - 1);
  await tapSpace(page);
  await expect(page.locator('.takeover-banner')).toHaveCount(1);
  await expect(page.locator('.pack-summary')).toHaveCount(0);
  // Then the next one settles the card, and does not move on.
  await page.clock.runFor(1);
  await expect(stage).toHaveAttribute('aria-busy', 'false');
  await tapSpace(page);
  await expect(page.locator('.takeover-banner')).toHaveCount(0);
  await expect(page.locator('.takeover-overlay')).toHaveCount(0);
  await expect(page.locator('.pack-top-count')).toHaveText('Card 5 of 5');
  await expect(page.locator('.pack-summary')).toHaveCount(0);
  expect(await placement(page), 'settling the takeover moved the card, at 200% text on a phone').toEqual(before);
  // And the one after that ends the pack.
  await tapSpace(page);
  await page.clock.resume();
  await expect(page.locator('.pack-summary')).toBeVisible({ timeout: 15000 });
  expect(errors).toEqual([]);
});

test('a Brainrot settles on the first tap with Pause on good pulls off, and with the Reduced motion setting holds still', async ({ page, baseURL }) => {
  test.setTimeout(90000);
  await page.setViewportSize(PHONE);
  // The device says nothing; the app's own Motion setting is what holds it still (data-motion on the page).
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.clock.install();
  const errors = await start(page, baseURL!, { nonce: 8, settings: { pauseBigPulls: false, motion: 'reduced' } });
  await scaleText(page, 200);
  await toCard(page, 5);
  const before = await placement(page);
  await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 2000));
  await tapSpace(page);

  const shot = await look(page);
  expect(shot.motion).toBe('reduced');
  expect(shot.reason).toBe('BRAINROT');
  expectFitsAndAnnounces(shot);
  expect(await placement(page), 'the takeover moved the card').toEqual(before);
  expect(shot.animations).toEqual({ overlay: 'none', art: 'none', rays: 'none', banner: 'none' });
  await expect(page.locator('.active-card-container')).toHaveAttribute('aria-busy', 'false');

  // Nothing holds the reveal: the first tap settles it.
  await tapSpace(page);
  await expect(page.locator('.takeover-banner')).toHaveCount(0);
  await expect(page.locator('.pack-top-count')).toHaveText('Card 5 of 5');
  expect(await placement(page), 'settling the takeover moved the card').toEqual(before);
  await page.clock.resume();
  expect(errors).toEqual([]);
});

test('a 10,000-point Diamond duplicate gets no takeover, only its ribbon and halo', async ({ page, baseURL }) => {
  test.setTimeout(90000);
  // The whole set is owned but one card the pack does not hold, so nothing in it is new and nothing completes the set.
  const errors = await start(page, baseURL!, { nonce: 411, collection: collectionWithout(['steal-an-egg']) });
  await toCard(page, 5);
  await tapSpace(page);
  await expect(page.locator('.pack-top-bar .showcase-ribbon')).toContainText('10,000 points');
  await expect(page.locator('.reveal-card.is-celebrating .showcase-halo')).toHaveCount(1);
  await expect(page.locator('.takeover-banner')).toHaveCount(0);
  await expect(page.locator('.takeover-overlay')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the pack summary of a takeover pack gets the ordinary top padding, on a phone and on a short landscape one', async ({ page, baseURL }) => {
  test.setTimeout(90000);
  await page.setViewportSize(PHONE);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // Nonce 8 deals a Brainrot takeover; with no cards owned it is new.
  const errors = await start(page, baseURL!, { nonce: 8, settings: { pauseBigPulls: false } });
  await toCard(page, 5);
  await tapSpace(page);
  await expect(page.locator('.takeover-banner')).toHaveCount(1);
  await tapSpace(page);
  await expect(page.locator('.takeover-banner')).toHaveCount(0);
  await tapSpace(page);
  await expect(page.locator('.pack-summary')).toBeVisible({ timeout: 15000 });

  /** The area's top padding at the summary, against an ordinary reveal area (no takeover band) beside it. */
  const summaryPadding = () => page.evaluate(() => {
    const area = document.querySelector<HTMLElement>('.card-reveal-area');
    if (!area || !area.querySelector('.pack-summary')) throw new Error('the summary is not up');
    const probe = document.createElement('div');
    probe.className = 'card-reveal-area';
    area.parentElement!.append(probe);
    const ordinary = getComputedStyle(probe).paddingTop;
    probe.remove();
    return { reserved: area.hasAttribute('data-takeover'), padding: getComputedStyle(area).paddingTop, ordinary };
  });
  // A phone, and a short landscape phone, where the height is scarcest.
  for (const size of [PHONE, { width: 640, height: 360 }]) {
    await page.setViewportSize(size);
    const shot = await summaryPadding();
    expect(shot.reserved, `the summary keeps the banner band at ${size.width}x${size.height}`).toBe(false);
    expect(shot.padding, `the summary sits lower than a plain pack's at ${size.width}x${size.height}`).toBe(shot.ordinary);
  }
  expect(errors).toEqual([]);
});
