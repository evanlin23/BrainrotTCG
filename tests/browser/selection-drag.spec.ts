import { test, expect, type Locator, type Page } from '@playwright/test';
import { monitor, expectDecoded, fingerFor, type Finger } from './support';

// Rapid presses on game controls must not highlight text or start a native image drag, while
// inputs, copyable text and links keep their normal behaviour (#264).

const selectedText = (page: Page) => page.evaluate(() => document.getSelection()?.toString() ?? '');

async function countDragStarts(page: Page) {
  await page.evaluate(() => {
    const counter = window as unknown as { nativeDrags: number };
    counter.nativeDrags = 0;
    document.addEventListener('dragstart', () => { counter.nativeDrags++; }, true);
  });
  return () => page.evaluate(() => (window as unknown as { nativeDrags: number }).nativeDrags);
}

/** A double then a triple press at the middle of an element, as a player hammering it would. */
async function hammer(page: Page, target: Locator) {
  const box = (await target.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.dblclick(x, y);
  await page.mouse.click(x, y, { clickCount: 3 });
}

/** Presses on an image and moves a short way, the start of a native drag if one were allowed. */
async function tryDrag(page: Page, target: Locator, dx: number, dy: number) {
  const box = (await target.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height * 0.7;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let step = 1; step <= 5; step++) await page.mouse.move(x + (dx * step) / 5, y + (dy * step) / 5);
  await page.mouse.up();
}

/** The same with a finger: a long press first, as a phone starts its own drags and selections. */
async function tryTouchDrag(page: Page, finger: Finger, target: Locator, dx: number, dy: number) {
  const box = (await target.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height * 0.7;
  await finger.press(x, y);
  await page.waitForTimeout(800);
  for (let step = 1; step <= 5; step++) await finger.move(x + (dx * step) / 5, y + (dy * step) / 5);
  await finger.release();
}

/** Scroll offset and range of the nearest ancestor that scrolls (or the page). */
const scrollOf = (target: Locator) => target.evaluate((element) => {
  let scroller: Element | null = element.parentElement;
  while (scroller && !(/auto|scroll/.test(getComputedStyle(scroller).overflowY) && scroller.scrollHeight > scroller.clientHeight + 1)) {
    scroller = scroller.parentElement;
  }
  scroller ??= document.scrollingElement!;
  return { top: scroller.scrollTop, max: scroller.scrollHeight - scroller.clientHeight };
});

/**
 * Shortens the window until the summary overflows, then scrolls by a gesture that starts on one of
 * its no-drag card images: suppressing the native drag must not take the scroll with it.
 */
async function expectSummaryScrolls(page: Page, scroll: (x: number, y: number, down: boolean) => Promise<void>) {
  await page.setViewportSize({ width: page.viewportSize()!.width, height: 420 });
  const image = page.locator('.summary-cards img').first();
  await expect.poll(async () => (await scrollOf(image)).max).toBeGreaterThan(120);
  await image.scrollIntoViewIfNeeded();
  const before = await scrollOf(image);
  const down = before.top < before.max / 2;
  const box = (await image.boundingBox())!;
  await scroll(box.x + box.width / 2, box.y + box.height / 2, down);
  await expect.poll(async () => ((await scrollOf(image)).top - before.top) * (down ? 1 : -1)).toBeGreaterThan(20);
}

test('rapid clicks and drags on the pack and reveal select no text and start no native drag', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const errors = await monitor(page, baseURL!);
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  const packShell = page.getByRole('button', { name: /^Open a .* pack$/ });
  await expectDecoded(packShell.locator('img'), 2);
  const dragStarts = await countDragStarts(page);

  // A press-drag across the title letters grows a selection wherever text is selectable.
  await tryDrag(page, page.locator('.app-logo'), 60, 0);
  expect(await selectedText(page)).toBe('');
  await page.locator('.app-logo').click({ clickCount: 3 });
  await packShell.dblclick();
  await packShell.click({ clickCount: 3 });
  expect(await selectedText(page)).toBe('');
  // A short vertical press-drag stays well inside the cut gesture's threshold.
  await tryDrag(page, packShell.locator('img').first(), 0, 40);
  expect(await dragStarts()).toBe(0);
  expect(await selectedText(page)).toBe('');

  await packShell.focus();
  await page.keyboard.press('Space');
  await expect(page.locator('.card-reveal-area')).toBeVisible({ timeout: 15000 });
  // The previous card stays in the DOM while it animates out; the current one is last.
  const card = page.locator('.reveal-card').last().locator('.card-wrapper');
  await expect(card).toBeVisible({ timeout: 15000 });
  await card.dblclick();
  await expect(card).toBeVisible({ timeout: 15000 });
  await card.click({ clickCount: 3 });
  expect(await selectedText(page)).toBe('');
  await expect(card).toBeVisible({ timeout: 15000 });
  await tryDrag(page, card.locator('img').first(), 30, 0);
  expect(await dragStarts()).toBe(0);
  expect(await selectedText(page)).toBe('');
  // The rarity line and tip under the card took a selection from rapid presses before #264.
  for (const label of ['.reveal-rarity', '.tip-text']) {
    await hammer(page, page.locator(label));
    expect(await selectedText(page), label).toBe('');
  }

  await page.locator('button.reveal-skip').dblclick({ timeout: 15000 });
  await expect(page.locator('.pack-summary')).toBeVisible({ timeout: 30000 });
  expect(await selectedText(page)).toBe('');
  await tryDrag(page, page.locator('.summary-cards img').first(), 30, 30);
  expect(await dragStarts()).toBe(0);
  // That press is also a click, which opens the card viewer over the summary.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expectSummaryScrolls(page, async (x, y, down) => {
    await page.mouse.move(x, y);
    await page.mouse.wheel(0, down ? 150 : -150);
  });
  expect(errors).toEqual([]);
});

