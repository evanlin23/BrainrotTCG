import { test, expect, type Page } from '@playwright/test';
import { STORAGE_KEYS } from '../../src/constants/config';
import { expectSummaryTakesClicks, monitor, recordShownToasts } from './support';

/**
 * The achievement toast on the home screen (#803). The first visit back after a pack's summary still has
 * the toast up, and it used to hang over the set picker, so a tap meant for a set step opened Profile
 * instead. It takes no room: on a phone it lies over the header (clear of the Settings button), on a wide
 * screen it stays anchored at the top right, as on the pack's summary, fitted to the free column at the
 * right of the pack (and below the set picker's row), and compact in a short window, so with it up nothing
 * the player can press is under it (every control on the screen, not a list of them), the pack included, the
 * centre of each control still reaches that control, and the page is laid out the same with a toast, after
 * one and with none. A card close-up (any sheet) holds it. Each toast is held from the moment it shows (from inside the page,
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
  // Short windows. At doubled text the page has little room (the header alone is 168px, the pack a few dozen px
  // wide): the toast is compact here (Toasts.css, under 21rem tall: 672px at doubled text), and covers no
  // control from 900x480 up. 900x480 is the lowest window pinned; 900x470 only just clears, and below that the
  // Change pack row is under it (DESIGN.md, Toasts).
  { width: 900, height: 480 },
  { width: 900, height: 500 },
  { width: 1280, height: 550 },
  { width: 1280, height: 570 },
  { width: 900, height: 590 },
  { width: 900, height: 600 },
  { width: 900, height: 650 },
  // Just above the compact rule (672px at doubled text), where the whole toast is back and still clear.
  { width: 900, height: 680 },
];
const WIDE = VIEWPORTS.filter(({ width }) => width >= 900);
/** Doubled text is 32px to the rem: the toast is compact in a window shorter than 21rem. */
const COMPACT_BELOW = 21 * 32;

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

/** Every control a player can press or focus on the screen, whatever it is (the toast's own are left out). */
const INTERACTIVE = 'button, a[href], input, select, textarea, summary, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])';

