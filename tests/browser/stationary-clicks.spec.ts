import { test, expect, type Page } from '@playwright/test';
import { monitor, expectDecoded, expectSummaryTakesClicks } from './support';

/**
 * A player who clicks in one spot (#627): every click through the reveal lands where the last one did, and
 * the click that moves on from the last card lands on the summary the moment it appears. That click, and
 * any that follow in its first moments, must not open a card up close, the Card guide or the share sheet; the summary takes
 * a deliberate click once it has settled. The burst runs inside the page, from the observer that sees the
 * summary mount and then every frame for as long as the summary says it is settling, so it arrives before the
 * first frame whatever the machine's speed: no real mouse is quick enough to hit that window reliably, and
 * nothing waits on a timer. The test counts the presses that landed in the window, so it cannot pass without
 * any. The fixture key's nonce 21 deals no big pull, so nothing holds the reveal.
 */
test.setTimeout(90000);

/** The fixture player at nonce 21. Before monitor's own seed, which leaves a seeded player alone. */
const seedNonce21 = (page: Page, baseURL: string) => page.addInitScript((origin) => {
  if (window.location.origin !== origin || localStorage.getItem('brainrot-player-v1')) return;
  localStorage.setItem('brainrot-player-v1', JSON.stringify({ secretKey: '01'.repeat(32), name: 'Browser smoke fixture', nextNonce: 21, createdAt: 1 }));
  localStorage.setItem('brainrot-settings-v1', JSON.stringify({ effectsVolume: 0 }));
}, new URL(baseURL).origin);

test('clicks in one spot through the reveal never open a card or Share from under the summary', async ({ page, baseURL }) => {
  await seedNonce21(page, baseURL!);
  const errors = await monitor(page, baseURL!);
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();

  await page.getByRole('button', { name: /^Open pack/ }).focus();
  await page.keyboard.press('Space');
  const card = page.locator('.reveal-card:focus');
  await expect(card).toHaveAttribute('aria-label', 'Flip card 1 of 5', { timeout: 15000 });
  const box = (await card.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;

  // The summary's first frames: from the moment it mounts, and every frame while it is settling, click what
  // is under the spot, then every card, the Card guide and Share, as a stuck finger would.
  await page.evaluate(([px, py]) => {
    const burst = { settling: 0, dialogs: 0, fewest: Infinity };
    (window as unknown as { __burst: typeof burst }).__burst = burst;
    const press = () => {
      const under = document.elementFromPoint(px, py)?.closest('button');
      const named = (label: string) => Array.from(document.querySelectorAll('button')).filter((b) => b.textContent?.includes(label));
      const targets = [under, ...Array.from(document.querySelectorAll('.summary-card')), ...named('Card guide'), ...named('Share')];
      const found = targets.filter((target): target is HTMLElement => target instanceof HTMLElement);
      for (const target of found) target.click();
      burst.fewest = Math.min(burst.fewest, found.length);
      burst.dialogs = Math.max(burst.dialogs, document.querySelectorAll('[role="dialog"]').length);
    };
    const next = () => {
      // The attribute and the guard clear in one commit, so a press that still sees it was held.
      if (!document.querySelector('.summary-cards[data-settling]')) return;
      press();
      burst.settling += 1;
      requestAnimationFrame(next);
    };
    const observer = new MutationObserver(() => {
      if (!document.querySelector('.summary-cards')) return;
      observer.disconnect();
      next();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }, [x, y]);

  // Flip, then move on, five times: each click waits for the card it follows to have changed.
  for (let n = 1; n <= 5; n++) {
    await expect(card).toHaveAttribute('aria-label', `Flip card ${n} of 5`, { timeout: 10000 });
    await page.mouse.click(x, y);
    await expect(card).toHaveAttribute('aria-label', new RegExp(`^(Next card|See the pack summary)\\. Card ${n} of 5: `));
    await page.mouse.click(x, y);
  }

  await expect(page.locator('.summary-card')).toHaveCount(5, { timeout: 30000 });
  await expectSummaryTakesClicks(page);
  const burst = await page.evaluate(() => (window as unknown as { __burst: { settling: number; dialogs: number; fewest: number } }).__burst);
  expect(burst.settling, 'presses landed while the summary was settling').toBeGreaterThan(0);
  // Every press found its targets: the 5 cards, the Card guide and Share, so none sat out for a missing selector.
  expect(burst.fewest, 'targets found by the thinnest press').toBeGreaterThanOrEqual(7);
  expect(burst.dialogs, 'the stuck clicks opened something').toBe(0);
  await expect(page.locator('[role="dialog"]')).toHaveCount(0);

  // A deliberate click, once the summary has settled, still opens the card up close.
  await expectDecoded(page.locator('.summary-cards img'), 5);
  await expectSummaryTakesClicks(page);
  await page.locator('.summary-card').first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(errors).toEqual([]);
});