test('rapid clicks on the main navigation select no text', async ({ page, baseURL }) => {
  const errors = await monitor(page, baseURL!, 0, { returning: true });
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Main', exact: true });
  for (const name of ['Cards', 'Rankings', 'Profile', 'Open']) {
    const item = nav.locator('.app-nav-item').filter({ hasText: name });
    await hammer(page, item);
    expect(await selectedText(page), name).toBe('');
    // The label itself, where a double press lands on its word.
    await hammer(page, item.locator('.app-nav-label'));
    expect(await selectedText(page), `${name} label`).toBe('');
  }
  expect(errors).toEqual([]);
});

test.describe('with a touch screen', () => {
  // The phone project has touch already; this adds it to the desktop one too.
  test.use({ hasTouch: true });

  test('long presses and drags select no text, start no native drag, and still scroll the summary', async ({ page, baseURL }) => {
    test.setTimeout(60000);
    const errors = await monitor(page, baseURL!);
    await page.goto('./');
    await expect(page.locator('.app-logo')).toBeVisible();
    const packShell = page.getByRole('button', { name: /^Open a .* pack$/ });
    await expectDecoded(packShell.locator('img'), 2);
    await packShell.scrollIntoViewIfNeeded();
    const dragStarts = await countDragStarts(page);
    const finger = await fingerFor(page, true);

    // Below the tear line, so the press is no cut.
    await tryTouchDrag(page, finger, packShell.locator('img').first(), 0, 40);
    expect(await dragStarts()).toBe(0);
    expect(await selectedText(page)).toBe('');
    await expect(packShell).not.toHaveClass(/\bis-cut\b/);

    await packShell.focus();
    await page.keyboard.press('Space');
    const card = page.locator('.reveal-card').last().locator('.card-wrapper');
    await expect(card).toBeVisible({ timeout: 15000 });
    await tryTouchDrag(page, finger, card.locator('img').first(), 0, 30);
    expect(await dragStarts()).toBe(0);
    expect(await selectedText(page)).toBe('');
    await tryTouchDrag(page, finger, page.locator('.reveal-rarity'), 0, 0);
    expect(await selectedText(page)).toBe('');

    await page.locator('button.reveal-skip').click({ timeout: 15000 });
    await expect(page.locator('.pack-summary')).toBeVisible({ timeout: 30000 });
    await tryTouchDrag(page, finger, page.locator('.summary-cards img').first(), 30, 0);
    expect(await dragStarts()).toBe(0);
    // A swipe up scrolls down, and a swipe down scrolls back up.
    await expectSummaryScrolls(page, async (x, y, down) => {
      await finger.press(x, y);
      for (let step = 1; step <= 8; step++) await finger.move(x, y + (down ? -15 : 15) * step);
      await finger.release();
    });
    expect(errors).toEqual([]);
  });

  test('long presses and drags on the logo and navigation labels select no text and start no native drag', async ({ page, baseURL }) => {
    test.setTimeout(60000);
    const errors = await monitor(page, baseURL!, 0, { returning: true });
    await page.goto('./');
    const logo = page.locator('.app-logo');
    await expect(logo).toBeVisible();
    const dragStarts = await countDragStarts(page);
    const finger = await fingerFor(page, true);

    // Across the title letters, the way a long press then a slide would grow a selection.
    await tryTouchDrag(page, finger, logo, 40, 0);
    expect(await dragStarts()).toBe(0);
    expect(await selectedText(page)).toBe('');
    const nav = page.getByRole('navigation', { name: 'Main', exact: true });
    for (const name of ['Cards', 'Rankings', 'Profile', 'Open']) {
      await tryTouchDrag(page, finger, nav.locator('.app-nav-item').filter({ hasText: name }).locator('.app-nav-label'), 20, 0);
      expect(await dragStarts(), name).toBe(0);
      expect(await selectedText(page), name).toBe('');
    }
    expect(errors).toEqual([]);
  });
});

