import { test, expect, type Locator } from '@playwright/test';
import { cardPoints } from '../../src/engine/scoring';
import { monitor, snapshot } from './support';

/**
 * Profile's Best cards (#337): open one real pack, find its five cards on the Profile page best first,
 * open the card viewer from a row and see Share card, then get focus back on the row. The focus ring
 * follows the shared rules (tests/browser/quiet-focus-ring.spec.ts, #312): the viewer hands focus back
 * by script, which is quiet after a click and rings after Escape.
 */

/** The shared ring's outer edge (tokens.css --focus-ring). */
const RING = 'rgb(255, 210, 63) 0px 0px 0px 4px';

/** Where the ring stands once the box-shadow transition has run its course, so "no ring" is read at the end, not the start. */
const ringOf = (target: Locator) => target.evaluate(async (el) => {
  await Promise.all(el.getAnimations().filter((a) => a instanceof CSSTransition).map((a) => a.finished.catch(() => undefined)));
  const own = getComputedStyle(el);
  return {
    focusVisible: el.matches(':focus-visible'),
    input: document.documentElement.dataset.input,
    outline: own.outlineStyle,
    shadows: own.boxShadow,
  };
});

test('lists the opened pack best first, opens a card to Share, and gives focus back to its row', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const errors = await monitor(page, baseURL!);
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  await page.getByRole('button', { name: /^Open pack/ }).focus();
  await page.keyboard.press('Space');
  await expect(page.locator('.card-reveal-area')).toBeVisible({ timeout: 15000 });
  await page.locator('button.reveal-skip').click({ timeout: 15000 });
  await expect(page.locator('.pack-summary')).toBeVisible({ timeout: 30000 });

  // The pack's five cards, as the save holds them, with the points each is worth.
  const cards = (await snapshot(page)).stats.highestPackCards!;
  expect(cards).toHaveLength(5);
  const worth = cards.map((c) => ({ name: c.name, points: cardPoints(c.rarity, c.isHolo, c.finish, c.misprint) }));
  const best = Math.max(...worth.map((c) => c.points));

  await page.reload();
  await expect(page.locator('.app-logo')).toBeVisible();
  await page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('button', { name: 'Profile', exact: true }).click();
  const profile = page.getByRole('main', { name: 'Profile', exact: true });
  await expect(profile).toContainText('All packs · 1');

  const section = profile.getByRole('region', { name: 'Best cards', exact: true });
  await expect(section.getByRole('heading', { name: 'Best cards', exact: true })).toBeVisible();
  await section.locator(':scope > details > summary').click();
  // Each of the pack's five cards is a button, best first.
  await expect(section.getByRole('button')).toHaveCount(5);
  const rows = section.locator('button.best-card-row');
  await expect(rows).toHaveCount(5);
  const scores = await rows.locator('.pull-row-score').allTextContents();
  expect(scores.map((s) => Number(s.replace(/\D/g, '')))).toEqual(worth.map((c) => c.points).sort((a, b) => b - a));
  const row = rows.first();
  const name = (await row.locator('.pull-row-hand').textContent())!;
  expect(worth.filter((c) => c.points === best).map((c) => c.name)).toContain(name);
  await expect(row).toContainText('ticket #0');

  // A click opens the viewer for that card, with Share. Closing it with the button leaves no ring on the row.
  const viewer = page.getByRole('dialog', { name, exact: true });
  await row.click();
  await expect(viewer).toBeVisible();
  await expect(viewer.getByRole('button', { name: 'Share card', exact: true })).toBeVisible();
  await viewer.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(viewer).toBeHidden();
  await expect(row).toBeFocused();
  expect(await ringOf(row)).toMatchObject({ input: 'pointer', outline: 'none' });
  expect((await ringOf(row)).shadows).not.toContain(RING);
  // iOS focuses no button on a tap, so there the viewer's focus return is script focus with no click behind it. Chromium
  // rings that when a key was typed last (focus-visible matches), though the modality stays "pointer" (a typed
  // character changes nothing, inputModality.ts), so only the row's CSS keeps it quiet.
  // Focus the header without toggling the section closed.
  await section.getByRole('heading', { name: 'Best cards', exact: true }).focus();
  await page.keyboard.press('q');
  await row.evaluate((el: HTMLElement) => el.focus());
  await expect(row).toBeFocused();
  const scripted = await ringOf(row);
  expect(scripted, 'the case Chromium rings').toMatchObject({ focusVisible: true, input: 'pointer', outline: 'none' });
  expect(scripted.shadows).not.toContain(RING);

  // Enter opens it too and is as quiet as a click; Escape closes it and brings the ring back.
  await page.keyboard.press('Enter');
  await expect(viewer).toBeVisible();
  await expect(viewer.getByRole('button', { name: 'Share card', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(viewer).toBeHidden();
  await expect(row).toBeFocused();
  // Buttons ease their box-shadow in, so the ring is read once that has settled.
  await expect.poll(async () => (await ringOf(row)).shadows).toContain(RING);
  expect(await ringOf(row)).toMatchObject({ focusVisible: true, input: 'keyboard' });
  expect(errors).toEqual([]);
});
