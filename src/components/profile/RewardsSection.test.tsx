// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CARD_BACKS, PACK_FOILS } from '../../game/progression';
import { DEFAULT_SETTINGS } from '../../utils/settings';
import type { Settings } from '../../types';
import RewardsSection from './RewardsSection';

let root: Root;
let container: HTMLElement;
let onSettingsChange: ReturnType<typeof vi.fn<(settings: Settings) => void>>;
const render = (level: number | null, openRequest?: number) =>
  act(() => root.render(<RewardsSection level={level} settings={DEFAULT_SETTINGS} onSettingsChange={onSettingsChange} openRequest={openRequest} />));
const details = () => document.querySelector<HTMLDetailsElement>('#rewards details')!;
const summary = () => document.querySelector('#rewards summary')!.textContent;
const TOTAL = CARD_BACKS.length + PACK_FOILS.length;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  onSettingsChange = vi.fn<(settings: Settings) => void>();
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('the card back and foil section', () => {
  it('is titled once and folded away, with a summary that counts what is unlocked', () => {
    render(1);
    expect(document.querySelector('#rewards h2')!.textContent).toBe('Card back and foil');
    expect(details().open).toBe(false);
    const unlocked = [...CARD_BACKS, ...PACK_FOILS].filter((r) => r.level <= 1).length;
    expect(summary()).toBe(`${unlocked} of ${TOTAL} unlocked`);
  });

  it('says every reward is unlocked once the level covers them all', () => {
    const top = Math.max(...[...CARD_BACKS, ...PACK_FOILS].map((r) => r.level));
    render(top);
    expect(summary()).toBe('Every reward unlocked');
    render(top - 1);
    expect(summary()).toMatch(new RegExp(`^\\d+ of ${TOTAL} unlocked$`));
  });

  it('opens when asked for, and again for a later request after being closed', () => {
    render(1, 1);
    expect(details().open).toBe(true);
    act(() => {
      details().open = false;
      details().dispatchEvent(new Event('toggle'));
    });
    expect(details().open).toBe(false);
    render(1, 2);
    expect(details().open).toBe(true);
  });

  it('keeps locked rewards disabled and the arrow keys moving between unlocked ones', () => {
    render(4, 1);
    const backs = document.querySelector<HTMLElement>('[role="radiogroup"][aria-label="Card back"]')!;
    const locked = backs.querySelector<HTMLButtonElement>('[data-reward="gold"]')!;
    expect(locked.disabled).toBe(true);
    expect(locked.getAttribute('aria-label')).toBe('Gold, unlocks at level 10');
    act(() => backs.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    expect(onSettingsChange).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, cardBack: 'midnight' });
  });

  it('names the next reward, and every reward that shares its level (#212)', () => {
    const next = () => document.querySelector('.rewards-next')!.textContent;
    render(3, 1);
    expect(next()).toBe('Next: Midnight (card back) at level 4');
    // Level 12 holds a pack foil and a title; level 20 a card back and a title. The choosable cosmetic is named first.
    render(11, 1);
    expect(next()).toBe('Next: Gold foil (pack foil) and Meme Historian (title) at level 12');
    render(19, 1);
    expect(next()).toBe('Next: Prismatic (card back) and Aura Farmer (title) at level 20');
    render(30, 1);
    expect(next()).toBe('Every reward unlocked.');
  });

  it('shows a loading note instead of the rewards while the level is unknown', () => {
    render(null);
    expect(document.querySelector('#rewards details')).toBeNull();
    expect(document.body.textContent).toContain("Reading your saved packs… Your card backs and foils will show once they're in.");
    render(1);
    expect(document.querySelector('.rewards')).not.toBeNull();
  });
});
