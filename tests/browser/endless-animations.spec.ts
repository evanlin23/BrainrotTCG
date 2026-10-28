import { readFileSync } from 'node:fs';
import { test as base, expect, type Page } from '@playwright/test';
import { STORAGE_KEYS } from '../../src/constants/config';
import { expectDecoded, expectPackDropped, expectSummaryTakesClicks, fingerFor, holdArt, holdTickets, monitor, PLAYER_SECRET, unexpectedArtErrors } from './support';

// Reading keyframes catches paint/layout work even if another animation puts the same node on a
// layer. LayerTree then proves that Chromium actually runs each visible running target's animation
// on its own compositor layer, including pseudo-elements. An allowed property alone is insufficient.
const COMPOSITOR_REASONS: Record<string, string> = {
  backdropFilter: 'ActiveBackdropFilterAnimation', filter: 'ActiveFilterAnimation', opacity: 'ActiveOpacityAnimation',
  rotate: 'ActiveRotateAnimation', scale: 'ActiveScaleAnimation', transform: 'ActiveTransformAnimation', translate: 'ActiveTranslateAnimation',
};
type Layer = { layerId: string; backendNodeId?: number };
type Probe = (expected: Record<string, number>) => Promise<void>;

const test = base.extend<{ compositor: Probe }>({
  compositor: async ({ page }, provide, testInfo) => {
    const session = await page.context().newCDPSession(page);
    let layers: Layer[] = [];
    const changed = (event: { layers?: Layer[] }) => { layers = event.layers ?? []; };
    session.on('LayerTree.layerTreeDidChange', changed);
    try {
      await session.send('DOM.enable');
      await session.send('LayerTree.enable');
      await provide(async (expected) => {
        // A cross-process navigation can retire the tree enabled on about:blank. Subscribe afresh
        // on this document, and request a complete initial tree for every screen.
        await page.evaluate(() => {
          for (const animation of document.getAnimations()) {
            if (animation.effect?.getComputedTiming().iterations !== Infinity || animation.playState !== 'running') continue;
            const effect = animation.effect;
            const phase = (animation as CSSAnimation).animationName === 'pack-idle-lift' ? .59 : .175;
            animation.currentTime = Number(effect.getTiming().delay) + Number(effect.getTiming().duration) * phase;
            // Leave the animation running within its moving segment while CDP reads each own layer.
            animation.playbackRate = .001;
          }
        });
        await session.send('LayerTree.disable');
        layers = [];
        await session.send('LayerTree.enable');
        const animations = await page.evaluate(() => {
          for (const old of Array.from(document.querySelectorAll('[data-endless-probe]'))) old.removeAttribute('data-endless-probe');
          const targets = new Map<Element, string>();
          return document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations === Infinity).map((animation) => {
            const effect = animation.effect as KeyframeEffect;
            const target = effect.target as Element;
            const id = targets.get(target) ?? String(targets.size);
            targets.set(target, id);
            target.setAttribute('data-endless-probe', id);
            const box = target.getBoundingClientRect();
            const style = getComputedStyle(target);
            // SVG groups have no CSS box, and a horizontal stroked seam has a zero-height fill box.
            const shown = target instanceof SVGElement ? style.display !== 'none' && style.visibility === 'visible' && Number(style.opacity) > 0
              : target.checkVisibility({ opacityProperty: true, visibilityProperty: true });
            const properties = [...new Set(effect.getKeyframes().flatMap((frame) => Object.keys(frame)))]
              .filter((name) => !['offset', 'computedOffset', 'easing', 'composite'].includes(name)).sort();
            return {
              id, animation: (animation as CSSAnimation).animationName, pseudo: effect.pseudoElement,
              on: `${target.tagName.toLowerCase()}.${target.getAttribute('class') ?? ''}${effect.pseudoElement ?? ''}`, properties,
              active: animation.playState === 'running' && shown
                && !target.closest('.card-face[aria-hidden="true"]') && box.width > 0 && (box.height > 0 || target instanceof SVGGraphicsElement)
                && box.right > 0 && box.bottom > 0 && box.left < innerWidth && box.top < innerHeight,
            };
          });
        });
        if (Object.keys(expected).length) expect(animations.length, 'a representative animated screen must contain endless animations').toBeGreaterThan(0);
        expect(animations.filter(({ properties }) => properties.some((name) => !Object.hasOwn(COMPOSITOR_REASONS, name))), 'endless animations that repaint or lay out').toEqual([]);
        const active = animations.filter((animation) => animation.active);
        for (const [name, count] of Object.entries(expected)) {
          expect(count, 'every required family has a nonzero sample').toBeGreaterThan(0);
          expect(active.filter(({ animation }) => animation === name), `active ${name} targets`).toHaveLength(count);
        }
        if (Object.keys(expected).length) expect(active.length, 'visible running targets must be sampled').toBeGreaterThan(0);
        const evidence: { animation: string; on: string; properties: string[]; backendNodeId: number; reasons: string[] }[] = [];
        // Promotion and pseudo-node creation are observable states, rather than a timed settling sleep.
        try {
          await expect.poll(async () => {
            evidence.length = 0;
            const missing: string[] = [];
            const { root } = await session.send('DOM.getDocument');
            for (const animation of active) {
              const { nodeId } = await session.send('DOM.querySelector', { nodeId: root.nodeId, selector: `[data-endless-probe="${animation.id}"]` });
              if (!nodeId) { missing.push(`${animation.on}: target detached`); continue; }
              const { node } = await session.send('DOM.describeNode', { nodeId });
              const target = animation.pseudo ? node.pseudoElements?.find((pseudo: { pseudoType?: string }) => `::${pseudo.pseudoType}` === animation.pseudo) : node;
              if (!target) { missing.push(`${animation.on}: no pseudo node`); continue; }
              const reasons: string[] = [];
              for (const layer of layers.filter((candidate) => candidate.backendNodeId === target.backendNodeId)) {
                try {
                  const result = await session.send('LayerTree.compositingReasons', { layerId: layer.layerId });
                  reasons.push(...result.compositingReasonIds);
                } catch (error) {
                  // A layer may retire between its event and this read. The next tree must provide it.
                  if (!(error instanceof Error) || !error.message.includes('No layer matching')) throw error;
                }
              }
              evidence.push({ animation: animation.animation, on: animation.on, properties: animation.properties, backendNodeId: target.backendNodeId, reasons });
              if (!animation.properties.every((property) => reasons.includes(COMPOSITOR_REASONS[property]))) missing.push(`${animation.animation} on ${animation.on}: no active compositor reason (${reasons.join(', ')})`);
            }
            return missing;
          }, { message: 'each animated target needs its own active compositor reason' }).toEqual([]);
        } finally {
          await testInfo.attach('compositor-targets', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
        }
      });
    } finally {
      session.off('LayerTree.layerTreeDidChange', changed);
      try {
        await session.send('LayerTree.disable');
        await session.send('DOM.disable');
      } finally { await session.detach(); }
    }
  },
});

