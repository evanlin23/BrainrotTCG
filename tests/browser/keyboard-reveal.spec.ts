import { test, expect, type Locator, type Page } from '@playwright/test';
import { monitor } from './support';

/**
 * A whole pack by keyboard alone (#12): Tab reaches the Open pack button, Space tears the pack, and the
 * card is the one button for the reveal, flip then next (#312: a real button named with the card's rarity). Tab
 * shows a focus ring on the pack button; Space paints none on the cards it moves to or flips (#529), and an arrow key
 * brings it back. A single polite live region names each card as it turns face up, never before. The fixture key's nonce 21 deals no big
 * pull, so nothing holds the reveal, and it repeats a card (2 and 5), so the checks meet a duplicate name.
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

/** The fixture player at nonce 21. Before monitor's own seed, which leaves a seeded player alone. */
const seedNonce21 = (page: Page, baseURL: string) => page.addInitScript((origin) => {
  if (window.location.origin !== origin || localStorage.getItem('brainrot-player-v1')) return;
  localStorage.setItem('brainrot-player-v1', JSON.stringify({ secretKey: '01'.repeat(32), name: 'Browser smoke fixture', nextNonce: 21, createdAt: 1 }));
  localStorage.setItem('brainrot-settings-v1', JSON.stringify({ effectsVolume: 0 }));
}, new URL(baseURL).origin);

/** Every region that speaks on its own, and what it says now. */
const liveTexts = (page: Page) => page.locator('[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"], [role="log"]').allTextContents();

