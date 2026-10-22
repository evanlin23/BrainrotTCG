import { test, expect, type Locator, type Page } from '@playwright/test';
import { STORAGE_KEYS } from '../../src/constants/config';
import { monitor } from './support';

/**
 * The share sheet against the browser's share and clipboard APIs (#704), in desktop Chromium and the
 * Pixel 5 emulation. Every API answer here is injected, so this is a synthetic boundary check and not
 * evidence about an OS share sheet, clipboard permissions or user activation on a real phone.
 *
 * - The system share sheet is offered only where the primary pointer is coarse (the Pixel 5 project).
 * - Cancelling it (AbortError) and a refusal are different: only a refusal falls back, and nothing
 *   is ever reported as done that the browser did not accept.
 * - A refused clipboard leaves the person a way to copy by hand, or an image to save.
 * The fixture's ticket #0 is its real pack, so the copied link is the pack's own.
 */

interface Native {
  /** What navigator.share does when called: take it, be cancelled (AbortError) or be refused. */
  share: 'resolves' | 'abort' | 'denied';
  /** navigator.canShare accepts files. Without it the share carries the title, text and link. */
  files: boolean;
  /** Whether the clipboard accepts what it is given. */
  clipboard: 'ok' | 'fail';
}
interface NativeLog {
  shares: { keys: string[]; files: string[]; url?: string }[];
  text: string[];
  images: string[];
  prompts: [string, string][];
  /** Every non-empty message the sheet's status line showed, in order. */
  said: string[];
}
declare global {
  interface Window { native: Native; nativeLog: NativeLog }
}

/** Stubs the share and clipboard APIs before the page loads. `share: null` removes navigator.share. */
async function stubNative(page: Page, env: { share: Native['share'] | null; files?: boolean; clipboard?: Native['clipboard']; clipboardItem?: boolean }) {
  await page.addInitScript((env) => {
    window.native = { share: env.share ?? 'resolves', files: env.files ?? true, clipboard: env.clipboard ?? 'ok' };
    window.nativeLog = { shares: [], text: [], images: [], prompts: [], said: [] };
    const define = (key: string, value: unknown) => Object.defineProperty(navigator, key, { configurable: true, value });
    const refused = () => new DOMException('stub: refused', 'NotAllowedError');
    if (env.share === null) {
      define('share', undefined);
      define('canShare', undefined);
    } else {
      define('canShare', (data?: { files?: unknown[] }) => window.native.files && !!data?.files?.length);
      define('share', async (data: { files?: File[]; url?: string; text?: string; title?: string }) => {
        window.nativeLog.shares.push({ keys: Object.keys(data).sort(), files: (data.files ?? []).map((file) => `${file.type}:${file.name}`), url: data.url });
        if (window.native.share === 'abort') throw new DOMException('stub: cancelled', 'AbortError');
        if (window.native.share === 'denied') throw refused();
      });
    }
    define('clipboard', {
      writeText: async (value: string) => {
        if (window.native.clipboard === 'fail') throw refused();
        window.nativeLog.text.push(value);
      },
      write: async (items: ClipboardItem[]) => {
        if (window.native.clipboard === 'fail') throw refused();
        for (const item of items) window.nativeLog.images.push(item.types.join(','));
      },
    });
    if (env.clipboardItem === false) Object.defineProperty(window, 'ClipboardItem', { configurable: true, value: undefined });
    window.prompt = (message?: string, value?: string) => {
      window.nativeLog.prompts.push([message ?? '', value ?? '']);
      return null;
    };
  }, env);
}

const native = (page: Page, patch: Partial<Native>) => page.evaluate((patch) => { Object.assign(window.native, patch); }, patch);
const logged = (page: Page) => page.evaluate(() => window.nativeLog);
/** Waits for the stub to have been called `count` times in all. */
const sharesReach = (page: Page, count: number) => page.waitForFunction((count) => window.nativeLog.shares.length === count, count);
const promptsReach = (page: Page, count: number) => page.waitForFunction((count) => window.nativeLog.prompts.length === count, count);

/** Records what the sheet's status line says from now on, so a claim that flashed and went is still seen. */
const watchStatus = (sheet: Locator) => sheet.locator('p.share-done[role="status"]').evaluate((line) => {
  new MutationObserver(() => { if (line.textContent) window.nativeLog.said.push(line.textContent); })
    .observe(line, { childList: true, characterData: true, subtree: true });
});

const button = (sheet: Locator, name: string) => sheet.getByRole('button', { name, exact: true });
const shareTo = (sheet: Locator) => button(sheet, 'Share to…');

/** The fixture pack's share sheet, opened from the profile's pull list. Ticket #0 is a real pack. */
async function openPackShare(page: Page, baseURL: string) {
  const errors = await monitor(page, baseURL, 1, { returning: true });
  await page.route(/\/hall-of-fame\.json(\?.*)?$/, (route) => route.fulfill({ json: [] }));
  await page.goto('./#/profile');
  const main = page.getByRole('main', { name: 'Profile', exact: true });
  await expect(main).toBeVisible();
  await main.locator('.pulls-history .pull-row').first().click();
  const sheet = page.getByRole('dialog', { name: 'Share your pull', exact: true });
  await expect(sheet.locator('.sheet--deferred')).toHaveCount(0);
  await expect(sheet.getByRole('img', { name: "The image you'll share", exact: true })).toBeVisible();
  await watchStatus(sheet);
  return { errors, sheet };
}

