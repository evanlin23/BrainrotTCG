import { test, expect, type Page } from '@playwright/test';
import { monitor, snapshot } from './support';

/**
 * Focus mode (#312): from the tear to leaving the pack, summary included, the chrome steps aside. On a
 * phone that's the header, the tabs and the set picker; from 900px the header stays and the rest goes.
 */
async function expectChrome(page: Page, focus: boolean) {
  const header = page.locator('.app-header');
  const others = [page.locator('.app-nav'), page.locator('.set-picker')];
  if (focus) {
    await expect(page.locator('.app')).toHaveClass(/\bis-focus\b/);
    if ((page.viewportSize()?.width ?? 0) < 900) await expect(header).toBeHidden();
    else await expect(header).toBeVisible();
    for (const element of others) await expect(element).toBeHidden();
  } else {
    await expect(page.locator('.app')).not.toHaveClass(/\bis-focus\b/);
    await expect(header).toBeVisible();
    for (const element of others) await expect(element).toBeVisible();
  }
}

/** A page before the app, so Back has somewhere to leave to. */
const START = 'data:text/html,<title>before</title>';

const packShell = (page: Page) => page.getByRole('button', { name: /^Open a .* pack$/ });

async function tear(page: Page) {
  await packShell(page).focus();
  await page.keyboard.press('Space');
}

const onPackEntry = (page: Page) => page.evaluate(() => !!(history.state as { brainrotPack?: boolean } | null)?.brainrotPack);

test('keeps the chrome out of the way through the reveal and the summary, which leads with the cards', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const errors = await monitor(page, baseURL!, 0, { returning: true });
  await page.goto(START);
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  await expectChrome(page, false);
  const length = await page.evaluate(() => history.length);

  await tear(page);
  await expect(page.locator('.pack-top-count')).toHaveText('Card 1 of 5', { timeout: 15000 });
  await expectChrome(page, true);

  await page.getByRole('button', { name: 'Skip opening animation' }).click();
  await expect(page.locator('.summary-card')).toHaveCount(5);
  await expectChrome(page, true);
  // Result first: the heading and the cards, then the actions; the keyboard starts at the heading, in view.
  const order = await page.evaluate(() => {
    const at = (selector: string) => document.querySelector(selector)!;
    const follows = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    return {
      cardsFirst: follows(at('.summary-title'), at('.summary-cards')) && follows(at('.summary-cards'), at('.summary-actions')),
      focused: document.activeElement === at('.summary-title'),
    };
  });
  expect(order).toEqual({ cardsFirst: true, focused: true });
  await expect(page.locator('.summary-title')).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Open another pack' })).toBeInViewport();

  await page.getByRole('button', { name: 'Open another pack' }).click();
  await expect(packShell(page)).toBeVisible();
  await expectChrome(page, false);
  await expect.poll(() => onPackEntry(page), 'leaving kept the pack\'s entry').toBe(false);
  expect(await page.evaluate(() => history.length)).toBe(length + 1);
  expect((await snapshot(page)).stats?.packsOpened).toBe(2);
  expect(errors).toEqual([]);

  // Back after leaving leaves the page, as it would have before the pack.
  await page.goBack();
  await expect(page).toHaveTitle('before');
});

test('the X while the ticket is still on its way brings the chrome straight back', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const errors = await monitor(page, baseURL!, 0, { returning: true });
  // Hold the ticket worker's jobs until released, so the tear waits on a ticket that's still mining.
  await page.addInitScript(() => {
    const held: (() => void)[] = [];
    let holding = true;
    const native = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (this: Worker, ...args: Parameters<Worker['postMessage']>) {
      const send = () => (native as (...a: unknown[]) => void).apply(this, args);
      if (holding) held.push(send);
      else send();
    } as Worker['postMessage'];
    Object.defineProperty(window, '__releaseTickets', { value: () => { holding = false; held.splice(0).forEach((send) => send()); } });
  });
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();

  await tear(page);
  await expect(page.locator('.pack-hint.is-waiting')).toBeVisible({ timeout: 15000 });
  await expectChrome(page, true);
  await page.getByRole('button', { name: 'Back to packs', exact: true }).click();
  await expectChrome(page, false);
  await expect(packShell(page)).toBeVisible();

  // The torn pack still lands and is recorded once, without taking the screen back.
  await page.evaluate(() => (window as unknown as { __releaseTickets: () => void }).__releaseTickets());
  await expect.poll(async () => (await snapshot(page)).stats?.packsOpened, { timeout: 20000 }).toBe(2);
  await expectChrome(page, false);
  expect(errors).toEqual([]);
});

test('a reload mid-pack drops the pack\'s entry, so the first Back leaves the page', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const errors = await monitor(page, baseURL!, 0, { returning: true });
  await page.goto(START);
  await page.goto('./');
  await tear(page);
  await expect(page.locator('.pack-top-count')).toHaveText('Card 1 of 5', { timeout: 15000 });
  expect(await onPackEntry(page)).toBe(true);

  await page.reload();
  await expect(page.locator('.app-logo')).toBeVisible();
  await expect.poll(() => onPackEntry(page).catch(() => true)).toBe(false);
  await expect(packShell(page)).toBeVisible();
  await expectChrome(page, false);
  expect(errors).toEqual([]);

  await page.goBack();
  await expect(page).toHaveTitle('before');
});