test('inputs, copyable text and links keep selection and activation', async ({ page, baseURL }) => {
  const errors = await monitor(page, baseURL!, 0, { returning: true });
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  const dialog = (name: string) => page.getByRole('dialog', { name, exact: true });
  await page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('button', { name: 'Profile', exact: true }).click();
  const player = page.getByRole('main', { name: 'Profile', exact: true });

  const name = player.getByRole('textbox', { name: 'Name shown on shared pulls', exact: true });
  await expect(name).toHaveValue('Browser smoke fixture');
  await name.click({ clickCount: 3 });
  expect(await name.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd]))
    .toEqual([0, 'Browser smoke fixture'.length]);

  // The ID is plain text; the status region beside it only carries save results.
  const playerId = player.getByRole('paragraph').filter({ hasText: /^Player ID #/ });
  await expect(playerId).toContainText('Player ID #');
  await playerId.click({ clickCount: 3 });
  expect(await selectedText(page)).toContain((await playerId.textContent())!);
  await page.evaluate(() => document.getSelection()?.removeAllRanges());
  await player.getByRole('button', { name: 'Close Profile', exact: true }).click();

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('main', { name: 'Settings', exact: true }).getByRole('button', { name: 'Report a problem', exact: true }).click();
  // By its label: the textarea's id comes from useId, so it isn't a stable selector.
  const report = dialog('Report a problem').getByRole('textbox', { name: 'Report details (editable)', exact: true });
  await expect(report).toBeVisible();
  await report.focus();
  await page.keyboard.press('ControlOrMeta+A');
  expect(await report.evaluate((area: HTMLTextAreaElement) => area.selectionEnd - area.selectionStart))
    .toBe(await report.evaluate((area: HTMLTextAreaElement) => area.value.length));
  const notice = page.locator('.diagnostic-report p', { hasText: 'No automatic uploads' });
  await notice.click({ clickCount: 3 });
  expect(await selectedText(page)).toContain('No automatic uploads');

  // A 204 cancels the popup's navigation, so answer the issue form locally instead (still offline).
  await page.context().route('https://github.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '' }));
  const [issues] = await Promise.all([
    page.context().waitForEvent('page'),
    page.getByRole('link', { name: 'Open GitHub issues' }).click(),
  ]);
  expect(issues.url()).toMatch(/^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/new\?template=bug\.yml$/);
  await issues.close();
  expect(errors).toEqual([]);
});
