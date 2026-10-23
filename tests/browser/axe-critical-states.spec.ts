import { test, expect, type Page } from '@playwright/test';
import { AXE_EXCEPTIONS, AXE_RULES, AXE_STATES, type AxeException, expectAxeClean, invalidExceptions, problems, scanPage, settle } from './axe-scan';
import { expectDecoded, monitor } from './support';

/**
 * Automated axe checks (names, roles, relationships, document, rendered colour contrast) for four loaded
 * states: the first pack, the pack summary, Settings, and a card's share sheet opened over its viewer
 * (#747). One scan per state per project, from the helper in axe-scan.ts. The wiring tests prove the
 * helper fails on an unnamed control, a broken relationship and poor contrast, so an empty or skipped
 * scan cannot read as success.
 */

const emptyHallOfFame = (page: Page) => page.route(/\/hall-of-fame\.json(\?.*)?$/, (route) => route.fulfill({ json: [] }));

test.describe('critical states', () => {
  test('the first pack', async ({ page, baseURL }, testInfo) => {
    const errors = await monitor(page, baseURL!);
    await page.goto('./');
    await expect(page.locator('.app-logo')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open pack', exact: true })).toBeVisible();
    await expectDecoded(page.locator('.pack-shell img'), 2);
    await expectAxeClean(page, testInfo, 'first-pack');
    expect(errors).toEqual([]);
  });

  test('the pack summary', async ({ page, baseURL }, testInfo) => {
    test.setTimeout(90000);
    const errors = await monitor(page, baseURL!);
    await page.goto('./');
    await expect(page.locator('.app-logo')).toBeVisible();
    const pack = page.getByRole('button', { name: 'Open pack', exact: true });
    await pack.focus();
    await page.keyboard.press('Space');
    await page.locator('button.reveal-skip').click({ timeout: 15000 });
    await expect(page.locator('.summary-card')).toHaveCount(5, { timeout: 30000 });
    await expectDecoded(page.locator('.summary-cards img'), 5);
    await expectAxeClean(page, testInfo, 'summary');
    expect(errors).toEqual([]);
  });

  test('Settings', async ({ page, baseURL }, testInfo) => {
    const errors = await monitor(page, baseURL!, 0, { returning: true });
    await page.goto('./');
    await expect(page.locator('.app-logo')).toBeVisible();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('switch', { name: 'Particles', exact: true })).toBeVisible();
    await expectAxeClean(page, testInfo, 'settings');
    expect(errors).toEqual([]);
  });

  test('a card share sheet over its viewer', async ({ page, baseURL }, testInfo) => {
    test.setTimeout(60000);
    await emptyHallOfFame(page);
    const errors = await monitor(page, baseURL!, 1, { returning: true });
    await page.goto('./#/profile');
    const main = page.getByRole('main', { name: 'Profile', exact: true });
    await expect(main).toBeVisible();
    await main.locator('.pulls-history .pull-row').first().click();
    const pull = page.getByRole('dialog', { name: 'Share your pull', exact: true });
    await expect(pull.locator('.sheet--deferred')).toHaveCount(0);
    await pull.getByText('Share an individual card', { exact: true }).click();
    const card = pull.getByRole('region', { name: 'Cards in this pack', exact: true }).getByRole('button').first();
    const name = (await card.getAttribute('aria-label'))!.replace(/ \(.*\)$/, '');
    await card.click();
    await page.getByRole('dialog', { name, exact: true }).getByRole('button', { name: 'Share card', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: `Share ${name}`, exact: true });
    await expect(sheet.locator('.sheet--deferred')).toHaveCount(0);
    await expect(sheet.getByRole('img', { name: "The image you'll share", exact: true })).toBeVisible();
    await expectAxeClean(page, testInfo, 'card-share');
    expect(errors).toEqual([]);
  });
});

