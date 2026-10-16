import { test, expect, type Page } from '@playwright/test';
import { monitor, expectDecoded, fingerFor, snapshot } from './support';

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
async function openSummary(page: Page, baseURL: string, { textZoom = 100, viewport = isPhone() ? PHONE : DESKTOP, history = 0 } = {}) {
  const errors = await monitor(page, baseURL, history);
  await page.setViewportSize(viewport);
  if (isPhone()) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { bottom: INSET, bottomMax: INSET } });
  }
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  if (textZoom !== 100) await page.addStyleTag({ content: `html { font-size: ${textZoom}% !important; }` });
  const packShell = page.getByRole('button', { name: 'Open pack', exact: true });
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
    await expect(page.getByRole('button', { name: 'Open another pack' })).toBeInViewport({ ratio: 1 });

    // Scrolled to the end, the actions are still whole on screen and the last card is clear of them.
    await page.locator('.summary-content').evaluate((list) => { list.scrollTop = list.scrollHeight; });
    const after = await layout(page);
    expect(after.scrollTop).toBeGreaterThan(0);
    expect(after.actions.bottom).toBeLessThanOrEqual(after.content.bottom);
    await expect(page.getByRole('button', { name: 'Open another pack' })).toBeInViewport({ ratio: 1 });
    expect(after.lastCard.bottom).toBeLessThanOrEqual(after.actions.top);

    // Focus order is the page's: the heading, every card and its Share, the Card guide, then the actions.
    // Each stop is on screen and not under anything, the stuck actions included.
    await page.locator('.summary-content').evaluate((list) => { list.scrollTop = 0; });
    await page.locator('.summary-title').focus();
    const expected = await page.locator('.pack-summary').evaluate((summary) => Array.from(summary.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input, select, textarea, details > summary, [tabindex]:not([tabindex="-1"])',
    )).filter((element) => element.checkVisibility()).map((element) => element.outerHTML));
    await expect(page.locator('.summary-card-share')).toHaveCount(5);
    expect(expected.length).toBeGreaterThanOrEqual(13);
    const visited: string[] = [];
    for (let stop = 0; stop < expected.length; stop++) {
      await page.keyboard.press('Tab');
      visited.push(await page.evaluate(() => document.activeElement!.outerHTML));
      expect(await obstruction(page), `stop ${stop + 1} is covered or off screen`).toBeNull();
    }
    expect(visited).toEqual(expected);
    expect(visited.at(-1)).toContain('Open another pack');
    expect(errors).toEqual([]);
  });
}

// The whole result on one phone screen at 100% text: headline, score, all five cards and both
// actions without scrolling, and nothing sideways (Chromium emulation of the two phone sizes).
for (const viewport of [{ width: 390, height: 844 }, { width: 360, height: 740 }]) test(`shows the headline, score, every card and both actions without scrolling at ${viewport.width}x${viewport.height}`, async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const { errors } = await openSummary(page, baseURL!, { viewport });
  expect(await page.locator('.summary-content').evaluate((list) => list.scrollTop)).toBe(0);
  // The cards are the last content: the summary has nothing left to scroll to.
  expect(await page.locator('.summary-content').evaluate((list) => list.scrollHeight - list.clientHeight)).toBeLessThanOrEqual(0);
  for (const locator of [
    page.locator('.summary-title'),
    page.locator('.pack-headline-odds'),
    ...Array.from({ length: 5 }, (_, index) => page.locator('.summary-card').nth(index)),
    page.getByRole('button', { name: 'Share', exact: true }),
    page.getByRole('button', { name: 'Open another pack' }),
  ]) await expect(locator).toBeInViewport({ ratio: 1 });
  // Nothing in the actions' way: the last card ends above them.
  const { lastCard, actions, buttons, pageOverflow } = await layout(page);
  expect(lastCard.bottom).toBeLessThanOrEqual(Math.min(...buttons.map((button) => button.top)));
  expect(actions.bottom).toBeLessThanOrEqual(viewport.height);
  expect(pageOverflow).toBeLessThanOrEqual(0);
  expect(errors).toEqual([]);
});

// At 100% a card is a third of the phone; at 200% (on a 320x568 phone) the row holds fewer cards, so
// each card stays as wide as its Share, and the pack's own Share still fits its row (#312).
for (const [textZoom, viewport] of [[100, { width: 320, height: 640 }], [200, { width: 320, height: 568 }]] as const) test(`each card's Share fits inside its card on a 320px phone at ${textZoom}% text (#472)`, async ({ page, baseURL }) => {
  test.setTimeout(90000);
  const { errors } = await openSummary(page, baseURL!, { textZoom, viewport });
  const shares = await page.locator('.summary-cards li').evaluateAll((cards) => cards.map((card) => {
    const share = card.querySelector('.summary-card-share')!;
    const [c, s] = [card.getBoundingClientRect(), share.getBoundingClientRect()];
    return {
      inside: s.left >= c.left - 0.5 && s.right <= c.right + 0.5,
      clipped: share.scrollWidth > share.clientWidth,
      height: Math.round(s.height),
      width: Math.round(s.width),
      card: Math.round(c.width),
    };
  }));
  expect(shares).toHaveLength(5);
  for (const share of shares) expect(share, JSON.stringify(share)).toMatchObject({ inside: true, clipped: false });
  for (const share of shares) expect(share.height).toBeGreaterThanOrEqual(44);
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

// The fixture's ticket 10 is a Two Pair worth 20,900, over the Hall of Fame's score bar. The list is an
// empty stand-in, so it makes today's Rankings; the relays stay blocked and nothing is submitted.
for (const viewport of [{ width: 360, height: 740 }, { width: 390, height: 844 }]) test(`a pull that makes today's Rankings says so above the fold with the actions at ${viewport.width}x${viewport.height}`, async ({ page, baseURL }) => {
  test.setTimeout(60000);
  await page.route('**/hall-of-fame.json', (route) => route.fulfill({ json: [] }));
  const { errors } = await openSummary(page, baseURL!, { viewport, history: 10 });
  const line = page.locator('.summary-hof');
  await expect(line).toContainText("Makes today's Rankings");
  await expect(line.getByRole('button', { name: 'Submit to the Hall of Fame' })).toBeVisible();
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
  const submit = line.getByRole('button', { name: 'Submit to the Hall of Fame' });
  await expect(submit).toBeVisible();
  tops.offered = await cardsTop();
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
