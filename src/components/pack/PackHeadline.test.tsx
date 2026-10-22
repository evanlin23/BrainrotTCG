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
  it('shows the total and the combo with its multiplier, and no standout line', () => {
    const common = pick('COMMON');
    const big = meta(common, 1, { isHolo: true, finish: 'DIAMOND', misprint: true });
    render([big, meta(common, 2), meta(pick('UNCOMMON'), 3), meta(pick('UNCOMMON'), 4), meta(pick('RARE'), 5)]);
    expect(container.querySelector('.pack-headline-total')!.textContent).toBe('Pack total: 400,000,850');
    expect(container.querySelector('.pack-headline-combo')!.textContent).toBe('Two Pair ×10');
    expect(container.textContent).not.toMatch(/Standout|card points/);
  });

  it('leaves the total out when a score panel shows it', () => {
    act(() => root.render(<PackHeadline cards={[meta(pick('COMMON'), 1), meta(pick('RARE'), 2)]} showTotal={false} />));
    expect(container.querySelector('.pack-headline-total')).toBeNull();
    expect(container.querySelector('.pack-headline-combo')).not.toBeNull();
  });

  it('keeps No Matches visible', () => {
    render([meta(pick('RARE', 0), 1), meta(pick('RARE', 1), 2), meta(pick('COMMON', 0), 3), meta(pick('UNCOMMON'), 4), meta(pick('COMMON', 1), 5)]);
    expect(container.querySelector('.pack-headline-combo')!.textContent).toBe('No Matches ×1');
  });
});

describe('PackHeadline on the results screen', () => {
  const common = pick('COMMON');
  const pair = [meta(common, 1), meta(common, 2), meta(pick('UNCOMMON'), 3), meta(pick('RARE'), 4), meta(pick('RARE', 1), 5)];
  const results = (cards: CardWithMeta[]) => act(() => root.render(<PackHeadline cards={cards} headingRef={() => {}} />));
  /** The headline as copied: one line per element, nothing hidden. */
  const lines = () => [...container.querySelector('.pack-headline')!.children].map((el) => el.textContent);

  it('heads with the score, then the combo with its multiplier, and no chance line (#778)', () => {
    results(pair);
    const total = cardPoints('COMMON', false) * 2 + cardPoints('UNCOMMON', false) + cardPoints('RARE', false) * 2;
    expect(lines()).toEqual([`${(total * 2).toLocaleString()} Brainrot Score`, 'Pair ×2']);
    expect(container.querySelector('h2')!.textContent).toBe(lines()[0]);
    expect(container.textContent).not.toMatch(/1 in|packs score|Most packs|%|card points|Standout/);
  });

  it('keeps No Matches visible with its multiplier', () => {
    results([meta(pick('RARE', 0), 1), meta(pick('RARE', 1), 2), meta(common, 3), meta(pick('UNCOMMON'), 4), meta(pick('COMMON', 1), 5)]);
    expect(lines().slice(1)).toEqual(['No Matches ×1']);
  });
});
