import { test, expect, type Page } from '@playwright/test';
import { STORAGE_KEYS } from '../../src/constants/config';
import { monitor } from './support';

// Sharing one card from the packs this player owns (#185): from My pulls (the profile's pack list)
// and from the profile's verified Best pack highlight. The fixture's ticket #0 is its real pack, so the card
// link must name that ticket. The clipboard is stubbed: headless Chromium has no clipboard to grant,
// and a stub records exactly what each button put on it.

declare global {
  interface Window { clipboardLog: { kind: 'text' | 'image'; value: string }[] }
}

async function stubClipboard(page: Page) {
  await page.addInitScript(() => {
    window.clipboardLog = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (value: string) => { window.clipboardLog.push({ kind: 'text', value }); },
        write: async (items: ClipboardItem[]) => {
          for (const item of items) window.clipboardLog.push({ kind: 'image', value: item.types.join(',') });
        },
      },
    });
  });
}

/** The Hall of Fame list is same-origin; an empty one makes every qualifying pull one that would join. */
const emptyHallOfFame = (page: Page) => page.route(/\/hall-of-fame\.json(\?.*)?$/, (route) => route.fulfill({ json: [] }));

const profile = async (page: Page) => {
  await page.goto('./#/profile');
  const main = page.getByRole('main', { name: 'Profile', exact: true });
  await expect(main).toBeVisible();
  return main;
};

/** Opens a card of the "Share your pull" sheet, then its card share, and checks the sheet it opens. */
async function shareCardFromPull(page: Page) {
  const pull = page.getByRole('dialog', { name: 'Share your pull', exact: true });
  await expect(pull.locator('.sheet--deferred')).toHaveCount(0);
  await pull.getByText('Share an individual card', { exact: true }).click();
  const cards = pull.getByRole('region', { name: 'Cards in this pack', exact: true });
  const card = cards.getByRole('button').first();
  const name = (await card.getAttribute('aria-label'))!.replace(/ \(.*\)$/, '');
  await card.click();
  const viewer = page.getByRole('dialog', { name, exact: true });
  const shareButton = viewer.getByRole('button', { name: 'Share card', exact: true });
  await shareButton.click();
  const sheet = page.getByRole('dialog', { name: `Share ${name}`, exact: true });
  await expect(sheet.locator('.sheet--deferred')).toHaveCount(0);
  // Ticket #0 is a real pack: the card's link opens it.
  await expect(sheet).toContainText('(ticket #0)');
  await expect(sheet.getByRole('img', { name: "The image you'll share", exact: true })).toBeVisible();
  return { sheet, shareButton, viewer, name };
}

async function expectCopies(page: Page, sheet: ReturnType<Page['getByRole']>) {
  const done = sheet.locator('p.share-done[role="status"]');
  await sheet.getByRole('button', { name: 'Copy link', exact: true }).click();
  await expect(done).toHaveText('Link copied');
  const log = await page.evaluate(() => window.clipboardLog);
  expect(log).toHaveLength(1);
  expect(log[0].kind).toBe('text');
  expect(new URL(log[0].value).hash).toMatch(/^#\/pull\//);
  await sheet.getByRole('button', { name: 'Copy image', exact: true }).click();
  await expect(done).toHaveText('Image copied');
  expect(await page.evaluate(() => window.clipboardLog.slice(1))).toEqual([{ kind: 'image', value: 'image/png' }]);
}

/** Escape closes only the top sheet, and focus goes back to the button that opened it. */
async function expectEscapeCloses(page: Page, sheet: ReturnType<Page['getByRole']>, opener: ReturnType<Page['getByRole']>, under: ReturnType<Page['getByRole']>) {
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(under).toBeVisible();
  await expect(opener).toBeFocused();
}

test.beforeEach(async ({ page }) => {
  await stubClipboard(page);
  await emptyHallOfFame(page);
});

test('shares a card from My pulls, with its link, image and ticket', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const errors = await monitor(page, baseURL!, 1, { returning: true });
  const main = await profile(page);
  await expect(main).toContainText('All packs · 1');
  await main.locator('.pulls-history .pull-row').first().click();
  const { sheet, shareButton, viewer } = await shareCardFromPull(page);
  await expectCopies(page, sheet);
  await expectEscapeCloses(page, sheet, shareButton, viewer);
  expect(errors).toEqual([]);
});

