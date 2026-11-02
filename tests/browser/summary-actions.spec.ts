import { test, expect, type Page } from '@playwright/test';
import { monitor, expectDecoded, expectSummaryTakesClicks, fingerFor, snapshot, untilIdle, PLAYER_KEY_PREFIX } from './support';
import { STORAGE_KEYS } from '../../src/constants/config';
import { HOF_RELAYS } from '../../src/game/nostrInbox';

/**
 * The pack summary (#182, #339): its actions stay stuck on screen while the rest scrolls, at 360x640
 * and 1280x800, at 100% and 200% text, and nothing but the pack's X (or Escape, Back, or the actions)
 * leaves it. The phone runs are Pixel 5 emulation with touch and an emulated 34px home-indicator
 * inset, not a real phone; 200% text is emulated by doubling the root font size the rem tokens use.
 * The drags that select the card viewer's text use Playwright's emulated mouse in both runs.
 */

const PHONE = { width: 360, height: 640 };
const DESKTOP = { width: 1280, height: 800 };
const INSET = 34;

const isPhone = () => test.info().project.name.startsWith('mobile');

/**
 * Opens the fixture player's first pack and skips to its summary. `history` seeds that many synthetic
 * packs first, so the pack opened is the fixture's ticket with that nonce.
 */
/** Earlier packs to seed in place of the synthetic ones, as [set, version, score] by ticket, and the set the next pack opens from. */
interface RecordSeed {
  setId: string;
  packs: [setId: string, version: number, score: number][];
}

async function openSummary(page: Page, baseURL: string, { textZoom = 100, viewport = isPhone() ? PHONE : DESKTOP, history = 0, seed }: { textZoom?: number; viewport?: { width: number; height: number }; history?: number; seed?: RecordSeed } = {}) {
  const errors = await monitor(page, baseURL, seed ? seed.packs.length : history);
  // Runs after monitor's seeding, on the first load only: this player's earlier packs (no cards, so only
  // their scores count) and the selected set, so the pack opened next lands on ticket packs.length.
  if (seed) await page.addInitScript(({ keys, prefix, seed }) => {
    if (sessionStorage.getItem('records-seeded')) return;
    sessionStorage.setItem('records-seeded', '1');
    localStorage.setItem(keys.SELECTED_SET, seed.setId);
    localStorage.setItem(keys.HISTORY, JSON.stringify(seed.packs.map(([s, v, x], n) => ({ s, v, n, k: prefix, h: 'Pair', x, t: 1_000 + n })).reverse()));
  }, { keys: STORAGE_KEYS, prefix: PLAYER_KEY_PREFIX, seed });
  await page.setViewportSize(viewport);
  if (isPhone()) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { bottom: INSET, bottomMax: INSET } });
  }
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  if (textZoom !== 100) await page.addStyleTag({ content: `html { font-size: ${textZoom}% !important; }` });
  const packShell = page.getByRole('button', { name: /^Open pack/ });
  await packShell.focus();
  await page.keyboard.press('Space');
  await expect(page.locator('.card-reveal-area')).toBeVisible({ timeout: 15000 });
  await page.locator('button.reveal-skip').click({ timeout: 15000 });
  await expect(page.locator('.summary-card')).toHaveCount(5, { timeout: 30000 });
  await expectDecoded(page.locator('.summary-cards img'), 5);
  await expect(page.locator('.summary-title')).toBeFocused();
  await expectSummaryTakesClicks(page);
  await settled(page);
  return { errors, packShell };
}