const set = JSON.parse(readFileSync(new URL('../../src/content/sets/right-now/set.json', import.meta.url), 'utf8')) as {
  cards: { id: string; name: string; rarity: string }[];
};
const vectors = JSON.parse(readFileSync(new URL('../../spec/vectors.json', import.meta.url), 'utf8')) as {
  valid: { note: string; proof: string; hand: string; cards: { cardId: string; isHolo: boolean }[] }[];
};
const holoPull = vectors.valid.find(({ note }) => note === 'non-ASCII name')!;

async function seedNonce(page: Page, baseURL: string, nonce: number) {
  await page.addInitScript(({ origin, secret, nonce }) => {
    if (location.origin !== origin) return;
    localStorage.setItem('brainrot-player-v1', JSON.stringify({ secretKey: secret, name: 'Browser smoke fixture', nextNonce: nonce, createdAt: 1 }));
    localStorage.setItem('brainrot-settings-v1', JSON.stringify({ effectsVolume: 0, pauseBigPulls: false }));
  }, { origin: new URL(baseURL).origin, secret: PLAYER_SECRET, nonce });
}

async function seedCollection(page: Page) {
  const collection = Object.fromEntries(set.cards.map(({ id }, index) => {
    const key = `right-now/${id}`;
    return [key, { card: { id, key, setId: 'right-now' }, normalCount: 1, holoCount: 1,
      ...(index === 0 ? { finishes: { GOLD: 1 }, misprints: 1 } : {}) }];
  }));
  await page.addInitScript(({ collection, key }) => {
    localStorage.setItem(key, JSON.stringify(collection));
    localStorage.setItem('brainrot-data-version', '3');
  }, { collection, key: STORAGE_KEYS.COLLECTION });
}

