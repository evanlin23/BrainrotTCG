import { test, expect, type Page } from '@playwright/test';
import { xpForLevel, type SetDefinition } from '../../src/engine';
import { getNextMilestone, type NextMilestoneGoal } from '../../src/game/nextMilestone';
import { expectStill, monitor, scaleText } from './support';

/**
 * The next goal (#212) shares the Card guide's row under the pack, after the announcement it yields to, so it
 * adds no height of its own: it can't change the pack's size or position or the nav's, or cover the pack, its
 * tear line or the toast, and opening the pack stays the biggest thing on screen. It steps aside where the
 * row is too narrow for it and on a phone on its side, and nothing in it moves.
 */

async function open(page: Page, baseURL: string, size: { width: number; height: number }) {
  await page.setViewportSize(size);
  const errors = await monitor(page, baseURL, 1, { returning: true });
  await page.goto('./');
  return errors;
}

/** An announcement, when one is unread, has the row first; the goal waits for it to be dismissed. */
async function clearNews(page: Page) {
  await expect(page.locator('.card-guide-link')).toBeVisible();
  const dismiss = page.getByRole('button', { name: 'Dismiss announcement' });
  if (await dismiss.isVisible()) await dismiss.click();
  // Where the row is too narrow or short for the announcement it is hidden, not dismissed: take it out, so
  // what the goal does there is its own rule and not the announcement's.
  else await page.evaluate(() => document.querySelector('.news-banner')?.remove());
  await expect(page.locator('.news-banner')).toHaveCount(0);
}

const layout = (page: Page) => page.evaluate(() => {
  const box = (selector: string) => {
    const { x, y, width, height } = document.querySelector(selector)!.getBoundingClientRect();
    return { x, y, width, height };
  };
  return { pack: box('.pack-display'), header: box('.app-header'), nav: box('.app-nav'), row: box('.card-guide-entry') };
});

/** The pack falls in on load: wait until it stops moving before measuring anything. */
const settled = (page: Page) => expectStill(page.locator('.pack-display'), 'the pack has settled');

/** Every cosmetic goal a player can be shown, worked out by the real rules (a set with no cards has no set goal to get in the way). */
const COSMETIC_GOALS = Array.from({ length: 31 }, (_, i) => getNextMilestone(
  { xp: xpForLevel(i + 1), uniqueBySet: {}, holoUniqueBySet: {} },
  { cards: [] } as unknown as SetDefinition,
)).filter((goal, i, all) => goal.kind === 'cosmetic' && all.findIndex((g) => g.targetName === goal.targetName) === i);

/** Puts a goal's words into the chip on the page (and its card-back picture, if it has one), at its worst case of "99%". */
const show = (page: Page, goal: NextMilestoneGoal) => page.locator('.pack-milestone').evaluate((chip, g) => {
  chip.querySelector('.pack-milestone-target')!.textContent = g.targetName;
  chip.querySelector('.pack-milestone-kind')!.textContent = ` ${g.targetKind}`;
  chip.querySelector('.pack-milestone-detail')!.textContent = g.detail;
  chip.querySelector('.pack-milestone-progress')!.textContent = '99%';
  chip.querySelector('.back-swatch')?.remove();
  if (g.preview) {
    const swatch = document.createElement('span');
    swatch.className = `back-swatch back-${g.preview.id}`;
    swatch.innerHTML = '<img class="card-back-image" alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">';
    chip.prepend(swatch);
  }
}, goal);

/** Whether the chip shows its whole name and the whole "Cosmetic, odds unchanged" cue, and stays the row's height. */
const fits = (page: Page) => page.locator('.pack-milestone').evaluate((chip) => {
  const within = (inner: Range | Element, outer: Element) => inner.getBoundingClientRect().right <= outer.getBoundingClientRect().right + 0.5;
  const text = chip.querySelector('.pack-milestone-text')!;
  const detail = chip.querySelector('.pack-milestone-detail')!;
  const cue = document.createRange();
  cue.setStart(detail.firstChild!, 0);
  cue.setEnd(detail.firstChild!, 'Cosmetic, odds unchanged'.length);
  const progress = chip.querySelector('.pack-milestone-progress')!;
  return {
    name: within(chip.querySelector('.pack-milestone-target')!, text),
    cue: within(cue, detail),
    progress: within(progress, chip) && progress.getBoundingClientRect().left >= text.getBoundingClientRect().right - 0.5,
    height: chip.getBoundingClientRect().height,
    row: chip.parentElement!.getBoundingClientRect().height,
    // The pictures injected by show() included: the Prismatic back loops elsewhere (#1164 is held), never here.
    animations: chip.getAnimations({ subtree: true }).length,
    // A card-back picture keeps the card's proportions whatever stylesheets have loaded since.
    picture: (() => {
      const swatch = chip.querySelector('.back-swatch');
      if (!swatch) return null;
      const { width, height } = swatch.getBoundingClientRect();
      return { height, ratio: Math.round((width / height) * 1000) / 1000 };
    })(),
  };
});