/** Waits out the summary's entrance: its fade and rise have ended. */
async function settled(page: Page) {
  await expect.poll(() => page.locator('.pack-summary').evaluate((el) => {
    const { transform, opacity } = getComputedStyle(el);
    return new DOMMatrixReadOnly(transform).isIdentity && opacity === '1';
  }), { message: 'the summary settled' }).toBe(true);
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

/**
 * Null when the focused element is what's hit across its visible part inside the scrolling list, else
 * what covers it. Only the summary's own parts count as covering: a toast over the app is not one.
 */
function obstruction(page: Page) {
  return page.evaluate(() => {
    const element = document.activeElement!;
    const box = element.getBoundingClientRect();
    const list = document.querySelector('.summary-content')!.getBoundingClientRect();
    const top = Math.max(box.top, list.top);
    const bottom = Math.min(box.bottom, list.bottom);
    if (bottom - top < 1) return `off screen: ${Math.round(box.top)}..${Math.round(box.bottom)} in ${Math.round(list.top)}..${Math.round(list.bottom)}`;
    // The middle, then both ends of the visible part: the stuck actions can cover the bottom of a card.
    const x = (box.left + box.right) / 2;
    for (const y of [(top + bottom) / 2, top + 1, bottom - 1]) {
      const hit = document.elementsFromPoint(x, y).find((under) => under.closest('.pack-summary'));
      if (!hit || !element.contains(hit)) return `at y=${Math.round(y)} (${Math.round(top)}..${Math.round(bottom)}): ${hit?.className || hit?.tagName}`;
    }
    return null;
  });
}

/**
 * A point on the summary's empty space: what's hit there is the area or a summary container itself, and
 * a finger's width clear of a toast (a touch's radius would reach it, and a tap on that opens a page).
 */
function emptyPoint(page: Page, classes: string[]) {
  return page.evaluate((classes) => {
    const toast = document.querySelector('.toast')?.getBoundingClientRect();
    const reach = 24;
    for (let y = 8; y < innerHeight; y += 12) {
      for (let x = 4; x < innerWidth; x += 12) {
        if (toast && x > toast.left - reach && x < toast.right + reach && y > toast.top - reach && y < toast.bottom + reach) continue;
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

// At 100% the summary fits without scrolling (the tests below); 200% text makes it scroll.
for (const textZoom of [200]) {
  test(`keeps the summary's actions on screen at ${textZoom}% text, stuck above the inset while the rest scrolls`, async ({ page, baseURL }) => {
    test.setTimeout(60000);
    const { errors } = await openSummary(page, baseURL!, { textZoom });

    const before = await layout(page);
    expect(before.viewport).toEqual(isPhone() ? PHONE : DESKTOP);
    // The phone keeps clear of the emulated home indicator; from 900px the inset isn't in play.
    if (isPhone()) expect(before.inset).toBe(INSET);
    expect(before.scrollable, 'the summary needs to scroll for this check to mean anything').toBeGreaterThan(40);
    expect(before.pageOverflow, 'the page scrolls sideways').toBeLessThanOrEqual(0);
    // The actions sit whole on screen, inside the list's box and above the inset.
    expect(before.actions.top).toBeGreaterThanOrEqual(before.content.top);
    expect(before.actions.bottom).toBeLessThanOrEqual(before.content.bottom);
    expect(before.actions.bottom).toBeLessThanOrEqual(before.viewport.height - (isPhone() ? INSET : 0));
    for (const button of before.buttons) {
      expect(button.left).toBeGreaterThanOrEqual(0);
      expect(button.right).toBeLessThanOrEqual(before.viewport.width);
      expect(button.top).toBeGreaterThanOrEqual(before.actions.top);
      expect(button.bottom).toBeLessThanOrEqual(before.actions.bottom);
      expect(button.bottom - button.top).toBeGreaterThanOrEqual(44);
    }
    await expect(page.getByRole('button', { name: /^Open .+ again$/ })).toBeInViewport({ ratio: 1 });

    // Scrolled to the end, the actions are still whole on screen and the last card is clear of them.
    await page.locator('.summary-content').evaluate((list) => { list.scrollTop = list.scrollHeight; });
    const after = await layout(page);
    expect(after.scrollTop).toBeGreaterThan(0);
    expect(after.actions.bottom).toBeLessThanOrEqual(after.content.bottom);
    await expect(page.getByRole('button', { name: /^Open .+ again$/ })).toBeInViewport({ ratio: 1 });
    expect(after.lastCard.bottom).toBeLessThanOrEqual(after.actions.top);
    // "Try another pack" is there too: in view, clear of the stuck actions (to a pixel of layout rounding), and what is hit at its centre (#898).
    const tryAnother = page.getByRole('button', { name: /^Try another pack, \d+ other packs? to choose from$/ });
    await expect(tryAnother).toBeInViewport({ ratio: 1 });
    expect(await tryAnother.evaluate((button) => {
      const box = button.getBoundingClientRect();
      // Only the summary's own parts cover it: a toast over the app is the toast specs' concern.
      const hit = document.elementsFromPoint(box.left + box.width / 2, box.top + box.height / 2).find((under) => under.closest('.pack-summary'));
      return { covered: !hit || !button.contains(hit), clearOfActions: box.bottom <= document.querySelector('.summary-actions')!.getBoundingClientRect().top + 1 };
    })).toEqual({ covered: false, clearOfActions: true });

    // Focus order is the page's: the heading, "How Rankings work" in the note (this pull doesn't qualify), the Card
    // guide, every card, then the actions.
    // Each stop is on screen and not under anything, the stuck actions included.
    await page.locator('.summary-content').evaluate((list) => { list.scrollTop = 0; });
    await page.locator('.summary-title').focus();
    const expected = await page.locator('.pack-summary').evaluate((summary) => Array.from(summary.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input, select, textarea, details > summary, [tabindex]:not([tabindex="-1"])',
    )).filter((element) => element.checkVisibility()).map((element) => element.outerHTML));
    await expect(page.locator('.summary-card')).toHaveCount(5);
    expect(expected.length).toBeGreaterThanOrEqual(8);
    const visited: string[] = [];
    for (let stop = 0; stop < expected.length; stop++) {
      await page.keyboard.press('Tab');
      // data-ring-kept is state the stop gets from the Tab that placed it (inputModality.ts), not part of the control.
      visited.push(await page.evaluate(() => {
        const stop = document.activeElement!.cloneNode(true) as Element;
        stop.removeAttribute('data-ring-kept');
        return stop.outerHTML;
      }));
      expect(await obstruction(page), `stop ${stop + 1} is covered or off screen`).toBeNull();
    }
    expect(visited).toEqual(expected);
    expect(visited.at(-1)).toMatch(/Open .+ again/);
    expect(errors).toEqual([]);
  });
}

// The whole result on one phone screen at 100% text: headline, score, all five cards and both
// actions without scrolling, and nothing sideways (Chromium emulation of the two phone sizes).
for (const viewport of [{ width: 390, height: 844 }, { width: 360, height: 740 }]) test(`shows the headline, score, every card and both actions without scrolling at ${viewport.width}x${viewport.height}`, async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const { errors } = await openSummary(page, baseURL!, { viewport });
  // The fixture's first pack has no earlier best to beat (#1287).
  await expect(page.locator('.pack-headline-record')).toHaveCount(0);
  expect(await page.locator('.summary-content').evaluate((list) => list.scrollTop)).toBe(0);
  // The cards are the last content: the summary has nothing left to scroll to.
  expect(await page.locator('.summary-content').evaluate((list) => list.scrollHeight - list.clientHeight)).toBeLessThanOrEqual(0);
  for (const locator of [
    page.locator('.summary-title'),
    page.locator('.pack-headline-combo'),
    ...Array.from({ length: 5 }, (_, index) => page.locator('.summary-card').nth(index)),
    page.getByRole('button', { name: 'Share', exact: true }),
    page.getByRole('button', { name: /^Open .+ again$/ }),
  ]) await expect(locator).toBeInViewport({ ratio: 1 });
  // Nothing in the actions' way: the last card ends above them.
  const { lastCard, actions, buttons, pageOverflow } = await layout(page);
  expect(lastCard.bottom).toBeLessThanOrEqual(Math.min(...buttons.map((button) => button.top)));
  expect(actions.bottom).toBeLessThanOrEqual(viewport.height);
  expect(pageOverflow).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});

// Other packs are discoverable from the result (#898): after a first pack, "Try another pack" sits between the
// cards and the stuck actions, stays whole on screen clear of the other buttons, and opens the same Packs sheet
// the picker does, with the pack's set still the chosen one. At the owner's phone, a short landscape phone and
// the desktop. Picking another set from that sheet puts focus on the new sealed pack.
for (const viewport of [{ width: 393, height: 727 }, { width: 667, height: 375 }, { width: 1280, height: 800 }]) test(`offers Try another pack after a first pack and opens the Packs sheet at ${viewport.width}x${viewport.height}`, async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const { errors } = await openSummary(page, baseURL!, { viewport });
  const tryAnother = page.getByRole('button', { name: /^Try another pack, \d+ other packs? to choose from$/ });
  const again = page.getByRole('button', { name: /^Open .+ again$/ });
  await expect(tryAnother).toBeVisible();
  // On a short screen the summary scrolls: focus brings it clear of the stuck actions, as a keyboard player would.
  await tryAnother.focus();
  await expect(tryAnother).toBeInViewport({ ratio: 1 });
  await expect(again).toBeInViewport({ ratio: 1 });
  // Above the stuck row (not in it), and is a 44px target that never overlaps the Share and primary buttons below it.
  const boxes = await page.evaluate(() => {
    const box = (element: Element | null) => {
      const { top, bottom, left, right, height } = element!.getBoundingClientRect();
      return { top, bottom, left, right, height };
    };
    const buttons = Array.from(document.querySelectorAll('.summary-try-another, .summary-actions button'));
    return { buttons: buttons.map((button) => ({ text: button.textContent!.trim().slice(0, 14), ...box(button) })), inActions: document.querySelectorAll('.summary-actions .summary-try-another').length, pageOverflow: document.documentElement.scrollWidth - innerWidth };
  });
  expect(boxes.inActions).toBe(0);
  expect(boxes.buttons.map((b) => b.text)).toEqual([expect.stringMatching(/^Try another/), expect.anything(), expect.stringMatching(/^Open /)]);
  expect(boxes.buttons[0].height).toBeGreaterThanOrEqual(44);
  for (const lower of boxes.buttons.slice(1)) expect(boxes.buttons[0].bottom, JSON.stringify(boxes)).toBeLessThanOrEqual(lower.top);
  expect(boxes.pageOverflow).toBeLessThanOrEqual(0);

  const selectedBefore = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEYS.SELECTED_SET);
  await tryAnother.focus();
  await page.keyboard.press('Enter');
  const sheet = page.getByRole('dialog', { name: 'Packs' });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('.pack-tile[aria-pressed="true"]')).toHaveCount(1);
  expect(await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEYS.SELECTED_SET)).toBe(selectedBefore);
  // Closing it leaves the summary as it was, with focus back on the control that opened it.
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(tryAnother).toBeFocused();
  await expect(page.locator('.summary-card')).toHaveCount(5);

  // Picking another set replaces the summary and the control that opened the sheet: the new sealed pack takes
  // focus, so a keyboard player is not dropped on the page.
  await page.keyboard.press('Enter');
  await expect(sheet).toBeVisible();
  await sheet.locator('.pack-tile[aria-pressed="false"]').first().click();
  await expect(sheet).toBeHidden();
  await expect(page.locator('.summary-card')).toHaveCount(0);
  await expect(page.locator('[data-pack-open]')).toBeFocused();
  expect(errors).toEqual([]);
});

