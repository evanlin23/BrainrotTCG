import { test, expect, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { monitor, expectDecoded, holdArt, unexpectedArtErrors } from './support';

/**
 * Card art that is still on the way (#762). The score, certificate and the action to open packs never
 * wait for art, and a slot whose art is pending is an empty frame: it must not carry the finish caption,
 * which on a dark slot reads as a card back (the pull viewer, the pack summary and the binder all print
 * one). Art is held with route interception and released on demand, so no step depends on timing.
 *
 * The app gives a finish render 15s to load its art. A frozen page clock keeps that deadline from
 * running out on a slow runner, so a held slot stays pending however long the run takes.
 */
const vectors = JSON.parse(readFileSync(new URL('../../spec/vectors-python.json', import.meta.url), 'utf8')) as {
  valid: { note: string; proof: string; hand: string; score: number; cards: { finish: string | null }[] }[];
};
const vector = vectors.valid.find((v) => v.note === 'modifiers (§5.4): a Silver misprint, stacked')!;
const finished = vector.cards.filter((card) => card.finish).length;

/** Freezes the page clock after load starts, so the app's own timeouts never fire during the hold. */
async function freezeClock(page: Page) {
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 60_000));
}

async function openSharedPull(page: Page) {
  const pull = page.getByRole('dialog', { name: vector.hand, exact: true });
  await page.goto(`./#/pull/${vector.proof}`);
  await expect(pull).toContainText('This pull checks out — re-verified in your browser just now', { timeout: 20000 });
  await expect(pull.locator('.score-panel-total')).toHaveText(vector.score.toLocaleString('en-US'));
  return pull;
}

test('a shared pull shows no finish captions on pending art, and keeps score and actions usable', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const errors = await monitor(page, baseURL!, 0, { returning: true });
  const art = await holdArt(page);
  await freezeClock(page);
  const pull = await openSharedPull(page);
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
  expect(unexpectedArtErrors(errors)).toEqual([]);
});

test('art that was held and then fails leaves the captions on its hatched slots', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const errors = await monitor(page, baseURL!, 0, { returning: true });
  const art = await holdArt(page);
  await freezeClock(page);
  const pull = await openSharedPull(page);
  await expect.poll(() => art.requests()).toBeGreaterThan(0);

  const cards = pull.locator('.pack-viewer-cards > button');
  await expect(cards).toHaveCount(vector.cards.length);
  const captions = cards.locator('.mod-label');
  await expect(captions).toHaveCount(finished);
  for (const caption of await captions.all()) await expect(caption).toBeHidden();

  // A 404 settles every held request as a failure; the slot is then the "no art" box, which keeps its caption.
  art.set('drop');
  const slots = cards.locator('img.card-image');
  await expect.poll(() => slots.evaluateAll((images) => images.every((img) => (img as HTMLImageElement).dataset.state === 'failed'))).toBe(true);
  for (const caption of await captions.all()) await expect(caption).toBeVisible();
  expect(art.failed()).toBeGreaterThan(0);
  expect(unexpectedArtErrors(errors)).toEqual([]);
});

test('a pack summary hides the finish captions on pending art, and shows them once it is drawn', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const errors = await monitor(page, baseURL!, 0, { returning: true });
  const art = await holdArt(page);
  await page.goto('./');
  const opener = page.getByRole('button', { name: /^Open pack/ });
  await expect(opener).toBeEnabled();
  await opener.focus();
  await page.keyboard.press('Space');
  await expect(page.locator('.card-reveal-area')).toBeVisible({ timeout: 15000 });
  await page.locator('button.reveal-skip').click({ timeout: 15000 });
  await expect(page.locator('.pack-summary')).toBeVisible({ timeout: 15000 });

  const slots = page.locator('.summary-cards img.card-image');
  await expect(slots).toHaveCount(5);
  const captions = page.locator('.summary-cards .mod-label');
  // A pending slot is either still being prepared (a finish) or waiting on its art; both are empty frames.
  await expect.poll(() => slots.evaluateAll((images) => images.every((img) => ['rendering', 'loading'].includes((img as HTMLImageElement).dataset.state ?? '')))).toBe(true);
  expect(await captions.count()).toBeGreaterThan(0);
  for (const caption of await captions.all()) await expect(caption).toBeHidden();
  for (const tile of await page.locator('.summary-card').all()) await expect(tile).toHaveAccessibleName(/^View /);

  art.set('serve');
  await expectDecoded(slots, 5);
  for (const caption of await captions.all()) await expect(caption).toBeVisible();
  expect(unexpectedArtErrors(errors)).toEqual([]);
});

// Rankings rows and pull rows draw cards about 30px wide. Their placeholder has to read as "loading", so it
// is measured against the page behind it: a wash close to the background is a black box, not a placeholder.
const MIN_PLACEHOLDER_CONTRAST = 1.8;