async function openPack(page: Page) {
  await page.goto('./');
  await page.getByRole('button', { name: /^Open pack/ }).focus();
  await page.keyboard.press('Space');
  await expect(page.locator('.reveal-card:focus')).toHaveAttribute('aria-label', 'Flip card 1 of 5');
}

async function nextCard(page: Page, number: number) {
  const card = page.locator('.reveal-card:focus');
  await expectDecoded(card.locator('img.card-image:not(.misprint-ghost)'), 1);
  await page.keyboard.press('Space');
  await expect(card).toHaveAttribute('aria-label', /^Next card\./);
  await page.keyboard.press('Space');
  await expect(card).toHaveAttribute('aria-label', `Flip card ${number + 1} of 5`);
}

test('sealed foil, idle lift and the live cut seam have active compositor layers', async ({ page, baseURL, hasTouch, compositor }) => {
  const errors = await monitor(page, baseURL!);
  await holdTickets(page);
  await page.goto('./');
  const cue = page.locator('.pack-shell[data-open-cue="play"] .open-cue-travel');
  await expect(cue).toHaveCount(1);
  // Hold the finite cue open while its existing endless arrow is probed, then let its real
  // animation-end handler retire it before sampling the independently running idle lift.
  await cue.evaluate((element) => { for (const animation of element.getAnimations()) animation.pause(); });
  await expectPackDropped(page);
  await compositor({ swipeMotion: 1 });
  await cue.evaluate((element) => { for (const animation of element.getAnimations()) animation.finish(); });
  await expectPackDropped(page);
  await expect(page.locator('.pack-shell')).toHaveClass(/\bis-idle\b/);
  for (const foil of ['standard', 'shimmer', 'gold', 'prism']) {
    await page.evaluate((name) => { document.documentElement.dataset.packFoil = name; }, foil);
    await compositor({ 'pack-idle-lift': 2, ...(foil === 'standard' ? {} : { 'pack-foil': 2 }) });
  }
  const shell = page.locator('.pack-shell');
  const box = (await shell.boundingBox())!;
  const finger = await fingerFor(page, hasTouch);
  await finger.press(box.x + box.width * .4, box.y + box.height * .19);
  await finger.move(box.x + box.width * .5, box.y + box.height * .19);
  await expect(shell.locator('.cut-line')).toHaveCount(1);
  await compositor({ 'seam-shimmer': 1 });
  await finger.release();
  expect(errors).toEqual([]);
});

test('a real holo reveal, its summary and the close-up keep every endless effect on the compositor', async ({ page, baseURL, isMobile, compositor }) => {
  await seedNonce(page, baseURL!, 21);
  const errors = await monitor(page, baseURL!);
  await openPack(page);
  for (let number = 1; number < 4; number++) await nextCard(page, number);
  const card = page.locator('.reveal-card:focus');
  await expect(card.locator('.card-wrapper.holo')).toHaveCount(1);
  await expectDecoded(card.locator('img.card-image'), 1);
  await page.keyboard.press('Space');
  await expect(card).toHaveAttribute('aria-label', /^Next card\./);
  await compositor({ holoRainbowShimmer: 1, ...(isMobile ? { holoGlint: 1 } : {}) });
  await page.locator('button.reveal-skip').click();
  await expect(page.locator('.summary-card')).toHaveCount(5);
  await expectSummaryTakesClicks(page);
  await expectDecoded(page.locator('.summary-card img.card-image'), 5);
  await compositor({});
  // The summary's holo uses its existing transform effects; opening it exercises the viewer's pair.
  await page.locator('.summary-card.holo').click();
  await expectDecoded(page.locator('.card-viewer-card img.card-image'), 1);
  await compositor({ cardViewerHoloRainbow: 1, cardViewerHoloShine: 1 });
  expect(errors).toEqual([]);
});