/** Whether the chip holds its text at an enlarged text size: nothing clipped, nothing under the progress bar, the row kept. */
const holdsText = (page: Page) => page.locator('.pack-milestone').evaluate((chip) => {
  const bottom = chip.getBoundingClientRect().bottom;
  const texts = Array.from(chip.querySelectorAll('.pack-milestone-text, .pack-milestone-progress, .pack-milestone-detail'))
    .filter((el) => getComputedStyle(el).display !== 'none');
  const text = chip.querySelector('.pack-milestone-text')!;
  return {
    clipped: chip.scrollHeight > chip.clientHeight,
    // The bar is 3px along the bottom edge: every line ends above it.
    clear: Math.min(...texts.map((el) => bottom - el.getBoundingClientRect().bottom)) >= 3,
    name: chip.querySelector('.pack-milestone-target')!.getBoundingClientRect().right <= text.getBoundingClientRect().right + 0.5,
    height: chip.getBoundingClientRect().height,
    row: chip.parentElement!.getBoundingClientRect().height,
    lines: texts.length,
  };
});

/** What the chip says on screen about its own goal, by the kind of goal it is. */
const expectedCue = /^(Cosmetic, odds unchanged · Lv \d+|\d+\/\d+ (cards|as holos), \d+ to go|Every reward is unlocked)$/;