const luminance = ([r, g, b]: number[]) => {
  const [lr, lg, lb] = [r, g, b].map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
};
const contrast = (a: number[], b: number[]) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** The thumb's mean colour, from its pixels, and the first opaque colour behind it. */
async function thumbAndBackdrop(thumb: Locator) {
  const { channels } = await sharp(await thumb.screenshot()).removeAlpha().stats();
  const backdrop = await thumb.evaluate((element) => {
    for (let node: Element | null = element.parentElement; node; node = node.parentElement) {
      const color = getComputedStyle(node).backgroundColor;
      const parts = color.match(/[\d.]+/g)?.map(Number) ?? [];
      if (parts.length === 3 || (parts.length === 4 && parts[3] === 1)) return parts.slice(0, 3);
    }
    return [18, 17, 20];
  });
  return { thumb: channels.map((channel) => channel.mean), backdrop };
}

test.describe('with motion reduced, so a placeholder holds one still wash', () => {
  test.use({ reducedMotion: 'reduce' });

  test('Rankings thumbs read as loading, not as dark boxes, until their art is drawn', async ({ page, baseURL }) => {
    test.setTimeout(60000);
    const errors = await monitor(page, baseURL!, 0, { returning: true });
    const art = await holdArt(page);
    const entry = {
      id: 'thumb-fixture', proof: 'thumb-fixture-proof', name: 'Collector', fingerprint: 'abcd', setId: 'right-now', setName: 'Right Now',
      hand: 'Full House', multiplier: 150, score: 50_000, submittedAt: '2026-10-01T00:00:00.000Z', issue: 1000, githubUser: 'fixture',
      cards: ['pirate-gaster', 'niu-lai', 'bukangi', 'huss-valley', 'la-peace'].map((cardId) => ({ cardId, isHolo: false })),
    };
    await page.route('**/hall-of-fame.json', (route) => route.fulfill({ json: [entry] }));
    // Today's board reads the relays; a relay that answers "nothing stored" leaves the fixture on All-time.
    await page.routeWebSocket(/.*/, (socket) => socket.onMessage((message) => {
      const [type, subscription] = JSON.parse(String(message)) as [string, string];
      if (type === 'REQ') socket.send(JSON.stringify(['EOSE', subscription]));
    }));
    await page.goto('./#/rankings');
    const rankings = page.getByRole('main', { name: 'Rankings', exact: true });
    await rankings.getByRole('tab', { name: 'All-time', exact: true }).click();
    const thumbs = rankings.locator('.hof-cards img.card-image');
    await expect(thumbs).toHaveCount(5);
    await expect.poll(() => art.requests()).toBeGreaterThan(0);
    await expect.poll(() => thumbs.evaluateAll((images) => images.every((img) => (img as HTMLImageElement).dataset.state === 'loading'))).toBe(true);

    const { thumb, backdrop } = await thumbAndBackdrop(thumbs.nth(2));
    expect(contrast(thumb, backdrop), `placeholder ${thumb.map(Math.round)} on ${backdrop}`).toBeGreaterThanOrEqual(MIN_PLACEHOLDER_CONTRAST);

    art.set('serve');
    await expectDecoded(thumbs, 5);
    expect(unexpectedArtErrors(errors)).toEqual([]);
  });

  test('pull-row thumbs on Profile read as loading, not as dark boxes, until their art is drawn', async ({ page, baseURL }) => {
    test.setTimeout(60000);
    const errors = await monitor(page, baseURL!, 1, { returning: true });
    await page.route(/\/hall-of-fame\.json(\?.*)?$/, (route) => route.fulfill({ json: [] }));
    const art = await holdArt(page);
    await page.goto('./#/profile');
    const main = page.getByRole('main', { name: 'Profile', exact: true });
    const thumbs = main.locator('.pulls-history .pull-row').first().locator('.pull-row-thumbs img.card-image');
    await expect(thumbs.first()).toBeVisible();
    await expect.poll(() => art.requests()).toBeGreaterThan(0);
    const count = await thumbs.count();
    expect(count).toBeGreaterThan(0);
    await expect.poll(() => thumbs.evaluateAll((images) => images.every((img) => ['loading', 'rendering'].includes((img as HTMLImageElement).dataset.state ?? '')))).toBe(true);

    // A holo thumb wears its foil ring while it waits, which is not the plain wash; measure a plain one.
    const plain = main.locator('.pulls-history .pull-row').first().locator('.pull-row-thumbs img.card-image:not(.holo)').first();
    const { thumb, backdrop } = await thumbAndBackdrop(plain);
    expect(contrast(thumb, backdrop), `placeholder ${thumb.map(Math.round)} on ${backdrop}`).toBeGreaterThanOrEqual(MIN_PLACEHOLDER_CONTRAST);

    art.set('serve');
    await expectDecoded(thumbs, count);
    expect(unexpectedArtErrors(errors)).toEqual([]);
  });
});