// The longest set name on the owner's phone: when the actions wrap, Share and the primary each fill their row
// (no small Share orphaned above a wide primary), the long label reads whole, every target is 44px and the
// page never scrolls sideways (#898).
test('a long set name keeps Share and the primary whole, filling their rows, at 393x727', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const viewport = { width: 393, height: 727 };
  await page.route('**/hall-of-fame.json', (route) => route.fulfill({ json: [] }));
  const { errors } = await openSummary(page, baseURL!, { viewport, seed: { setId: 'italian-brainrot-deep-cuts', packs: [['genesis', 1, 1e12]] } });
  const again = page.getByRole('button', { name: 'Open Italian Brainrot Deep Cuts again' });
  await expect(again).toBeVisible();
  await expect(again).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole('button', { name: 'Share', exact: true })).toBeInViewport({ ratio: 1 });
  const rows = await page.evaluate(() => {
    const row = document.querySelector('.summary-actions')!.getBoundingClientRect();
    return {
      row: { left: row.left, right: row.right },
      pageOverflow: document.documentElement.scrollWidth - innerWidth,
      buttons: Array.from(document.querySelectorAll('.summary-try-another, .summary-actions .btn'), (button) => {
        const box = button.getBoundingClientRect();
        const style = getComputedStyle(button);
        return { text: button.textContent!.trim(), top: box.top, bottom: box.bottom, left: box.left, right: box.right, height: box.height, fontSize: parseFloat(style.fontSize), clipped: button.scrollWidth > button.clientWidth };
      }),
    };
  });
  const [tryAnother, share, primary] = rows.buttons;
  expect([tryAnother.text, share.text, primary.text]).toEqual(['Try another pack', 'Share', 'Open Italian Brainrot Deep Cuts again']);
  for (const button of rows.buttons) {
    expect(button.height, JSON.stringify(button)).toBeGreaterThanOrEqual(44);
    expect(button.fontSize, JSON.stringify(button)).toBeGreaterThanOrEqual(14);
    expect(button.clipped, JSON.stringify(button)).toBe(false);
    expect(button.left).toBeGreaterThanOrEqual(0);
    expect(button.right).toBeLessThanOrEqual(viewport.width);
  }
  // In order, nothing overlapping; the primary is the last and lowest.
  expect(tryAnother.bottom).toBeLessThanOrEqual(share.top);
  expect(share.bottom).toBeLessThanOrEqual(primary.top);
  // Wrapped, each fills its row: Share spans the row as the primary does, never a small orphan.
  expect(share.right - share.left, JSON.stringify(rows)).toBeGreaterThanOrEqual(rows.row.right - rows.row.left - 2);
  expect(primary.right - primary.left).toBeGreaterThanOrEqual(rows.row.right - rows.row.left - 2);
  expect(rows.pageOverflow).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});