/** The controls the toast overlaps, and (unless `centres` is off) those whose centre a touch would hand to the toast. A control the page itself puts under something else, or scrolls out of the window, is that page's own layout, so only the toast is looked for. */
const blocked = (page: Page, selectors = CONTROLS, centres = true) => page.evaluate(([list, checkCentres]) => {
  const toast = document.querySelector('.toast')!.getBoundingClientRect();
  const problems: string[] = [];
  for (const selector of list) {
    for (const [index, el] of Array.from(document.querySelectorAll(selector)).entries()) {
      if (el.closest('.toast')) continue;
      const box = el.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      const name = el.getAttribute('aria-label') ?? el.textContent?.trim().slice(0, 24) ?? '';
      const label = `${selector}[${index}] "${name}" at ${Math.round(box.left)},${Math.round(box.top)} ${Math.round(box.width)}x${Math.round(box.height)}`;
      if (toast.left < box.right && toast.right > box.left && toast.top < box.bottom && toast.bottom > box.top) problems.push(`${label} is under the toast`);
      if (!checkCentres) continue;
      const at = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      if (at?.closest('.toast')) problems.push(`${label} loses its centre to the toast`);
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

/** The toast is wholly inside the window (a toast that runs off the bottom of a short one is as good as lost). */
const expectInWindow = async (page: Page, message: string) => {
  const outside = await page.locator('.toast').evaluate((el) => {
    const box = el.getBoundingClientRect();
    return box.left < 0 || box.top < 0 || box.right > innerWidth || box.bottom > innerHeight ? [box.left, box.top, box.right, box.bottom].map(Math.round) : null;
  });
  expect(outside, message).toBeNull();
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
  await page.getByRole('button', { name: /^Open .+ again$/ }).click();
  const toast = page.locator('.toast-open');
  await expect(toast).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.set-current')).toBeVisible();
  return toast;
}

/** The toast region's height: it is a zero-height row, so a toast never takes room from the page. */
const regionHeight = (page: Page) => page.locator('.toast-region').evaluate((el) => Math.round(el.getBoundingClientRect().height));

/** Sets the page's text size like a player's text-size setting (one style element, so a later call replaces it), and lets the fonts settle. */
const setText = async (page: Page, percent: number) => {
  await page.evaluate((value) => {
    let style = document.getElementById('toast-spec-text');
    if (!style) {
      style = document.createElement('style');
      style.id = 'toast-spec-text';
      document.head.appendChild(style);
    }
    style.textContent = value === 100 ? '' : `html { font-size: ${value}% !important; }`;
  }, percent);
  await page.evaluate(() => document.fonts.ready);
};

/**
 * Resizes to a wide window so that the app's height container is evaluated from scratch, as a fresh load does. Chromium can
 * keep a size container query's last answer through a run of resizes that are all on one side of its limit (the page
 * stays compact at a height that is not, or the other way round), so the way in is through a window under 900px wide,
 * where there is no container at all (Toasts.css): this is what makes the compact-or-whole shape asserted at each window
 * the shape a load at that window gets. (Whether a player resizing a window with a toast up can meet the stale answer
 * is Chromium's, not tested here.)
 */
const resizeToWide = async (page: Page, viewport: { width: number; height: number }) => {
  await page.setViewportSize({ width: 800, height: viewport.height });
  await page.setViewportSize(viewport);
};

// Each scenario below is ONE test that walks its list of windows with page.setViewportSize while a toast is held
// (each toast is held from the moment it shows, so a resize can't lose it), and measures again after each resize:
// the layout (and the container query on the app's height) is live, so a resized page is the page a fresh load at
// that size gives. That is one pack opened per scenario rather than one per window: the burn-in job repeats these
// specs, and a test per window cost it more than its 45 minutes. A failure names the window.

// Both toasts, the grouped achievements and then the taller level-up with its line, over every size; and nothing
// the player is heading for moves as the toasts go: with the level-up toast up (it is the taller) every control is
// noted, and it is where it was once the toast has gone (#803).
test('both toasts on the home screen cover no control at every size, and nothing moves when they go', async ({ page, baseURL }) => {
  test.setTimeout(600000);
  await page.setViewportSize(VIEWPORTS[0]);
  const errors = await toSummary(page, baseURL!);
  const toast = await toHome(page);
  const during = new Map<string, string[]>();
  const goal = page.locator('.card-guide-entry .pack-milestone');

  for (const { kicker, name } of TOASTS) {
    await expect(page.locator('.toast-kicker').filter({ hasText: kicker })).toBeVisible({ timeout: 15000 });
    for (const viewport of VIEWPORTS) {
      const at = `${viewport.width}x${viewport.height}`;
      await page.setViewportSize(viewport);
      // The goal is one of the controls checked below wherever the row shows it (not below 360px of row, nor on a short landscape phone).
      if (viewport.width < 900 && viewport.height <= 520) await expect(goal, `${at}: no room for the goal`).toBeHidden();
      else await expect(goal, `${at}: the goal is on screen, so the checks below cover it`).toBeVisible();

      const controls = viewport.width < 900 ? CONTROLS : DESKTOP_CONTROLS;
      if (viewport.width >= 900) {
        await settled(page);
        await expectAnchoredTopRight(page, viewport.width);
      }
      await expect.poll(() => blocked(page, controls), { message: `${at}: no control is under the ${kicker} toast` }).toEqual([]);
      if (viewport.width >= 900) await expect.poll(() => blocked(page, [INTERACTIVE]), { message: `${at}: nothing the player can press is under the ${kicker} toast` }).toEqual([]);
      await expect.poll(() => squeezed(page), { message: `${at} ${kicker}: the pack and set steps are touch targets` }).toEqual([]);
      expect(await regionHeight(page), `${at} ${kicker}: the toast takes no room`).toBe(0);
      // However little of it a short screen draws, the button's name is still all of it.
      await expect(toast).toHaveAccessibleName(name);
      if (kicker === TOASTS[TOASTS.length - 1].kicker) during.set(at, await placed(page));
    }
    await dismiss(page);
  }
  await expect(page.locator('.toast')).toHaveCount(0);
  for (const viewport of VIEWPORTS) {
    const at = `${viewport.width}x${viewport.height}`;
    await page.setViewportSize(viewport);
    await expect.poll(() => placed(page), { message: `${at}: every control stays where it was when the toast went` }).toEqual(during.get(at));
  }
  expect(errors).toEqual([]);
});

// Doubled text on a wide screen: the toast, the set picker and the header all grow, and the picker then runs the
// page's width, so the toast must be below it as well as clear of the pack. In a short window (under 21rem, 672px
// here) the page has almost no room left (the pack is a few dozen px wide), so the toast is compact, one 44px line
// of its kicker and X, and starts just under the picker: it then covers no control of the screen, the next-goal
// chip, the Card guide link and the Change pack row included. Taller than that it is whole. With a banner above
// the header, see the cases further down.
test('at 200% text both toasts leave every control uncovered on the home screen at every wide size', async ({ page, baseURL }) => {
  test.setTimeout(600000);
  await page.setViewportSize(WIDE[0]);
  const errors = await toSummary(page, baseURL!);
  await page.addStyleTag({ content: ENLARGED });
  const toast = await toHome(page);
  const shown = new Map<string, string[]>();

  for (const { kicker, name } of TOASTS) {
    await expect(page.locator('.toast-kicker').filter({ hasText: kicker })).toBeVisible({ timeout: 15000 });
    for (const viewport of WIDE) {
      const at = `${viewport.width}x${viewport.height}`;
      await resizeToWide(page, viewport);
      // The chip and the guide link are on screen, so the checks below cover them.
      await expect(page.locator('.card-guide-entry .pack-milestone'), `${at}: the goal is on screen, so the checks below cover it`).toBeVisible();
      await expect(page.locator('.card-guide-link')).toBeVisible();
      const compact = viewport.height < COMPACT_BELOW;
      await settled(page);
      // A resize can land between the toast's last two frames, so the shape it settles to is polled for.
      const titleWidth = () => page.locator('.toast-title').evaluate((el) => el.getBoundingClientRect().width);
      if (compact) {
        await expect.poll(async () => (await page.locator('.toast').boundingBox())!.height, { message: `${at} ${kicker}: a short window gets the compact toast, one line` }).toBeLessThan(64);
        await expect.poll(titleWidth, { message: `${at} ${kicker}: the title is not drawn` }).toBeLessThanOrEqual(1);
      } else {
        await expect.poll(titleWidth, { message: `${at} ${kicker}: the whole toast is back` }).toBeGreaterThan(40);
      }
      await expectAnchoredTopRight(page, viewport.width);
      await expectInWindow(page, `${at} ${kicker}: the toast is inside the window`);
      await expect.poll(() => blocked(page, [INTERACTIVE]), { message: `${at}: no control is under the ${kicker} toast` }).toEqual([]);
      await expect.poll(() => blocked(page, DESKTOP_CONTROLS), { message: `${at}: none of the home controls is under the ${kicker} toast` }).toEqual([]);
      // Where every control is while the toast is up; it is the same once it is gone (the toast takes no room).
      shown.set(at, await placed(page));
      // Under about 520px tall at doubled text the page itself leaves the pack under 44px (the header, the picker and
      // the Change pack and guide rows take the stage); that is not the toast's doing, as it takes no room: the pack
      // and every control below are exactly where they are without it (checked after the last toast is gone).
      if (viewport.height >= 520) expect(await squeezed(page), `${at} ${kicker}: the pack and set steps are touch targets`).toEqual([]);
      expect(await regionHeight(page), `${at} ${kicker}: the toast takes no room`).toBe(0);
      // What the compact toast draws of its kicker is whole, not cut with an ellipsis ("8 unlocked").
      const cut = await page.locator('.toast-kicker').evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(cut, `${at} ${kicker}: the kicker is whole`).toBeLessThanOrEqual(1);
      // However little of it a short screen draws, the button's name is still all of it.
      await expect(toast).toHaveAccessibleName(name);
    }
    await dismiss(page);
  }
  await expect(page.locator('.toast')).toHaveCount(0);
  for (const viewport of WIDE) {
    const at = `${viewport.width}x${viewport.height}`;
    await resizeToWide(page, viewport);
    await expect.poll(() => placed(page), { message: `${at}: the toast took no room from the pack or any control` }).toEqual(shown.get(at));
  }
  expect(errors).toEqual([]);
});

// A banner above the header takes room from the page, and with larger text the toast no longer clears the Change pack
// row or the chips beneath it. Two banners, two answers (Toasts.css, App.tsx):
// - the save warning (here the kept-aside recovery note) is tall and its height is not known, so on a wide screen
//   every toast waits behind it: none on screen with it up, and each one comes in, whole and clear, once it is hidden;
// - the staging note is a line or three of fixed text, so the toast is compact 4rem sooner and clears the page.
const BANNER_WINDOWS = [
  { width: 900, height: 700, text: 200 },
  { width: 900, height: 800, text: 200 },
  { width: 1024, height: 768, text: 200 },
  { width: 1280, height: 700, text: 200 },
  { width: 900, height: 600, text: 175 },
  { width: 900, height: 500, text: 150 },
];
const RECOVERY_ARCHIVE = JSON.stringify({ raw: '{"lost-set/ghost":null}', player: null });
const STAGING_NOTE = 'Staging: a test copy of the next release. Saves here are separate from the real game, and nothing is sent to the Hall of Fame.';

test('with the save warning up, at each wide window and text size the toasts wait behind it, then cover no control', async ({ page, baseURL }) => {
  test.setTimeout(600000);
  const origin = new URL(baseURL!).origin;
  await page.addInitScript(({ key, archive, origin }) => {
    if (window.location.origin !== origin) return;
    try { if (!localStorage.getItem(key)) localStorage.setItem(key, archive); } catch { /* storage blocked */ }
  }, { key: STORAGE_KEYS.COLLECTION_RECOVERY, archive: RECOVERY_ARCHIVE, origin });
  await page.setViewportSize(BANNER_WINDOWS[0]);
  const errors = await toSummary(page, baseURL!);
  const banner = page.locator('.save-warning[role="alert"]');
  await expect(banner).toBeVisible();
  await page.getByRole('button', { name: /^Open .+ again$/ }).click();
  await expect(page.locator('.set-current')).toBeVisible();
  await expect(page.locator('.app')).toHaveAttribute('data-toasts-ready', 'true');
  // The toasts are queued (the pack made two); in every window a few frames and an idle moment later none has come in.
  for (const { width, height, text } of BANNER_WINDOWS) {
    await page.setViewportSize({ width, height });
    await setText(page, text);
    await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => requestIdleCallback(() => done())))));
    await expect(page.locator('.toast'), `${width}x${height} at ${text}%: no toast over the banner`).toHaveCount(0);
    await expect(banner).toBeVisible();
  }
  expect(await page.evaluate(() => (window as unknown as { __shownToasts: string[] }).__shownToasts.slice())).toEqual([]);

  await banner.getByRole('button', { name: 'Hide note' }).click();
  await expect(banner).toHaveCount(0);
  for (const { kicker, name } of TOASTS) {
    await expect(page.locator('.toast-kicker').filter({ hasText: kicker })).toBeVisible({ timeout: 15000 });
    for (const { width, height, text } of BANNER_WINDOWS) {
      const at = `${width}x${height} at ${text}%`;
      await resizeToWide(page, { width, height });
      await setText(page, text);
      await settled(page);
      await expectAnchoredTopRight(page, width);
      await expectInWindow(page, `${at} ${kicker}: the toast is inside the window`);
      await expect.poll(() => blocked(page, [INTERACTIVE]), { message: `${at}: nothing is under the ${kicker} toast` }).toEqual([]);
      await expect(page.locator('.toast-open')).toHaveAccessibleName(name);
    }
    await dismiss(page);
  }
  expect(errors).toEqual([]);
});

