import { test, expect, type Page } from '@playwright/test';
import { monitor, expectDecoded, expectSummaryTakesClicks } from './support';

/**
 * The card viewer's card keeps its shape (#531): on short, landscape and large-text screens it scales
 * width and height together instead of being squashed by the version, points and rarity lines under
 * it. Sizes are emulated viewports; 200% text is emulated by doubling the root font size the rem
 * tokens use.
 */

const CASES = [
  { name: 'landscape phone', viewport: { width: 812, height: 375 }, textZoom: 100 },
  { name: 'short phone', viewport: { width: 360, height: 560 }, textZoom: 100 },
  { name: 'phone at 200% text', viewport: { width: 360, height: 640 }, textZoom: 200 },
  { name: 'short desktop', viewport: { width: 1280, height: 600 }, textZoom: 100 },
  { name: 'desktop at 200% text', viewport: { width: 1280, height: 800 }, textZoom: 200 },
];

async function openViewer(page: Page, baseURL: string) {
  const errors = await monitor(page, baseURL);
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  const pack = page.getByRole('button', { name: /^Open pack/ });
  await pack.focus();
  await page.keyboard.press('Space');
  await page.locator('button.reveal-skip').click({ timeout: 15000 });
  await expect(page.locator('.summary-card')).toHaveCount(5, { timeout: 30000 });
  await expectDecoded(page.locator('.summary-cards img'), 5);
  await expectSummaryTakesClicks(page);
  await page.locator('.summary-card').first().click();
  await expect(page.locator('.card-viewer .card-viewer-card')).toBeVisible();
  return errors;
}

/** The card's box and the ratio its CSS asks for. */
function cardShape(page: Page) {
  return page.locator('.card-viewer .card-viewer-card').evaluate((card) => {
    const [w, h] = getComputedStyle(card).getPropertyValue('--card-aspect').split('/').map(Number);
    const box = card.getBoundingClientRect();
    return { width: box.width, height: box.height, top: box.top, aspect: w / h };
  });
}

test('the card viewer never squashes the card', async ({ page, baseURL }) => {
  test.setTimeout(90000);
  const errors = await openViewer(page, baseURL!);
  const zoom = await page.addStyleTag({ content: '/* text zoom */' });
  for (const { name, viewport, textZoom } of CASES) {
    await page.setViewportSize(viewport);
    await zoom.evaluate((style, z) => { style.textContent = z === 100 ? '' : `html { font-size: ${z}% !important; }`; }, textZoom);
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    const shot = process.env.VIEWER_SHOTS;
    if (shot) await page.screenshot({ path: `${shot}/${test.info().project.name}-${name.replace(/\W+/g, '-')}.png` });
    const card = await cardShape(page);
    expect.soft(card.width / card.height, `${name}: the card keeps its ratio`).toBeCloseTo(card.aspect, 2);
    // Big enough to see, and its top on screen (the text under it may scroll).
    expect.soft(card.height, `${name}: the card is a usable size`).toBeGreaterThan(150);
    expect.soft(card.top, `${name}: the card starts on screen`).toBeGreaterThanOrEqual(0);
    // One identity line (modifier and rarity together), not a heading and a badge saying the same thing (#900).
    await expect.soft(page.locator('.card-viewer-info .rarity-pill'), `${name}: one identity line`).toHaveCount(1);
    await expect.soft(page.locator('.card-viewer-info'), `${name}: no "Plain" headline`).not.toContainText(/^Plain\b/);
  }
  expect(errors).toEqual([]);
});