// A pull under the Rankings bar says why it has no Submit (#1004): the fixture's first pack is a No Matches. The
// line is the Rankings page's own rule text, fits the width and stays on screen with the rest of the summary.
for (const viewport of [{ width: 390, height: 844 }, { width: 360, height: 740 }]) test(`a pull that does not qualify says why it has no Submit, in view, at ${viewport.width}x${viewport.height}`, async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const { errors } = await openSummary(page, baseURL!, { viewport });
  const line = page.locator('.summary-hof');
  await expect(line).toContainText("Doesn't qualify for Rankings, which take a Full House or better, or a Brainrot Score of");
  await expect(line).toContainText('See How Rankings work.');
  // "How Rankings work" is the one button in the line (it goes to that section of Rankings, below).
  await expect(line.getByRole('button')).toHaveCount(1);
  await expect(line.getByRole('button', { name: 'How Rankings work' })).toBeVisible();
  await expect(line).toBeInViewport({ ratio: 1 });
  const { fits, lines } = await line.evaluate((el) => ({
    fits: el.scrollWidth <= el.clientWidth,
    lines: Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)),
  }));
  expect(fits).toBe(true);
  expect(lines).toBeLessThanOrEqual(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});

// "How Rankings work" in that note is a real button: it opens Rankings with that section open and in view, by
// keyboard too, and Close returns to the same summary (it stays mounted under a page).
test('"How Rankings work" in the note opens that section of Rankings, and Close comes back to the summary', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const { errors } = await openSummary(page, baseURL!);
  const help = page.locator('.summary-hof').getByRole('button', { name: 'How Rankings work' });
  // The words are small, but the button's hit area is a 44px target around them, and it stops short of the Card
  // guide below the note: no two controls' hit areas overlap. The area is the button's ::after box.
  const areas = await help.evaluate((el) => {
    const [box, after] = [el.getBoundingClientRect(), getComputedStyle(el, '::after')];
    const area = {
      left: box.left + parseFloat(after.left), top: box.top + parseFloat(after.top),
      width: parseFloat(after.width), height: parseFloat(after.height),
    };
    const guide = document.querySelector('.summary-guide-line .card-guide-link')!.getBoundingClientRect();
    const x = area.left + area.width / 2;
    // Hit-testing agrees: the area's first and last rows belong to the button, the Card guide's top row to the guide.
    const owner = (at: number, from: number) => document.elementFromPoint(at, from)?.closest('button');
    return {
      area, guide: { left: guide.left, right: guide.right, top: guide.top, bottom: guide.bottom },
      topRow: owner(x, area.top + 1) === el, bottomRow: owner(x, area.top + area.height - 1) === el,
      guideRow: owner(Math.min(Math.max(x, guide.left + 1), guide.right - 1), guide.top + 1)?.textContent?.includes('Card guide') === true,
    };
  });
  const { area, guide } = areas;
  // 44px less the sub-pixel rounding of the line box.
  expect(area.height, 'the hit area is a 44px target').toBeGreaterThanOrEqual(43.5);
  expect([areas.topRow, areas.bottomRow, areas.guideRow]).toEqual([true, true, true]);
  const overlap = area.left < guide.right && area.left + area.width > guide.left
    && area.top < guide.bottom && area.top + area.height > guide.top;
  expect(overlap, `the note's hit area ${JSON.stringify(area)} overlaps the Card guide's ${JSON.stringify(guide)}`).toBe(false);
  await help.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#\/rankings$/);
  const rankings = page.getByRole('main', { name: 'Rankings', exact: true });
  const how = rankings.locator('details.hof-how');
  await expect(how).toHaveJSProperty('open', true);
  await expect(how.locator('summary')).toBeFocused();
  await expect(how).toBeInViewport();
  await rankings.getByRole('button', { name: 'Close Rankings' }).click();
  await expect(page.locator('.summary-cards')).toBeVisible();
  expect(errors).toEqual([]);
});

