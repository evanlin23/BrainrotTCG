import { test, expect, type Locator, type Page } from '@playwright/test';
import { monitor } from './support';

/**
 * A whole pack by keyboard alone (#12): Tab reaches the pack, Space tears it, and the card is the one
 * button for the reveal, flip then next. Each control shows a focus ring, and a single polite live
 * region names each card as it turns face up, never before. The fixture key's nonce 21 deals no big
 * pull, so nothing holds the reveal.
 */
const RARITY = '(?:Holo )?(?:Common|Uncommon|Rare|Epic|Legendary|Brainrot)';
const announced = (n: number) => new RegExp(`^Card ${n} of 5: (.+), ${RARITY}(?:, .+)?$`);
const BRAND = 'rgb(255, 210, 63)';

type Rgb = [number, number, number];
const rgb = (css: string): Rgb => (css.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number) as Rgb;
const luminance = (c: Rgb) => {
  const [r, g, b] = c.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** The focus ring an element shows: its outline, its box-shadow, or a pseudo-element's box-shadow. */
const ring = (target: Locator, pseudo?: '::after') => target.evaluate((el, pseudo) => {
  const style = getComputedStyle(el, pseudo ?? null);
  return {
    focusVisible: (document.activeElement?.matches(':focus-visible') ?? false),
    boxShadow: style.boxShadow,
    outline: `${style.outlineStyle} ${style.outlineColor}`,
    page: getComputedStyle(document.body).backgroundColor,
  };
}, pseudo);

/** Every region that speaks on its own, and what it says now. */
const liveTexts = (page: Page) => page.locator('[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"], [role="log"]').allTextContents();

test('opens a pack and reveals every card by keyboard alone, with a visible focus ring and one announcement per card', async ({ page, baseURL }) => {
  test.setTimeout(90000);
  const origin = new URL(baseURL!).origin;
  // Before monitor's own seed, which leaves a seeded player alone.
  await page.addInitScript((origin) => {
    if (window.location.origin !== origin || localStorage.getItem('brainrot-player-v1')) return;
    localStorage.setItem('brainrot-player-v1', JSON.stringify({ secretKey: '01'.repeat(32), name: 'Browser smoke fixture', nextNonce: 21, createdAt: 1 }));
    localStorage.setItem('brainrot-settings-v1', JSON.stringify({ musicVolume: 0, effectsVolume: 0 }));
  }, origin);
  const errors = await monitor(page, baseURL!);
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();

  // Tab, from the top of the page, reaches the pack.
  const pack = page.getByRole('button', { name: /^Open a .* pack$/ });
  await expect(pack).toBeVisible();
  let tabs = 0;
  while (!(await pack.evaluate((el) => el === document.activeElement))) {
    expect(++tabs, 'Tab never reached the pack').toBeLessThan(40);
    await page.keyboard.press('Tab');
  }
  const packRing = await ring(pack.locator('.swipe-hint'));
  expect(packRing.focusVisible).toBe(true);
  expect(packRing.boxShadow).toContain(BRAND);
  expect((await ring(pack)).outline).toBe(`solid ${BRAND}`);
  expect(contrast(rgb(BRAND), rgb(packRing.page))).toBeGreaterThanOrEqual(3);

  await page.keyboard.press('Space');
  await expect(page.locator('.pack-top-count')).toHaveText('Card 1 of 5', { timeout: 15000 });

  const live = page.locator('.sr-only[aria-live="polite"]');
  const area = page.locator('.card-reveal-area');
  // The card that has focus. The one before it can still be leaving, so it's found by focus, not label.
  const card = page.locator('.reveal-card:focus');
  for (let n = 1; n <= 5; n++) {
    // The tear, and each move on, leave focus on the card, ready to flip.
    await expect(card).toHaveAttribute('aria-label', `Flip card ${n} of 5`, { timeout: 10000 });
    const cardRing = await ring(card, '::after');
    expect(cardRing.focusVisible).toBe(true);
    expect(cardRing.boxShadow).toContain(BRAND);
    expect(contrast(rgb(BRAND), rgb(cardRing.page))).toBeGreaterThanOrEqual(3);
    // Nothing is said about a card still face down, and nothing on the screen names it yet.
    await expect(live).toHaveCount(1);
    await expect(live).toHaveText('');
    const before = await area.ariaSnapshot();

    await page.keyboard.press('Space');
    await expect(live).toHaveText(announced(n), { timeout: 10000 });
    const text = (await live.textContent())!;
    const name = text.match(announced(n))![1];
    expect(before, `card ${n} was named before its flip`).not.toContain(name);
    // Said once: no other region repeats the card.
    expect((await liveTexts(page)).filter((t) => t.includes(name))).toEqual([text]);

    await expect(card).toHaveAttribute('aria-label', n < 5 ? 'Next card' : 'See the pack summary');
    expect((await ring(card, '::after')).boxShadow).toContain(BRAND);
    if (n === 1) {
      // The emulated screen-reader view of the reveal, for the PR (Chromium's accessibility tree).
      console.log(`--- face down, card 1 ---\n${before}\n--- face up, card 1 ---\n${await area.ariaSnapshot()}`);
    }
    await page.keyboard.press('Space');
  }

  await expect(page.locator('.pack-summary')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.summary-card')).toHaveCount(5);
  expect(errors).toEqual([]);
});
