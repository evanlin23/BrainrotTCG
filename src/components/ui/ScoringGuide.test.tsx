// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getLatestSet, getSet } from '../../content/sets';
import { FINISH_MULTIPLIER, HOLO_MULTIPLIER, MISPRINT_MULTIPLIER, MODIFIERS_V1, ODDS_TOTAL, POKER_HANDS, RARITY_POINTS, getPokerHand, handFromCounts } from '../../engine';
import { formatOneIn } from '../../game/cardStats';
import ScoringGuide from './ScoringGuide';

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
  expect(text).toContain('Add up the points of your five cards, then multiply by your combo. A higher score is better.');
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
    `No Matches: A B C D E (no card repeats), ×${POKER_HANDS.NO_MATCH.multiplier}`,
    `Pair: A A B C D (2 copies of A), ×${POKER_HANDS.PAIR.multiplier}`,
    `Full House: A A A B B (3 copies of A and 2 copies of B), ×${POKER_HANDS.FULL_HOUSE.multiplier}`,
  ]);
});

it('says holo, not Gold, for the plain-copy match in a set without finishes (#645)', () => {
  const set = getSet('right-now', 1)!;
  act(() => root.render(<ScoringGuide set={set} onClose={() => {}} />));
  const text = document.body.textContent ?? '';
  expect(text).toContain('a plain and a holo copy of the same card still match');
  expect(text).not.toContain('a plain and a Gold copy');
});

it('the engine treats a plain and a Gold copy as one card and two same-rarity cards as different (#645)', () => {
  expect(handFromCounts([1, 1, 1, 1, 1])).toBe('NO_MATCH');
  expect(handFromCounts([2, 1, 1, 1])).toBe('PAIR');
  expect(handFromCounts([3, 2])).toBe('FULL_HOUSE');
  const gold = { cardId: 'a', rarity: 'COMMON' as const, isHolo: false, finish: 'GOLD' as const };
  const plain = { cardId: 'a', rarity: 'COMMON' as const, isHolo: false };
  const other = { cardId: 'b', rarity: 'COMMON' as const, isHolo: false };
  expect(getPokerHand([gold, plain, other, other, other]).name).toBe('Full House');
  expect(getPokerHand([plain, other]).name).toBe('No Matches');
});