// The same note in the share sheet: its button closes the sheet and opens Rankings at that section, focused.
test('"How Rankings work" in the share sheet closes the sheet and opens that section of Rankings', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const { errors } = await openSummary(page, baseURL!);
  await page.getByRole('button', { name: 'Share', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Share your pull' });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: 'How Rankings work' }).click();
  await expect(sheet).toBeHidden();
  await expect(page).toHaveURL(/#\/rankings$/);
  const how = page.getByRole('main', { name: 'Rankings', exact: true }).locator('details.hof-how');
  await expect(how).toHaveJSProperty('open', true);
  await expect(how.locator('summary')).toBeFocused();
  expect(errors).toEqual([]);
});

// The share sheet reads recent pulls from the relays when it opens, which can cost up to ten ticket checks.
// The relays are stand-ins that answer "nothing stored" and note each goodbye (CLOSE), so a read is known
// to have ended once every relay has said it; nothing leaves the browser and nothing is submitted (#1317).
test('opening the share sheet again reads recent pulls from the relays only once', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  await page.route('**/hall-of-fame.json', (route) => route.fulfill({ json: [] }));
  let withdrawnReads = 0;
  await page.route('**/hall-of-fame-withdrawn.json', (route) => {
    withdrawnReads += 1;
    return route.fulfill({ json: [] });
  });
  let relayReads = 0;
  await page.routeWebSocket(/.*/, (socket) => socket.onMessage((message) => {
    const [type, subscription] = JSON.parse(String(message)) as [string, string];
    if (type === 'REQ') socket.send(JSON.stringify(['EOSE', subscription]));
    if (type === 'CLOSE') relayReads += 1;
  }));
  const { errors } = await openSummary(page, baseURL!, { history: 10 });
  const sheet = page.getByRole('dialog', { name: 'Share your pull' });
  const share = page.getByRole('button', { name: 'Share', exact: true });
  // The summary's own line reads once, to the end.
  await expect.poll(() => relayReads).toBe(HOF_RELAYS.length);
  await share.click();
  await expect(sheet.getByText('This makes Rankings')).toBeVisible();
  await expect.poll(() => relayReads).toBe(2 * HOF_RELAYS.length);
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await share.click();
  await expect(sheet.getByText('This makes Rankings')).toBeVisible();
  // The sheet's read, if it made one, would have fetched the rejected list before now. Asking for that file
  // once more from the page goes through the same route queue, so once it is answered every earlier ask
  // has been counted: a read that should not have happened can no longer be on its way.
  await page.evaluate(() => fetch(new URL('hall-of-fame-withdrawn.json', document.baseURI), { cache: 'no-cache' }).then((res) => res.json()));
  expect({ withdrawnReads, relayReads }).toEqual({ withdrawnReads: 3, relayReads: 2 * HOF_RELAYS.length });
  expect(errors).toEqual([]);
});

// On a 320px phone at 100% and 200% text, the pack's own Share still fits its row and nothing
// scrolls sideways (#312, #472). Each card shares from its up-close view, not from the summary.
for (const [textZoom, viewport] of [[100, { width: 320, height: 640 }], [200, { width: 320, height: 568 }]] as const) test(`the pack's actions fit a 320px phone at ${textZoom}% text (#472)`, async ({ page, baseURL }) => {
  test.setTimeout(90000);
  const { errors } = await openSummary(page, baseURL!, { textZoom, viewport });
  await expect(page.locator('.summary-card')).toHaveCount(5);
  const actions = await page.locator('.summary-actions .btn').evaluateAll((buttons) => buttons.map((button) => {
    const [b, row] = [button.getBoundingClientRect(), button.parentElement!.getBoundingClientRect()];
    return {
      label: button.textContent!.trim(),
      inside: b.left >= row.left - 0.5 && b.right <= row.right + 0.5 && b.left >= 0 && b.right <= innerWidth,
      clipped: button.scrollWidth > button.clientWidth,
    };
  }));
  expect(actions.map((action) => action.label)).toContain('Share');
  for (const action of actions) expect(action, JSON.stringify(action)).toMatchObject({ inside: true, clipped: false });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  expect(errors).toEqual([]);
});

test('card taps, swipes and empty space never leave the summary; the viewer closes from outside, not from a drag off its text, the X leaves', async ({ page, baseURL, hasTouch }) => {
  test.setTimeout(60000);
  const { errors, packShell } = await openSummary(page, baseURL!);
  const summary = page.locator('.pack-summary');
  const dialog = page.getByRole('dialog');
  const recorded = async () => (await snapshot(page)).stats?.packsOpened;
  expect(await recorded()).toBe(1);
  const stays = async (what: string) => {
    await untilIdle(page);
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
  // The long drag runs right to left across the whole row with touch: a level left-to-right drag is
  // the browser's own swipe-back in Chromium's touch emulation (history.back, which no page CSS stops
  // there), not the summary dismissing itself.
  // Without touch there's no swipe-back, so the mouse run drags it left to right.
  const across = [last.x + last.width / 2, first.x + first.width / 2];
  const [from, to] = hasTouch ? across : across.reverse();
  const strokes = [
    [from, last.y + last.height / 2, to, last.y + last.height / 2],
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
      await untilIdle(page);
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

// The fixture's ticket 10 is a Two Pair worth 20,900, over the Hall of Fame's score bar. The list is an
// empty stand-in, so it makes today's Rankings; the relays stay blocked and nothing is submitted. It also
// beats the fixture's ten 1,020-point packs, so its heading leads with NEW BEST (#1287), all still in view.
for (const viewport of [{ width: 360, height: 740 }, { width: 390, height: 844 }]) test(`a pull that makes today's Rankings says so above the fold with the actions at ${viewport.width}x${viewport.height}`, async ({ page, baseURL }) => {
  test.setTimeout(60000);
  await page.route('**/hall-of-fame.json', (route) => route.fulfill({ json: [] }));
  const { errors } = await openSummary(page, baseURL!, { viewport, history: 10 });
  await expect(page.locator('.summary-title')).toContainText('NEW BEST');
  await expect(page.locator('.pack-headline-previous')).toHaveText('previous best 1,020 · +1,949%');
  for (const locator of [page.locator('.summary-title'), page.locator('.pack-headline-previous')]) await expect(locator).toBeInViewport({ ratio: 1 });
  // The tallest headline (NEW BEST and the Rankings line) still leaves the last card clear of the stuck
  // actions, which sit in the same scroller (so being in the viewport isn't enough), and at 390x844 the
  // summary has nothing to scroll (docs/DESIGN.md, one-screen summary rule).
  const fit = await layout(page);
  expect(fit.lastCard.bottom, JSON.stringify(fit)).toBeLessThanOrEqual(Math.min(...fit.buttons.map((button) => button.top)));
  if (viewport.height === 844) expect(fit.scrollable, JSON.stringify(fit)).toBeLessThanOrEqual(0);
  const line = page.locator('.summary-hof');
  await expect(line).toContainText("Makes today's Rankings");
  await expect(line.getByRole('button', { name: 'Submit to Rankings' })).toBeVisible();
  const boxes = await page.evaluate(() => Array.from(document.querySelectorAll('.summary-hof, .summary-actions .btn'), (element) => {
    const { top, bottom, left, right } = element.getBoundingClientRect();
    const actions = document.querySelector('.summary-actions')!.getBoundingClientRect();
    return {
      what: element.textContent!.trim(),
      onScreen: top >= 0 && bottom <= innerHeight && left >= 0 && right <= innerWidth,
      clearOfActions: element.closest('.summary-actions') !== null || bottom <= actions.top,
    };
  }));
  expect(boxes.length).toBeGreaterThanOrEqual(3);
  for (const box of boxes) expect(box, JSON.stringify(box)).toMatchObject({ onScreen: true, clearOfActions: true });
  expect(await page.evaluate(() => document.querySelector('.summary-content')!.scrollTop)).toBe(0);
  expect(errors).toEqual([]);
});

// A pull that qualifies for Rankings but cannot beat the lowest score on the list says why (#1072).
// The line fits one screen at 360x740 and 390x844 with no scroll, and keeps the cards at the same position.
for (const viewport of [{ width: 360, height: 740 }, { width: 390, height: 844 }, { width: 320, height: 568 }]) {
  test(`a pull that qualifies but would not make the list says why in view at ${viewport.width}x${viewport.height} (#1072)`, async ({ page, baseURL }) => {
    test.setTimeout(60000);
    await page.clock.setFixedTime('2026-10-30T12:00:00.000Z');
    const fullBoard = [
      ...Array.from({ length: 100 }, (_, i) => ({ id: `alltime-${i}`, setId: 'set-1', hand: 'Royal Rot', multiplier: 50, score: 50000 + i, submittedAt: '2026-10-01T00:00:00.000Z' })),
      ...Array.from({ length: 50 }, (_, i) => ({ id: `daily-${i}`, setId: 'set-1', hand: 'Royal Rot', multiplier: 50, score: 30000 + i, submittedAt: '2026-10-30T12:00:00.000Z' })),
    ];
    await page.route('**/hall-of-fame.json', (route) => route.fulfill({ json: fullBoard }));
    const { errors } = await openSummary(page, baseURL!, { viewport, history: 10 });
    const line = page.locator('.summary-hof');
    await expect(line).toContainText("Qualifies, but wouldn't beat the lowest listed score.");
    await expect(line).toContainText('See How Rankings work.');
    await expect(line.getByRole('button', { name: 'Submit to Rankings' })).toHaveCount(0);
    await expect(line.getByRole('button', { name: 'How Rankings work' })).toBeVisible();
    await expect(line).toBeInViewport({ ratio: 1 });
    const { fits, lines } = await line.locator('span').first().evaluate((el) => ({
      fits: el.scrollWidth <= el.clientWidth,
      lines: Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)),
    }));
    expect(fits).toBe(true);
    expect(lines).toBeLessThanOrEqual(3);
    if (viewport.width !== 320) {
      expect(await page.evaluate(() => document.querySelector('.summary-content')!.scrollTop)).toBe(0);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
  });
}

// The line keeps one height while the list loads and in every state after, so the cards below never
// move. The relays are stand-ins on this page: a socket asking for pending sends closes, and a send
// either fails (the socket closes) or waits for the test to accept it. Nothing leaves the browser.
test('the Hall of Fame line never moves the cards below it', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  let release = () => {};
  const listLoads = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/hall-of-fame.json', async (route) => {
    await listLoads;
    await route.fulfill({ json: [] });
  });
  let relays: 'refuse' | 'hold' = 'refuse';
  const held: (() => void)[] = [];
  await page.routeWebSocket(/.*/, (socket) => socket.onMessage((message) => {
    const [type, event] = JSON.parse(String(message)) as [string, { id: string }];
    if (type === 'EVENT' && relays === 'hold') held.push(() => socket.send(JSON.stringify(['OK', event.id, true, ''])));
    else socket.close();
  }));
  const { errors } = await openSummary(page, baseURL!, { history: 10 });
  const line = page.locator('.summary-hof');
  const cardsTop = () => page.locator('.summary-cards').evaluate((cards) => cards.getBoundingClientRect().top);
  const tops: Record<string, number> = {};

  await expect(line).toHaveAttribute('aria-hidden', 'true');
  tops.loading = await cardsTop();
  release();
  const submit = line.getByRole('button', { name: 'Submit to Rankings' });
  await expect(submit).toBeVisible();
  tops.offered = await cardsTop();
  await expectSummaryTakesClicks(page);
  await submit.click();
  await expect(line).toContainText("Couldn't submit");
  tops.failed = await cardsTop();
  relays = 'hold';
  await line.getByRole('button', { name: 'Retry' }).click();
  await expect(line).toContainText('Submitting…');
  await expect.poll(() => held.length).toBeGreaterThan(0);
  tops.sending = await cardsTop();
  held[0]();
  await expect(line).toContainText('Submitted · #1 today');
  tops.sent = await cardsTop();

  expect(tops, JSON.stringify(tops)).toEqual(Object.fromEntries(Object.keys(tops).map((state) => [state, tops.loading])));
  expect(errors).toEqual([]);
});

for (const textZoom of [100, 200]) {
  test(`the Hall of Fame line never moves the cards below it when the pull would not make the list at 320x568 at ${textZoom}% text (#1072)`, async ({ page, baseURL }) => {
    test.setTimeout(60000);
    await page.clock.setFixedTime('2026-10-30T12:00:00.000Z');
    let release = () => {};
    const listLoads = new Promise<void>((resolve) => (release = resolve));
    const fullBoard = [
      ...Array.from({ length: 100 }, (_, i) => ({ id: `alltime-${i}`, setId: 'set-1', hand: 'Royal Rot', multiplier: 50, score: 50000 + i, submittedAt: '2026-10-01T00:00:00.000Z' })),
      ...Array.from({ length: 50 }, (_, i) => ({ id: `daily-${i}`, setId: 'set-1', hand: 'Royal Rot', multiplier: 50, score: 30000 + i, submittedAt: '2026-10-30T12:00:00.000Z' })),
    ];
    await page.route('**/hall-of-fame.json', async (route) => {
      await listLoads;
      await route.fulfill({ json: fullBoard });
    });
    const { errors } = await openSummary(page, baseURL!, { viewport: { width: 320, height: 568 }, textZoom, history: 10 });
    const line = page.locator('.summary-hof');
    const cardsTop = () => page.locator('.summary-cards').evaluate((cards) => cards.getBoundingClientRect().top);
    const tops: Record<string, number> = {};

    await expect(line).toHaveAttribute('aria-hidden', 'true');
    tops.loading = await cardsTop();
    release();
    await expect(line).toContainText("Qualifies, but wouldn't beat the lowest listed score.");
    tops.notListed = await cardsTop();

    if (textZoom === 100) {
      const { lines } = await line.locator('span').first().evaluate((el) => ({
        lines: Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)),
      }));
      expect(lines).toBeLessThanOrEqual(3);
    }
    expect(tops.notListed).toBe(tops.loading);
    expect(errors).toEqual([]);
  });
}

