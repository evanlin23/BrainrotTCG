import { readdirSync, readFileSync } from 'node:fs';
import { test, expect, type Locator, type Page } from '@playwright/test';
import ts from 'typescript';
import { STORAGE_KEYS } from '../../src/constants/config';
import { HOF_RELAYS } from '../../src/game/nostrInbox';
import { PAGE_TITLES } from '../../src/game/route';
import { AXE_STATE_SPECS, AXE_STATES, type AxeState, expectAxeClean } from './axe-scan';
import { expectDecoded, monitor } from './support';

/**
 * Automated axe checks for the rest of the main routes (#766), on the helper from axe-scan.ts that
 * axe-critical-states.spec.ts (#747) already uses for the first pack, the summary, Settings and a card
 * share sheet. Here: mid-reveal, Cards, Rankings, Profile and a shared pull. Plus the route contract
 * pages.spec.ts does not pin, on every page including Settings: the page is a named main landmark with
 * one level-1 heading, and nothing focusable is stranded where a keyboard can reach it but nobody can
 * scroll to it. Arrival focus on the heading, dialog focus traps and focus restore stay with
 * pages.spec.ts, accessibility.spec.ts and card-share.spec.ts.
 */

const vectors = JSON.parse(readFileSync(new URL('../../spec/vectors.json', import.meta.url), 'utf8')) as {
  valid: { note: string; proof: string; hand: string }[];
};

const entries = Array.from({ length: 25 }, (_, i) => ({
  id: `fixture-${i}`, proof: `fixture-proof-${i}`, name: `Fixture ${i + 1}`, fingerprint: 'abcd', setId: 'right-now',
  setName: 'Right Now', hand: 'Full House', multiplier: 150, score: 50_000 - i, submittedAt: '2026-10-01T00:00:00.000Z',
  cards: [], issue: 1000 + i, githubUser: 'fixture',
}));

/** A saved collection of one whole set, so Cards shows card tiles and not the empty-collection note. */
const SET = 'right-now';
const cardIds = readdirSync(new URL(`../../src/content/sets/${SET}/cards/`, import.meta.url))
  .filter((file) => file.endsWith('.webp'))
  .map((file) => file.slice(0, -'.webp'.length));
async function seedCollection(page: Page, baseURL: string) {
  const collection = Object.fromEntries(cardIds.map((id) => {
    const key = `${SET}/${id}`;
    return [key, { card: { id, key, setId: SET }, normalCount: 1, holoCount: 0 }];
  }));
  await page.addInitScript(({ storageKey, collection, origin }) => {
    if (window.location.origin !== origin) return;
    if (localStorage.getItem(storageKey)) return;
    localStorage.setItem(storageKey, JSON.stringify(collection));
    localStorage.setItem('brainrot-data-version', '3');
  }, { storageKey: STORAGE_KEYS.COLLECTION, collection, origin: new URL(baseURL).origin });
}
const cardTiles = (main: Locator) => main.locator('.collection-grid button.collection-item');

/** The scan each page gets. Adding a page to PAGE_TITLES fails the type check here and the coverage test below. */
const PAGE_SCANS = { cards: 'cards', rankings: 'rankings', profile: 'profile', settings: 'settings' } as const satisfies Record<keyof typeof PAGE_TITLES, AxeState>;

/** The product's own relays answer every read with "nothing stored", so Rankings sees a working feed and no network. */
const relayOrigins = new Set(HOF_RELAYS.map((relay) => new URL(relay).origin));
const relaysAnswerEmpty = (page: Page) => page.routeWebSocket((url) => relayOrigins.has(url.origin), (socket) => socket.onMessage((message) => {
  const [type, subscription] = JSON.parse(String(message)) as [string, string];
  if (type === 'REQ') socket.send(JSON.stringify(['EOSE', subscription]));
}));

