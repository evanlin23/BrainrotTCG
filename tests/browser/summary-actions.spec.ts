import { test, expect, type Page } from '@playwright/test';
import { monitor, expectDecoded, fingerFor, snapshot } from './support';

/**
 * The pack summary (#182): its actions keep their own row on screen while the cards scroll, at 360x640
 * and 1280x800, at 100% and 200% text, and nothing but the pack's X (or Escape, Back, or the actions)
 * leaves it. The phone runs are Pixel 5 emulation with touch and an emulated 34px home-indicator
 * inset, not a real phone; 200% text is emulated by doubling the root font size the rem tokens use.
 * The drags that select the card viewer's text use Playwright's emulated mouse in both runs.
 */

const PHONE = { width: 360, height: 640 };
const DESKTOP = { width: 1280, height: 800 };
const INSET = 34;

const isPhone = () => test.info().project.name.startsWith('mobile');

/** Opens the fixture player's first pack and skips to its summary. */
async function openSummary(page: Page, baseURL: string, { textZoom = 100 } = {}) {
  const errors = await monitor(page, baseURL);
  await page.setViewportSize(isPhone() ? PHONE : DESKTOP);
  if (isPhone()) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { bottom: INSET, bottomMax: INSET } });
  }
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  if (textZoom !== 100) await page.addStyleTag({ content: `html { font-size: ${textZoom}% !important; }` });
  const packShell = page.getByRole('button', { name: /^Open a .* pack$/ });
  await packShell.focus();
  await page.keyboard.press('Space');
  await expect(page.locator('.card-reveal-area')).toBeVisible({ timeout: 15000 });
  await page.locator('button.reveal-skip').click({ timeout: 15000 });
  await expect(page.locator('.summary-card')).toHaveCount(5, { timeout: 30000 });
  await expectDecoded(page.locator('.summary-cards img'), 5);
  await expect(page.locator('.summary-title')).toBeFocused();
  await settled(page);
  return { errors, packShell };
}

/** Waits out the summary's entrance: two reads of its layout a frame apart agree. */
async function settled(page: Page) {
  const read = () => page.evaluate(() => JSON.stringify(
    ['.summary-content', '.summary-actions', '.summary-cards li:last-child'].map((selector) => document.querySelector(selector)?.getBoundingClientRect()),
  ));
  await expect.poll(async () => (await read()) === (await page.waitForTimeout(150).then(read)), 'the summary settled').toBe(true);
}

/** The summary's boxes, rounded to whole pixels; `content` is the scrolling list, `actions` its own row. */
function layout(page: Page) {
  return page.evaluate(() => {
    const box = (element: Element) => {
      const { top, bottom, left, right } = element.getBoundingClientRect();
      return { top: Math.round(top), bottom: Math.round(bottom), left: Math.round(left), right: Math.round(right) };
    };
    const content = document.querySelector<HTMLElement>('.summary-content')!;
    return {
      viewport: { width: innerWidth, height: innerHeight },
      inset: parseFloat(getComputedStyle(document.querySelector('.app-main')!).paddingBottom),
      scrollTop: content.scrollTop,
      scrollable: content.scrollHeight - content.clientHeight,
      pageOverflow: document.documentElement.scrollWidth - innerWidth,
      content: box(content),
      actions: box(document.querySelector('.summary-actions')!),
      buttons: Array.from(document.querySelectorAll('.summary-actions .btn'), box),
      lastCard: box(document.querySelector('.summary-cards li:last-child')!),
    };
  });
}

/** True when the element is the one hit at the middle of its part inside the scrolling list. */
function unobstructed(page: Page) {
  return page.evaluate(() => {
    const element = document.activeElement!;
    const box = element.getBoundingClientRect();
    const list = document.querySelector('.summary-content')!.getBoundingClientRect();
    const scope = element.closest('.summary-actions') ? box : list;
    const top = Math.max(box.top, scope.top);
    const bottom = Math.min(box.bottom, scope.bottom);
    if (bottom - top < 1) return false;
    const hit = document.elementFromPoint((box.left + box.right) / 2, (top + bottom) / 2);
    return !!hit && element.contains(hit);
  });
}

/** A point on the summary's empty space: what's hit there is the area or a summary container itself. */
function emptyPoint(page: Page, classes: string[]) {
  return page.evaluate((classes) => {
    for (let y = 8; y < innerHeight; y += 12) {
      for (let x = 4; x < innerWidth; x += 12) {
        const hit = document.elementFromPoint(x, y);
        if (hit && classes.some((name) => hit.classList.contains(name)) && !hit.closest('button, a, [role="dialog"]')) return { x, y };
      }
    }
    return null;
  }, classes);
}

/**
 * A point outside the open card viewer's content once its entrance is over: the backdrop, or the bare
 * sheet's own empty space, which is all a phone shows around the card.
 */
