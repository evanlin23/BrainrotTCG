import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { SetDefinition } from '../../src/engine/types';
import { monitor } from './support';

// CardImage's Retry over a holo card in the built viewer (#226, follow-ups to #475). The stylesheet test
// (tests/card-image-styles.test.ts) checks the declared numbers; this checks the layers the browser
// actually stacks in the card's stacking context, and where focus goes when a retry fails again.

const json = <T,>(path: string): T => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as T;
const vectors = json<{ valid: { note: string; proof: string; set: string; hand: string; cards: { cardId: string; isHolo: boolean }[] }[] }>(
  '../../spec/vectors.json',
);
const vector = vectors.valid.find(({ note }) => note === 'non-ASCII name')!;
const holo = vector.cards.find(({ isHolo }) => isHolo)!;
const [setId, version] = vector.set.split('@');
const definition = json<SetDefinition>(`../../src/content/sets/${setId}/set.v${version}.json`).cards.find(({ id }) => id === holo.cardId)!;
// Verifying the pull's Argon2id ticket in a worker is slow on a cold mobile run (shared-pull.smoke).
const VIEWER_TIMEOUT = 20000;

test('Retry sits above a holo card\'s foil and shine, and gets focus back when the retry fails again', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const errors = await monitor(page, baseURL!);
  // Page routes run before monitor's context route: the holo card's art never arrives, nor any finish
  // thumbnail of it (`<card>.gold-<hash>.webp`), so the route and the errors filter below still agree
  // if the card has a finish.
  const art = new RegExp(`/assets/${holo.cardId}(?:\\.[a-z]+)?-[\\w-]{8}\\.webp$`);
  let attempts = 0;
  await page.route(art, (route) => {
    attempts += 1;
    return route.abort();
  });

  await page.goto(`./#/pull/${vector.proof}`);
  const pull = page.getByRole('dialog', { name: vector.hand, exact: true });
  await expect(pull).toBeVisible({ timeout: VIEWER_TIMEOUT });
  await pull.locator('.pack-viewer-cards > button.holo').click();
  const detail = page.getByRole('dialog', { name: definition.name, exact: true });
  const card = detail.locator('.card-viewer-card.holo');
  await expect(card.locator('img.card-image').first()).toHaveAttribute('data-state', 'failed');
  const retry = card.getByRole('button', { name: `Retry loading ${definition.name}`, exact: true });
  await expect(retry).toBeVisible();

  const layers = await card.evaluate((element) => {
    const z = (target: Element, pseudo?: string) => Number(getComputedStyle(target, pseudo).zIndex);
    return {
      retry: z(element.querySelector('.card-image-retry')!),
      // Everything else positioned in the card: holo foil and shine, and any misprint ghost or sticker.
      others: [z(element.querySelector('.holo-rainbow-layer')!), z(element, '::after'),
        ...Array.from(element.querySelectorAll('.misprint-ghost, .modifier-sticker'), (layer) => z(layer))],
    };
  });
  // The foil and shine are real layers here (not `auto`), so the comparison means something.
  expect(layers.others.slice(0, 2).every(Number.isFinite)).toBe(true);
  expect(layers.retry).toBeGreaterThan(Math.max(...layers.others.filter(Number.isFinite)));

  const before = attempts;
  await retry.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => attempts).toBeGreaterThan(before);
  await expect(card.locator('img.card-image').first()).toHaveAttribute('data-state', 'failed');
  await expect(retry).toBeFocused();

  // Only the art this test aborts may fail to load.
  expect(errors.filter((error) => !art.test(error) && error !== 'Failed to load resource: net::ERR_FAILED')).toEqual([]);
});