/**
 * Focusable controls a keyboard can reach but the page cannot show: not hidden, not inert, and wholly
 * above or left of the page's origin, or wholly beyond its width. Vertical scroll is not stranding, and a
 * control inside a horizontal scroller is reached by scrolling it, so it is not stranded either.
 */
const stranded = (page: Page) => page.evaluate(() => {
  const width = document.documentElement.scrollWidth;
  const focusable = 'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable=""], [contenteditable="true"]';
  const inScroller = (el: HTMLElement) => {
    for (let up = el.parentElement; up && up !== document.documentElement; up = up.parentElement) {
      const overflowX = getComputedStyle(up).overflowX;
      if ((overflowX === 'auto' || overflowX === 'scroll') && up.scrollWidth > up.clientWidth) return true;
    }
    return false;
  };
  return Array.from(document.querySelectorAll<HTMLElement>(focusable)).filter((el) => {
    if (el.tabIndex < 0 || el.closest('[inert], [hidden], [aria-hidden="true"]') || (el as HTMLButtonElement).disabled) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const box = el.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) return false;
    if (box.bottom + window.scrollY <= 0) return true;
    return (box.right <= 0 || box.left >= width) && !inScroller(el);
  }).map((el) => `${el.tagName.toLowerCase()}${el.className ? `.${String(el.className).trim().split(/\s+/).join('.')}` : ''} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)}"`);
});

/** The page's main landmark once its chunk has loaded: neither the loading skeleton nor the error panel is showing. */
async function loaded(page: Page, name: string, timeout = 15000) {
  const main = page.getByRole('main', { name, exact: true });
  await expect(main).toBeVisible({ timeout });
  await expect(main.locator('.page-skeleton')).toHaveCount(0, { timeout });
  await expect(main.locator('.page-error')).toHaveCount(0, { timeout });
  return main;
}

/**
 * The page's contract once it has loaded and shows real content (`content` picks an element only the
 * loaded page has): one named main with one h1, and no stranded focusable control. The skeleton has a
 * main and a heading too, so nothing is judged before the content is there.
 */
async function expectRouteContract(page: Page, name: string, content: (main: Locator) => Locator) {
  const main = await loaded(page, name);
  await expect(content(main).first()).toBeVisible();
  await expect(main.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.getByRole('main')).toHaveCount(1);
  expect(await stranded(page), `${name}: focusable controls out of reach of the eye`).toEqual([]);
}

test('the stranded-control check sees a button parked off the page, but not one in a scroller', async ({ page }) => {
  await page.setContent('<main><button type="button">Here</button><button type="button" style="position:absolute;left:-9999px">Gone</button>'
    + '<button type="button" style="position:absolute;left:-9999px" hidden>Hidden</button>'
    + '<div style="width:200px;overflow-x:auto;display:flex"><button type="button" style="flex:none;width:300px">Scrolls</button><button type="button" style="flex:none;width:300px;margin-left:3000px">Also scrolls</button></div></main>');
  expect(await stranded(page)).toEqual(['button "Gone"']);
});

/**
 * The states a spec really scans: an `await expectAxeClean(page, testInfo, '<state>')` statement that sits
 * directly in the body of a `test(...)` callback. A mention in a comment or a string, a call wrapped in
 * `expect(...).rejects`, one under an `if`, or one in a test that is skipped is not a scan.
 */