async function outsideViewer(page: Page) {
  const sheet = page.locator('.sheet');
  await expect.poll(() => sheet.evaluate((panel) => panel.getAnimations().every((a) => a.playState === 'finished')), 'the viewer settled').toBe(true);
  return sheet.evaluate((panel) => {
    const empty = [document.querySelector('.sheet-backdrop'), panel, panel.querySelector('.sheet-body')];
    for (let y = 8; y < innerHeight; y += 12) {
      for (let x = 4; x < innerWidth; x += 12) {
        const hit = document.elementFromPoint(x, y);
        if (hit && empty.includes(hit)) return { x, y, hit: hit.className };
      }
    }
    return null;
  });
}

/**
 * Two mouse drags in the open card viewer that end on its body's empty space, where the browser fires
 * the click on the body (their common ancestor): one from the card, one across the first line of its
 * text (the flavor, or the rarity) to the body's padding on the right of that line.
 */
function viewerDrags(page: Page) {
  return page.locator('.sheet').evaluate((panel) => {
    const body = panel.querySelector('.sheet-body')!;
    const onBody = (x: number, y: number) => document.elementFromPoint(x, y) === body;
    const card = panel.querySelector('.card-viewer-card')!.getBoundingClientRect();
    const area = body.getBoundingClientRect();
    let empty: { x: number; y: number } | null = null;
    for (let y = Math.ceil(area.top) + 2; !empty && y < area.bottom; y += 6) {
      for (let x = Math.ceil(area.left) + 2; x < area.right; x += 6) if (onBody(x, y)) { empty = { x, y }; break; }
    }
    const info = panel.querySelector('.card-viewer-info')!;
    const range = document.createRange();
    range.selectNodeContents(info.querySelector('.card-viewer-flavor') ?? info.firstElementChild!);
    const line = range.getClientRects()[0];
    const y = Math.round(line.top + line.height / 2);
    let right: number | null = null;
    for (let x = Math.floor(area.right) - 2; right === null && x > line.right; x -= 2) if (onBody(x, y)) right = x;
    return {
      fromCard: empty && { x0: card.left + card.width / 2, y0: card.top + card.height / 2, x1: empty.x, y1: empty.y },
      acrossText: right === null ? null : { x0: Math.ceil(line.left) + 2, y0: y, x1: right, y1: y },
    };
  });
}

for (const textZoom of [100, 200]) {
  test(`keeps the summary's actions on screen at ${textZoom}% text while the cards scroll past the last one`, async ({ page, baseURL }) => {
    test.setTimeout(60000);
    const { errors } = await openSummary(page, baseURL!, { textZoom });

    const before = await layout(page);
    expect(before.viewport).toEqual(isPhone() ? PHONE : DESKTOP);
    // The phone keeps clear of the emulated home indicator; from 900px the inset isn't in play.
    if (isPhone()) expect(before.inset).toBe(INSET);
    expect(before.scrollable, 'the cards need to scroll for this check to mean anything').toBeGreaterThan(40);
    expect(before.pageOverflow, 'the page scrolls sideways').toBeLessThanOrEqual(0);
    // The actions sit whole on screen, above the inset, below the list and never over it.
    expect(before.actions.top).toBeGreaterThanOrEqual(before.content.bottom);
    expect(before.actions.bottom).toBeLessThanOrEqual(before.viewport.height - (isPhone() ? INSET : 0));
    for (const button of before.buttons) {
      expect(button.left).toBeGreaterThanOrEqual(0);
      expect(button.right).toBeLessThanOrEqual(before.viewport.width);
      expect(button.top).toBeGreaterThanOrEqual(before.actions.top);
      expect(button.bottom).toBeLessThanOrEqual(before.actions.bottom);
      expect(button.bottom - button.top).toBeGreaterThanOrEqual(44);
    }
    await expect(page.getByRole('button', { name: 'Open another pack' })).toBeInViewport({ ratio: 1 });

    // Scrolled to the end, the actions haven't moved and the last card is clear of them.
    await page.locator('.summary-content').evaluate((list) => { list.scrollTop = list.scrollHeight; });
    const after = await layout(page);
    expect(after.scrollTop).toBeGreaterThan(0);
    expect(after.actions).toEqual(before.actions);
    expect(after.buttons).toEqual(before.buttons);
    expect(after.lastCard.bottom).toBeLessThanOrEqual(after.content.bottom);
    expect(after.lastCard.bottom).toBeLessThanOrEqual(after.actions.top);

    // Focus order is the page's: the heading, every card and its Share, the rest, then the actions.
    // Each stop is on screen and not under anything, the last card's Share included.
    await page.locator('.summary-content').evaluate((list) => { list.scrollTop = 0; });
    await page.locator('.summary-title').focus();
    const expected = await page.locator('.pack-summary').evaluate((summary) => Array.from(summary.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )).filter((element) => element.checkVisibility()).map((element) => element.outerHTML));
    await expect(page.locator('.summary-card-share')).toHaveCount(5);
    expect(expected.length).toBeGreaterThanOrEqual(12);
    const visited: string[] = [];
    for (let stop = 0; stop < expected.length; stop++) {
      await page.keyboard.press('Tab');
      visited.push(await page.evaluate(() => document.activeElement!.outerHTML));
      expect(await unobstructed(page), `stop ${stop + 1} is covered or off screen`).toBe(true);
    }
    expect(visited).toEqual(expected);
    expect(visited.at(-1)).toContain('Open another pack');
    expect(errors).toEqual([]);
  });
}

