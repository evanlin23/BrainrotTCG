import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { monitor, expectDecoded, holdArt, unexpectedArtErrors } from './support';

/**
 * A shared pull opened while its card art is still on the way (#762). The score, certificate and the
 * action to open packs never wait for art, and a slot whose art is pending is an empty frame:
 * it must not carry the finish caption, which on a dark slot reads as a card back. Art is held with
 * route interception and released on demand, so no step depends on timing.
 */
const vectors = JSON.parse(readFileSync(new URL('../../spec/vectors-python.json', import.meta.url), 'utf8')) as {
  valid: { note: string; proof: string; hand: string; score: number; cards: { finish: string | null }[] }[];
};
const vector = vectors.valid.find((v) => v.note === 'modifiers (§5.4): a Silver misprint, stacked')!;
const finished = vector.cards.filter((card) => card.finish).length;

test('a shared pull shows no finish captions on pending art, and keeps score and actions usable', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const errors = await monitor(page, baseURL!, 0, { returning: true });
  const art = await holdArt(page);
  await page.goto(`./#/pull/${vector.proof}`);

  const pull = page.getByRole('dialog', { name: vector.hand, exact: true });
  await expect(pull).toContainText('Verified on this device', { timeout: 20000 });
  await expect(pull.locator('.score-panel-total')).toHaveText(vector.score.toLocaleString('en-US'));
  // A set that can still be chased offers its own packs instead of the generic action (#802).
  await expect(pull.getByRole('button', { name: /^Open (your own|.+) packs$/ })).toBeEnabled();
  await expect.poll(() => art.requests()).toBeGreaterThan(0);

  const cards = pull.locator('.pack-viewer-cards > button');
  await expect(cards).toHaveCount(vector.cards.length);
  const slots = cards.locator('img.card-image');
  // Every slot is still waiting for held art; a finish also waits for its inks to be prepared.
  await expect.poll(() => slots.evaluateAll((images) => images.map((img) => (img as HTMLImageElement).dataset.state)))
    .toEqual(vector.cards.map((card) => (card.finish ? 'rendering' : 'loading')));
  const captions = cards.locator('.mod-label');
  await expect(captions).toHaveCount(finished);
  for (const caption of await captions.all()) await expect(caption).toBeHidden();
  // The names that tell a screen reader what each card is stay on the buttons.
  for (const card of await cards.all()) await expect(card).toHaveAccessibleName(/\S/);

  art.set('serve');
  await expectDecoded(slots, vector.cards.length);
  for (const caption of await captions.all()) await expect(caption).toBeVisible();
  expect(unexpectedArtErrors(errors).filter((error) => !error.startsWith('net::ERR_ABORTED'))).toEqual([]);
});