test('shares a card from the verified Best pack highlight', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const errors = await monitor(page, baseURL!, 1, { returning: true });
  // The fixture's ticket #0 kept as the best pack the way older saves kept it: by reference and score,
  // no cards. The highlight opens that ticket again in this browser and shows only what the engine opened.
  await page.addInitScript((key) => {
    if (sessionStorage.getItem('best-pack-seeded')) return;
    sessionStorage.setItem('best-pack-seeded', '1');
    localStorage.setItem(key, JSON.stringify({
      packsOpened: 1, holoCards: {}, highestPackValue: 0, highestPackCards: [],
      highestPackRef: { setId: 'right-now', setVersion: 2, nonce: 0 }, highestPackFlexValue: 1020,
    }));
  }, STORAGE_KEYS.STATS);
  const main = await profile(page);
  const best = main.getByRole('region', { name: 'Best pack', exact: true });
  await expect(best.locator('.profile-verified')).toHaveText(/Verified/);
  await expect(best.locator('.pull-row-meta')).toContainText('ticket #0');
  await best.locator('.pull-row').click();
  const { sheet, shareButton, viewer } = await shareCardFromPull(page);
  await expectCopies(page, sheet);
  await expectEscapeCloses(page, sheet, shareButton, viewer);
  // Escape again closes the card, then the pull, one sheet at a time.
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a pull that would join the Hall of Fame keeps its buttons ahead of the poster', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const errors = await monitor(page, baseURL!, 1, { returning: true });
  // A synthetic Full House at a ticket the fixture never opened: shown and shared from history,
  // never submitted (the Submit button is not pressed and the network is stubbed).
  await page.addInitScript((key) => {
    if (sessionStorage.getItem('full-house-seeded')) return;
    sessionStorage.setItem('full-house-seeded', '1');
    localStorage.setItem(key, JSON.stringify([{
      s: 'right-now', v: 2, n: 0, k: '8a88e3dd7409f195', c: 'bukangi,bukangi,bukangi,la-peace,la-peace', h: 'Full House', x: 0, t: 1,
    }]));
  }, STORAGE_KEYS.HISTORY);
  const main = await profile(page);
  await main.locator('.pulls-history .pull-row').first().click();
  const pull = page.getByRole('dialog', { name: 'Share your pull', exact: true });
  await expect(pull.locator('.share-hof')).toBeVisible();
  const order = await pull.locator('.share-side > *').evaluateAll((children) => children.map((child) => child.className));
  expect(order.indexOf('share-actions-main')).toBe(0);
  expect(order.indexOf('share-actions-main')).toBeLessThan(order.findIndex((name) => name.includes('share-hof')));
  expect(order.findIndex((name) => name.includes('share-hof'))).toBeLessThan(order.indexOf('share-preview'));
  // Copy link comes first among the buttons, and Submit sits after every share button.
  const buttons = await pull.locator('.share-side button').allTextContents();
  expect(buttons[0].trim()).toBe('Copy link');
  expect(buttons.findIndex((text) => /Submit/.test(text))).toBeGreaterThan(buttons.findIndex((text) => /Copy text/.test(text)));
  expect(errors).toEqual([]);
});

test('folds the secondary share outputs and the card gallery behind disclosures a keyboard can reach', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const errors = await monitor(page, baseURL!, 1, { returning: true });
  const main = await profile(page);
  await main.locator('.pulls-history .pull-row').first().click();
  const pull = page.getByRole('dialog', { name: 'Share your pull', exact: true });
  await expect(pull.getByRole('img', { name: "The image you'll share", exact: true })).toBeVisible();

  // Closed by default: the main outputs are in view, the alternatives and the gallery are not.
  const more = pull.getByText('More sharing options', { exact: true });
  const copyText = pull.getByRole('button', { name: 'Copy text', exact: true });
  const cards = pull.getByRole('region', { name: 'Cards in this pack', exact: true });
  await expect(pull.getByRole('button', { name: 'Copy link', exact: true })).toBeVisible();
  await expect(pull.getByRole('button', { name: 'Copy image', exact: true })).toBeVisible();
  await expect(copyText).toBeHidden();
  await expect(cards).toBeHidden();

  // Space on the focused summary opens it; the revealed action keeps its own feedback; Space closes it again.
  await more.focus();
  await page.keyboard.press('Space');
  await expect(copyText).toBeVisible();
  await expect(more).toBeFocused();
  await copyText.click();
  await expect(pull.locator('p.share-done[role="status"]')).toHaveText('Text copied');
  expect((await page.evaluate(() => window.clipboardLog)).at(-1)).toMatchObject({ kind: 'text' });
  await more.focus();
  await page.keyboard.press('Space');
  await expect(copyText).toBeHidden();
  await expect(more).toBeFocused();

  // The gallery opens the same way and keeps the whole-pack versus single-card distinction.
  const individual = pull.getByText('Share an individual card', { exact: true });
  await individual.focus();
  await page.keyboard.press('Enter');
  await expect(cards).toBeVisible();
  await expect(cards).toContainText('The controls above share the whole pack.');
  await expect(individual).toBeFocused();
  expect(errors).toEqual([]);
});

test('the sheet keeps Tab and Shift+Tab inside it when its disclosure summaries are the first and last stops', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const errors = await monitor(page, baseURL!, 1, { returning: true });
  const main = await profile(page);
  await main.locator('.pulls-history .pull-row').first().click();
  const pull = page.getByRole('dialog', { name: 'Share your pull', exact: true });
  await expect(pull.getByRole('img', { name: "The image you'll share", exact: true })).toBeVisible();
  const inside = () => pull.evaluate((element) => element.contains(document.activeElement));

  // Closed, the gallery summary is the last tab stop: Tab past it wraps to the first, never out of the dialog.
  const individual = pull.getByText('Share an individual card', { exact: true });
  await individual.focus();
  await page.keyboard.press('Tab');
  expect(await inside()).toBe(true);
  await page.keyboard.press('Shift+Tab');
  await expect(individual).toBeFocused();

  // Tab reaches the other summary, and with a disclosure open its buttons join the cycle.
  await pull.getByRole('button', { name: 'Copy image', exact: true }).focus();
  await page.keyboard.press('Tab');
  const more = pull.getByText('More sharing options', { exact: true });
  await expect(more).toBeFocused();
  await page.keyboard.press('Space');
  await page.keyboard.press('Tab');
  await expect(pull.getByRole('button', { name: 'Save image', exact: true })).toBeFocused();
  expect(errors).toEqual([]);
});