for (const [width, height, percent] of [[390, 844, 100], [360, 640, 100], [320, 568, 100], [320, 568, 200]] as const) {
  test(`sits in the guide's row without moving anything on a ${width} x ${height} phone at ${percent}% text`, async ({ page, baseURL }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-chromium', 'A phone layout check; one emulated phone is enough.');
    const errors = await open(page, baseURL!, { width, height });
    if (percent !== 100) await scaleText(page, percent);
    await settled(page);
    const withNews = await layout(page);
    await clearNews(page);
    await settled(page);
    // Dismissing the news (or none being unread) moved nothing, with the goal in its place or not.
    expect(await layout(page)).toEqual(withNews);

    const goal = page.locator('.card-guide-entry .pack-milestone');
    if (width === 320) {
      // No room beside the guide link: it shows nothing rather than squeeze it.
      await expect(goal).toBeHidden();
    } else {
      await expect(goal).toBeVisible();
      const [box, guide, row, pack] = [(await goal.boundingBox())!, (await page.locator('.card-guide-link').boundingBox())!, withNews.row, withNews.pack];
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeLessThanOrEqual(row.height + 0.5);
      // Inside the row, level with the guide link, clear of it, of the pack and of the screen's edges.
      expect(box.x).toBeGreaterThanOrEqual(guide.x + guide.width - 0.5);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      expect(box.y).toBeGreaterThanOrEqual(pack.y + pack.height - 0.5);
      // No second row, and no animation of its own to run.
      expect(await goal.evaluate((el) => el.getAnimations({ subtree: true }).length)).toBe(0);
      // Beyond the aria-label, the chip says on screen what the goal is (it does not wait for a wide row): a
      // cosmetic that it changes no odds, a set goal how many cards are to go.
      const shown = await page.locator('.pack-milestone-detail').innerText();
      expect(shown).toMatch(expectedCue);
      if (shown.startsWith('Cosmetic')) expect(shown).toContain('odds unchanged');
      // Every reward there is, at its worst case, shows its whole name and the whole cue in the row's height.
      expect(COSMETIC_GOALS.length).toBeGreaterThan(10);
      for (const reward of COSMETIC_GOALS) {
        await show(page, reward);
        const { picture, ...rest } = await fits(page);
        expect(rest, `${reward.targetName} (${reward.targetKind}) at ${width}px`).toEqual({
          name: true, cue: true, progress: true, height: 44, row: row.height, animations: 0,
        });
        expect(picture === null, `${reward.targetName} has a picture only if it is a card back`).toBe(!reward.preview);
        if (picture) expect(picture, `${reward.targetName} picture`).toEqual({ height: 28, ratio: 0.671 });
      }
      // The Prismatic back loops its colours wherever it is shown (that loop is held, #1164): never inside the chip.
      // No goal ever names it (a title shares its level), so it is put in by hand, as the pictures above are.
      await show(page, { ...COSMETIC_GOALS.find((reward) => reward.preview)!, targetName: 'Prismatic', preview: { kind: 'card-back', id: 'prism' } });
      expect((await fits(page)).animations, 'the Prismatic back is still in the chip').toBe(0);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    expect(errors).toEqual([]);
  });
}

for (const [width, height] of [[390, 844], [360, 640]] as const) {
  test(`keeps a card back's proportions on a ${width} x ${height} phone once the Profile styles have loaded`, async ({ page, baseURL }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-chromium', 'A phone layout check; one emulated phone is enough.');
    const errors = await open(page, baseURL!, { width, height });
    await clearNews(page);
    // Profile.css gives every card-back swatch a width of its own: visit the Profile (as the goal's link does), then come back.
    await page.locator('.app-nav-item:visible').filter({ hasText: /^Profile$/ }).first().click();
    await expect(page).toHaveURL(/profile/);
    await expect(page.locator('.back-swatch').first()).toBeAttached();
    await page.locator('.app-nav-item:visible').filter({ hasText: /^Open$/ }).first().click();
    await settled(page);
    const goal = page.locator('.card-guide-entry .pack-milestone');
    await expect(goal).toBeVisible();
    const row = (await layout(page)).row;
    const backs = COSMETIC_GOALS.filter((reward) => reward.preview);
    expect(backs.length).toBeGreaterThan(3);
    for (const reward of backs) {
      await show(page, reward);
      const { picture, ...rest } = await fits(page);
      expect(picture, `${reward.targetName}: the picture is 28px high at the card's proportions`).toEqual({ height: 28, ratio: 0.671 });
      expect(rest, `${reward.targetName} at ${width}px after the Profile styles`).toEqual({
        name: true, cue: true, progress: true, height: 44, row: row.height, animations: 0,
      });
    }
    expect(errors).toEqual([]);
  });
}

// The chip is a fixed 44px but its text is not: at enlarged text on a roomy screen (the row is still wide enough to show it)
// the second line gives way, and nothing is clipped or left under the progress bar.
for (const [width, height, percent] of [[768, 1024, 125], [768, 1024, 150], [768, 1024, 200], [1280, 800, 150], [1280, 800, 200]] as const) {
  test(`holds its text in 44px on a ${width} x ${height} screen at ${percent}% text`, async ({ page, baseURL }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'A desktop layout check; the window is set here.');
    const errors = await open(page, baseURL!, { width, height });
    await scaleText(page, percent);
    await settled(page);
    const withNews = await layout(page);
    await clearNews(page);
    await settled(page);
    // The row, the pack and the nav are where they were with the announcement in the row.
    expect(await layout(page)).toEqual(withNews);
    const goal = page.locator('.card-guide-entry .pack-milestone');
    await expect(goal).toBeVisible();
    for (const reward of COSMETIC_GOALS) {
      await show(page, reward);
      const held = await holdsText(page);
      expect(held, `${reward.targetName} (${reward.targetKind}) at ${percent}% text`).toMatchObject({ clipped: false, clear: true, name: true, height: 44, row: withNews.row.height });
      // One line, or two while they fit: past a point the cue is dropped, never cut.
      expect([1, 2].includes(held.lines - 1)).toBe(true);
    }
    expect(errors).toEqual([]);
  });
}

test('steps aside on a phone on its side, where the pack has no room to spare', async ({ page, baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-chromium', 'A phone layout check; one emulated phone is enough.');
  const errors = await open(page, baseURL!, { width: 740, height: 360 });
  await expect(page.locator('.app-logo')).toBeVisible();
  await clearNews(page);
  await expect(page.locator('.card-guide-entry .pack-milestone')).toBeHidden();
  expect(errors).toEqual([]);
});

test('on a desktop window it names the goal and goes to the rewards, and the pack stays where it was', async ({ page, baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'A desktop layout check.');
  const errors = await open(page, baseURL!, { width: 1280, height: 800 });
  await settled(page);
  const before = await layout(page);
  await clearNews(page);
  const goal = page.locator('.card-guide-entry .pack-milestone');
  await expect(goal).toBeVisible();
  expect(await layout(page)).toEqual(before);
  await expect(goal).toContainText('odds unchanged');
  await goal.click();
  await expect(page).toHaveURL(/profile/);
  expect(errors).toEqual([]);
});
