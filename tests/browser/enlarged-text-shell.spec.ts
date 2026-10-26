import { test, expect, type Locator, type Page } from '@playwright/test';
import { STORAGE_KEYS } from '../../src/constants/config';
import { expectPackDropped, monitor } from './support';

// CSS text-resize simulation (root font 200% = 32 px), not browser zoom or a device check. The
// shell must keep its controls reachable by an ordinary pointer: Settings in the desktop header
// (#615), the Card guide entry clear of the bottom tabs (#684), and a Card guide sheet that leaves
// a real reading area on a short phone (#800).

const enlarge = (page: Page, enlarged: boolean) => page.evaluate((on) => {
  document.documentElement.style.fontSize = on ? '200%' : '';
}, enlarged);

interface Hit { left: number; right: number; top: number; bottom: number; width: number; height: number; hit: boolean }

/** Where the control is, and whether its centre point really lands on it (not on something over it). */
const geometry = (target: Locator): Promise<Hit> => target.evaluate((el) => {
  const box = el.getBoundingClientRect();
  const at = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  return {
    left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height,
    hit: at === el || el.contains(at),
  };
});

const expectInViewport = (box: Hit, viewport: { width: number; height: number }) => {
  expect(box.left).toBeGreaterThanOrEqual(0);
  expect(box.top).toBeGreaterThanOrEqual(0);
  expect(box.right).toBeLessThanOrEqual(viewport.width);
  expect(box.bottom).toBeLessThanOrEqual(viewport.height);
};

for (const width of [900, 1024, 1280]) {
  for (const enlarged of [false, true]) {
    test(`keeps every header destination reachable at ${width}px with ${enlarged ? '200%' : 'normal'} text (#615)`, async ({ page, baseURL }) => {
      const viewport = { width, height: 800 };
      await page.setViewportSize(viewport);
      const errors = await monitor(page, baseURL!, 0, { returning: true });
      await page.goto('./');
      await expect(page.locator('.pack-shell')).toBeVisible();
      await enlarge(page, enlarged);
      if (enlarged) expect(await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize))).toBe(32);

      const header = page.locator('.app-header');
      for (const name of ['Open', 'Cards', 'Rankings', 'Profile', 'Settings']) {
        const control = header.getByRole('button', { name, exact: true });
        const box = await geometry(control);
        expectInViewport(box, viewport);
        expect(box.hit, `${name} owns its centre point`).toBe(true);
        expect(box.height).toBeGreaterThanOrEqual(44);
      }
      expect(await page.evaluate(() => [scrollX, scrollY, document.querySelector('.app')!.scrollLeft])).toEqual([0, 0, 0]);

      // An ordinary pointer click, with no scroll to make it reachable.
      await header.getByRole('button', { name: 'Settings', exact: true }).click();
      await expect(page.getByRole('main', { name: 'Settings', exact: true })).toBeVisible();
      expect(errors).toEqual([]);
    });
  }
}

