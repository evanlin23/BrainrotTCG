import { test, expect, type Locator, type Page } from '@playwright/test';
import { monitor, expectDecoded } from './support';

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

test('rapid clicks and drags on the pack and reveal select no text and start no native drag', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const errors = await monitor(page, baseURL!);
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  const packShell = page.getByRole('button', { name: /^Open a .* pack$/ });
  await expectDecoded(packShell.locator('img'), 2);
  const dragStarts = await countDragStarts(page);

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
  expect(errors).toEqual([]);
});

test('inputs, copyable text and links keep selection and activation', async ({ page, baseURL }) => {
  const errors = await monitor(page, baseURL!);
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  const dialog = (name: string) => page.getByRole('dialog', { name, exact: true });
  await page.getByRole('button', { name: 'Player', exact: true }).click();
  const player = dialog('Player');

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
  await player.getByRole('button', { name: 'Close', exact: true }).click();

  await page.getByRole('button', { name: 'Sound & display', exact: true }).click();
  await dialog('Sound & display').getByRole('button', { name: 'Report a problem', exact: true }).click();
  const report = page.locator('#diagnostic-report-text');
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