/** Copies the link, and waits for the sheet to say so. */
async function copyLinkAndSettle(sheet: Locator) {
  await button(sheet, 'Copy link').click();
  await expect(sheet.locator('p.share-done')).toHaveText('Link copied');
}

test('without navigator.share it offers copying only, and the copied link opens a verified pull', async ({ page, context, baseURL }) => {
  test.setTimeout(90000);
  await stubNative(page, { share: null });
  const { errors, sheet } = await openPackShare(page, baseURL!);
  await expect(shareTo(sheet)).toHaveCount(0);

  await copyLinkAndSettle(sheet);
  await button(sheet, 'Copy image').click();
  await expect(sheet.locator('p.share-done')).toHaveText('Image copied');
  await button(sheet, 'Copy text').click();
  await expect(sheet.locator('p.share-done')).toHaveText('Text copied');
  const log = await logged(page);
  expect(log.said).toEqual(['Link copied', 'Image copied', 'Text copied']);
  expect(log.images).toEqual(['image/png']);
  expect(log.prompts).toEqual([]);
  const [link, text] = log.text;
  expect(new URL(link).hash).toMatch(/^#\/pull\//);
  expect(text).toContain(link);

  // Pasted into a fresh tab (only its fragment: the local build stands in for the live site), the link
  // re-derives the pack on this device.
  const pasted = await context.newPage();
  const pastedErrors = await monitor(pasted, baseURL!, 1, { returning: true });
  await pasted.goto(`./${new URL(link).hash}`);
  const pull = pasted.getByRole('dialog', { name: /./ });
  await expect(pull).toContainText('Verified on this device', { timeout: 20000 });
  await expect(pull.locator('.pull-viewer-whose')).toHaveText(/^Browser smoke fixture pulled this pack in /);
  expect(errors).toEqual([]);
  expect(pastedErrors).toEqual([]);
});

for (const files of [true, false]) {
  test(`navigator.share ${files ? 'with file support' : 'without it'} is offered on a touch phone only, and shares what the sheet shows`, async ({ page, baseURL, isMobile }) => {
    test.setTimeout(90000);
    await stubNative(page, { share: 'resolves', files });
    const { errors, sheet } = await openPackShare(page, baseURL!);
    if (!isMobile) {
      // A computer with a share API still gets copy only: the sheet is a detour there.
      await expect(button(sheet, 'Copy link')).toBeVisible();
      await expect(shareTo(sheet)).toHaveCount(0);
      expect((await logged(page)).shares).toEqual([]);
      expect(errors).toEqual([]);
      return;
    }
    await shareTo(sheet).click();
    await sharesReach(page, 1);
    // An accepted share is the system's to report: the sheet claims nothing and copies nothing.
    await copyLinkAndSettle(sheet);
    const log = await logged(page);
    expect(log.said).toEqual(['Link copied']);
    expect(log.text).toHaveLength(1);
    const [share] = log.shares;
    if (files) {
      expect(share.keys).toEqual(['files', 'text']);
      expect(share.files).toEqual([expect.stringMatching(/^image\/png:brainrot-pull-.+\.png$/)]);
    } else {
      expect(share.keys).toEqual(['text', 'title', 'url']);
      expect(share.url).toBe(log.text[0]);
    }
    expect(errors).toEqual([]);
  });
}

test('cancelling the share sheet claims nothing; a refusal falls back to copying, then to copying by hand', async ({ page, baseURL, isMobile }) => {
  test.setTimeout(90000);
  await stubNative(page, { share: 'abort' });
  const { errors, sheet } = await openPackShare(page, baseURL!);
  if (!isMobile) {
    await expect(shareTo(sheet)).toHaveCount(0);
    expect(errors).toEqual([]);
    return;
  }
  const status = sheet.locator('p.share-done');

  // Cancelled (AbortError): nothing is said, copied or prompted.
  await shareTo(sheet).click();
  await sharesReach(page, 1);
  await copyLinkAndSettle(sheet);
  await expect(status).toHaveText('');
  expect(await logged(page)).toMatchObject({ said: ['Link copied'], prompts: [] });
  expect((await logged(page)).text).toHaveLength(1);

  // Refused (any other error) with a working clipboard: the link is copied instead, and said so.
  await native(page, { share: 'denied' });
  await shareTo(sheet).click();
  await sharesReach(page, 2);
  await expect.poll(async () => (await logged(page)).text.length).toBe(2);
  await expect(status).toHaveText('Link copied');
  const refused = await logged(page);
  expect(refused.said).toEqual(['Link copied', 'Link copied']);
  expect(refused.text[1]).toBe(refused.text[0]);
  expect(refused.prompts).toEqual([]);
  await expect(status).toHaveText('');

  // Refused, and the clipboard refuses too: the link is offered to copy by hand and nothing is claimed.
  await native(page, { share: 'denied', clipboard: 'fail' });
  await shareTo(sheet).click();
  await promptsReach(page, 1);
  expect((await logged(page)).prompts).toEqual([['Copy this:', refused.text[0]]]);
  // The sheet is still usable: the image saves, and says so only once it has.
  const [download] = await Promise.all([page.waitForEvent('download'), button(sheet, 'Save image').click()]);
  expect(download.suggestedFilename()).toMatch(/^brainrot-pull-.+\.png$/);
  await expect(status).toHaveText('Image saved');
  expect((await logged(page)).said).toEqual(['Link copied', 'Link copied', 'Image saved']);
  expect(errors).toEqual([]);
});

test('a refused clipboard offers the link to copy by hand and an image to save, and claims neither as copied', async ({ page, baseURL }) => {
  test.setTimeout(90000);
  await stubNative(page, { share: null, clipboard: 'fail' });
  const { errors, sheet } = await openPackShare(page, baseURL!);

  await button(sheet, 'Copy link').click();
  await promptsReach(page, 1);
  await button(sheet, 'Copy text').click();
  await promptsReach(page, 2);
  const [link, text] = (await logged(page)).prompts;
  expect(link[0]).toBe('Copy this:');
  expect(new URL(link[1]).hash).toMatch(/^#\/pull\//);
  expect(text[1]).toContain(link[1]);
  // The image falls back to a saved file, and only that is said.
  const [download] = await Promise.all([page.waitForEvent('download'), button(sheet, 'Copy image').click()]);
  expect(download.suggestedFilename()).toMatch(/^brainrot-pull-.+\.png$/);
  await expect(sheet.locator('p.share-done')).toHaveText('Image saved');
  const log = await logged(page);
  expect(log).toMatchObject({ said: ['Image saved'], text: [], images: [] });
  expect(errors).toEqual([]);
});

test('a browser that cannot copy images offers Save image in its place', async ({ page, baseURL }) => {
  test.setTimeout(90000);
  await stubNative(page, { share: null, clipboardItem: false });
  const { errors, sheet } = await openPackShare(page, baseURL!);
  await expect(button(sheet, 'Copy image')).toHaveCount(0);
  const [download] = await Promise.all([page.waitForEvent('download'), button(sheet, 'Save image').click()]);
  expect(download.suggestedFilename()).toMatch(/^brainrot-pull-.+\.png$/);
  await expect(sheet.locator('p.share-done')).toHaveText('Image saved');
  await copyLinkAndSettle(sheet);
  expect((await logged(page)).said).toEqual(['Image saved', 'Link copied']);
  expect(errors).toEqual([]);
});

test('an image-only card with no proof link says why, and a refused share names the ways left', async ({ page, baseURL, isMobile }) => {
  test.setTimeout(120000);
  await stubNative(page, { share: 'abort' });
  const errors = await monitor(page, baseURL!);
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();
  await page.getByRole('button', { name: 'Open pack', exact: true }).click();
  await page.locator('button.reveal-skip').click({ timeout: 30000 });
  await expect(page.locator('.summary-card')).toHaveCount(5, { timeout: 30000 });
  // A collection with no record of the pack it came from, like a save from before packs kept their cards.
  await page.evaluate((key) => localStorage.removeItem(key), STORAGE_KEYS.HISTORY);
  await page.goto('./#/cards');
  await page.reload();
  const main = page.getByRole('main', { name: 'Cards', exact: true });
  await expect(main).toBeVisible();
  await main.getByRole('button', { name: /, \d+ owned/ }).first().click();
  await page.getByRole('button', { name: 'Share card', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: /^Share / });
  await expect(sheet.getByRole('img', { name: "The image you'll share", exact: true })).toBeVisible();
  await watchStatus(sheet);
  const status = sheet.locator('p.share-done');
  await expect(sheet).toContainText("doesn't have a verified pack record");
  await expect(button(sheet, 'Copy link')).toHaveCount(0);
  await expect(button(sheet, 'Copy image')).toBeVisible();

  if (!isMobile) {
    await expect(shareTo(sheet)).toHaveCount(0);
  } else {
    // Cancelled: nothing is said. Refused: no link to fall back to, so the ways left are named.
    await shareTo(sheet).click();
    await sharesReach(page, 1);
    await native(page, { share: 'denied' });
    await shareTo(sheet).click();
    await sharesReach(page, 2);
    await expect(status).toHaveText('Sharing failed — use Copy image, Save image or Copy text');
    await expect(status).toHaveClass(/is-failed/);
    expect((await logged(page)).said).toEqual(['Sharing failed — use Copy image, Save image or Copy text']);
    expect((await logged(page)).shares.map((share) => share.files.length)).toEqual([1, 1]);
  }
  // The ways it names work, and what they copy carries no link.
  await button(sheet, 'Copy text').click();
  await expect.poll(async () => (await logged(page)).text.length).toBe(1);
  expect((await logged(page)).text[0]).not.toContain('http');
  await button(sheet, 'Copy image').click();
  await expect(status).toHaveText('Image copied');
  expect((await logged(page)).images).toEqual(['image/png']);
  expect(errors).toEqual([]);
});