for (const [viewport, enlarged] of [
  [{ width: 568, height: 320 }, false],
  [{ width: 568, height: 320 }, true],
  [{ width: 667, height: 375 }, false],
  [{ width: 667, height: 375 }, true],
] as const) {
  test(`keeps the Card guide entry clear of the bottom tabs at ${viewport.width}x${viewport.height} with ${enlarged ? '200%' : 'normal'} text (#684)`, async ({ page, baseURL }) => {
    await page.setViewportSize(viewport);
    const errors = await monitor(page, baseURL!, 0, { returning: true });
    await page.goto('./');
    await expect(page.locator('.pack-shell')).toBeVisible();
    await enlarge(page, enlarged);

    const entry = page.getByRole('button', { name: 'Card guide', exact: true });
    await expect(entry).toBeVisible();
    const box = await geometry(entry);
    const nav = await geometry(page.locator('.app-nav'));
    expectInViewport(box, viewport);
    expect(box.hit, 'Card guide owns its centre point').toBe(true);
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.bottom).toBeLessThanOrEqual(nav.top);
    // The tabs still work on their own.
    const tabs = await geometry(page.getByRole('button', { name: 'Cards', exact: true }));
    expect(tabs.hit).toBe(true);

    await entry.click();
    await expect(page.getByRole('dialog', { name: 'Card guide', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });
}

for (const enlarged of [false, true]) {
  test(`gives the Card guide a reading area at 320x568 with ${enlarged ? '200%' : 'normal'} text (#800)`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    const errors = await monitor(page, baseURL!, 0, { returning: true });
    await page.goto('./');
    await expect(page.locator('.pack-shell')).toBeVisible();
    await enlarge(page, enlarged);

    const entry = page.getByRole('button', { name: 'Card guide', exact: true });
    await entry.click();
    const dialog = page.getByRole('dialog', { name: 'Card guide', exact: true });
    await expect(dialog).toBeVisible();
    await page.waitForFunction(() => document.querySelector('.sheet')?.getAnimations().length === 0);

    const body = dialog.locator('.sheet-body');
    const sizes = await page.evaluate(() => {
      const body = document.querySelector<HTMLElement>('.sheet-body')!;
      const sheet = document.querySelector<HTMLElement>('.sheet')!;
      // What stays on screen above the scrolling text, whatever the markup around it.
      return { sheet: sheet.getBoundingClientRect().height, bodyTop: body.getBoundingClientRect().top - sheet.getBoundingClientRect().top, reading: body.clientHeight };
    });
    // At normal size the fixed heading is a fifth of the sheet; enlarged, the reading area keeps at least half of it.
    expect(sizes.reading).toBeGreaterThanOrEqual(sizes.sheet * (enlarged ? 0.5 : 0.75));
    expect(sizes.bodyTop).toBeLessThanOrEqual(sizes.sheet * (enlarged ? 0.5 : 0.25));

    // Close stays reachable by pointer, and the scroll reaches the lower tables.
    const close = dialog.getByRole('button', { name: 'Close', exact: true });
    const closeBox = await geometry(close);
    expect(closeBox.hit).toBe(true);
    expectInViewport(closeBox, { width: 320, height: 568 });
    await body.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    expect(await body.evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 1)).toBe(true);
    expect((await geometry(close)).hit).toBe(true);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(entry).toBeFocused();
    expect(errors).toEqual([]);
  });
}

test('the kept-aside save warning leaves the pack reachable at 360x740 with 200% text (#1079)', async ({ page, baseURL }) => {
  const viewport = { width: 360, height: 740 };
  await page.setViewportSize(viewport);
  const errors = await monitor(page, baseURL!, 0, { returning: true });
  const origin = new URL(baseURL!).origin;
  const archive = JSON.stringify({ raw: '{"lost-set/ghost":null}', player: null });
  await page.addInitScript(({ key, archive, origin }) => {
    if (window.location.origin !== origin) return;
    try { if (!localStorage.getItem(key)) localStorage.setItem(key, archive); } catch { /* storage blocked */ }
  }, { key: STORAGE_KEYS.COLLECTION_RECOVERY, archive, origin });

  await page.goto('./');
  const warning = page.locator('.save-warning');
  const pack = page.locator('.pack-shell');
  await expect(warning).toBeVisible();
  await expect(pack).toBeVisible();
  await expectPackDropped(page);
  await enlarge(page, true);

  // The warning is bounded and does not monopolize the screen
  const warningBox = await warning.boundingBox();
  expect(warningBox).not.toBeNull();
  expect(warningBox!.height).toBeLessThanOrEqual(viewport.height * 0.4);

  // The pack remains in the viewport and owns its centre point
  const box = await geometry(pack);
  expect(box.hit, 'the pack owns its centre point').toBe(true);
  expectInViewport(box, viewport);

  // Warning actions are reachable and functional
  const hideButton = warning.getByRole('button', { name: 'Hide note', exact: true });
  await expect(hideButton).toBeVisible();
  await hideButton.click();
  await expect(warning).toBeHidden();
  await expect(pack).toBeVisible();

  expect(errors).toEqual([]);
});

