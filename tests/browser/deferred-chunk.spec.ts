import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { monitor } from './support';

// A shared pull opened cold mounts its DeferredSheet before the PullViewerPage chunk arrives (#340).
// These hold that chunk back or fail it on the built app. The timings are this runner's, on desktop
// Chromium and its phone emulation; real-phone latency is measured by hand under #8.

const vectors = JSON.parse(readFileSync(new URL('../../spec/vectors.json', import.meta.url), 'utf8')) as {
  valid: { note: string; proof: string; hand: string }[];
};
const vector = vectors.valid.find(({ note }) => note === 'empty name, archived set')!;
const CHUNK = /\/assets\/PullViewerPage-[\w-]+\.js$/;
const TITLE = 'Shared pull';
// Verifying the pull's Argon2id ticket in a worker is slow on a cold mobile run (shared-pull.smoke).
const VIEWER_TIMEOUT = 20000;
// From the chunk's release (or Retry) to its screen in the placeholder's place. Local runs take tens to
// a few hundred milliseconds; the bound is loose for slow CI and only catches a hang or a long timer.
const SCREEN_BOUND_MS = 3000;

interface Frame { at: number; dialogs: { title: string; placeholder: boolean; empty: boolean }[] }
declare global {
  interface Window {
    sheetFrames: Frame[];
    sheetEntrances: { part: 'panel' | 'backdrop'; deferred: boolean }[];
    markedAt?: number;
  }
}

/**
 * Logs every DOM state that changes the open sheets (as React commits them), and every sheet entrance
 * that starts, so a test can tell whether a frame ever showed no sheet, two, or an empty one.
 */
async function recordSheets(page: Page) {
  await page.addInitScript(() => {
    window.sheetFrames = [];
    window.sheetEntrances = [];
    let last = '';
    new MutationObserver(() => {
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'), (dialog) => ({
        title: dialog.querySelector('h2')?.textContent ?? '',
        placeholder: dialog.classList.contains('sheet--deferred'),
        empty: !dialog.querySelector('.sheet-body')?.textContent?.trim(),
      }));
      const key = JSON.stringify(dialogs);
      if (key !== last) window.sheetFrames.push({ at: performance.now(), dialogs });
      last = key;
    }).observe(document, { childList: true, subtree: true, characterData: true });
    document.addEventListener('animationstart', (event) => {
      const target = event.target as Element;
      const part = target.classList.contains('sheet-backdrop') ? 'backdrop' : target.classList.contains('sheet') ? 'panel' : null;
      if (part) window.sheetEntrances.push({ part, deferred: !!target.closest('.sheet-root')?.querySelector('.sheet--deferred') });
    }, true);
  });
}

/** Marks the page's clock just before the test lets the chunk through or presses Retry. */
const mark = (page: Page) => page.evaluate(() => { window.markedAt = performance.now(); });

/**
 * From the first sheet on, exactly one sheet is open and none is empty, and it never closes in between.
 * Returns how long after the mark the placeholder gave way to the screen.
 */
async function expectSeamless(page: Page) {
  const { frames, markedAt } = await page.evaluate(() => ({ frames: window.sheetFrames, markedAt: window.markedAt! }));
  const open = frames.slice(frames.findIndex(({ dialogs }) => dialogs.length > 0));
  expect(open.length).toBeGreaterThan(0);
  expect(open[0].dialogs).toEqual([{ title: TITLE, placeholder: true, empty: false }]);
  for (const { dialogs } of open) {
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0].empty).toBe(false);
  }
  const screen = open.find(({ at, dialogs }) => at >= markedAt && !dialogs[0].placeholder);
  expect(screen).toBeDefined();
  // Once the screen has replaced it, the placeholder never comes back.
  expect(open.slice(open.indexOf(screen!)).every(({ dialogs }) => !dialogs[0].placeholder)).toBe(true);
  return Math.round(screen!.at - markedAt);
}

/** The sheet entered once, as the placeholder: the screen that replaced it had no entrance of its own. */
async function expectOneEntrance(page: Page) {
  const entrances = await page.evaluate(() => window.sheetEntrances);
  expect(entrances.map(({ part }) => part).sort()).toEqual(['backdrop', 'panel']);
  expect(entrances.every(({ deferred }) => deferred)).toBe(true);
}

function report(name: string, ms: number) {
  test.info().annotations.push({ type: 'timing', description: `${name}: ${ms} ms` });
  console.log(`[${test.info().project.name}] ${name}: ${ms} ms`);
}

/** The pull itself, once its screen has loaded and verified it. */
const verifiedPull = (page: Page) => page.getByRole('dialog', { name: vector.hand, exact: true });

