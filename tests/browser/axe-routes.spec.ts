import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { expectAxeClean } from './axe-scan';
import { expectDecoded, monitor } from './support';

/**
 * Automated axe checks for the rest of the main routes (#766), on the helper from axe-scan.ts that
 * axe-critical-states.spec.ts (#747) already uses for the first pack, the summary, Settings and a card
 * share sheet. Here: mid-reveal, Cards, Rankings, Profile and a shared pull. Plus the route contract
 * pages.spec.ts does not pin, on every page including Settings: the page is a named main landmark with
 * one level-1 heading, and nothing focusable is stranded where a keyboard can reach it but nobody can
 * scroll to it. Arrival focus on the heading, dialog focus traps and focus restore stay with
 * pages.spec.ts, accessibility.spec.ts and card-share.spec.ts.
 */

const vectors = JSON.parse(readFileSync(new URL('../../spec/vectors.json', import.meta.url), 'utf8')) as {
  valid: { note: string; proof: string; hand: string }[];
};

const entries = Array.from({ length: 25 }, (_, i) => ({
  id: `fixture-${i}`, proof: `fixture-proof-${i}`, name: `Fixture ${i + 1}`, fingerprint: 'abcd', setId: 'right-now',
  setName: 'Right Now', hand: 'Full House', multiplier: 150, score: 50_000 - i, submittedAt: '2026-10-01T00:00:00.000Z',
  cards: [], issue: 1000 + i, githubUser: 'fixture',
}));

/** Relays that answer every read with "nothing stored", so Rankings sees a working feed and no network. */
const relaysAnswerEmpty = (page: Page) => page.routeWebSocket(/.*/, (socket) => socket.onMessage((message) => {
  const [type, subscription] = JSON.parse(String(message)) as [string, string];
  if (type === 'REQ') socket.send(JSON.stringify(['EOSE', subscription]));
}));

/**
 * Focusable controls a keyboard can reach but the page cannot show: not hidden, not inert, and wholly
 * above or left of the page's origin, or wholly beyond its width. Vertical scroll is not stranding.
 */
const stranded = (page: Page) => page.evaluate(() => {
  const width = document.documentElement.scrollWidth;
  const focusable = 'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable=""], [contenteditable="true"]';
  return Array.from(document.querySelectorAll<HTMLElement>(focusable)).filter((el) => {
    if (el.tabIndex < 0 || el.closest('[inert], [hidden], [aria-hidden="true"]') || (el as HTMLButtonElement).disabled) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const box = el.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) return false;
    return box.right <= 0 || box.left >= width || box.bottom + window.scrollY <= 0;
  }).map((el) => `${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).trim().split(/\s+/).join('.')}` : ''} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)}"`);
});

/** The page's contract once loaded: one named main with one h1, and no stranded focusable control. */
async function expectRouteContract(page: Page, name: string) {
  const main = page.getByRole('main', { name, exact: true });
  await expect(main).toBeVisible();
  await expect(main.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.getByRole('main')).toHaveCount(1);
  expect(await stranded(page), `${name}: focusable controls out of reach of the eye`).toEqual([]);
}

test('the stranded-control check sees a button parked off the page', async ({ page }) => {
  await page.setContent('<main><button type="button">Here</button><button type="button" style="position:absolute;left:-9999px">Gone</button>'
    + '<button type="button" style="position:absolute;left:-9999px" hidden>Hidden</button></main>');
  expect(await stranded(page)).toEqual(['button "Gone"']);
});

test.describe('routes', () => {
  test('mid-reveal', async ({ page, baseURL }, testInfo) => {
    test.setTimeout(90000);
    const errors = await monitor(page, baseURL!);
    await page.goto('./');
    await expect(page.locator('.app-logo')).toBeVisible();
    const pack = page.getByRole('button', { name: 'Open pack', exact: true });
    await pack.focus();
    await page.keyboard.press('Space');
    await expect(page.locator('.pack-top-count')).toHaveText('Card 1 of 5', { timeout: 15000 });
    await expect(page.locator('.reveal-card').first()).toBeVisible();
    await expectAxeClean(page, testInfo, 'mid-reveal');
    expect(errors).toEqual([]);
  });

  test('Cards', async ({ page, baseURL }, testInfo) => {
    const errors = await monitor(page, baseURL!, 1, { returning: true });
    await page.goto('./#/cards');
    await expectRouteContract(page, 'Cards');
    await expectAxeClean(page, testInfo, 'cards');
    expect(errors).toEqual([]);
  });

  test('Rankings', async ({ page, baseURL }, testInfo) => {
    const errors = await monitor(page, baseURL!, 0, { returning: true });
    await relaysAnswerEmpty(page);
    await page.route('**/hall-of-fame.json', (route) => route.fulfill({ json: entries }));
    await page.goto('./#/rankings');
    await expectRouteContract(page, 'Rankings');
    const rankings = page.getByRole('main', { name: 'Rankings', exact: true });
    await rankings.getByRole('tab', { name: 'All-time', exact: true }).click();
    await expect(rankings.locator('.hof-list')).toBeVisible();
    await expectAxeClean(page, testInfo, 'rankings');
    expect(errors).toEqual([]);
  });

  test('Profile', async ({ page, baseURL }, testInfo) => {
    const errors = await monitor(page, baseURL!, 1, { returning: true });
    await page.goto('./#/profile');
    await expectRouteContract(page, 'Profile');
    await expect(page.getByRole('main', { name: 'Profile', exact: true })).toContainText('All packs · 1');
    await expectAxeClean(page, testInfo, 'profile');
    expect(errors).toEqual([]);
  });

  test('Settings keeps the route contract', async ({ page, baseURL }) => {
    const errors = await monitor(page, baseURL!, 0, { returning: true });
    await page.goto('./#/settings');
    await expectRouteContract(page, 'Settings');
    expect(errors).toEqual([]);
  });

  test('a shared pull', async ({ page, baseURL }, testInfo) => {
    test.setTimeout(60000);
    const vector = vectors.valid.find((v) => v.note === 'empty name, archived set')!;
    const errors = await monitor(page, baseURL!, 1, { returning: true });
    await page.goto(`./#/pull/${vector.proof}`);
    const pull = page.getByRole('dialog', { name: vector.hand === 'No Matches' ? 'A pull' : vector.hand, exact: true });
    // Opening a shared pull verifies its Argon2id ticket in a worker, which is slow on a cold run.
    await expect(pull).toContainText('Verified on this device', { timeout: 20000 });
    await expect(pull.locator('.sheet--deferred')).toHaveCount(0);
    await expectDecoded(pull.locator('img.card-image'), 5);
    await expectAxeClean(page, testInfo, 'shared-pull');
    expect(errors).toEqual([]);
  });
});