function scannedStates(source: string): string[] {
  const file = ts.createSourceFile('owner.spec.ts', source, ts.ScriptTarget.Latest, true);
  const skipped = /^test\.(describe(\.\w+)*\.)?(skip|fixme)$/;
  const isSkip = (node: ts.Node) => ts.isCallExpression(node) && skipped.test(node.expression.getText(file));
  const states: string[] = [];
  const visit = (node: ts.Node) => {
    ts.forEachChild(node, visit);
    if (!ts.isExpressionStatement(node) || !ts.isAwaitExpression(node.expression)) return;
    const call = node.expression.expression;
    if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression) || call.expression.text !== 'expectAxeClean') return;
    const state = call.arguments[2];
    if (!state || !(ts.isStringLiteral(state) || ts.isNoSubstitutionTemplateLiteral(state))) return;
    const body = node.parent;
    const callback = body.parent;
    const test = callback?.parent;
    const isTestCallback = ts.isBlock(body) && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
      && ts.isCallExpression(test) && ts.isIdentifier(test.expression) && test.expression.text === 'test';
    if (!isTestCallback) return;
    const skippedBy = (from: ts.Node | undefined): boolean => !!from && (isSkip(from) || skippedBy(from.parent));
    const skipsItself = body.statements.some((statement) => ts.isExpressionStatement(statement) && isSkip(statement.expression));
    if (!skippedBy(test) && !skipsItself) states.push(state.text);
  };
  visit(file);
  return states;
}

test('the coverage check counts only a real scan', () => {
  const scan = "await expectAxeClean(page, testInfo, 'cards');";
  const inTest = (body: string) => `test.describe('d', () => { test('t', async ({ page }, testInfo) => { ${body} }); });`;
  expect(scannedStates(inTest(scan))).toEqual(['cards']);
  expect(scannedStates(inTest(`await page.goto('./'); ${scan} expect(errors).toEqual([]);`))).toEqual(['cards']);
  expect(scannedStates(inTest(`// ${scan}`)), 'a comment').toEqual([]);
  expect(scannedStates(inTest(`/* ${scan} */ const note = "${scan}";`)), 'a comment and a string').toEqual([]);
  expect(scannedStates(inTest("await expect(expectAxeClean(page, testInfo, 'cards')).rejects.toThrow(/x/);")), 'the .rejects wrapper').toEqual([]);
  expect(scannedStates(inTest("expect(expectAxeClean(page, testInfo, 'cards')).rejects.toThrow(/x/);")), 'the .rejects wrapper, not awaited').toEqual([]);
  expect(scannedStates(inTest(`if (process.env.CI) { ${scan} }`)), 'under an if').toEqual([]);
  expect(scannedStates(inTest(`expectAxeClean(page, testInfo, 'cards');`)), 'not awaited').toEqual([]);
  expect(scannedStates(`test.skip('t', async ({ page }, testInfo) => { ${scan} });`), 'test.skip').toEqual([]);
  expect(scannedStates(`test.fixme('t', async ({ page }, testInfo) => { ${scan} });`), 'test.fixme').toEqual([]);
  expect(scannedStates(`test.describe.skip('d', () => { test('t', async ({ page }, testInfo) => { ${scan} }); });`), 'a skipped describe').toEqual([]);
  expect(scannedStates(inTest(`test.skip(true, 'later'); ${scan}`)), 'a test that skips itself').toEqual([]);
  expect(scannedStates(`const scanIt = async () => { ${scan} };`), 'outside a test').toEqual([]);
});

test('every page has a scan, and every listed state is scanned by the spec that owns it', () => {
  expect(Object.keys(PAGE_SCANS).sort()).toEqual(Object.keys(PAGE_TITLES).sort());
  for (const state of AXE_STATES) {
    const owner = readFileSync(new URL(`./${AXE_STATE_SPECS[state]}`, import.meta.url), 'utf8');
    expect(scannedStates(owner), `${AXE_STATE_SPECS[state]} scans "${state}"`).toContain(state);
  }
  for (const state of Object.values(PAGE_SCANS)) expect(AXE_STATES).toContain(state);
});

