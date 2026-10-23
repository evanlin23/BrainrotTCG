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

const setPointer = (coarse: boolean) => vi.stubGlobal('matchMedia', (query: string) => ({
  matches: query === '(pointer: coarse)' ? coarse : false,
  addEventListener() {},
  removeEventListener() {},
}));

beforeEach(() => {
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
const card = (isRevealed: boolean): CardWithMeta => ({ ...common, uniqueId: 1, isRevealed, isHolo: false });
/** The line under the card for card `index` of 5. */
const hint = (index: number, isRevealed: boolean, revealLocked = false) => {
  act(() => root.render(
    <CardRevealUI currentCard={card(isRevealed)} currentIndex={index} totalCards={5} hasMovedMouse
      onInteraction={() => {}} onSkip={() => {}} revealLocked={revealLocked} />,
  ));
  return host.querySelector('.tip-text')!.textContent;
};

// What the press really does: the last face-up card's click, Space, Enter, swipe or tap opens the pack
// summary (PackOpener's handleInteraction, then nextCard), not another card (#790).
describe('the hint under the card', () => {
  it('with a mouse, says next card until the last card, then the pack summary', () => {
    setPointer(false);
    expect(hint(0, false)).toBe('Click or press Space to flip');
    expect(hint(0, true)).toBe('Click or press Space for the next card');
    expect(hint(2, true)).toBe('Click or press Space for the next card');
    expect(hint(3, true)).toBe('Click or press Space for the next card');
    expect(hint(4, false)).toBe('Click or press Space to flip');
    expect(hint(4, true)).toBe('Click or press Space to see the pack summary');
  });

  it('on a phone, says next card until the last card, then the pack summary', () => {
    setPointer(true);
    expect(hint(0, false)).toBe('Tap card to flip');
    expect(hint(0, true)).toBe('Swipe or tap for the next card');
    expect(hint(3, true)).toBe('Swipe or tap for the next card');
    expect(hint(4, false)).toBe('Tap card to flip');
    expect(hint(4, true)).toBe('Swipe or tap to see the pack summary');
  });

  it('keeps Big pull! while a good last card holds the input, then names the summary', () => {
    setPointer(false);
    expect(hint(4, true, true)).toBe('Big pull!');
    expect(hint(4, true, false)).toBe('Click or press Space to see the pack summary');
  });

  it('agrees with the card button\'s own label on what the next press opens', () => {
    setPointer(false);
    hint(4, true);
    expect(host.querySelector('.reveal-card')!.getAttribute('aria-label')).toMatch(/^See the pack summary\./);
    hint(3, true);
    expect(host.querySelector('.reveal-card')!.getAttribute('aria-label')).toMatch(/^Next card\./);
  });
});
