import { test, expect, type Locator, type Page } from '@playwright/test';
import { monitor } from './support';

// A keyboard-only pass over the app (#73): Tab reaches every tab and the gear with a visible focus
// ring, Enter opens each page with its heading focused, every control has a name, and the card guide
// sheet keeps Tab inside until Escape hands focus back. Pages are routes, not sheets, so they have no
// trap of their own; the sheet is where a trap belongs.

const PAGES = ['Cards', 'Rankings', 'Profile', 'Settings'] as const;

const nav = (page: Page) => page.getByRole('navigation', { name: 'Main', exact: true });
const control = (page: Page, name: string) => (name === 'Settings'
  ? page.getByRole('button', { name: 'Settings', exact: true })
  : nav(page).getByRole('button', { name, exact: true }));
const pageNamed = (page: Page, name: string) => page.getByRole('main', { name, exact: true });

const isFocused = (target: Locator) => target.evaluate((el) => el === document.activeElement);

/** Presses Tab until the target has focus, as a keyboard user would, and fails if it never does. */
async function tabTo(page: Page, target: Locator) {
  for (let presses = 0; presses < 40; presses++) {
    if (await isFocused(target)) return;
    await page.keyboard.press('Tab');
  }
  await expect(target).toBeFocused();
}

/** The focused control shows a keyboard focus ring: an outline or a box shadow. */
async function expectFocusRing(target: Locator) {
  const ring = await target.evaluate((el) => {
    const style = getComputedStyle(el);
    return {
      visible: el.matches(':focus-visible'),
      outline: style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0,
      shadow: style.boxShadow !== 'none',
    };
  });
  expect(ring.visible).toBe(true);
  expect(ring.outline || ring.shadow).toBe(true);
}

/** Lines of the accessibility tree for a button or link with no name. */
async function unnamedControls(page: Page) {
  const tree = await page.locator('body').ariaSnapshot();
  return tree.split('\n').filter((line) => /^\s*- (button|link)\s*(\[[^\]]*\])?\s*:?\s*$/.test(line));
}

test('a keyboard reaches every page and the card guide, with focus shown and every control named', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const errors = await monitor(page, baseURL!, 1, { returning: true });
  await page.goto('./');
  await expect(page.getByRole('button', { name: 'Open pack', exact: true })).toBeEnabled();
  expect(await unnamedControls(page)).toEqual([]);

  for (const name of PAGES) {
    const target = control(page, name);
    await tabTo(page, target);
    await expectFocusRing(target);
    await page.keyboard.press('Enter');
    const shown = pageNamed(page, name);
    await expect(shown).toBeVisible();
    await expect(page.getByRole('main')).toHaveCount(1);
    await expect(shown.getByRole('heading', { level: 1 })).toBeFocused();
    await expect(target).toHaveAttribute('aria-current', 'page');
    await expect(shown.locator('.page-skeleton')).toHaveCount(0);
    expect(await unnamedControls(page)).toEqual([]);
  }

  // Back to the packs screen, then the card guide sheet by keyboard.
  await page.goto('./');
  const guide = page.locator('.card-guide-entry').getByRole('button', { name: 'Card guide', exact: true });
  await tabTo(page, guide);
  await expectFocusRing(guide);
  await page.keyboard.press('Enter');
  const sheet = page.getByRole('dialog', { name: 'Card guide', exact: true });
  await expect(sheet).toBeVisible();
  expect(await unnamedControls(page)).toEqual([]);
  // Tab and Shift+Tab go round inside the sheet and never reach the page under it.
  for (const key of ['Tab', 'Tab', 'Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab', 'Shift+Tab']) {
    await page.keyboard.press(key);
    expect(await sheet.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(guide).toBeFocused();
  expect(errors).toEqual([]);
});
