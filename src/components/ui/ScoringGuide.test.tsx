// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getLatestSet, getSet } from '../../content/sets';
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

it('is the Card guide, explaining rarity, holo and modifiers and how often a pack has a special card', () => {
  const set = getLatestSet('right-now')!;
  act(() => root.render(<ScoringGuide set={set} onClose={() => {}} />));
  expect(dialogName()).toBe('Card guide');
  const text = document.body.textContent ?? '';
  expect(text).toContain(`Rarity, modifiers and scoring for ${set.name}`);
  expect(text).toMatch(/Rarity is which card you pulled, from Common up to \w+/);
  expect(text).toContain('Holo is a shiny copy that any card can roll');
  expect(text).toContain('Finishes (Silver up to Diamond) and misprints are rarer extras');
  expect(text).toContain('about 63% of packs have at least one');
  // The scoring tables stay.
  expect(text).toContain('Brainrot Score = card points × combo multiplier');
});

it('leaves finishes out for a set without modifiers', () => {
  const set = getSet('right-now', 1)!;
  expect(set.modifiers).toBeUndefined();
  act(() => root.render(<ScoringGuide set={set} onClose={() => {}} />));
  const text = document.body.textContent ?? '';
  expect(text).not.toContain('Finishes (Silver');
  expect(text).toContain('Holo cards are special cards: about 23% of packs have at least one.');
});
