// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cardPoints, getSetCards } from '../../data/cards';
import type { CardWithMeta } from '../cards/Card';
import PackHeadline from './PackHeadline';

const setCards = getSetCards('genesis');
const pick = (rarity: string, n = 0) => setCards.filter((c) => c.rarity === rarity)[n];
const meta = (card: (typeof setCards)[number], uniqueId: number, extra: Partial<CardWithMeta> = {}): CardWithMeta =>
  ({ ...card, uniqueId, isRevealed: true, isHolo: false, finish: null, ...extra }) as CardWithMeta;

let root: Root;
let container: HTMLElement;
const render = (cards: CardWithMeta[]) => act(() => root.render(<PackHeadline cards={cards} />));

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('PackHeadline', () => {
  it('shows the total, the combo and a modified standout with its own points', () => {
    const common = pick('COMMON');
    const big = meta(common, 1, { isHolo: true, finish: 'DIAMOND', misprint: true });
    render([big, meta(common, 2), meta(pick('UNCOMMON'), 3), meta(pick('UNCOMMON'), 4), meta(pick('RARE'), 5)]);
    expect(container.querySelector('.pack-headline-total')!.textContent).toBe('Pack total: 400,000,850');
    expect(container.querySelector('.pack-headline-combo')!.textContent).toBe('Two Pair ×10');
    expect(container.querySelector('.pack-headline-standout')!.textContent).toBe(
      `Standout card: Diamond Holo Misprint ${common.name} · 40,000,000 card points`,
    );
  });

  it('keeps No Matches visible and gives a tie to the later card', () => {
    const [a, b] = [pick('RARE', 0), pick('RARE', 1)];
    render([meta(a, 1), meta(b, 2), meta(pick('COMMON', 0), 3), meta(pick('UNCOMMON'), 4), meta(pick('COMMON', 1), 5)]);
    expect(container.querySelector('.pack-headline-combo')!.textContent).toBe('No Matches ×1');
    expect(container.querySelector('.pack-headline-standout')!.textContent).toBe(
      `Standout card: ${b.name} · ${cardPoints('RARE', false).toLocaleString()} card points`,
    );
  });
});