test('card taps, swipes and empty space never leave the summary; the viewer closes from outside, not from a drag off its text, the X leaves', async ({ page, baseURL, hasTouch }) => {
  test.setTimeout(60000);
  const { errors, packShell } = await openSummary(page, baseURL!);
  const summary = page.locator('.pack-summary');
  const dialog = page.getByRole('dialog');
  const recorded = async () => (await snapshot(page)).stats?.packsOpened;
  expect(await recorded()).toBe(1);
  const stays = async (what: string) => {
    await page.waitForTimeout(400);
    await expect(summary, `${what} left the summary`).toBeVisible();
    await expect(page.locator('.summary-card'), `${what} changed the summary`).toHaveCount(5);
    await expect(packShell, `${what} brought the sealed pack back`).toBeHidden();
    expect(await recorded(), `${what} recorded the pack again`).toBe(1);
  };
  const finger = await fingerFor(page, hasTouch);
  const tap = async (x: number, y: number) => { await finger.press(x, y); await finger.release(); };

  // Taps on the summary's empty space: the blank background never leaves a pack (DESIGN.md).
  for (const classes of [['card-reveal-area'], ['pack-summary', 'summary-content', 'summary-details']]) {
    const point = await emptyPoint(page, classes);
    expect(point, `no empty ${classes[0]} to tap`).not.toBeNull();
    await tap(point!.x, point!.y);
    await stays(`a tap on the empty ${classes[0]}`);
  }

  // Swipes across the cards, sideways and up, flick or drag: they scroll or select, never dismiss.
  const first = (await page.locator('.summary-card').first().boundingBox())!;
  const last = (await page.locator('.summary-card').last().boundingBox())!;
  const strokes = [
    [first.x + first.width / 2, first.y + first.height / 2, last.x + last.width / 2, first.y + first.height / 2],
    [first.x + first.width * 0.8, first.y + first.height / 2, Math.max(4, first.x - 120), first.y + first.height / 2],
    [first.x + first.width / 2, first.y + first.height * 0.8, first.x + first.width / 2, Math.max(8, first.y - 160)],
  ];
  for (const [index, [x0, y0, x1, y1]] of strokes.entries()) {
    await page.locator('.summary-card').first().scrollIntoViewIfNeeded();
    await finger.press(x0, y0);
    for (let step = 1; step <= 8; step++) await finger.move(x0 + ((x1 - x0) * step) / 8, y0 + ((y1 - y0) * step) / 8);
    await finger.release();
    await stays(`swipe ${index + 1} across the cards`);
    await expect(dialog, `swipe ${index + 1} opened a card`).toHaveCount(0);
  }

  // A tap on a card opens it over the summary; a tap outside it closes only the viewer and gives focus
  // back to the card. Dragging from the card, or across its text, onto the empty space leaves it open.
  for (const index of [0, 4]) {
    const card = page.locator('.summary-card').nth(index);
    await card.scrollIntoViewIfNeeded();
    const box = (await card.boundingBox())!;
    await tap(box.x + box.width / 2, box.y + box.height / 2);
    await expect(dialog).toBeVisible();
    const outside = await outsideViewer(page);
    expect(outside, 'no empty space outside the card to tap').not.toBeNull();
    // A wide screen shows the backdrop around the card; a phone's bare sheet covers it.
    if (!isPhone()) expect(outside!.hit).toBe('sheet-backdrop');

    const drags = await viewerDrags(page);
    for (const [name, drag] of Object.entries(drags)) {
      expect(drag, `no empty space in the viewer's body for the drag ${name}`).not.toBeNull();
      const { x0, y0, x1, y1 } = drag!;
      await page.mouse.move(x0, y0);
      await page.mouse.down();
      await page.mouse.move(x1, y1, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(200);
      await expect(dialog, `a drag ${name} to the empty space closed card ${index + 1}`).toBeVisible();
    }
    await page.evaluate(() => getSelection()?.removeAllRanges());

    await tap(outside!.x, outside!.y);
    await expect(dialog).toHaveCount(0);
    await expect(card, `closing card ${index + 1} from outside didn't give focus back to it`).toBeFocused();
    await stays(`closing card ${index + 1} from outside`);
  }

  // The pack's X leaves, to the sealed pack, without recording the pack again.
  await page.getByRole('button', { name: 'Back to packs', exact: true }).click();
  await expect(packShell).toBeVisible({ timeout: 15000 });
  await expect(summary).toHaveCount(0);
  expect(await recorded()).toBe(1);
  expect(errors).toEqual([]);
});
