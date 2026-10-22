import { test, expect } from '@playwright/test';
import { monitor, expectDecoded, expectRecordedPack, dropArt, holdArt, unexpectedArtErrors as unexpected } from './support';

/**
 * Card art that won't load (#226): a phone that drops its connection, or runs out of memory, mid-pack.
 * The pack still opens and saves, every card says it failed instead of showing a blank face, a pull's
 * poster says it couldn't be drawn instead of sharing a blank image, and the cards come back when the
 * device is online again or the player presses Retry. Every wait is on a card's state, never on time.
 */

test('a pack whose art will not load still opens and saves, and its cards come back online', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const errors = await monitor(page, baseURL!);
  const art = await dropArt(page);
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  // The pack itself still draws: only card art is cut off.
  await expectDecoded(page.locator('.pack-shell img'), 2);
  await page.getByRole('button', { name: /^Open pack/ }).focus();
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
  const wait = pull.locator('.share-preview-wait');
  await expect(wait).toContainText("Couldn't draw the image");
  const sheetRetry = wait.getByRole('button', { name: 'Retry', exact: true });
  await expect(sheetRetry).toBeVisible();
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

  // With the art back, the poster's own Retry draws the image and turns on Copy and Save.
  await viewer.press('Escape');
  await sheetRetry.click();
  await expect(pull.getByRole('img', { name: "The image you'll share", exact: true })).toBeVisible({ timeout: 15000 });
  await expect(sheetRetry).toHaveCount(0);
  for (const button of await imageButtons.all()) await expect(button).toBeEnabled();
  expect(unexpected(errors)).toEqual([]);
});

test('a poster whose art never arrives times out with Retry instead of drawing forever', async ({ page, baseURL }) => {
  test.setTimeout(90000);
  const errors = await monitor(page, baseURL!, 1, { returning: true });
  await page.route(/\/hall-of-fame\.json(\?.*)?$/, (route) => route.fulfill({ json: [] }));
  const art = await holdArt(page);
  await page.goto('./#/profile');
  const main = page.getByRole('main', { name: 'Profile', exact: true });
  await expect(main).toBeVisible();
  await main.locator('.pulls-history .pull-row').first().click();

  const pull = page.getByRole('dialog', { name: 'Share your pull', exact: true });
  const wait = pull.locator('.share-preview-wait');
  await expect(wait).toContainText('Drawing the image');
  // The held requests never answer; the poster gives up after its own deadline (10s) rather than waiting for them.
  await expect(wait).toContainText("Couldn't draw the image", { timeout: 30000 });
  await expect(pull.getByRole('img', { name: "The image you'll share", exact: true })).toHaveCount(0);

  art.set('serve');
  await wait.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(pull.getByRole('img', { name: "The image you'll share", exact: true })).toBeVisible({ timeout: 30000 });
  for (const button of await pull.getByRole('button', { name: /^(Copy|Save) image$/ }).all()) await expect(button).toBeEnabled();
  expect(unexpected(errors)).toEqual([]);
});
