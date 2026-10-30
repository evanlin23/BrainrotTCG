import { test, expect, type Page } from '@playwright/test';
import { expectSummaryTakesClicks, monitor, recordShownToasts } from './support';

/**
 * The achievement toast on the home screen (#803). The first visit back after a pack's summary still has
 * the toast up, and it used to hang over the set picker, so a tap meant for a set step opened Profile
 * instead. It takes no room: on a phone it lies over the header (clear of the Settings button), on a wide
 * screen it stays anchored at the top right, as on the pack's summary, fitted to the free column at the
 * right of the pack (and below the set picker's row), so with it up nothing the player can press is under
 * it, the pack included, the centre of each control still reaches that control, and the page is laid out
 * the same with a toast, after one and with none. A card close-up (any sheet) holds it. Each toast is held from the moment it shows (from inside the page,
 * as a resting pointer would: a stall of any length between two steps can't let it go) and sent away with
 * its X rather than waited out (the timing is the unit tests' job: a jump of Playwright's clock leaves
 * the exit animation behind the next toast's timer), so no step races a timer and none waits 5 or 6 seconds.
 */

const VIEWPORTS = [
  { width: 360, height: 640 },
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
  // A phone on its side: the least height, where the pack is already only about 100px tall.
  { width: 640, height: 360 },
  { width: 844, height: 390 },
  // Wide screens, from where the nav joins the header up, to a full-HD window.
  { width: 900, height: 700 },
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
  // Square and portrait windows: the pack, 80% of the width at most, leaves no free column for the toast.
  { width: 1024, height: 1000 },
  { width: 900, height: 1200 },
  { width: 1280, height: 1200 },
  { width: 1080, height: 1920 },
  // Short windows. At doubled text the page has little room: from 590px up the toast is clear of every
  // control, and below about 580px it reaches the Card guide row (see SHORT, below).
  { width: 900, height: 500 },
  { width: 1280, height: 550 },
  { width: 1280, height: 570 },
  { width: 900, height: 590 },
  { width: 900, height: 600 },
  // Just past where the one-line clamp ends (Toasts.css, 640px).
  { width: 900, height: 650 },
];
/** The windows where, at doubled text, the toast is long enough to reach the Card guide row at the foot of the stage. */
const SHORT = VIEWPORTS.filter(({ width, height }) => width >= 900 && height < 580);
const WIDE = VIEWPORTS.filter(({ width }) => width >= 900);
/** Wide windows tall enough that the toast at doubled text covers no control at all. */
const TALL_ENOUGH = WIDE.filter((viewport) => !SHORT.includes(viewport));

/** Every control on the home screen, as the page lays it out. */
const CONTROLS = ['.set-step', '.set-current', '.pack-shell', '[data-pack-open]', '.card-guide-link', '.pack-milestone', '.app-utilities button', '.app-nav-item'];
/** Every control on the home screen of a wide screen: the phone's list and the wordmark. */
const DESKTOP_CONTROLS = [...CONTROLS, '.app-logo'];
/** Every control on the pack's summary (the screen the toast is first up on), the header's Settings button included; its tabs are hidden in focus mode. */
const SUMMARY_CONTROLS = ['.app-logo', '.app-utilities button', '.pack-close', '.summary-card', '.pack-summary .link-btn', '.pack-summary .btn', '.card-guide-link'];
/** The touch targets the toast must never squeeze below 44 CSS px (the pack to open and the set steps). */
const TARGETS = ['.set-step', '[data-pack-open]'];
const TARGET = 44;

const ENLARGED = 'html { font-size: 200% !important; }';

/** The controls the toast overlaps, and (unless `centres` is off, for a screen the page itself lays out past the window or over its own parts) those whose centre a touch would hand to something else. */
const blocked = (page: Page, selectors = CONTROLS, centres = true) => page.evaluate(([list, checkCentres]) => {
  const toast = document.querySelector('.toast')!.getBoundingClientRect();
  const problems: string[] = [];
  for (const selector of list) {
    for (const [index, el] of Array.from(document.querySelectorAll(selector)).entries()) {
      const box = el.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      const label = `${selector}[${index}]`;
      if (toast.left < box.right && toast.right > box.left && toast.top < box.bottom && toast.bottom > box.top) problems.push(`${label} is under the toast`);
      if (!checkCentres) continue;
      const at = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      if (!at || !el.contains(at)) problems.push(`${label} loses its centre to ${at?.closest('.toast') ? 'the toast' : at?.className}`);
    }
  }
  return problems;
}, [selectors, centres] as const);

