import { readdirSync, readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { xpForLevel, type SetDefinition } from '../../src/engine';
import { getNextMilestone, type NextMilestoneGoal } from '../../src/game/nextMilestone';
import { expectStill, monitor, scaleText } from './support';

/**
 * Resizing the window with the next goal under the pack (follow-up to #1350). The goal is a size container
 * (pack-milestone) inside the Card guide's row (card-guide), and its text and picture read the row's width through it
 * (PackMilestone.css: the 20rem, 34rem and 36rem lines). A player drags a window's edge, so each rule must give the
 * answer a fresh load at that width gives, whichever way the window got there: a plain setViewportSize walk, up and
 * down across each line and with several steps on the same side of it, at normal and doubled text.
 *
 * One test per chip (the picture and cue of a cosmetic, the count and unit of a master set), each walking all its
 * windows with the chip left alone, so that a stale answer cannot be hidden by the chip being redrawn.
 */

const HEIGHT = 900;
const FIRST_WIDTH = 700;
/** The lines, in rem of the row's inner width, that PackMilestone.css reads from card-guide. */
const LINES = [20, 34, 36];
/** Doubled text is 32px to the rem. */
const TEXT_SIZES = [100, 200];
/** Offsets from a line, in px at normal text (scaled with the text), in the order walked: down then up across it, and back, several steps to a side. */
const OFFSETS = [60, 24, 6, -6, -24, -60, -24, 6, 24, 60, 24, -6, -24];

const COSMETIC_GOAL = Array.from({ length: 31 }, (_, i) => getNextMilestone(
  { xp: xpForLevel(i + 1), uniqueBySet: {}, holoUniqueBySet: {} },
  { cards: [] } as unknown as SetDefinition,
)).find((goal) => goal.kind === 'cosmetic' && goal.preview)!;

/** The master-set goal (#898) of the real set with the most cards, one holo short of mastered, by the real rules. */
const MASTER_GOAL = (() => {
  const sets = readdirSync(new URL('../../src/content/sets/', import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => JSON.parse(readFileSync(new URL(`../../src/content/sets/${entry.name}/set.json`, import.meta.url), 'utf8')) as { id: string; cards: unknown[] });
  const set = sets.reduce((a, b) => (b.cards.length > a.cards.length ? b : a));
  const n = set.cards.length;
  return getNextMilestone({ xp: 0, uniqueBySet: { [set.id]: n }, holoUniqueBySet: { [set.id]: n - 1 } }, set as unknown as SetDefinition);
})();

/** Puts a goal's words into the chip on the page, as pack-milestone.spec.ts does. */
const show = (page: Page, goal: NextMilestoneGoal) => page.locator('.pack-milestone').evaluate((chip, g) => {
  chip.querySelector('.pack-milestone-target')!.textContent = g.targetName;
  chip.querySelector('.pack-milestone-kind')!.textContent = g.targetKind ? ` ${g.targetKind}` : '';
  chip.querySelector('.pack-milestone-detail')!.textContent = g.detail;
  const progress = chip.querySelector('.pack-milestone-progress')!;
  progress.innerHTML = g.progressUnit ? `${g.progressText}<span class="pack-milestone-unit"> ${g.progressUnit}</span>` : '99%';
  chip.querySelector('.back-swatch')?.remove();
  if (g.preview) {
    const swatch = document.createElement('span');
    swatch.className = `back-swatch back-${g.preview.id}`;
    swatch.innerHTML = '<img class="card-back-image" alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">';
    chip.prepend(swatch);
  }
}, goal);

/** A returning player's home at a window size, with the goal's words put in. */
async function load(page: Page, baseURL: string, goal: NextMilestoneGoal, width: number, text: number) {
  await page.setViewportSize({ width, height: HEIGHT });
  const errors = await monitor(page, baseURL, 1, { returning: true });
  await page.goto('./');
  await expectStill(page.locator('.pack-display'), 'the pack has settled');
  if (text !== 100) await scaleText(page, text);
  await show(page, goal);
  return errors;
}

/** The row's inner width (what the card-guide queries compare), in px. */
const rowInner = (page: Page) => page.locator('.card-guide-entry').evaluate((row) => {
  const style = getComputedStyle(row);
  return row.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
});

/** What the query-driven rules decide for the chip and what is inside it, and the room each takes. */
const decided = (page: Page) => page.locator('.card-guide-entry').evaluate((row) => {
  const pick = (selector: string) => {
    const el = row.querySelector(selector);
    if (!el) return null;
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    return {
      display: style.display, flexDirection: style.flexDirection, alignItems: style.alignItems, rowGap: style.rowGap,
      marginLeft: style.marginLeft, paddingLeft: style.paddingLeft, paddingRight: style.paddingRight,
      width: Math.round(box.width), height: Math.round(box.height),
    };
  };
  return Object.fromEntries(['.pack-milestone', '.back-swatch', '.pack-milestone-detail', '.pack-milestone-line', '.pack-milestone-progress']
    .map((selector) => [selector, pick(selector)]));
});

async function walk(page: Page, baseURL: string, goal: NextMilestoneGoal, text: number) {
  const inner0 = await rowInner(page);
  const windows = LINES.flatMap((line) => OFFSETS.map((offset) => {
    const inner = line * 16 * (text / 100) + offset * (text / 100);
    return { line, width: Math.round(FIRST_WIDTH + inner - inner0), inner: Math.round(inner) };
  })).filter(({ width }) => width >= 320);

  // What a fresh load gives at each width, found first on a page of its own, so that the walk below is only plain resizes.
  const loaded = new Map<number, Awaited<ReturnType<typeof decided>>>();
  const other = await page.context().newPage();
  for (const { width } of windows) {
    if (loaded.has(width)) continue;
    const errors = await load(other, baseURL, goal, width, text);
    loaded.set(width, await decided(other));
    expect(errors).toEqual([]);
  }
  await other.close();

  for (const { line, width, inner } of windows) {
    const at = `${width}px wide (the row's inner width ${inner}px, ${(inner / (16 * text / 100)).toFixed(2)}rem, near the ${line}rem line) at ${text}%`;
    await page.setViewportSize({ width, height: HEIGHT });
    await expectStill(page.locator('.pack-display'), 'the pack has settled');
    expect(Math.abs((await rowInner(page)) - inner), `${at}: the row is the width planned`).toBeLessThanOrEqual(1);
    await expect.poll(() => decided(page), { message: `${at}: the chip is the one a fresh load gives, wherever the window came from` }).toEqual(loaded.get(width));
  }
}

for (const [name, goal] of [['picture and cue of a cosmetic goal', COSMETIC_GOAL], ['count and unit of a master-set goal', MASTER_GOAL]] as const) {
  test(`resizing a window with the ${name} up gives the chip a fresh load gives, across the 20rem, 34rem and 36rem lines, at normal and doubled text`, async ({ page, baseURL }) => {
    test.setTimeout(600000);
    for (const text of TEXT_SIZES) {
      const errors = await load(page, baseURL!, goal, FIRST_WIDTH, text);
      await walk(page, baseURL!, goal, text);
      expect(errors).toEqual([]);
    }
  });
}