test('a page still loading is not judged', async ({ page, baseURL }) => {
  const errors = await monitor(page, baseURL!, 1, { returning: true });
  await seedCollection(page, baseURL!);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  // Page routes run before monitor's context route.
  await page.route('**/assets/CollectionBrowser-*.js', async (route) => {
    await held;
    await route.continue();
  });
  await page.goto('./#/cards');
  const main = page.getByRole('main', { name: 'Cards', exact: true });
  // The placeholder already has the landmark and the heading the contract looks for.
  await expect(main.locator('.page-skeleton')).toBeVisible();
  await expect(main.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(loaded(page, 'Cards', 300)).rejects.toThrow(/page-skeleton/);
  release();
  await expectRouteContract(page, 'Cards', cardTiles);
  expect(errors).toEqual([]);
});

test.describe('routes', () => {
  test('mid-reveal', async ({ page, baseURL }, testInfo) => {
    test.setTimeout(90000);
    const errors = await monitor(page, baseURL!);
    await page.goto('./');
    await expect(page.locator('.app-logo')).toBeVisible();
    const pack = page.getByRole('button', { name: 'Open pack', exact: true });
    await pack.focus();
    await page.keyboard.press('Space');
    await expect(page.locator('.pack-top-count')).toHaveText('Card 1 of 5', { timeout: 15000 });
    await expect(page.locator('.reveal-card').first()).toBeVisible();
    await expectAxeClean(page, testInfo, 'mid-reveal');
    expect(errors).toEqual([]);
  });

  test('Cards', async ({ page, baseURL }, testInfo) => {
    const errors = await monitor(page, baseURL!, 1, { returning: true });
    await seedCollection(page, baseURL!);
    await page.goto('./#/cards');
    await expectRouteContract(page, 'Cards', cardTiles);
    await expect(cardTiles(page.getByRole('main', { name: 'Cards', exact: true }))).toHaveCount(cardIds.length);
    await expectAxeClean(page, testInfo, 'cards');
    expect(errors).toEqual([]);
  });

  test('Rankings', async ({ page, baseURL }, testInfo) => {
    const errors = await monitor(page, baseURL!, 0, { returning: true });
    await relaysAnswerEmpty(page);
    await page.route('**/hall-of-fame.json', (route) => route.fulfill({ json: entries }));
    await page.goto('./#/rankings');
    const rankings = await loaded(page, 'Rankings');
    await rankings.getByRole('tab', { name: 'All-time', exact: true }).click();
    await expectRouteContract(page, 'Rankings', (main) => main.locator('.hof-list'));
    await expectAxeClean(page, testInfo, 'rankings');
    expect(errors).toEqual([]);
  });

  test('Profile', async ({ page, baseURL }, testInfo) => {
    const errors = await monitor(page, baseURL!, 1, { returning: true });
    await page.goto('./#/profile');
    await expectRouteContract(page, 'Profile', (main) => main.locator('.pulls-history .pull-row'));
    await expect(page.getByRole('main', { name: 'Profile', exact: true })).toContainText('All packs · 1');
    await expectAxeClean(page, testInfo, 'profile');
    expect(errors).toEqual([]);
  });

  test('Settings keeps the route contract', async ({ page, baseURL }) => {
    const errors = await monitor(page, baseURL!, 0, { returning: true });
    await page.goto('./#/settings');
    await expectRouteContract(page, 'Settings', (main) => main.getByRole('switch', { name: 'Particles', exact: true }));
    expect(errors).toEqual([]);
  });

  test('a shared pull', async ({ page, baseURL }, testInfo) => {
    test.setTimeout(60000);
    const vector = vectors.valid.find((v) => v.note === 'empty name, archived set')!;
    const errors = await monitor(page, baseURL!, 1, { returning: true });
    await page.goto(`./#/pull/${vector.proof}`);
    const pull = page.getByRole('dialog', { name: vector.hand === 'No Matches' ? 'A pull' : vector.hand, exact: true });
    // Opening a shared pull verifies its Argon2id ticket in a worker, which is slow on a cold run.
    await expect(pull).toContainText('Verified on this device', { timeout: 20000 });
    await expect(pull.locator('.sheet--deferred')).toHaveCount(0);
    await expectDecoded(pull.locator('img.card-image'), 5);
    await expectAxeClean(page, testInfo, 'shared-pull');
    expect(errors).toEqual([]);
  });
});