test('opens a pack and reveals every card by keyboard alone, with a visible focus ring and one announcement per card', async ({ page, baseURL }) => {
  test.setTimeout(90000);
  await seedNonce21(page, baseURL!);
  const errors = await monitor(page, baseURL!);
  await page.goto('./');
  await expect(page.locator('.app-logo')).toBeVisible();

  // Tab, from the top of the page, reaches the Open pack button.
  const pack = page.getByRole('button', { name: 'Open pack', exact: true });
  await expect(pack).toBeVisible();
  let tabs = 0;
  while (!(await pack.evaluate((el) => el === document.activeElement))) {
    expect(++tabs, 'Tab never reached the Open pack button').toBeLessThan(40);
    await page.keyboard.press('Tab');
  }
  // The shared ring, over the transparent outline forced colours paint (#312 S5). The button's
  // box-shadow eases in, so the ring is read once that transition has settled.
  await expect.poll(async () => (await ring(pack)).boxShadow).toContain(BRAND);
  const packRing = await ring(pack);
  expect(packRing.focusVisible).toBe(true);
  expect(packRing.outline).toBe('solid rgba(0, 0, 0, 0)');
  expect(contrast(rgb(BRAND), rgb(packRing.page))).toBeGreaterThanOrEqual(3);

  await page.keyboard.press('Space');
  await expect(page.locator('.pack-top-count')).toHaveText('Card 1 of 5', { timeout: 15000 });

  const live = page.locator('.sr-only[aria-live="polite"]');
  const area = page.locator('.card-reveal-area');
  // The card that has focus. The one before it can still be leaving, so it's found by focus, not label.
  const card = page.locator('.reveal-card:focus');
  const names: string[] = [];
  for (let n = 1; n <= 5; n++) {
    // The tear, and each move on, leave focus on the card, ready to flip.
    await expect(card).toHaveAttribute('aria-label', `Flip card ${n} of 5`, { timeout: 10000 });
    // Space only drove the game here, so the card has focus and no ring (#529); an arrow key, which does
    // nothing on the reveal, is navigation and puts the shared ring back on the card that has focus.
    expect((await ring(card, '::after')).boxShadow, `card ${n} rang after Space`).not.toContain(BRAND);
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await ring(card, '::after')).boxShadow).toContain(BRAND);
    const cardRing = await ring(card, '::after');
    expect(cardRing.focusVisible).toBe(true);
    expect(contrast(rgb(BRAND), rgb(cardRing.page))).toBeGreaterThanOrEqual(3);
    // Nothing is said about a card still face down, and nothing on the screen names it yet.
    await expect(live).toHaveCount(1);
    await expect(live).toHaveText('');
    // The card's own name, art and text. Earlier cards, face up, can still be leaving the area: inert, so out of
    // Chromium's accessibility tree, but Playwright's snapshot doesn't skip inert content and still lists them.
    const before = await card.ariaSnapshot();
    const areaBefore = await area.ariaSnapshot();
    const liveBefore = await liveTexts(page);

    await page.keyboard.press('Space');
    await expect(live).toHaveText(announced(n), { timeout: 10000 });
    const text = (await live.textContent())!;
    const name = text.match(announced(n))![1];
    expect(before, `card ${n} was named before its flip`).not.toContain(name);
    // The rest of the area too, unless a leaving card can carry the same name.
    if (!names.some((earlier) => earlier.includes(name))) {
      expect(areaBefore, `card ${n} was named on screen before its flip`).not.toContain(name);
    }
    names.push(name);
    // Said once: the announcement, card number and all, is in one region, and no other region newly names
    // the card. One still naming an earlier card of the same name was there before the flip.
    const liveAfter = await liveTexts(page);
    expect(liveAfter.filter((t) => t.includes(text))).toEqual([text]);
    expect(liveAfter.filter((t) => t !== text && t.includes(name) && !liveBefore.includes(t)), `card ${n} was said twice`).toEqual([]);

    // Face up, the button's name says what it does next, then the card with its rarity (#312).
    await expect(card).toHaveAttribute('aria-label', n < 5 ? /^Next card\. Card \d of 5: / : /^See the pack summary\. Card 5 of 5: /);
    expect(await card.getAttribute('aria-label')).toMatch(new RegExp(`${RARITY}`));
    // The flip was Space too: no ring until a navigation key brings it back.
    expect((await ring(card, '::after')).boxShadow, `card ${n} rang after the flip`).not.toContain(BRAND);
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await ring(card, '::after')).boxShadow).toContain(BRAND);
    if (n === 1) {
      // The emulated screen-reader view of the reveal, for the PR (Chromium's accessibility tree).
      console.log(`--- face down, card 1 ---\n${areaBefore}\n--- face up, card 1 ---\n${await area.ariaSnapshot()}`);
    }
    await page.keyboard.press('Space');
  }

  // The fixture's duplicate, so a repeated name always meets the checks above.
  expect(new Set(names).size, `the fixture pack repeats no card: ${names.join(', ')}`).toBeLessThan(names.length);
  await expect(page.locator('.pack-summary')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.summary-card')).toHaveCount(5);
  expect(errors).toEqual([]);
});

/** The site's address as built for /BrainrotTCG/ (vite.config.ts): the longest one it's served from. */
const AS_BUILT = 'evanlin23.github.io/BrainrotTCG';