// The pack leaves for a quarter second over the reveal that fades in under it. A tap in that time is
// aimed at the reveal's Skip, and the pack must not be what answers it.
test('the pack leaving never takes a tap meant for the reveal', async ({ page, baseURL }) => {
  const errors = await monitor(page, baseURL!);
  await page.setViewportSize(isPhone() ? PHONE : DESKTOP);
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  await page.getByRole('button', { name: /^Open pack/ }).focus();
  const covered = page.evaluate(() => new Promise<{ frames: number; hittable: number }>((resolve) => {
    let frames = 0;
    let hittable = 0;
    const watch = () => {
      const pack = document.querySelector('.pack-display');
      if (!document.querySelector('button.reveal-skip')) return requestAnimationFrame(watch);
      if (!pack) return resolve({ frames, hittable });
      frames += 1;
      if (getComputedStyle(pack).pointerEvents !== 'none') hittable += 1;
      return requestAnimationFrame(watch);
    };
    requestAnimationFrame(watch);
  }));
  await page.keyboard.press('Space');
  const { frames, hittable } = await covered;
  expect(frames).toBeGreaterThan(0);
  expect(hittable).toBe(0);
  expect(errors).toEqual([]);
});

// The record lines a NEW BEST doesn't cover (#1287). A set best in the released set with the longest name:
// an earlier pack of another set scores far above anything a pack can, and the set's own earlier pack 0,
// so whatever the fixture's ticket scores, it is a set best and not an all-time one. A #2 pack: one far
// above it and one at 0 before it.
const SET_BEST: RecordSeed = { setId: 'italian-brainrot-deep-cuts', packs: [['genesis', 1, 1e12], ['italian-brainrot-deep-cuts', 2, 0]] };
const SECOND: RecordSeed = { setId: 'right-now', packs: [['genesis', 1, 1e12], ['genesis', 1, 0]] };

