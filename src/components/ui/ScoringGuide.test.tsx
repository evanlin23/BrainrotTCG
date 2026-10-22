// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getLatestSet, getSet } from '../../content/sets';
import { FINISH_MULTIPLIER, HOLO_MULTIPLIER, MISPRINT_MULTIPLIER, MODIFIERS_V1, ODDS_TOTAL, POKER_HANDS, RARITY_POINTS, type SetDefinition } from '../../engine';
import { formatOneIn } from '../../game/cardStats';
import ScoringGuide from './ScoringGuide';

// The guide compares the set it shows with the openable sets in the registry; a test can swap that list for fixtures.
const { registry } = vi.hoisted(() => ({ registry: { sets: null as unknown[] | null } }));
vi.mock('../../content/sets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../content/sets')>();
  return { ...actual, get SETS() { return registry.sets ?? actual.SETS; } };
});

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // jsdom has no ResizeObserver; the Sheet only uses it to track overflow.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});

afterEach(() => {
  registry.sets = null;
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const dialogName = () => {
  const dialog = document.querySelector('[role="dialog"]')!;
  return document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent;
};

it('is the Card guide, explaining rarity, holo and modifiers, and how a misprint stacks on a finish', () => {
  const set = getLatestSet('right-now')!;
  act(() => root.render(<ScoringGuide set={set} onClose={() => {}} />));
  expect(dialogName()).toBe('Card guide');
  const text = document.body.textContent ?? '';
  expect(text).toContain(`Rarity, modifiers and scoring for ${set.name}`);
  expect(text).toMatch(/Rarity is which card you pulled, from Common up to \w+/);
  expect(text).toContain('Holo is a shiny copy that any card can roll');
  expect(text).toContain('Finishes (Silver up to Diamond) and misprints are rarer extras. A card gets one finish at most, and a misprint can land on top of it.');
  // A card rolls one finish at most (the engine walks one roll through the finish odds), so finishes never stack with each other.
  expect(text).not.toContain('with each other');
  // The misprint is a separate roll, so it stacks on any finish: the guide works one through from the engine's multipliers.
  const stacked = FINISH_MULTIPLIER.GOLD * MISPRINT_MULTIPLIER;
  expect(text).toContain(`Misprint stacks on any finish: Gold Misprint = ×${FINISH_MULTIPLIER.GOLD.toLocaleString()} × ${MISPRINT_MULTIPLIER.toLocaleString()} = ×${stacked.toLocaleString()}.`);
  expect(text).toContain('Each card rolls its rarity, holo, finish and misprint separately, so any card can get any mix. Its points multiply: rarity points × holo × finish × misprint.');
  expect(text).not.toContain('has no finishes or misprints');
  // The special-card chance and the "rarer always pays more" line are gone.
  expect(text).not.toContain('special cards');
  expect(text).not.toContain('of packs have at least one');
  expect(text).not.toContain('Rarer always pays more');
  expect(text).not.toContain('Odds below are exact');
  expect(text).toContain('Combos');
  expect(text).not.toContain('same card more than once');
  // The scoring tables stay.
  expect(text).toContain('Brainrot Score = card points added up × combo multiplier');
  // It says how to read the score, and offers no chance of reaching one (#778).
  expect(text).toContain(`Add up the points of your ${set.packSize} cards, then multiply by your combo. A higher score is better.`);
  expect(text).not.toMatch(/packs score this high|Most packs/);
});

it('leaves finishes out for a set without modifiers', () => {
  const set = getSet('right-now', 1)!;
  expect(set.modifiers).toBeUndefined();
  act(() => root.render(<ScoringGuide set={set} onClose={() => {}} />));
  const text = document.body.textContent ?? '';
  expect(text).not.toContain('Finishes (Silver');
  expect(text).toContain(`${set.name} has no finishes or misprints: only rarity and holo.`);
  expect(text).toContain('Each card rolls its rarity and holo separately');
  expect(text).not.toContain('special cards');
  // No finishes, so no misprint stacking note either.
  expect(text).not.toContain('Misprint stacks');
  // The worked example drops the finish: a holo card, from the set's own holo odds.
  expect(text).toContain('Example: a holo card');
  expect(text).toContain(`About 1 in ${formatOneIn(ODDS_TOTAL / set.holoOdds)} cards is Holo (${set.holoOdds / 100}%), at any rarity.`);
  expect(text).toContain(`Common ${RARITY_POINTS.COMMON} × holo ${HOLO_MULTIPLIER} = ${(RARITY_POINTS.COMMON * HOLO_MULTIPLIER).toLocaleString()} points`);
});

it('works a holo Gold card through from the engine odds, keeping the modifier odds apart from the rarity odds', () => {
  const set = getLatestSet('right-now')!;
  act(() => root.render(<ScoringGuide set={set} onClose={() => {}} />));
  const text = document.body.textContent ?? '';
  const gold = MODIFIERS_V1.finishOdds.GOLD;
  const bothOneIn = formatOneIn(1 / ((set.holoOdds / ODDS_TOTAL) * (gold / ODDS_TOTAL)));
  expect(text).toContain('Example: a holo Gold card');
  expect(text).toContain(`About 1 in ${bothOneIn} cards is both Holo (${set.holoOdds / 100}%) and Gold (${gold / 100}%), at any rarity.`);
  expect(text).not.toContain('Rarity is a roll of its own');
  const points = RARITY_POINTS.COMMON * HOLO_MULTIPLIER * FINISH_MULTIPLIER.GOLD;
  expect(text).toContain(`Common ${RARITY_POINTS.COMMON} × holo ${HOLO_MULTIPLIER} × Gold ${FINISH_MULTIPLIER.GOLD} = ${points.toLocaleString()} points`);
});

it('makes no claim about finishes for a modifier table it does not know', () => {
  const set = { ...getLatestSet('right-now')!, modifiers: 2 as unknown as 1 };
  act(() => root.render(<ScoringGuide set={set} onClose={() => {}} />));
  const text = document.body.textContent ?? '';
  expect(text).toContain('Holo is a shiny copy that any card can roll');
  expect(text).not.toContain('Finishes (');
  expect(text).not.toContain('Misprint stacks');
  // Not a set without modifiers either: no claim about which it has.
  expect(text).not.toContain('has no finishes or misprints');
});

it('defines what matches in a combo and shows No Matches, Pair and Full House from the engine rules (#645)', () => {
  const set = getLatestSet('right-now')!;
  act(() => root.render(<ScoringGuide set={set} onClose={() => {}} />));
  const text = document.body.textContent ?? '';
  expect(text).toContain('A combo counts copies of the same card in your pack.');
  expect(text).toContain("Rarity, holo, finish and misprint don't make a card different: a plain and a Gold copy of the same card still match, but two different cards of the same rarity don't.");
  const items = [...document.querySelectorAll('[aria-label="Combo examples"] li')].map((li) => li.textContent);
  expect(items).toEqual([
    `No Matches: A B C D E (no card repeats), combo ×${POKER_HANDS.NO_MATCH.multiplier}`,
    `Pair: A A B C D (2 copies of A), combo ×${POKER_HANDS.PAIR.multiplier}`,
    `Full House: A A A B B (3 copies of A and 2 copies of B), combo ×${POKER_HANDS.FULL_HOUSE.multiplier}`,
  ]);
});

it('says holo, not Gold, for the plain-copy match in a set without finishes (#645)', () => {
  const set = getSet('right-now', 1)!;
  act(() => root.render(<ScoringGuide set={set} onClose={() => {}} />));
  const text = document.body.textContent ?? '';
  expect(text).toContain("Rarity and holo don't make a card different: a plain and a holo copy of the same card still match");
  expect(text).not.toContain('finish and misprint don');
  expect(text).not.toContain('a plain and a Gold copy');
});

it("states the pack size, and that a pack holds one set's cards, from the set data (#804)", () => {
  const set = getLatestSet('right-now')!;
  act(() => root.render(<ScoringGuide set={set} onClose={() => {}} />));
  const text = document.body.textContent ?? '';
  expect(text).toContain(`Every pack holds ${set.packSize} cards, all from ${set.name}: a pack never mixes sets`);
  // The combo table says what its chance is per.
  expect(text).toContain(`Combo chances are for one ${set.packSize}-card pack.`);
  // A different pack size shows up in both places.
  act(() => root.render(<ScoringGuide set={{ ...set, packSize: 7 }} onClose={() => {}} />));
  const other = document.body.textContent ?? '';
  expect(other).toContain('Every pack holds 7 cards');
  expect(other).toContain('Combo chances are for one 7-card pack.');
});

it('says the odds hold for every set only while every openable set rolls packs the same way (#804)', () => {
  const base = getLatestSet('right-now')!;
  const text = () => document.body.textContent ?? '';
  const render = (set: SetDefinition) => act(() => root.render(<ScoringGuide set={set} onClose={() => {}} />));
  const SHARED = 'Every set you can open uses these same odds, pack size and scoring, so the tables below hold for all of them.';
  const SCOPED = `Odds or pack size differ between sets; these tables are for ${base.name}.`;
  // A copy of the shown set with its keys in another order: only the values count.
  const reordered: SetDefinition = { ...base, odds: Object.fromEntries(Object.entries(base.odds).reverse()) as SetDefinition['odds'] };
  const withoutACard = (rarity: string): SetDefinition => {
    const i = base.cards.findIndex((c) => c.rarity === rarity);
    return { ...base, cards: base.cards.filter((_, j) => j !== i) };
  };

  registry.sets = [base, reordered];
  render(base);
  expect(text()).toContain(SHARED);
  expect(text()).not.toContain(SCOPED);

  // A different holo chance, pack size or modifier table is not the same.
  for (const other of [{ ...base, holoOdds: base.holoOdds + 100 }, { ...base, packSize: base.packSize + 1 }, { ...base, modifiers: undefined }]) {
    registry.sets = [base, other];
    render(base);
    expect(text()).not.toContain('Every set you can open uses these same odds');
    expect(text()).toContain(SCOPED);
  }

  // Same odds, pack size and modifiers but fewer cards of a rarity: handOdds splits that rarity's chance across its cards, so the combo table differs.
  registry.sets = [base, withoutACard('COMMON')];
  render(base);
  expect(text()).not.toContain('Every set you can open uses these same odds');
  expect(text()).toContain(SCOPED);

  // The same goes when the shown set is the one with the different card count.
  registry.sets = [base];
  render(withoutACard('COMMON'));
  expect(text()).not.toContain('Every set you can open uses these same odds');

  // Sets that aren't openable (drafts, archived) don't count against the claim.
  registry.sets = [base, { ...withoutACard('COMMON'), draft: true }, { ...withoutACard('COMMON'), archivedAt: '2020-01-01' }];
  render(base);
  expect(text()).toContain(SHARED);
});

it('explains set versions with the version being shown, and flags an older one (#804)', () => {
  const latest = getLatestSet('right-now')!;
  act(() => root.render(<ScoringGuide set={latest} onClose={() => {}} />));
  let text = document.body.textContent ?? '';
  expect(text).toContain(`${latest.name} is on version ${latest.version}. A set gets a new version when its cards, rarities, odds or pack size change.`);
  expect(text).toContain('A pack stays on the version it was opened in, so older packs and shared links still check out exactly as they did.');
  expect(text).not.toContain('This guide shows the older version');

  const old = getSet('right-now', 1)!;
  expect(old.version).toBeLessThan(latest.version);
  act(() => root.render(<ScoringGuide set={old} onClose={() => {}} />));
  text = document.body.textContent ?? '';
  expect(text).toContain(`${old.name} is on version 1.`);
  expect(text).toContain(`This guide shows the older version 1; the current one is version ${latest.version}.`);
  // An older version is no claim about today's other sets.
  expect(text).not.toContain('Every set you can open uses these same odds');
});