/** On a wide screen the toast is at the right edge (the page's gutter is 2rem, 64px at doubled text, at most) and at the top (no lower than 6.5rem under the header). */
const expectAnchoredTopRight = async (page: Page, width: number) => {
  const box = (await page.locator('.toast').boundingBox())!;
  expect(box.x + box.width, 'anchored to the right edge').toBeGreaterThanOrEqual(width - 72);
  const limit = await page.evaluate(() => document.querySelector('.app-header')!.getBoundingClientRect().bottom + 6.5 * parseFloat(getComputedStyle(document.documentElement).fontSize));
  expect(box.y, 'anchored to the top').toBeLessThanOrEqual(limit);
};

/** The toast has finished entering (it comes in from 12px up, at no opacity), so a box measured now is the one that stays. */
const settled = (page: Page) => expect.poll(() => page.locator('.toast').evaluate((el) => {
  const style = getComputedStyle(el);
  return style.opacity === '1' && (style.transform === 'none' || style.transform === 'matrix(1, 0, 0, 1, 0, 0)');
}), { message: 'the toast has finished entering' }).toBe(true);

/** The controls too small to press, at the sizes the page lays them out. */
const squeezed = (page: Page) => page.evaluate(([selectors, min]) => {
  const problems: string[] = [];
  for (const selector of selectors as string[]) {
    for (const [index, el] of Array.from(document.querySelectorAll(selector)).entries()) {
      const { width, height } = el.getBoundingClientRect();
      if (width < (min as number) - 0.5 || height < (min as number) - 0.5) problems.push(`${selector}[${index}] is ${Math.round(width)}x${Math.round(height)}`);
    }
  }
  return problems;
}, [TARGETS, TARGET] as const);

/** Where every control sits, rounded to a pixel, for comparing the page before and after. */
const placed = (page: Page) => page.evaluate((selectors) => selectors.flatMap((selector) =>
  Array.from(document.querySelectorAll(selector)).map((el, index) => {
    const { left, top, width, height } = el.getBoundingClientRect();
    return `${selector}[${index}] ${Math.round(left)},${Math.round(top)} ${Math.round(width)}x${Math.round(height)}`;
  })), CONTROLS);

/** A fresh player's first pack, opened and skipped to its summary; the toast for it is up. */
async function toSummary(page: Page, baseURL: string) {
  await recordShownToasts(page, { hold: true });
  const errors = await monitor(page, baseURL);
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  await page.getByRole('button', { name: /^Open pack/ }).focus();
  await page.keyboard.press('Space');
  await expect(page.locator('.card-reveal-area')).toBeVisible({ timeout: 15000 });
  await page.locator('button.reveal-skip').click({ timeout: 15000 });
  await expect(page.locator('.summary-card')).toHaveCount(5, { timeout: 30000 });
  return errors;
}

/** The toasts a fresh player's first pack makes, in order, and what each one's button is named. */
const TOASTS = [
  { kicker: /^\d+ achievements unlocked$/, name: /^\s*\d+ achievements unlocked\s+\S.*/ },
  // The level-up's line is clamped on screen; the button's name still has all of it.
  { kicker: /^Level up$/, name: /^\s*Level up\s+\S.*\S\s+Next: .+/ },
];

/** Sends the toast on screen away with its X, as a player would: the page is then as it is once one has timed out. */
const dismiss = async (page: Page) => {
  await page.locator('.toast-dismiss').click();
};

/** Back home from the summary, with the first toast still up and held by focus; its button is returned. */
async function toHome(page: Page) {
  await page.getByRole('button', { name: /Next pack/ }).click();
  const toast = page.locator('.toast-open');
  await expect(toast).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.set-current')).toBeVisible();
  return toast;
}

/** The toast region's height: it is a zero-height row, so a toast never takes room from the page. */
const regionHeight = (page: Page) => page.locator('.toast-region').evaluate((el) => Math.round(el.getBoundingClientRect().height));

// Both toasts, the grouped achievements and then the taller level-up with its line, over every size.
for (const viewport of VIEWPORTS) {
  test(`both toasts on the home screen cover no control at ${viewport.width}x${viewport.height}`, async ({ page, baseURL }) => {
    test.setTimeout(120000);
    await page.setViewportSize(viewport);
    const errors = await toSummary(page, baseURL!);
    const toast = await toHome(page);
    // The goal is one of the controls checked below wherever the row shows it (not below 360px of row, nor on a short landscape phone).
    const goal = page.locator('.card-guide-entry .pack-milestone');
    if (viewport.width < 900 && viewport.height <= 520) await expect(goal).toBeHidden();
    else await expect(goal, 'the goal is on screen, so the checks below cover it').toBeVisible();

    const controls = viewport.width < 900 ? CONTROLS : DESKTOP_CONTROLS;
    for (const { kicker, name } of TOASTS) {
      await expect(page.locator('.toast-kicker').filter({ hasText: kicker })).toBeVisible({ timeout: 15000 });
      if (viewport.width >= 900) {
        await settled(page);
        await expectAnchoredTopRight(page, viewport.width);
      }
      await expect.poll(() => blocked(page, controls), { message: `no control is under the ${kicker} toast` }).toEqual([]);
      expect(await squeezed(page), `${kicker}: the pack and set steps are touch targets`).toEqual([]);
      expect(await regionHeight(page), `${kicker}: the toast takes no room`).toBe(0);
      // However little of it a short screen draws, the button's name is still all of it.
      await expect(toast).toHaveAccessibleName(name);
      await dismiss(page);
    }
    expect(errors).toEqual([]);
  });
}

