import { readdirSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { monitor, expectDecoded, expectRecordedPack } from './support';

/**
 * Card art that won't load (#226): a phone that drops its connection, or runs out of memory, mid-pack.
 * The pack still opens and saves, every card says it failed instead of showing a blank face, a pull's
 * poster says it couldn't be drawn instead of sharing a blank image, and the cards come back when the
 * device is online again or the player presses Retry. Every wait is on a card's state, never on time.
 */

const sets = new URL('../../src/content/sets/', import.meta.url);
const cardIds = readdirSync(sets, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((set) => readdirSync(new URL(`${set.name}/cards/`, sets)).filter((file) => file.endsWith('.webp')))
  .map((file) => file.slice(0, -'.webp'.length).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
/** A card's built art, plain or as a finish thumbnail; never the pack, its thumbnail or the frame mask. */
const ART = `/assets/(?:${cardIds.join('|')})(?:\\.[a-z]+)?-[\\w-]{8}\\.webp`;
const artUrl = new RegExp(`${ART}$`);
/** A logged failure that names a card's art (request failures and the errors that carry its URL). */
const namesArt = new RegExp(ART);

/** Fails every card art request until restored; the rest of the app loads as usual. */
async function dropArt(page: Page) {
  let failing = true;
  let failed = 0;
  await page.route(artUrl, (route) => {
    if (!failing) return route.continue();
    failed += 1;
    return route.abort();
  });
  return { failed: () => failed, restore: () => { failing = false; } };
}

/** Errors other than the art that was meant to fail. */
const unexpected = (errors: string[]) =>
  errors.filter((error) => !namesArt.test(error) && error !== 'Failed to load resource: net::ERR_FAILED');

test('a pack whose art will not load still opens and saves, and its cards come back online', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const errors = await monitor(page, baseURL!);
  const art = await dropArt(page);
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  // The pack itself still draws: only card art is cut off.
  await expectDecoded(page.locator('.pack-shell img'), 2);
  await page.getByRole('button', { name: 'Open pack', exact: true }).focus();
  await page.keyboard.press('Space');
  await expect(page.locator('.card-reveal-area')).toBeVisible({ timeout: 15000 });
  await page.locator('button.reveal-skip').click({ timeout: 15000 });
  await expect(page.locator('.pack-summary')).toBeVisible({ timeout: 30000 });

  // Each card says it failed (a reserved box with Retry nearby), not a blank face or an endless spinner.
  const summary = page.locator('.summary-cards img');
  await expect(summary).toHaveCount(5);
  for (const image of await summary.all()) await expect(image).toHaveAttribute('data-state', 'failed');
  expect(art.failed()).toBeGreaterThan(0);
  // The pack is saved exactly as dealt, art or not.
  await expectRecordedPack(page);

  // Back online: every failed card tries again and shows.
  art.restore();
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expectDecoded(summary, 5);
  expect(unexpected(errors)).toEqual([]);
});

test('a pull without its art says the poster could not be drawn, and Retry brings its cards back', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const errors = await monitor(page, baseURL!, 1, { returning: true });
  await page.route(/\/hall-of-fame\.json(\?.*)?$/, (route) => route.fulfill({ json: [] }));
  const art = await dropArt(page);
  await page.goto('./#/profile');
  const main = page.getByRole('main', { name: 'Profile', exact: true });
  await expect(main).toBeVisible();
  await main.locator('.pulls-history .pull-row').first().click();

  const pull = page.getByRole('dialog', { name: 'Share your pull', exact: true });
  await expect(pull.locator('.sheet--deferred')).toHaveCount(0);
  // No art means no poster: it says so, and there is no blank image to copy or save.
  await expect(pull.locator('.share-preview')).toHaveText("Couldn't draw the image");
  await expect(pull.getByRole('img', { name: "The image you'll share", exact: true })).toHaveCount(0);
  const imageButtons = pull.getByRole('button', { name: /^(Copy|Save) image$/ });
  await expect(imageButtons.first()).toBeVisible();
  for (const button of await imageButtons.all()) await expect(button).toBeDisabled();

  const cards = pull.getByRole('region', { name: 'Cards in this pack', exact: true });
  const faces = cards.locator('img.card-image');
  await expect(faces).toHaveCount(5);
  for (const image of await faces.all()) await expect(image).toHaveAttribute('data-state', 'failed');

  // The card viewer offers Retry; once the art is reachable, one press brings back every failed card.
  const card = cards.getByRole('button').first();
  const name = (await card.getAttribute('aria-label'))!.replace(/ \(.*\)$/, '');
  await card.click();
  const viewer = page.getByRole('dialog', { name, exact: true });
  const face = viewer.locator('img.card-image:not(.misprint-ghost)');
  await expect(face).toHaveAttribute('data-state', 'failed');
  const retry = viewer.getByRole('button', { name: `Retry loading ${name}`, exact: true });
  await expect(retry).toBeVisible();
  const failedBefore = art.failed();
  expect(failedBefore).toBeGreaterThan(0);
  art.restore();
  await retry.click();
  await expectDecoded(face, 1);
  await expect(retry).toHaveCount(0);
  await expectDecoded(faces, 5);
  expect(unexpected(errors)).toEqual([]);
});