for (const [nonce, rarity] of [[8, 'brainrot'], [10, 'legendary']] as const) {
  test(`the real nonce ${nonce} ${rarity} tell expands its hard ring on the compositor`, async ({ page, baseURL, compositor }) => {
    await seedNonce(page, baseURL!, nonce);
    const errors = await monitor(page, baseURL!);
    await openPack(page);
    for (let number = 1; number < 5; number++) await nextCard(page, number);
    const wrapper = page.locator(`.reveal-card:focus .card-wrapper.tell-${rarity}`);
    await expect(wrapper).toBeVisible();
    await compositor({ tellPulse: 8 });
    // The finite lift remains independent of the eight endless ring pieces, on both siblings.
    await wrapper.evaluate((element) => element.classList.add('lift-cue'));
    const lift = await wrapper.evaluate((element) => Array.from(element.querySelectorAll('.card-back, .card-back-tell')).map((back) =>
      back.getAnimations().filter((animation) => animation instanceof CSSAnimation && animation.animationName === 'first-card-lift').map((animation) => animation.effect!.getTiming().iterations)));
    expect(lift).toEqual([[1], [1]]);
    expect(errors).toEqual([]);
  });
}

test('loaded holo collection tiles and pending visible/offscreen images use their own bounded layers', async ({ page, baseURL, compositor }) => {
  const errors = await monitor(page, baseURL!, 0, { returning: true });
  await holdTickets(page);
  await seedCollection(page);
  const art = await holdArt(page);
  await page.goto('./#/cards');
  const tiles = page.locator('.collection-item.holo');
  await expect(tiles).toHaveCount(set.cards.length);
  const first = tiles.first();
  await expect(first.locator('img')).toHaveAttribute('data-state', 'loading');
  const visibleShines = await tiles.evaluateAll((items) => items.filter((item) => { const box = item.getBoundingClientRect(); return box.top < innerHeight && box.bottom > 0; }).length);
  const visibleLoading = await page.locator('.card-image-placeholder').evaluateAll((items) => items.filter((item) => { const box = item.getBoundingClientRect(); return box.top < innerHeight && box.bottom > 0; }).length);
  await compositor({ collectionItemHoloShine: visibleShines, 'card-image-shimmer': visibleLoading });
  // This whole small set fits on a tall desktop. A short narrow window creates a real scroll boundary.
  const viewport = page.viewportSize()!;
  await page.setViewportSize({ width: 320, height: 360 });
  await tiles.last().scrollIntoViewIfNeeded();
  await expect(first.locator('img')).toHaveAttribute('data-offscreen', '');
  expect(await first.locator('.card-image-placeholder').evaluate((element) => getComputedStyle(element, '::before').animationPlayState)).toBe('paused');
  art.set('serve');
  await page.setViewportSize(viewport);
  await first.scrollIntoViewIfNeeded();
  await expectDecoded(first.locator('img'), 1);
  await expect(first.locator('.card-image-placeholder')).toHaveCount(0);
  expect(unexpectedArtErrors(errors)).toEqual([]);
});

