// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_CARDS } from '../../data/cards';
import { cardPoints } from '../../engine';
import { STORAGE_KEYS } from '../../constants';
import CardRevealUI from './CardRevealUI';
import type { CardWithMeta } from '../cards/Card';

// A browser has AnimationEvent, so React listens for animationend. jsdom 27+ has no AnimationEvent but its
// cssstyle (5) now has WebkitAnimation, which makes React listen for webkitAnimationEnd instead; jsdom 26
// had neither. This runs before react-dom reads the window (the imports below are hoisted after it).
vi.hoisted(() => {
  Object.defineProperty(window, 'AnimationEvent', { value: class AnimationEvent extends Event {}, configurable: true });
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let reduce = false;

beforeEach(() => {
  reduce = false;
  localStorage.clear();
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(prefers-reduced-motion: reduce)' && reduce,
    addEventListener() {},
    removeEventListener() {},
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
const card = (extra: Partial<CardWithMeta> = {}): CardWithMeta => ({ ...common, uniqueId: 1, isRevealed: false, isHolo: false, ...extra });
const show = (props: { currentCard?: CardWithMeta; currentIndex?: number; firstPack?: boolean } = {}) => act(() => root.render(
  <CardRevealUI currentCard={props.currentCard ?? card()} currentIndex={props.currentIndex ?? 0} totalCards={5} hasMovedMouse
    onInteraction={() => {}} onSkip={() => {}} firstPack={props.firstPack} />,
));
const wrapper = () => host.querySelector('.card-wrapper')!;
const hint = () => host.querySelector('.tip-text')!;
const plays = () => localStorage.getItem(STORAGE_KEYS.FIRST_CARD_CUE_PLAYS);

describe('the first-card cue', () => {
  it('lifts the back once on the first card of the first pack, over the existing hint', () => {
    show({ firstPack: true });
    expect(wrapper().classList.contains('lift-cue')).toBe(true);
    expect(hint().getAttribute('data-first-card-cue')).toBe('play');
    expect(hint().textContent).toBe('Click or press Space to flip');
    expect(plays()).toBe('1');
  });

  it('is over for good once the card is flipped, and stays off the next card and a re-render', () => {
    show({ firstPack: true });
    show({ firstPack: true, currentCard: card({ isRevealed: true }) });
    expect(wrapper().classList.contains('lift-cue')).toBe(false);
    show({ firstPack: true, currentCard: card({ uniqueId: 2 }), currentIndex: 1 });
    expect(wrapper().classList.contains('lift-cue')).toBe(false);
    show({ firstPack: true, currentCard: card() });
    expect(wrapper().classList.contains('lift-cue')).toBe(false);
    expect(hint().hasAttribute('data-first-card-cue')).toBe(false);
    expect(plays()).toBe('1');
  });

  it('does not play again on a later first-pack mount, such as a reload, once it has played', () => {
    show({ firstPack: true });
    act(() => root.unmount());
    root = createRoot(host);
    show({ firstPack: true });
    expect(wrapper().classList.contains('lift-cue')).toBe(false);
    expect(hint().hasAttribute('data-first-card-cue')).toBe(false);
    expect(plays()).toBe('1');
  });

  it('never plays for a player who already has a pack, and leaves the count alone', () => {
    show();
    expect(wrapper().classList.contains('lift-cue')).toBe(false);
    expect(hint().hasAttribute('data-first-card-cue')).toBe(false);
    expect(plays()).toBeNull();
  });

  it('only plays on the first card of the pack', () => {
    show({ firstPack: true, currentIndex: 1 });
    expect(wrapper().classList.contains('lift-cue')).toBe(false);
    expect(plays()).toBeNull();
  });

  it('stops at the first press on the card', () => {
    show({ firstPack: true });
    act(() => { host.querySelector('.reveal-card')!.dispatchEvent(new Event('pointerdown', { bubbles: true })); });
    expect(wrapper().classList.contains('lift-cue')).toBe(false);
    expect(hint().hasAttribute('data-first-card-cue')).toBe(false);
  });

  it('is over when the lift has played', () => {
    show({ firstPack: true });
    const done = new Event('animationend', { bubbles: true });
    Object.defineProperty(done, 'animationName', { value: 'first-card-lift' });
    act(() => { host.querySelector('.card-back')!.dispatchEvent(done); });
    expect(wrapper().classList.contains('lift-cue')).toBe(false);
  });

  it('is the caption alone under reduced motion: no lift, the hint marked, still counted as played', () => {
    reduce = true;
    show({ firstPack: true });
    expect(wrapper().classList.contains('lift-cue')).toBe(false);
    expect(hint().getAttribute('data-first-card-cue')).toBe('still');
    expect(hint().textContent).toBe('Click or press Space to flip');
    expect(plays()).toBe('1');
  });
});

describe('the lower row under a revealed card', () => {
  it.each([
    ['a plain card', {}],
    ['a holo', { isHolo: true }],
    ['a finish and a misprint', { finish: 'DIAMOND', misprint: true } as Partial<CardWithMeta>],
    ['a holo with a finish and a misprint', { isHolo: true, finish: 'GOLD', misprint: true } as Partial<CardWithMeta>],
  ])('shows the rarity and the engine\'s points for %s, and New', (_name, extra) => {
    const revealed = card({ ...extra, isRevealed: true, isNew: true });
    show({ currentCard: revealed });
    const row = host.querySelector('.reveal-rarity')!;
    const points = cardPoints(revealed.rarity, revealed.isHolo, revealed.finish, revealed.misprint);
    expect(row.querySelector('.rarity-pill-points')!.textContent).toBe(`${points.toLocaleString()} pts`);
    expect(row.querySelector('.rarity-pill')!.textContent).toContain('Common');
    expect(row.querySelector('.reveal-new')!.textContent).toBe('New');
  });

  it('keeps the row empty face down, so the points can\'t spoil the flip', () => {
    show({ currentCard: card({ isNew: true }) });
    expect(host.querySelector('.reveal-rarity')!.textContent).toBe('');
  });
});