// Staging cannot be turned on here (it is decided by the host name the deploy sets), so the note is put in as the
// app renders it: the same element and class as the first child of the app.
test('with the staging note up, at each wide window and text size both toasts cover no control and stay in the window', async ({ page, baseURL }) => {
  test.setTimeout(600000);
  const windows = [...BANNER_WINDOWS, { width: 900, height: 600, text: 200 }, { width: 1280, height: 560, text: 200 }];
  await page.setViewportSize(windows[0]);
  const errors = await toSummary(page, baseURL!);
  await page.evaluate((note) => {
    const banner = document.createElement('p');
    banner.setAttribute('role', 'note');
    banner.className = 'save-warning staging-banner';
    banner.textContent = note;
    document.querySelector('.app')!.prepend(banner);
  }, STAGING_NOTE);
  const toast = await toHome(page);
  await expect(page.locator('.card-guide-entry .pack-milestone')).toBeVisible();
  for (const { kicker, name } of TOASTS) {
    await expect(page.locator('.toast-kicker').filter({ hasText: kicker })).toBeVisible({ timeout: 15000 });
    for (const { width, height, text } of windows) {
      const at = `${width}x${height} at ${text}%`;
      await resizeToWide(page, { width, height });
      await setText(page, text);
      await settled(page);
      await expectAnchoredTopRight(page, width);
      await expectInWindow(page, `${at} ${kicker}: the toast is inside the window`);
      await expect.poll(() => blocked(page, [INTERACTIVE]), { message: `${at}: nothing is under the ${kicker} toast` }).toEqual([]);
      await expect(toast).toHaveAccessibleName(name);
    }
    await dismiss(page);
  }
  expect(errors).toEqual([]);
});