// Doubled text on a wide screen: the toast and the set picker both grow, and the picker then runs the page's
// width, so the toast must be below it as well as clear of the pack.
for (const viewport of TALL_ENOUGH) {
  test(`at 200% text both toasts leave every control uncovered on the home screen at ${viewport.width}x${viewport.height}`, async ({ page, baseURL }) => {
    test.setTimeout(120000);
    await page.setViewportSize(viewport);
    const errors = await toSummary(page, baseURL!);
    await page.addStyleTag({ content: ENLARGED });
    const toast = await toHome(page);

    for (const { kicker, name } of TOASTS) {
      await expect(page.locator('.toast-kicker').filter({ hasText: kicker })).toBeVisible({ timeout: 15000 });
      await settled(page);
      await expectAnchoredTopRight(page, viewport.width);
      await expect.poll(() => blocked(page, DESKTOP_CONTROLS), { message: `no control is under the ${kicker} toast` }).toEqual([]);
      expect(await squeezed(page), `${kicker}: the pack and set steps are touch targets`).toEqual([]);
      expect(await regionHeight(page), `${kicker}: the toast takes no room`).toBe(0);
      await expect(toast).toHaveAccessibleName(name);
      await dismiss(page);
    }
    expect(errors).toEqual([]);
  });
}

// The short band at doubled text (under about 580px tall, where the page has almost no room left): the toast
// still sits top right and still covers the pack, the set picker, the tabs, Settings and the wordmark, but it
// reaches down to the Card guide row at the foot of the stage and covers the right end of the goal chip, and at
// 900px wide the guide link's edge. That is the limit DESIGN.md states; this pins it to those two controls, so
// the toast reaching anything else, or a window above the band (TALL_ENOUGH) reaching them, fails.
const GUIDE_ROW = ['.card-guide-link', '.pack-milestone'];
for (const viewport of SHORT) {
  test(`at 200% text in a short window both toasts cover nothing but the guide row at ${viewport.width}x${viewport.height}`, async ({ page, baseURL }) => {
    test.setTimeout(120000);
    await page.setViewportSize(viewport);
    const errors = await toSummary(page, baseURL!);
    await page.addStyleTag({ content: ENLARGED });
    const toast = await toHome(page);

    for (const { kicker, name } of TOASTS) {
      await expect(page.locator('.toast-kicker').filter({ hasText: kicker })).toBeVisible({ timeout: 15000 });
      await settled(page);
      await expectAnchoredTopRight(page, viewport.width);
      await expect.poll(() => blocked(page, DESKTOP_CONTROLS.filter((selector) => !GUIDE_ROW.includes(selector))), { message: `only the guide row is under the ${kicker} toast` }).toEqual([]);
      expect(await squeezed(page), `${kicker}: the pack and set steps are touch targets`).toEqual([]);
      expect(await regionHeight(page), `${kicker}: the toast takes no room`).toBe(0);
      await expect(toast).toHaveAccessibleName(name);
      await dismiss(page);
    }
    expect(errors).toEqual([]);
  });
}

// The one-line clamp is for windows short enough to need it: at 900x700 and normal text nothing is near the
// toast, so the level-up's line (here "Next: ...") is shown whole.
test('at 900x700 and normal text the level-up toast shows its whole line', async ({ page, baseURL }) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 900, height: 700 });
  const errors = await toSummary(page, baseURL!);
  await toHome(page);
  await dismiss(page);
  await expect(page.locator('.toast-kicker').filter({ hasText: /^Level up$/ })).toBeVisible({ timeout: 15000 });
  await settled(page);
  const clipped = await page.locator('.toast-desc').evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(clipped, 'the description is not cut short').toBeLessThanOrEqual(1);
  expect(await blocked(page, DESKTOP_CONTROLS)).toEqual([]);
  expect(errors).toEqual([]);
});

