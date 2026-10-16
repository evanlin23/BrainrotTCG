// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_CARDS } from '../../data/cards';
import CardRevealUI from './CardRevealUI';
import type { CardWithMeta } from '../cards/Card';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let reduce = false;
const listeners = new Set<() => void>();

beforeEach(() => {
  reduce = false;
  listeners.clear();
  // A desktop with a mouse, so the tilt hint shows unless motion is reduced.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(prefers-reduced-motion: reduce)' ? reduce : query !== '(pointer: coarse)',
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  }));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const common = ALL_CARDS.find((c) => c.rarity === 'COMMON')!;
const legendary = ALL_CARDS.find((c) => c.rarity === 'LEGENDARY')!;
const meta = (overrides: Partial<CardWithMeta> = {}): CardWithMeta => ({ ...common, uniqueId: 1, isRevealed: false, isHolo: false, ...overrides });
const render = (currentCard: CardWithMeta, currentIndex = 0, extra: { revealLocked?: boolean; celebrating?: boolean } = {}) => act(() => root.render(
  <CardRevealUI currentCard={currentCard} currentIndex={currentIndex} totalCards={5} hasMovedMouse={false}
    onInteraction={() => {}} onSkip={() => {}} {...extra} />,
));
const live = () => host.querySelector<HTMLElement>('[aria-live]')!;
const cardButton = () => {
  const cards = host.querySelectorAll<HTMLElement>('.reveal-card');
  return cards[cards.length - 1];
};

describe('the reveal for screen readers', () => {
  it('announces each card once, as it turns face up, and nothing before', () => {
    render(meta());
    expect(host.querySelectorAll('[aria-live]')).toHaveLength(1);
    expect(live().getAttribute('aria-live')).toBe('polite');
    expect(live().getAttribute('aria-atomic')).toBe('true');
    expect(live().textContent).toBe('');

    render(meta({ isRevealed: true, isNew: true }));
    expect(live().textContent).toBe(`Card 1 of 5: ${common.name}, Common, new`);

    render(meta({ ...legendary, uniqueId: 2, isHolo: true, finish: 'GOLD' }), 1);
    expect(live().textContent).toBe('');
    render(meta({ ...legendary, uniqueId: 2, isHolo: true, finish: 'GOLD', isRevealed: true }), 1);
    expect(live().textContent).toBe(`Card 2 of 5: ${legendary.name}, Holo Legendary, Gold`);
  });

  it('shows the rarity badge without reading it again, and adds no status of its own', () => {
    render(meta({ ...legendary, isRevealed: true, finish: 'DIAMOND' }), 4, { celebrating: true });
    const badge = host.querySelector('.reveal-rarity')!;
    expect(badge.textContent).not.toBe('');
    expect(badge.getAttribute('aria-hidden')).toBe('true');
    expect(badge.hasAttribute('aria-live')).toBe(false);
    // The big pull's ribbon in the top bar (PackTopBar) is its one status.
    expect(host.querySelector('[role="status"]')).toBeNull();
  });
});

describe('the card as the reveal\'s button', () => {
  it('flips, then moves on, and says which', () => {
    render(meta(), 2);
    expect(cardButton().getAttribute('role')).toBe('button');
    expect(cardButton().tabIndex).toBe(0);
    expect(cardButton().getAttribute('aria-label')).toBe('Flip card 3 of 5');
    render(meta({ isRevealed: true }), 2);
    expect(cardButton().getAttribute('aria-label')).toBe('Next card');
    render(meta({ isRevealed: true }), 4);
    expect(cardButton().getAttribute('aria-label')).toBe('See the pack summary');
  });

  it('is marked disabled while a big pull holds the reveal', () => {
    render(meta({ ...legendary, isRevealed: true, finish: 'DIAMOND' }), 4, { celebrating: true, revealLocked: true });
    expect(cardButton().getAttribute('aria-disabled')).toBe('true');
    render(meta({ ...legendary, isRevealed: true, finish: 'DIAMOND' }), 4, { celebrating: true });
    expect(cardButton().hasAttribute('aria-disabled')).toBe(false);
  });

  it('takes focus after the tear, and passes it to each next card', () => {
    (document.activeElement as HTMLElement | null)?.blur();
    render(meta());
    expect(document.activeElement).toBe(cardButton());
    render(meta({ isRevealed: true }));
    expect(document.activeElement).toBe(cardButton());
    const first = cardButton();
    render(meta({ uniqueId: 2 }), 1);
    expect(cardButton()).not.toBe(first);
    expect(document.activeElement).toBe(cardButton());
  });

  it('leaves focus alone when the player has moved it elsewhere', () => {
    render(meta());
    const skip = host.querySelector<HTMLButtonElement>('.reveal-skip')!;
    skip.focus();
    render(meta({ uniqueId: 2 }), 1);
    expect(document.activeElement).toBe(skip);
  });
});

describe('the tilt hint', () => {
  it('shows for a mouse, and goes when reduced motion turns on', () => {
    render(meta());
    expect(host.querySelector('.mouse-hint')).not.toBeNull();
    act(() => {
      reduce = true;
      listeners.forEach((listener) => listener());
    });
    expect(host.querySelector('.mouse-hint')).toBeNull();
  });
});

describe('the card leaving', () => {
  it('is out of the Tab order and hidden from screen readers while it exits', () => {
    render(meta({ isRevealed: true }));
    const leaving = cardButton();
    expect(leaving.hasAttribute('inert')).toBe(false);
    expect(leaving.hasAttribute('aria-hidden')).toBe(false);
    render(meta({ uniqueId: 2 }), 1);
    // Still on screen for its exit, but inert, so neither Tab nor a screen reader reaches it.
    expect(leaving.isConnected).toBe(true);
    expect(cardButton()).not.toBe(leaving);
    expect(leaving.hasAttribute('inert')).toBe(true);
    expect(leaving.getAttribute('aria-hidden')).toBe('true');
    // The card that replaces it is the reveal's button.
    expect(cardButton().hasAttribute('inert')).toBe(false);
    expect(cardButton().hasAttribute('aria-hidden')).toBe(false);
    expect(cardButton().getAttribute('aria-label')).toBe('Flip card 2 of 5');
  });
});
