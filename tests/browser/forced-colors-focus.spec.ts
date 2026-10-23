import { test, expect, type Locator, type Page } from '@playwright/test';
import { monitor } from './support';

// Forced colours (Windows High Contrast) drop box-shadows, so the shared focus ring would vanish.
// Every control also carries a transparent outline, which forced colours paint in a system colour
// (#312 S5). Tab through the pack screen, a sheet and the reveal, and check each stop shows a real
// outline.
test.use({ forcedColors: 'active' });

/** The focused element's outline, or null when nothing has a visible focus. */
const focusedOutline = (page: Page) => page.evaluate(() => {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body || !el.matches(':focus-visible')) return null;
  const style = getComputedStyle(el);
  return {
    name: `${el.tagName.toLowerCase()}.${el.className}: ${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 30)}`,
    inDialog: el.closest('[role="dialog"]') !== null,
    style: style.outlineStyle,
    width: parseFloat(style.outlineWidth),
    color: style.outlineColor,
    offset: style.outlineOffset,
    input: document.documentElement.dataset.input,
  };
});

/** Checks the focused element shows an outline forced colours can paint, and returns its name. */
const expectOutline = async (page: Page) => {
  const focused = await focusedOutline(page);
  if (!focused) return null;
  expect(focused.style, focused.name).not.toBe('none');
  expect(focused.width, focused.name).toBeGreaterThanOrEqual(2);
  expect(focused.color, focused.name).not.toMatch(/^(transparent|rgba\(\d+, \d+, \d+, 0\))$/);
  return focused;
};

/** Presses Tab until the target has focus, checking every stop on the way; returns their names. */
const tabTo = async (page: Page, target: Locator) => {
  const stops: string[] = [];
  for (let tab = 0; tab < 40 && !(await target.evaluate((el) => el === document.activeElement)); tab++) {
    await page.keyboard.press('Tab');
    const focused = await expectOutline(page);
    if (focused) stops.push(focused.name);
  }
  await expect(target).toBeFocused();
  return stops;
};

const openPackScreen = async (page: Page, baseURL: string) => {
  const errors = await monitor(page, baseURL, 0, { returning: true });
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Open pack/ })).toBeVisible();
  expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true);
  return errors;
};

test('shows a visible focus outline on every Tab stop of the pack screen in forced colours', async ({ page, baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'A keyboard check; the desktop project has the keyboard.');
  const errors = await openPackScreen(page, baseURL!);
  const stops = await tabTo(page, page.getByRole('button', { name: /^Open pack/ }));
  // The walk reached the pack through the header, nav and set picker, not one lucky stop.
  expect(stops.length).toBeGreaterThanOrEqual(3);
  expect(errors).toEqual([]);
});

test('shows a visible focus outline inside a sheet and on the reveal card in forced colours', async ({ page, baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'A keyboard check; the desktop project has the keyboard.');
  test.setTimeout(60000);
  const errors = await openPackScreen(page, baseURL!);

  // A sheet: the set picker's shelf of packs. Its close button and every pack in it show the outline.
  await tabTo(page, page.locator('.set-current'));
  await page.keyboard.press('Enter');
  const sheet = page.getByRole('dialog', { name: 'Packs' });
  await expect(sheet).toBeVisible();
  const inSheet: string[] = [];
  for (let tab = 0; tab < 6; tab++) {
    await page.keyboard.press('Tab');
    const focused = await expectOutline(page);
    expect(focused?.inDialog, 'Tab left the open sheet').toBe(true);
    if (focused) inSheet.push(focused.name);
  }
  expect(new Set(inSheet).size, inSheet.join('\n')).toBeGreaterThanOrEqual(2);
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);

  // The reveal: the card is its one control, and keeps the outline while the ring is a pseudo-element.
  // Space and Enter only drive the game, so they paint no yellow ring (#529). Focus is still never left
  // invisible (WCAG 2.4.7): the card wears the quiet outline, 2px and set off 3px, which forced colours
  // paint like any other outline. An arrow key, which does nothing on the reveal, is navigation and
  // brings the full ring's outline back, set off 2px. Box-shadows are dropped in forced colours, so the
  // outline offset is what tells the two apart here; the colours are covered by quiet-focus-ring.spec.ts.
  const expectQuiet = async () => {
    const focused = await expectOutline(page);
    expect(focused?.name, 'the card keeps a visible outline after Space').toMatch(/reveal-card/);
    expect(focused, 'Space is a press, not navigation').toMatchObject({ input: 'press', offset: '3px' });
  };
  const expectRing = async () => {
    const focused = await expectOutline(page);
    expect(focused?.name).toMatch(/reveal-card/);
    expect(focused, 'an arrow key is navigation').toMatchObject({ input: 'keyboard', offset: '2px' });
  };
  await tabTo(page, page.getByRole('button', { name: /^Open pack/ }));
  await page.keyboard.press('Space');
  const card = page.locator('.reveal-card:focus');
  await expect(card).toHaveAttribute('aria-label', 'Flip card 1 of 5', { timeout: 15000 });
  await expectQuiet();
  await page.keyboard.press('ArrowRight');
  await expectRing();
  await page.keyboard.press('Space');
  await expect(card).toHaveAttribute('aria-label', /^Next card\. Card 1 of 5: /, { timeout: 10000 });
  await expectQuiet();
  await page.keyboard.press('ArrowRight');
  await expectRing();
  expect(errors).toEqual([]);
});