test('a held page chunk exposes nonempty composited skeleton rows', async ({ page, baseURL, compositor }) => {
  const errors = await monitor(page, baseURL!, 0, { returning: true });
  await holdTickets(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(/\/assets\/CollectionBrowser-[\w-]+\.js$/, async (route) => { await held; await route.fallback(); });
  try {
    await page.goto('./#/cards');
    const rows = page.locator('.page-skeleton-item');
    await expect(rows.first()).toBeVisible();
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
    await compositor({ 'page-skeleton': count });
  } finally { release(); }
  await expect(page.locator('.page-skeleton')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a verified holo pull uses compositor layers in its carousel and in the saved grid', async ({ page, baseURL, compositor }) => {
  const errors = await monitor(page, baseURL!, 0, { returning: true });
  await page.goto(`./#/pull/${holoPull.proof}`);
  const carousel = page.locator('.pack-viewer-card-carousel');
  await expect(carousel).toHaveCount(5);
  await expectDecoded(carousel.locator('img'), 5);
  await compositor({ packViewerHoloRainbow: 1, packViewerHoloShine: 1 });
  // A history gallery is the real product's grid mode, with the same already-validated fixture cards.
  await page.evaluate(({ key, cards }) => {
    localStorage.setItem(key, JSON.stringify([{ s: 'web-ancients', v: 1, n: 1, k: '8a88e3dd7409f195', c: cards.map(({ cardId, isHolo }) => `${cardId}${isHolo ? '*' : ''}`).join(','), h: 'Pair', x: 0, t: 1 }]));
  }, { key: STORAGE_KEYS.HISTORY, cards: holoPull.cards });
  await page.goto('./#/profile');
  await page.locator('.pulls-history .pull-row').first().click();
  await page.getByRole('dialog', { name: 'Share your pull', exact: true }).getByText('Share an individual card', { exact: true }).click();
  const grid = page.locator('.pack-viewer-card-grid');
  await expect(grid).toHaveCount(5);
  await expectDecoded(grid.locator('img'), 5);
  await compositor({ packViewerHoloRainbow: 1, packViewerHoloShine: 1 });
  expect(errors).toEqual([]);
});

test('profile foil swatches remain composited', async ({ page, baseURL, compositor }) => {
  const errors = await monitor(page, baseURL!, 0, { returning: true });
  await holdTickets(page);
  await page.goto('./#/profile');
  await page.locator('#rewards summary').click();
  await expect(page.locator('.foil-swatch')).toHaveCount(4);
  await page.getByRole('radiogroup', { name: 'Pack foil', exact: true }).scrollIntoViewIfNeeded();
  await compositor({ 'pack-foil': 3 });
  await page.locator('.back-swatch.back-prism').scrollIntoViewIfNeeded();
  await compositor({ 'card-back-prism': 1 });
  expect(errors).toEqual([]);
});

test('Rankings pulses and five pending thumbnails in both lists keep their own bounds and layers', async ({ page, baseURL, compositor }) => {
  const errors = await monitor(page, baseURL!, 1, { returning: true });
  await holdTickets(page);
  const art = await holdArt(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(/\/hall-of-fame\.json(?:\?.*)?$/, async (route) => {
    await held;
    await route.fulfill({ json: [{
      id: 'animation-fixture', proof: 'fixture-not-submitted', name: 'Animation fixture', fingerprint: 'abcd',
      setId: 'web-ancients', setName: 'Web Ancients', hand: 'Pair', multiplier: 2, score: 1000,
      submittedAt: '2026-10-01T00:00:00.000Z', githubUser: 'fixture', issue: 1,
      cards: holoPull.cards.map((card) => ({ ...card, isHolo: false })),
    }] });
  });
  try {
    await page.goto('./#/rankings');
    const bars = page.locator('.hof-skeleton-bar');
    await expect(bars.first()).toBeVisible();
    const visible = await bars.evaluateAll((items) => items.filter((item) => { const box = item.getBoundingClientRect(); return box.top < innerHeight && box.bottom > 0; }).length);
    await compositor({ 'hof-pulse': visible });
  } finally { release(); }
  await page.getByRole('tab', { name: 'All-time', exact: true }).click();
  await expect(page.locator('.hof-cards img')).toHaveCount(5);
  for (const selector of ['.hof-cards', '.pulls-history .pull-row-thumbs']) {
    if (selector.includes('pulls')) await page.goto('./#/profile');
    const group = page.locator(selector).first();
    await group.scrollIntoViewIfNeeded();
    const images = group.locator('img.card-image');
    await expect(images).toHaveCount(5);
    await expect.poll(() => images.evaluateAll((items) => items.map((item) => (item as HTMLElement).dataset.state))).toEqual(Array(5).fill('loading'));
    const boxes = await images.evaluateAll((items) => items.map((image) => {
      const img = image.getBoundingClientRect();
      const slot = image.parentElement!.getBoundingClientRect();
      const placeholder = image.parentElement!.querySelector('.card-image-placeholder')!.getBoundingClientRect();
      return { image: { x: img.x, y: img.y, width: img.width, height: img.height }, slot: { x: slot.x, y: slot.y, width: slot.width, height: slot.height }, placeholder: { x: placeholder.x, y: placeholder.y, width: placeholder.width, height: placeholder.height } };
    }));
    for (const box of boxes) for (const dimension of ['x', 'y', 'width', 'height'] as const) {
      expect(box.slot[dimension], `slot ${dimension}`).toBeCloseTo(box.image[dimension], 1);
      expect(box.placeholder[dimension], `placeholder ${dimension}`).toBeCloseTo(box.image[dimension], 1);
    }
    const overlap = selector.includes('hof') ? 12 : page.viewportSize()!.width <= 420 ? 10 : 8;
    for (let index = 1; index < boxes.length; index++) expect(boxes[index].image.x - boxes[index - 1].image.x).toBeCloseTo(boxes[index - 1].image.width - overlap, 1);
    const visible = await page.locator('.card-image-placeholder').evaluateAll((items) => items.filter((item) => { const box = item.getBoundingClientRect(); return box.top < innerHeight && box.bottom > 0; }).length);
    await compositor({ 'card-image-shimmer': visible });
  }
  art.set('serve');
  await expectDecoded(page.locator('.pulls-history .pull-row-thumbs').first().locator('img'), 5);
  expect(unexpectedArtErrors(errors)).toEqual([]);
});

test('a full-size finish renders with one composited placeholder and no ghost shimmer', async ({ page, baseURL, compositor }) => {
  const errors = await monitor(page, baseURL!, 0, { returning: true });
  await holdTickets(page);
  const id = set.cards[0].id;
  await page.addInitScript(({ key, id }) => {
    const cardKey = `right-now/${id}`;
    localStorage.setItem(key, JSON.stringify({ [cardKey]: { card: { id, key: cardKey, setId: 'right-now' }, normalCount: 1, holoCount: 0, finishes: { GOLD: 1 }, misprints: 1 } }));
    localStorage.setItem('brainrot-data-version', '3');
  }, { key: STORAGE_KEYS.COLLECTION, id });
  const art = await holdArt(page);
  await page.goto('./#/cards');
  await page.locator('.collection-item').click();
  const card = page.locator('.card-viewer-card.misprint');
  await expect(card.locator('img').first()).toHaveAttribute('data-state', 'rendering');
  await expect(card.locator('img.misprint-ghost')).toHaveAttribute('data-state', 'rendering');
  await expect(card.locator('.card-image-placeholder')).toHaveCount(1);
  expect(await card.locator('img.misprint-ghost').evaluate((ghost) => ghost.getAnimations().length)).toBe(0);
  // The still-pending tile remains mounted behind the modal; both real first passes are checked.
  await compositor({ 'card-image-shimmer': 2 });
  art.set('serve');
  await expectDecoded(card.locator('img'), 2);
  await expect(card.locator('.card-image-placeholder')).toHaveCount(0);
  expect(unexpectedArtErrors(errors)).toEqual([]);
});

for (const motion of ['device', 'setting']) {
  test(`reduced motion from the ${motion} keeps pending and holo effects still`, async ({ page, baseURL }) => {
    const errors = await monitor(page, baseURL!, 0, { returning: true });
    await holdTickets(page);
    await seedCollection(page);
    if (motion === 'device') await page.emulateMedia({ reducedMotion: 'reduce' });
    else await page.addInitScript(() => localStorage.setItem('brainrot-settings-v1', JSON.stringify({ effectsVolume: 0, motion: 'reduced' })));
    const art = await holdArt(page);
    await page.goto('./#/cards');
    const first = page.locator('.collection-item').first();
    await expect(first.locator('img')).toHaveAttribute('data-state', 'loading');
    expect(await first.locator('img').evaluate((image) => getComputedStyle(image).backgroundImage)).toMatch(/^linear-gradient/);
    await expect(first.locator('.card-image-placeholder')).toBeHidden();
    expect(await page.evaluate(() => document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations === Infinity).length)).toBe(0);
    expect(await first.evaluate((item) => getComputedStyle(item, '::after').willChange)).toBe('auto');
    art.set('serve');
    await expectDecoded(first.locator('img'), 1);
    await first.click();
    await expectDecoded(page.locator('.card-viewer-card > .card-image-slot img'), 1);
    expect(await page.evaluate(() => document.getAnimations().filter((animation) => animation.effect?.getComputedTiming().iterations === Infinity).length)).toBe(0);
    expect(errors).toEqual([]);
  });
}