/** How the provenance line under the card lays out with the built site's address (the test server's is shorter). */
const provenance = (page: Page) => page.locator('.reveal-provenance').evaluate((line, host) => {
  // Only the host changes, so the break the address allows after its slash stays.
  const site = line.querySelector('.reveal-provenance-site')!;
  const first = site.firstChild;
  if (!(first instanceof Text)) throw new Error('the address starts with its host');
  first.data = host;
  const box = (el: Element) => el.getBoundingClientRect();
  const within = (el: Element) => {
    const [r, l] = [box(el), box(line)];
    return r.left >= l.left - 0.5 && r.right <= l.right + 0.5 && r.top >= l.top - 0.5 && r.bottom <= l.bottom + 0.5
      && r.left >= 0 && r.right <= window.innerWidth;
  };
  const style = getComputedStyle(line);
  // How wide it would be on one line, to know whether it should fit on one.
  line.style.whiteSpace = 'nowrap';
  const oneLine = line.scrollWidth;
  line.style.whiteSpace = '';
  const number = line.querySelector('.reveal-provenance-number')!;
  const set = line.querySelector('.reveal-provenance-set')!;
  const stage = box(document.querySelector('.active-card-container')!);
  // The address's text, row by row, as it wraps.
  const siteRows = new Map<number, string>();
  const walker = document.createTreeWalker(site, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    for (let i = 0; i < node.data.length; i++) {
      const range = document.createRange();
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const rect = range.getClientRects()[0];
      if (!rect || rect.width === 0) continue;
      const top = Math.round(rect.top);
      siteRows.set(top, (siteRows.get(top) ?? '') + node.data[i]);
    }
  }
  const rowsOf = (el: Element) => Math.round(box(el).height / parseFloat(style.lineHeight));
  return {
    fitsOnOne: oneLine <= line.clientWidth,
    overflows: line.scrollWidth > line.clientWidth,
    ellipsis: style.textOverflow === 'ellipsis',
    lines: Math.round(box(line).height / parseFloat(style.lineHeight)),
    // The top of each part (game, address, set and number): the line breaks only between them.
    rows: Array.from(line.querySelectorAll('.reveal-provenance-part'), (part) => Math.round(box(part).top - box(line).top)),
    setWhole: within(set) && within(number) && rowsOf(set) === 1,
    // Every part, and the number, inside the line and the screen: nothing runs off or is cut.
    partsWithin: Array.from(line.querySelectorAll('.reveal-provenance-part'), within).every(Boolean) && within(number),
    site: site.textContent,
    siteRows: [...siteRows.values()].map((row) => row.trim()),
    set: set.textContent,
    numberShown: getComputedStyle(number).visibility === 'visible' && getComputedStyle(number).opacity === '1',
    stage: [stage.x, stage.y, stage.width, stage.height].map(Math.round),
  };
}, AS_BUILT.split('/')[0]);

test('keeps the provenance line whole on a 320px phone, wrapping the set and number under it without moving the card', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  await page.setViewportSize({ width: 320, height: 640 });
  await seedNonce21(page, baseURL!);
  const errors = await monitor(page, baseURL!);
  await page.goto('./');
  const pack = page.getByRole('button', { name: 'Open pack', exact: true });
  await expect(pack).toBeVisible();
  await pack.focus();
  await page.keyboard.press('Space');
  const card = page.locator('.reveal-card:focus');
  await expect(card).toHaveAttribute('aria-label', 'Flip card 1 of 5', { timeout: 15000 });

  // Too long for 288px: the game and the address, then the set and number, moved down whole.
  const faceDown = await provenance(page);
  expect(faceDown).toMatchObject({ site: `${AS_BUILT} ·`, fitsOnOne: false, overflows: false, ellipsis: false, lines: 2, setWhole: true, partsWithin: true, numberShown: false });
  expect(faceDown.siteRows).toEqual([`${AS_BUILT} ·`]);
  expect(faceDown.rows[1]).toBe(faceDown.rows[0]);
  expect(faceDown.rows[2]).toBeGreaterThan(faceDown.rows[0]);
  expect(faceDown.set).toMatch(/^\S.* 001\/\d{3}$/);

  // Flipped, the number shows in the space it kept; the line, and so the card, stay put. Same for the next card.
  await page.keyboard.press('Space');
  await expect.poll(async () => (await provenance(page)).numberShown).toBe(true);
  expect(await provenance(page)).toEqual({ ...faceDown, numberShown: true });
  await page.keyboard.press('Space');
  await expect(card).toHaveAttribute('aria-label', 'Flip card 2 of 5', { timeout: 10000 });
  const next = await provenance(page);
  expect(next).toEqual({ ...faceDown, set: next.set });
  expect(next.set).toMatch(/^\S.* \d{3}\/\d{3}$/);

  // Wider screens: one line when it fits, never more than two, never cut.
  for (const width of [390, 800]) {
    await page.setViewportSize({ width, height: 640 });
    const line = await provenance(page);
    expect(line, `${width}px`).toMatchObject({ overflows: false, ellipsis: false, setWhole: true, partsWithin: true, lines: line.fitsOnOne ? 1 : 2 });
    if (width === 800) expect(line.fitsOnOne).toBe(true);
  }
  expect(errors).toEqual([]);
});

