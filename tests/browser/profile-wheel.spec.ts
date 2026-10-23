import { test, expect, type Page } from '@playwright/test';
import { monitor } from './support';

// Wheel input over the header or the outer page must not scroll the document and carry the app
// offscreen (#798). The shell is exactly one viewport tall and each page scrolls inside itself, so the
// document itself must have nothing to scroll. Chromium emulation of a 393x727 phone, not a device.

const documentScroll = (page: Page) => page.evaluate(() => ({
  top: document.scrollingElement!.scrollTop,
  overflow: document.scrollingElement!.scrollHeight - document.scrollingElement!.clientHeight,
}));

// Let the browser apply the wheel input: two animation frames, not a timer.
const settle = (page: Page) => page.evaluate(() => new Promise<void>((done) => {
  requestAnimationFrame(() => requestAnimationFrame(() => done()));
}));

test.describe('Profile outer-page wheel scrolling (#798)', () => {
  test('outer wheel never moves the app offscreen, and the inner scroller still works', async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 393, height: 727 });
    const errors = await monitor(page, baseURL!, 12, { returning: true });
    await page.goto('./#/profile');
    const profile = page.getByRole('main', { name: 'Profile', exact: true });
    await expect(profile.getByRole('heading', { name: 'Browser smoke fixture', exact: true })).toBeVisible();

    // Measure and wheel before any locator action that could scroll content into view.
    const top = () => profile.evaluate((el) => el.getBoundingClientRect().top);
    const startTop = await top();
    expect(startTop).toBeGreaterThanOrEqual(0);
    expect(await profile.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);

    await page.mouse.move(0, 0);
    await page.mouse.wheel(0, 900);
    await page.mouse.wheel(0, 730);
    await settle(page);
    expect(await documentScroll(page)).toEqual({ top: 0, overflow: 0 });
    expect(await top()).toBe(startTop);
    expect(await profile.evaluate((el) => el.scrollTop)).toBe(0);
    // Real content is still on screen at the middle of the viewport.
    expect(await page.evaluate(() => document.elementFromPoint(196, 360)?.closest('main') != null)).toBe(true);

    // Control: a wheel over Profile itself reaches the lower content and returns to the top.
    await page.mouse.move(196, 360);
    await page.mouse.wheel(0, 600);
    await expect.poll(() => profile.evaluate((el) => el.scrollTop)).toBeGreaterThan(300);
    expect(await documentScroll(page)).toEqual({ top: 0, overflow: 0 });
    await page.mouse.wheel(0, -5000);
    await expect.poll(() => profile.evaluate((el) => el.scrollTop)).toBe(0);
    expect(await top()).toBe(startTop);
    expect(errors).toEqual([]);
  });

  // A short phone on its side makes .app itself the scroller (index.css, max-height 520). The page's own
  // .sr-only text must not stretch .app's scrollable overflow, and a wheel over the header must not move it.
  test('short landscape: the app shell does not scroll, and the Profile scroller still works', async ({ page, baseURL }) => {
    await page.setViewportSize({ width: 667, height: 375 });
    const errors = await monitor(page, baseURL!, 12, { returning: true });
    await page.goto('./#/profile');
    const profile = page.getByRole('main', { name: 'Profile', exact: true });
    await expect(profile.getByRole('heading', { name: 'Browser smoke fixture', exact: true })).toBeVisible();
    const app = page.locator('.app');
    const appScroll = () => app.evaluate((el) => ({ top: el.scrollTop, overflow: el.scrollHeight - el.clientHeight }));
    const top = () => profile.evaluate((el) => el.getBoundingClientRect().top);
    const startTop = await top();
    expect(await profile.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    // The shell has nothing of its own to scroll: all the overflow belongs to the Profile page.
    expect((await appScroll()).overflow).toBe(0);

    await page.mouse.move(0, 0);
    await page.mouse.wheel(0, 900);
    await page.mouse.wheel(0, 730);
    await settle(page);
    expect(await documentScroll(page)).toEqual({ top: 0, overflow: 0 });
    expect((await appScroll()).top).toBe(0);
    expect(await top()).toBe(startTop);
    expect(await profile.evaluate((el) => el.scrollTop)).toBe(0);

    // Control: a wheel over Profile itself scrolls Profile, not the shell.
    await page.mouse.move(333, 250);
    await page.mouse.wheel(0, 600);
    await expect.poll(() => profile.evaluate((el) => el.scrollTop)).toBeGreaterThan(300);
    expect((await appScroll()).top).toBe(0);
    expect(await documentScroll(page)).toEqual({ top: 0, overflow: 0 });
    expect(errors).toEqual([]);
  });
});