// The helper is only worth trusting if it can fail. Each fixture is a page the real rules must reject.
test.describe('the scanner reports what is wrong', () => {
  const page5 = (body: string) => `<!doctype html><html lang="en"><head><title>Fixture</title></head><body><main>${body}</main></body></html>`;

  test('an unnamed control', async ({ page }) => {
    await page.setContent(page5('<button type="button"><svg width="10" height="10"></svg></button>'));
    const report = await scanPage(page, 'wiring-unnamed');
    expect(report.violations.map((v) => v.rule)).toContain('button-name');
    expect(problems(report)).not.toEqual([]);
  });

  test('a broken relationship', async ({ page }) => {
    await page.setContent(page5('<div role="tablist"><button type="button" role="tab" aria-controls="missing" aria-selected="true">One</button></div>'
      + '<ul role="list"><div>not an item</div></ul>'));
    const report = await scanPage(page, 'wiring-relationship');
    expect(new Set(report.violations.map((v) => v.rule))).toContain('aria-valid-attr-value');
    expect(problems(report)).not.toEqual([]);
  });

  test('poor contrast', async ({ page }) => {
    await page.setContent(page5('<p style="color:#777;background:#808080;font-size:16px">Faint words</p>'));
    const report = await scanPage(page, 'wiring-contrast');
    expect(report.violations.map((v) => v.rule)).toContain('color-contrast');
    expect(problems(report)).not.toEqual([]);
  });

  test('a clean fixture passes, with every rule reported on', async ({ page }) => {
    await page.setContent(page5('<h1>Clean</h1><button type="button">Go</button><p style="color:#111;background:#fff">Plain words</p>'));
    const report = await scanPage(page, 'wiring-clean');
    expect(problems(report)).toEqual([]);
    expect(report.passedNodes).toBeGreaterThan(0);
  });

  test('an empty page cannot pass', async ({ page }) => {
    // A title and a language, so the only thing wrong is that there is nothing to judge.
    await page.setContent(page5(''));
    const report = await scanPage(page, 'wiring-empty');
    expect(report.violations).toEqual([]);
    expect(problems(report)).toEqual(['color-contrast found nothing to check']);
  });

  test('a scan that passed no nodes cannot pass', async ({ page }) => {
    await page.setContent(page5('<div id="empty"></div>'));
    const report = await scanPage(page, 'wiring-scope', '#empty');
    expect(report.passedNodes).toBe(0);
    expect(problems(report)).toContain('axe passed no nodes at all');
  });

  test('the scan waits for a colour transition to finish', async ({ page }) => {
    await page.setContent(page5('<p id="words" style="margin:0;color:#ccc;background:#fff;transition:color 600ms linear">Fading words</p>'));
    const running = await page.evaluate(() => {
      const words = document.getElementById('words')!;
      words.style.color = '#000';
      return document.getAnimations().length;
    });
    expect(running).toBe(1);
    await settle(page);
    expect(await page.evaluate(() => ({ color: getComputedStyle(document.getElementById('words')!).color, running: document.getAnimations().length })))
      .toEqual({ color: 'rgb(0, 0, 0)', running: 0 });
  });

  test('the scan does not wait on a paused animation, and reads a looping one at rest', async ({ page }) => {
    await page.setContent(page5('<style>@keyframes fade { to { opacity: 0.3 } } .held { animation: fade 600ms paused } .pulse { animation: fade 600ms ease-in-out infinite alternate }'
      + ' @media (prefers-reduced-motion: reduce) { .pulse { animation: none } }</style><p class="held">Held words</p><p class="pulse">Pulsing words</p>'));
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(2);
    const report = await scanPage(page, 'wiring-motion');
    expect(report.violations).toEqual([]);
    // The page's own motion setting is back once the scan is over.
    expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(false);
  });

  test('contrast on art is reported as unjudged, not as passed', async ({ page }) => {
    await page.setContent(page5('<p style="color:#fff;background:url(data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2210%22%20height%3D%2210%22%2F%3E) #888;font-size:16px">On art</p>'));
    const report = await scanPage(page, 'wiring-art');
    expect(report.needsReview.map((f) => f.rule)).toContain('color-contrast');
    expect(report.violations.map((v) => v.rule)).not.toContain('color-contrast');
  });

  test('a defect added to a real screen fails that screen\'s scan', async ({ page, baseURL }, testInfo) => {
    const errors = await monitor(page, baseURL!);
    await page.goto('./');
    await expect(page.locator('.app-logo')).toBeVisible();
    await page.evaluate(() => {
      const bare = document.createElement('button');
      bare.append(document.createElementNS('http://www.w3.org/2000/svg', 'svg'));
      document.body.append(bare);
    });
    await expect(expectAxeClean(page, testInfo, 'first-pack')).rejects.toThrow(/button-name/);
    expect(errors).toEqual([]);
  });

  test('an exception covers exactly its rule and selector, and goes stale when nothing matches', async ({ page }) => {
    await page.setContent(page5('<p>Plain words</p><button id="bare" type="button"><svg width="10" height="10"></svg></button>'));
    const accepted: AxeException = {
      state: 'wiring-exception', rule: 'button-name', selector: '#bare', reason: 'fixture', owner: 'this test', removeWhen: 'never',
    };
    const covered = await scanPage(page, 'wiring-exception', undefined, [accepted]);
    expect(covered.violations).toEqual([]);
    expect(covered.excepted.map((f) => f.rule)).toEqual(['button-name']);
    expect(problems(covered)).toEqual([]);

    // Another selector, another rule or another state accepts nothing, and the unused entry is reported.
    for (const other of [{ selector: '#other' }, { rule: 'link-name' as const }, { state: 'elsewhere' }]) {
      const report = await scanPage(page, 'wiring-exception', undefined, [{ ...accepted, ...other }]);
      expect(report.violations.map((v) => v.rule)).toContain('button-name');
    }
    const gone = await scanPage(page, 'wiring-exception', undefined, [{ ...accepted, selector: '#gone' }]);
    expect(gone.staleExceptions).toHaveLength(1);
    expect(problems(gone).some((line) => line.startsWith('stale exception'))).toBe(true);
  });

  test('the exception list is complete, and names only listed rules and states', () => {
    expect(invalidExceptions(AXE_EXCEPTIONS)).toEqual([]);
    expect(new Set(AXE_RULES).size).toBe(AXE_RULES.length);
    expect(new Set(AXE_STATES).size).toBe(AXE_STATES.length);
  });

  test('an incomplete or misnamed exception is reported', () => {
    const complete: AxeException = { state: 'summary', rule: 'button-name', selector: '#x', reason: 'why', owner: 'who', removeWhen: 'when' };
    expect(invalidExceptions([complete])).toEqual([]);
    expect(invalidExceptions([{ ...complete, reason: ' ', owner: '', removeWhen: '' }])).toEqual([
      'button-name in summary has no reason', 'button-name in summary has no owner', 'button-name in summary has no removeWhen',
    ]);
    expect(invalidExceptions([{ ...complete, state: 'sumary', selector: '' }])).toEqual(['unknown state "sumary"', 'button-name in sumary has no selector']);
    expect(invalidExceptions([{ ...complete, rule: 'button-nme' as AxeException['rule'] }])).toEqual(['unknown rule "button-nme"']);
  });
});