/** Opens the fixture pack by keyboard and waits for its first card, face down. */
async function revealFirstCard(page: Page) {
  await page.goto('./');
  const pack = page.getByRole('button', { name: 'Open pack', exact: true });
  await expect(pack).toBeVisible();
  await pack.focus();
  await page.keyboard.press('Space');
  const card = page.locator('.reveal-card:focus');
  await expect(card).toHaveAttribute('aria-label', 'Flip card 1 of 5', { timeout: 15000 });
  return card;
}

test('wraps the address after its slash at large text on a 320px phone, so nothing runs off the stage (#472)', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  await page.setViewportSize({ width: 320, height: 640 });
  await seedNonce21(page, baseURL!);
  const errors = await monitor(page, baseURL!);
  await revealFirstCard(page);
  const style = await page.addStyleTag({ content: 'html { font-size: 125% !important; }' });
  const at125 = await provenance(page);
  expect(at125, '125% text').toMatchObject({ site: `${AS_BUILT} ·`, overflows: false, ellipsis: false, setWhole: true, partsWithin: true });
  // One part a row: the address still fits whole on its own.
  expect(at125.siteRows).toEqual([`${AS_BUILT} ·`]);
  expect(new Set(at125.rows).size).toBe(3);

  await style.evaluate((tag) => { tag.textContent = 'html { font-size: 200% !important; }'; });
  const at200 = await provenance(page);
  expect(at200, '200% text').toMatchObject({ site: `${AS_BUILT} ·`, overflows: false, ellipsis: false, partsWithin: true });
  // Wider than the line, the address breaks after its slash and nowhere else.
  expect(at200.siteRows).toEqual(['evanlin23.github.io/', 'BrainrotTCG ·']);
  expect(errors).toEqual([]);
});

test('levels a tilted card as soon as reduced motion turns on mid-reveal, and keeps it level', async ({ page, baseURL, hasTouch }) => {
  test.setTimeout(60000);
  await seedNonce21(page, baseURL!);
  const errors = await monitor(page, baseURL!);
  const card = await revealFirstCard(page);
  await page.keyboard.press('Space');
  await expect(card).toHaveAttribute('aria-label', /^Next card/, { timeout: 10000 });
  const wrapper = card.locator('.card-wrapper');
  const transform = () => wrapper.evaluate((el) => (el as HTMLElement).style.transform);
  const LEVEL = 'perspective(1000px) rotateX(0deg) rotateY(0deg)';
  const box = (await wrapper.boundingBox())!;

  // A real mouse tilts the card toward it; a phone's taps never do.
  await page.mouse.move(box.x + box.width, box.y + box.height);
  if (hasTouch) expect(await transform()).toBe(LEVEL);
  else await expect.poll(transform).not.toBe(LEVEL);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(transform).toBe(LEVEL);
  await page.mouse.move(box.x, box.y);
  await page.mouse.move(box.x + box.width * 0.9, box.y + 4);
  expect(await transform()).toBe(LEVEL);

  // Turned back off, the card waits for the mouse instead of snapping to its old angle.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  // emulateMedia resolves once the page has the new setting, not once the app has reacted: the media
  // query's change event reaches React in the page's next rendering update, which runs after that frame's
  // input events, and only then does the card listen for the mouse again. A move sent sooner is dropped
  // and never repeated, so wait out two frames (the change, then the effect it schedules) before moving.
  await page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
  expect(await transform()).toBe(LEVEL);
  if (!hasTouch) {
    await page.mouse.move(box.x + box.width, box.y + box.height);
    await expect.poll(transform).not.toBe(LEVEL);
  }
  expect(errors).toEqual([]);
});