// The compact toast is for windows short enough to need it (under 21rem tall: 336px at normal text, 672px at
// doubled text): at normal text, even in a 900x500 window, nothing is near the toast, so the level-up's line
// (here "Next: ...") is shown whole.
test('at 900x500 and 900x700 and normal text the level-up toast shows its whole line', async ({ page, baseURL }) => {
  test.setTimeout(300000);
  await page.setViewportSize({ width: 900, height: 700 });
  const errors = await toSummary(page, baseURL!);
  await toHome(page);
  await dismiss(page);
  await expect(page.locator('.toast-kicker').filter({ hasText: /^Level up$/ })).toBeVisible({ timeout: 15000 });
  for (const height of [500, 700]) {
    await page.setViewportSize({ width: 900, height });
    await settled(page);
    const clipped = await page.locator('.toast-desc').evaluate((el) => el.scrollHeight - el.clientHeight);
    expect(clipped, `900x${height}: the description is not cut short`).toBeLessThanOrEqual(1);
    expect(await blocked(page, [INTERACTIVE]), `900x${height}`).toEqual([]);
  }
  expect(errors).toEqual([]);
});

// The pack's summary is where the toast is first up: on a wide screen it hangs under the header at the
// right, clear of the header's tabs and Settings, the X, the cards and the buttons, at normal and doubled text.
test('both toasts cover no control on the pack summary at every wide size, at normal and doubled text', async ({ page, baseURL }) => {
  test.setTimeout(600000);
  await page.setViewportSize(WIDE[0]);
  const errors = await toSummary(page, baseURL!);

  for (const { kicker } of TOASTS) {
    await expect(page.locator('.toast-kicker').filter({ hasText: kicker })).toBeVisible({ timeout: 15000 });
    for (const enlarged of [false, true]) {
      await setText(page, enlarged ? 200 : 100);
      for (const viewport of WIDE) {
        const at = `${viewport.width}x${viewport.height}${enlarged ? ' and 200% text' : ''}`;
        await page.setViewportSize(viewport);
        await settled(page);
        await expectAnchoredTopRight(page, viewport.width);
        await expect.poll(() => blocked(page, SUMMARY_CONTROLS, !enlarged), { message: `${at}: no control is under the ${kicker} toast` }).toEqual([]);
      }
    }
    await dismiss(page);
  }
  expect(errors).toEqual([]);
});

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
