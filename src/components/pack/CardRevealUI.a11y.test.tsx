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
const cardButton = () => {
  const cards = host.querySelectorAll<HTMLButtonElement>('.reveal-card');
  return cards[cards.length - 1];
};

describe('the reveal for screen readers', () => {
  it('leaves announcing to the pack\'s one live region (PackOpener), so nothing is said twice', () => {
    render(meta());
    render(meta({ isRevealed: true, isNew: true }));
    expect(host.querySelector('[aria-live]')).toBeNull();
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
  it('is a real button that flips, then moves on, and says which, with the face\'s rarity once it shows', () => {
    render(meta(), 2);
    expect(cardButton().tagName).toBe('BUTTON');
    expect(cardButton().type).toBe('button');
    expect(cardButton().hasAttribute('role')).toBe(false);
    expect(cardButton().hasAttribute('tabindex')).toBe(false);
    // Face down, it says nothing of the card, so the flip isn't spoiled.
    expect(cardButton().getAttribute('aria-label')).toBe('Flip card 3 of 5');
    render(meta({ isRevealed: true }), 2);
    expect(cardButton().getAttribute('aria-label')).toBe(`Next card. Card 3 of 5: ${common.name}, Common`);
    render(meta({ ...legendary, isHolo: true, isRevealed: true }), 4);
    expect(cardButton().getAttribute('aria-label')).toBe(`See the pack summary. Card 5 of 5: ${legendary.name}, Holo Legendary`);
  });

  it('turns a click into the reveal\'s interaction, and keeps its keys for the pack', () => {
    const onInteraction = vi.fn();
    act(() => root.render(
      <CardRevealUI currentCard={meta()} currentIndex={0} totalCards={5} hasMovedMouse={false}
        onInteraction={onInteraction} onSkip={() => {}} />,
    ));
    act(() => cardButton().click());
    expect(onInteraction).toHaveBeenCalledTimes(1);
    // Space and Enter on it go to the pack's keys (hold Space to flip and move on), not a second click.
    expect(cardButton().hasAttribute('data-pack-keys')).toBe(true);
  });

  it('keeps a sideways flick on the card from the page, so Chromium has no fling to eat the next tap with', () => {
    render(meta());
    // jsdom has no Touch, so the events carry plain points.
    const touch = (type: string, target: Element, ...points: [number, number][]) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'touches', { value: points.map(([clientX, clientY]) => ({ clientX, clientY })) });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    };
    const card = cardButton();
    touch('touchstart', card, [100, 100]);
    expect(touch('touchmove', card, [130, 104]), 'sideways').toBe(true);
    touch('touchstart', card, [100, 100]);
    expect(touch('touchmove', card, [104, 140]), 'up and down still scrolls the page').toBe(false);
    touch('touchstart', card, [100, 100], [200, 100]);
    expect(touch('touchmove', card, [130, 100], [240, 100]), 'two fingers still zoom').toBe(false);
    const stage = card.closest('.active-card-container')!;
    touch('touchstart', stage, [100, 100]);
    expect(touch('touchmove', stage, [130, 100]), 'off the card').toBe(false);
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
    // Still on screen for its exit, but inert, so neither Tab nor a screen reader reaches it. Not
    // aria-hidden, which Chrome blocks while the card still has focus.
    expect(leaving.isConnected).toBe(true);
    expect(cardButton()).not.toBe(leaving);
    expect(leaving.hasAttribute('inert')).toBe(true);
    expect(leaving.hasAttribute('aria-hidden')).toBe(false);
    // The card that replaces it is the reveal's button.
    expect(cardButton().hasAttribute('inert')).toBe(false);
    expect(cardButton().hasAttribute('aria-hidden')).toBe(false);
    expect(cardButton().getAttribute('aria-label')).toBe('Flip card 2 of 5');
  });
});