/**
 * Fails every request for the chunk while `failing` is set. Vite asks for the chunk twice per attempt
 * (a modulepreload link beside the import itself), so failing only the first request is not enough.
 */
async function failChunk(page: Page) {
  const chunk = { failing: true, failed: 0, served: 0, url: '' };
  await page.route(CHUNK, (route) => {
    chunk.url = route.request().url();
    if (chunk.failing) {
      chunk.failed++;
      return route.abort('failed');
    }
    chunk.served++;
    return route.continue();
  });
  return chunk;
}

/** The failed attempt's own load errors, and nothing else, for a chunk that was made to fail. */
const unexpected = (errors: string[], chunkUrl: string) => errors.filter((error) =>
  error !== `net::ERR_FAILED ${chunkUrl}` && error !== 'Failed to load resource: net::ERR_FAILED');

test('a slow chunk shows one loading sheet, then its screen in place', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const errors = await monitor(page, baseURL!);
  await recordSheets(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let requests = 0;
  // Page routes run before monitor's context route.
  await page.route(CHUNK, async (route) => {
    requests++;
    await held;
    await route.continue();
  });
  const requested = page.waitForRequest(CHUNK);
  await page.goto(`./#/pull/${vector.proof}`);
  const placeholder = page.getByRole('dialog', { name: TITLE, exact: true });
  await expect(placeholder.getByRole('status')).toHaveText(`Loading ${TITLE}…`);
  await requested;
  // Hold the chunk until the placeholder's entrance has finished: the screen then takes its place
  // without an entrance of its own.
  await expect.poll(() => page.evaluate(() => document.querySelector('.sheet--deferred')?.getAnimations({ subtree: true }).length)).toBe(0);
  await expect(placeholder.getByRole('status')).toHaveText(`Loading ${TITLE}…`);
  await mark(page);
  release();
  await expect(page.locator('.sheet--deferred')).toHaveCount(0);
  await expect(verifiedPull(page)).toBeVisible({ timeout: VIEWER_TIMEOUT });
  await expect(verifiedPull(page)).toContainText('This pull checks out — re-verified in your browser just now');
  const ms = await expectSeamless(page);
  report('slow chunk released to screen', ms);
  expect(ms).toBeLessThan(SCREEN_BOUND_MS);
  await expectOneEntrance(page);
  expect(requests).toBe(1);
  expect(errors).toEqual([]);
});

test('a failed chunk offers Reload and Retry, and Retry loads it', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const errors = await monitor(page, baseURL!);
  await recordSheets(page);
  const chunk = await failChunk(page);
  await page.goto(`./#/pull/${vector.proof}`);
  const sheet = page.getByRole('dialog', { name: TITLE, exact: true });
  await expect(sheet.getByRole('alert')).toContainText(`Couldn't load ${TITLE}.`);
  await expect(sheet.getByRole('button', { name: 'Reload', exact: true })).toBeVisible();
  const retry = sheet.getByRole('button', { name: 'Retry', exact: true });
  await expect(retry).toBeVisible();
  expect(chunk.failed).toBeGreaterThan(0);
  expect(chunk.served).toBe(0);
  chunk.failing = false;
  await mark(page);
  await retry.click();
  await expect(page.locator('.sheet--deferred')).toHaveCount(0);
  await expect(verifiedPull(page)).toBeVisible({ timeout: VIEWER_TIMEOUT });
  await expect(verifiedPull(page)).toContainText('This pull checks out — re-verified in your browser just now');
  const ms = await expectSeamless(page);
  report('failed chunk Retry to screen', ms);
  expect(ms).toBeLessThan(SCREEN_BOUND_MS);
  await expectOneEntrance(page);
  // Retry asked the network again: the browser did not keep the failed import.
  expect(chunk.served).toBeGreaterThan(0);
  expect(unexpected(errors, chunk.url)).toEqual([]);
});

test('a failed chunk recovers with Reload, keeping the shared link', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const errors = await monitor(page, baseURL!);
  const chunk = await failChunk(page);
  await page.goto(`./#/pull/${vector.proof}`);
  const sheet = page.getByRole('dialog', { name: TITLE, exact: true });
  await expect(sheet.getByRole('alert')).toContainText(`Couldn't load ${TITLE}.`);
  chunk.failing = false;
  await sheet.getByRole('button', { name: 'Reload', exact: true }).click();
  await expect(verifiedPull(page)).toBeVisible({ timeout: VIEWER_TIMEOUT });
  await expect(page).toHaveURL(`${baseURL}#/pull/${vector.proof}`);
  expect(chunk.served).toBeGreaterThan(0);
  expect(unexpected(errors, chunk.url)).toEqual([]);
});
