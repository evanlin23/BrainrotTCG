import { readdirSync, readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { xpForLevel, type SetDefinition } from '../../src/engine';
import { getNextMilestone, type NextMilestoneGoal } from '../../src/game/nextMilestone';
import { monitor, scaleText } from './support';

/**
 * Resizing the window with the next goal under the pack (follow-up to #1350). The goal is a size container
 * (pack-milestone) inside the Card guide's row (card-guide), and its text and picture read the row's width through it
 * (PackMilestone.css: the 34rem line). A player drags a window's edge, so each rule must give the
 * answer a fresh load at that width gives, whichever way the window got there: a plain setViewportSize walk, up and
 * down across the 34rem line and with several steps on the same side of it, at normal and doubled text.
 *
 * One test per chip (the picture and cue of a cosmetic, the count and unit of a master set), each walking all its
 * windows with the chip left alone, so that a stale answer cannot be hidden by the chip being redrawn. The fresh
 * loads they compare with are the slow part: the first test to run loads the home once per goal at each window and
 * text size (the chip's words are put in after the load, as pack-milestone.spec.ts does) and keeps what it found, so
 * the other test, when it runs in the same worker, reuses it and makes no loads of its own.
 *
 * Only the 34rem line is walked: the 20rem line hides the chip itself (its nearest container is the row) and the 36rem
 * line moves Change pack, which is not inside the chip, so neither is read through the chip's container. The walk
 * holds the window a while above the line (a far and a near window), then crosses it in a small step and goes on down
 * to a far window and back up: on the old CSS that order kept the wide chip through the crossing at 100% and 200%
 * text (a jump straight from far above to just below did not, so the order is part of the test).
 */

const HEIGHT = 900;
const FIRST_WIDTH = 700;
/** The line, in rem of the row's inner width, that the chip's descendants read from card-guide (PackMilestone.css). */
const LINES = [34];
/** Doubled text is 32px to the rem. */
const TEXT_SIZES = [100, 200];
/** Offsets from the line, in px at normal text (scaled with the text), in the order walked: far then near above it, a small step across it, near then far below, and back up across it to near and far above. */
const OFFSETS = [60, 24, -6, -24, -60, 24, 60];

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

const GOALS = { cosmetic: COSMETIC_GOAL, master: MASTER_GOAL } as const;

/** Puts a goal's words into the chip on the page, as pack-milestone.spec.ts does. */
const show = (page: Page, goal: NextMilestoneGoal) => page.locator('.pack-milestone').evaluate((chip, g) => {
  chip.querySelector('.pack-milestone-target')!.textContent = g.targetName;
  chip.querySelector('.pack-milestone-kind')!.textContent = g.targetKind ? ` ${g.targetKind}` : '';
  chip.querySelector('.pack-milestone-detail')!.textContent = g.detail;
  const progress = chip.querySelector('.pack-milestone-progress')!;
  progress.innerHTML = g.progressUnit ? `${g.progressText}<span class="pack-milestone-unit"> ${g.progressUnit}</span>` : '99%';
  chip.querySelector('.pack-milestone-tag')?.remove();
  if (g.kind === 'cosmetic') {
    const tag = document.createElement('span');
    tag.className = 'pack-milestone-tag';
    tag.setAttribute('aria-hidden', 'true');
    tag.textContent = 'Cosmetic';
    chip.querySelector('.pack-milestone-detail')!.after(tag);
  }
  chip.querySelector('.back-swatch')?.remove();
  if (g.preview) {
    const swatch = document.createElement('span');
    swatch.className = `back-swatch back-${g.preview.id}`;
    swatch.innerHTML = '<img class="card-back-image" alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">';
    chip.prepend(swatch);
  }
}, goal);

/** A returning player's home at a window size; the goal's words are put in once the page has loaded. */
async function load(page: Page, goal: NextMilestoneGoal, width: number, text: number) {
  await page.setViewportSize({ width, height: HEIGHT });
  await page.goto('./');
  // Attached, not visible: a row of 20rem or less shows no goal.
  await expect(page.locator('.pack-milestone')).toBeAttached();
  if (text !== 100) await scaleText(page, text);
  await show(page, goal);
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
  return Object.fromEntries(['.pack-milestone', '.back-swatch', '.pack-milestone-detail', '.pack-milestone-tag', '.pack-milestone-line', '.pack-milestone-progress']
    .map((selector) => [selector, pick(selector)]));
});

type Decided = Awaited<ReturnType<typeof decided>>;
/** What a fresh load gives, by project, text size, width and chip: kept for the other test of the worker. */
const loaded = new Map<string, Decided>();
const key = (project: string, text: number, width: number, chip: string) => `${project}/${text}/${width}/${chip}`;

async function walk(page: Page, baseURL: string, project: string, chip: string, text: number) {
  const inner0 = await rowInner(page);
  const windows = LINES.flatMap((line) => OFFSETS.map((offset) => {
    const inner = line * 16 * (text / 100) + offset * (text / 100);
    return { line, width: Math.round(FIRST_WIDTH + inner - inner0), inner: Math.round(inner) };
  })).filter(({ width }) => width >= 320);

  // What a fresh load gives at each window, found first on a page of its own (watched once), so that the walk below is only plain resizes. One load per goal at each width, for both goals, and kept.
  const missing = [...new Set(windows.map(({ width }) => width))].filter((width) => !loaded.has(key(project, text, width, chip)));
  if (missing.length) {
    const other = await page.context().newPage();
    const errors = await monitor(other, baseURL, 1, { returning: true });
    for (const width of missing) {
      for (const [name, goal] of Object.entries(GOALS)) {
        await load(other, goal, width, text);
        loaded.set(key(project, text, width, name), await decided(other));
      }
    }
    await other.close();
    expect(errors).toEqual([]);
  }

  for (const { line, width, inner } of windows) {
    const at = `${width}px wide (the row's inner width ${inner}px, ${(inner / (16 * text / 100)).toFixed(2)}rem, near the ${line}rem line) at ${text}%`;
    await page.setViewportSize({ width, height: HEIGHT });
    expect(Math.abs((await rowInner(page)) - inner), `${at}: the row is the width planned`).toBeLessThanOrEqual(1);
    await expect.poll(() => decided(page), { message: `${at}: the chip is the one a fresh load gives, wherever the window came from` }).toEqual(loaded.get(key(project, text, width, chip)));
  }
}

for (const [name, chip] of [['picture and cue of a cosmetic goal', 'cosmetic'], ['count and unit of a master-set goal', 'master']] as const) {
  test(`resizing a window with the ${name} up gives the chip a fresh load gives, across the 34rem line, at normal and doubled text`, async ({ page, baseURL }, testInfo) => {
    test.setTimeout(300000);
    const errors = await monitor(page, baseURL!, 1, { returning: true });
    for (const text of TEXT_SIZES) {
      await load(page, GOALS[chip], FIRST_WIDTH, text);
      await walk(page, baseURL!, testInfo.project.name, chip, text);
    }
    expect(errors).toEqual([]);
  });
}