for (const [name, seed, line] of [['a set best', SET_BEST, '.pack-headline-record--set'], ['a #2 pack', SECOND, '.pack-headline-rank']] as const) {
  for (const viewport of [{ width: 360, height: 740 }, { width: 390, height: 844 }]) test(`${name} keeps the last card clear of the actions at ${viewport.width}x${viewport.height} (#1287)`, async ({ page, baseURL }) => {
    test.setTimeout(60000);
    await page.route('**/hall-of-fame.json', (route) => route.fulfill({ json: [] }));
    const { errors } = await openSummary(page, baseURL!, { viewport, seed });
    await expect(page.locator(line)).toHaveCount(1);
    await expect(page.locator(line)).toBeInViewport({ ratio: 1 });
    if (seed === SET_BEST) {
      await expect(page.locator('.summary-title')).toContainText('Best in Italian Brainrot Deep Cuts');
      await expect(page.locator('.pack-headline-previous')).toContainText('previous set best 0');
    } else {
      await expect(page.locator(line)).toHaveText('your #2 pack ever');
      await expect(page.locator('.pack-headline-record')).toHaveCount(0);
    }
    const fit = await layout(page);
    expect(fit.lastCard.bottom, JSON.stringify(fit)).toBeLessThanOrEqual(Math.min(...fit.buttons.map((button) => button.top)));
    if (viewport.height === 844) expect(fit.scrollable, JSON.stringify(fit)).toBeLessThanOrEqual(0);
    expect(fit.pageOverflow, JSON.stringify(fit)).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
  });
}