// The pack's summary is where the toast is first up: on a wide screen it hangs under the header at the
// right, clear of the header's tabs and Settings, the X, the cards and the buttons, at normal and doubled text.
for (const viewport of WIDE) {
  for (const enlarged of [false, true]) {
    test(`both toasts cover no control on the pack summary at ${viewport.width}x${viewport.height}${enlarged ? ' and 200% text' : ''}`, async ({ page, baseURL }) => {
      test.setTimeout(120000);
      await page.setViewportSize(viewport);
      const errors = await toSummary(page, baseURL!);
      if (enlarged) await page.addStyleTag({ content: ENLARGED });

      for (const { kicker } of TOASTS) {
        await expect(page.locator('.toast-kicker').filter({ hasText: kicker })).toBeVisible({ timeout: 15000 });
        await settled(page);
        await expectAnchoredTopRight(page, viewport.width);
        await expect.poll(() => blocked(page, SUMMARY_CONTROLS, !enlarged), { message: `no control is under the ${kicker} toast` }).toEqual([]);
        await dismiss(page);
      }
      expect(errors).toEqual([]);
    });
  }
}

// Doubled text makes both toasts (the grouped achievements, then the taller level-up with its line) at their
// largest: neither covers a control or squeezes the pack or the set steps below a touch target.
test('at 200% text on a 360px phone both toasts leave every control uncovered and at least 44px', async ({ page, baseURL }) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 360, height: 640 });
  const errors = await toSummary(page, baseURL!);
  await page.addStyleTag({ content: ENLARGED });
  const toast = await toHome(page);

  for (const { kicker, name } of TOASTS) {
    await expect(page.locator('.toast-kicker').filter({ hasText: kicker })).toBeVisible({ timeout: 15000 });
    await expect.poll(() => blocked(page), { message: `no control is under the ${kicker} toast` }).toEqual([]);
    expect(await squeezed(page), `${kicker}: the pack and set steps are touch targets`).toEqual([]);
    await expect(toast).toHaveAccessibleName(name);
    await dismiss(page);
  }
  await expect(page.locator('.toast')).toHaveCount(0);
  expect(errors).toEqual([]);
});

// Nothing the player is heading for moves as the toasts arrive or leave: the pack and the chevrons are
// where they were while one was up, so a tap on one never lands on the other (#803).
for (const viewport of VIEWPORTS) {
  test(`nothing on the home screen moves when the toasts go at ${viewport.width}x${viewport.height}`, async ({ page, baseURL }) => {
    test.setTimeout(120000);
    await page.setViewportSize(viewport);
    const errors = await toSummary(page, baseURL!);
    await toHome(page);
    // The taller level-up toast comes second; measure with it up.
    await dismiss(page);
    await expect(page.locator('.toast-kicker').filter({ hasText: /^Level up$/ })).toBeVisible({ timeout: 15000 });
    const during = await placed(page);

    await dismiss(page);
    await expect(page.locator('.toast')).toHaveCount(0);
    expect(await placed(page), 'every control stays where it was when the toast went').toEqual(during);
    expect(errors).toEqual([]);
  });
}

// A phone turned on its side with a toast up: nothing is under it either way round, and it takes no room.
test('turning a phone on its side with a toast up leaves nothing under it, and takes no room', async ({ page, baseURL }) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 360, height: 640 });
  const errors = await toSummary(page, baseURL!);
  const toast = await toHome(page);
  await expect.poll(() => blocked(page), { message: 'portrait: nothing is under the toast' }).toEqual([]);

  for (const turned of [{ width: 640, height: 360 }, { width: 360, height: 640 }]) {
    await page.setViewportSize(turned);
    await expect(toast).toBeVisible();
    await expect.poll(() => blocked(page), { message: `${turned.width}x${turned.height}: nothing is under the toast` }).toEqual([]);
    expect(await squeezed(page)).toEqual([]);
    expect(await regionHeight(page), 'the toast takes no room').toBe(0);
  }
  expect(errors).toEqual([]);
});

// A card close-up is a sheet over the summary: the toast waits for it to close instead of sitting over it
// (z-index above the sheet) and taking a tap meant for the sheet.
test('a card close-up holds the toast until it closes, at 200% text on a 360px phone', async ({ page, baseURL }) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 360, height: 640 });
  const errors = await toSummary(page, baseURL!);
  await page.addStyleTag({ content: ENLARGED });
  await expect(page.locator('.toast')).toBeVisible({ timeout: 15000 });

  await expectSummaryTakesClicks(page);
  await page.locator('.summary-card').first().click();
  const viewer = page.locator('.card-viewer');
  await expect(viewer).toBeVisible();
  await expect(page.locator('.toast')).toHaveCount(0);
  const close = viewer.getByRole('button', { name: /^Close/ }).first();
  const box = (await close.boundingBox())!;
  expect(await page.evaluate(([x, y]) => !document.elementFromPoint(x, y)?.closest('.toast'), [box.x + box.width / 2, box.y + box.height / 2])).toBe(true);

  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);
  await expect(page.locator('.toast')).toBeVisible();
  expect(errors).toEqual([]);
});
