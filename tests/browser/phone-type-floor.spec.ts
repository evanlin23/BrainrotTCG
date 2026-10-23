import { test, expect, type Page } from '@playwright/test';
import { monitor, expectDecoded, expectPackDropped } from './support';

// The narrowest phone we design for (#312 S6): nothing on the pack screen reads under 12 px, and
// form fields are 16 px so iOS doesn't zoom the page when one takes focus.
test.use({ viewport: { width: 360, height: 740 } });

/** Every visible text run on the page whose computed font size is under `floor` px. */
const textUnder = (page: Page, floor: number) => page.evaluate((floor) => {
  const small: string[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent?.trim();
    const element = node.parentElement;
    if (!text || !element?.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
    const range = document.createRange();
    range.selectNodeContents(node);
    const box = range.getBoundingClientRect();
    if (box.width < 1 || box.height < 1 || box.bottom <= 0 || box.top >= innerHeight) continue;
    const size = parseFloat(getComputedStyle(element).fontSize);
    if (size < floor) small.push(`${size.toFixed(1)}px .${element.className}: ${text.slice(0, 40)}`);
  }
  return small;
}, floor);

test('keeps pack-screen text at 12 px and form fields at 16 px on a 360 px phone', async ({ page, baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-chromium', 'A phone layout check; one emulated phone is enough.');
  // A returning player's pack screen: a new player's has no set picker or tabs to measure.
  const errors = await monitor(page, baseURL!, 0, { returning: true });
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Choose a pack', exact: true })).toBeVisible();
  const packShell = page.locator('.pack-shell');
  await expect(packShell).toBeVisible();
  await expectDecoded(packShell.locator('img'), 2);
  await expectPackDropped(page);
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => innerWidth)).toBe(360);
  // The set name on the wrapper is sized in pack widths, so it is the first thing to fall under the floor.
  await expect(packShell.locator('.pack-set-name')).toBeVisible();
  expect(await textUnder(page, 12)).toEqual([]);

  // The report textarea sets its own small monospace font; on a phone it still renders at 16 px.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('main', { name: 'Settings', exact: true }).getByRole('button', { name: 'Report a problem', exact: true }).click();
  const report = page.getByRole('dialog', { name: 'Report a problem', exact: true }).getByRole('textbox', { name: 'Report details (editable)', exact: true });
  await expect(report).toBeVisible();
  expect(await report.evaluate((field) => parseFloat(getComputedStyle(field).fontSize))).toBeGreaterThanOrEqual(16);
  expect(errors).toEqual([]);
});

test('keeps pack-screen text at 12 px on a desktop window too', async ({ page, baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'The desktop counterpart of the phone check above.');
  // This file's phone viewport would hide the desktop layout (static nav, wide header) this checks.
  await page.setViewportSize({ width: 1280, height: 800 });
  const errors = await monitor(page, baseURL!, 0, { returning: true });
  await page.goto('./');
  await expect(page.getByRole('navigation', { name: 'Choose a pack', exact: true })).toBeVisible();
  const packShell = page.locator('.pack-shell');
  await expect(packShell).toBeVisible();
  await expectDecoded(packShell.locator('img'), 2);
  await page.evaluate(() => document.fonts.ready);
  expect(await textUnder(page, 12)).toEqual([]);
  expect(errors).toEqual([]);
});