// At 200% text the long set name can't fit one line: it is cut short inside the heading, which stays
// inside the summary instead of growing past both edges (the summary clips sideways overflow).
for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }]) test(`a set best's long name is cut short inside the summary at ${viewport.width} px and 200% text (#1287)`, async ({ page, baseURL }) => {
  test.setTimeout(60000);
  await page.route('**/hall-of-fame.json', (route) => route.fulfill({ json: [] }));
  const { errors } = await openSummary(page, baseURL!, { viewport, seed: SET_BEST, textZoom: 200 });
  const boxes = await page.evaluate(() => {
    const box = (selector: string) => {
      const { left, right } = document.querySelector(selector)!.getBoundingClientRect();
      return { left: Math.round(left), right: Math.round(right) };
    };
    const name = document.querySelector('.pack-headline-record-name')!;
    return {
      content: box('.summary-content'),
      heading: box('.summary-title'),
      score: box('.summary-title .tabular'),
      name: { scroll: name.scrollWidth, client: name.clientWidth, text: name.textContent },
    };
  });
  for (const part of [boxes.heading, boxes.score]) {
    expect(part.left, JSON.stringify(boxes)).toBeGreaterThanOrEqual(boxes.content.left);
    expect(part.right, JSON.stringify(boxes)).toBeLessThanOrEqual(boxes.content.right);
  }
  // Cut short on screen; the whole name is still in the heading for a screen reader.
  expect(boxes.name.scroll, JSON.stringify(boxes)).toBeGreaterThan(boxes.name.client);
  expect(boxes.name.text).toBe('Best in Italian Brainrot Deep Cuts');
  expect(errors).toEqual([]);
});

// The short-phone headline clearance exists for the row "Try another pack" adds. A summary without that
// control (one set to choose from) keeps the layout it had: no extra top padding (#898). The browser
// always lists several sets, so the single-set summary is the same DOM with the control taken out.
test('the short-phone headline clearance only applies to a summary that shows Try another pack, at 360x640', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  await page.route('**/hall-of-fame.json', (route) => route.fulfill({ json: [] }));
  const { errors } = await openSummary(page, baseURL!, { viewport: PHONE });
  const padding = () => page.evaluate(() => getComputedStyle(document.querySelector('.summary-details')!).paddingTop);
  await expect(page.locator('.summary-try-another')).toBeVisible();
  expect(await padding()).toBe('48px');
  await page.evaluate(() => document.querySelector('.summary-try-another')!.remove());
  expect(await padding()).toBe('0px');
  expect(errors).toEqual([]);
});
