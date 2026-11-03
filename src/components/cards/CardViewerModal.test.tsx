// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_CARDS, CARD_RARITIES, getSetCards, type Card } from '../../data/cards';
import { DEFAULT_SET_ID } from '../../content/sets';
import CardViewerModal from './CardViewerModal';
import { cardStats } from '../../game/cardStats';
import type { OwnedVersion } from '../../game/versions';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('CardViewerModal versions presentation (issue #655)', () => {
  let root: Root;
  let container: HTMLElement;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    container = document.body.appendChild(document.createElement('div'));
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const card: Card = getSetCards(DEFAULT_SET_ID)[0];
  const rarityName = CARD_RARITIES[card.rarity].name;
  /** The one line naming the shown version and its rarity. */
  const identity = () => document.querySelector('.card-viewer-identity')?.textContent;

  it('renders a single combined Gold Misprint card without presenting multiple bogus chips', () => {
    const versions: OwnedVersion[] = [
      { version: { isHolo: false, finish: 'GOLD', misprint: true }, count: 1 },
    ];

    act(() => {
      root.render(
        <CardViewerModal
          card={card}
          versions={versions}
          onClose={() => {}}
        />,
      );
    });

    // When there is only 1 version, chips are not rendered
    expect(document.querySelector('.card-viewer-versions')).toBeNull();
    // The modal displays the Gold Misprint version name
    expect(identity()).toBe(`Gold · Misprint · ${rarityName}`);
  });

  it('renders uncertain chips with dashed styling and uncertain labels when modifiers are ambiguous', () => {
    const versions: OwnedVersion[] = [
      { version: { isHolo: false, finish: 'GOLD', misprint: false, uncertain: true }, count: 1 },
      { version: { isHolo: false, finish: null, misprint: true, uncertain: true }, count: 1 },
    ];

    act(() => {
      root.render(
        <CardViewerModal
          card={card}
          versions={versions}
          onClose={() => {}}
        />,
      );
    });

    const chips = [...document.querySelectorAll<HTMLButtonElement>('.version-chip')];
    expect(chips).toHaveLength(2);
    expect(chips[0].textContent).toContain('Gold (uncertain) ×1');
    expect(chips[0].classList.contains('uncertain-chip')).toBe(true);
    expect(chips[1].textContent).toContain('Misprint (uncertain) ×1');
    expect(chips[1].classList.contains('uncertain-chip')).toBe(true);
  });

  it('keeps the uncertain mark off the card face and offers no share for an uncertain version', () => {
    const versions: OwnedVersion[] = [
      { version: { isHolo: false, finish: 'GOLD', misprint: true, uncertain: true }, count: 1 },
      { version: { isHolo: false, finish: 'SILVER', misprint: false }, count: 1 },
    ];
    act(() => root.render(<CardViewerModal card={card} versions={versions} onClose={() => {}} canShare />));
    const shareButton = () => [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('Share card'));

    expect(identity()).toBe(`Gold · Misprint · ${rarityName} (uncertain)`);
    expect(document.querySelector('.modifier-sticker')?.textContent).toBe('Gold · Misprint');
    expect(shareButton()).toBeUndefined();

    act(() => document.querySelectorAll<HTMLButtonElement>('.version-chip')[1].click());
    expect(identity()).toBe(`Silver · ${rarityName}`);
    expect(shareButton()).toBeDefined();
  });

  it('allows switching between version chips', () => {
    const versions: OwnedVersion[] = [
      { version: { isHolo: false, finish: 'GOLD', misprint: false }, count: 1 },
      { version: { isHolo: false, finish: null, misprint: false }, count: 2 },
    ];

    act(() => {
      root.render(
        <CardViewerModal
          card={card}
          versions={versions}
          onClose={() => {}}
        />,
      );
    });

    const chips = [...document.querySelectorAll<HTMLButtonElement>('.version-chip')];
    expect(chips).toHaveLength(2);
    expect(chips[0].getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('.card-viewer-points')?.textContent).toBe(cardStats(card, { isHolo: false, finish: 'GOLD', misprint: false }).line);
    expect(identity()).toBe(`Gold · ${rarityName}`);

    act(() => {
      chips[1].click();
    });

    expect(chips[1].getAttribute('aria-pressed')).toBe('true');
    // An unmodified copy has no "Plain" headline: its identity is just its rarity.
    expect(identity()).toBe(rarityName);
    expect(document.querySelector('.card-viewer-points')?.textContent).toBe(cardStats(card, { isHolo: false, finish: null, misprint: false }).line);
  });
});

describe('card close-up tilt', () => {
  const LEVEL = 'perspective(1000px) rotateX(0deg) rotateY(0deg)';
  const legendary = ALL_CARDS.find((c) => c.rarity === 'LEGENDARY')!;

  let host: HTMLDivElement;
  let root: Root;
  let reduce = false;
  let mouse = true;
  const listeners = new Set<() => void>();

  const mousemoves = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter(([type]) => String(type) === 'mousemove').length;
  const setReduce = (value: boolean) => act(() => {
    reduce = value;
    listeners.forEach((listener) => listener());
  });
  const render = () => act(() => root.render(<CardViewerModal card={legendary} onClose={() => {}} />));
  const cardEl = () => document.querySelector<HTMLElement>('.card-viewer-card')!;
  const move = (x: number, y: number) => act(() => { window.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y })); });

  beforeEach(() => {
    reduce = false;
    mouse = true;
    listeners.clear();
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal('matchMedia', (query: string) => ({
      get matches() { return query === '(prefers-reduced-motion: reduce)' ? reduce : mouse; },
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

  /** Lays the card out as a 100x100 box at the origin, so a mouse at (100, 100) tilts it. */
  const layOut = () => vi.spyOn(cardEl(), 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 100, height: 100 } as DOMRect);

  it('tilts with a real mouse when motion is allowed', () => {
    render();
    layOut();
    move(100, 100);
    expect(cardEl().style.transform).not.toBe(LEVEL);
  });

  it('stays level when reduced motion is already on, and when the pointer is not a mouse', () => {
    reduce = true;
    render();
    layOut();
    move(100, 100);
    expect(cardEl().style.transform).toBe(LEVEL);
    expect(cardEl().dataset.tilt).toBeUndefined();
    act(() => root.unmount());
    root = createRoot(host);
    reduce = false;
    mouse = false;
    render();
    layOut();
    move(100, 100);
    expect(cardEl().style.transform).toBe(LEVEL);
    expect(cardEl().dataset.tilt).toBeUndefined();
  });

  it('levels an already tilted card the moment reduced motion turns on, and ignores the mouse after', () => {
    const remove = vi.spyOn(window, 'removeEventListener');
    render();
    layOut();
    move(100, 100);
    expect(cardEl().style.transform).not.toBe(LEVEL);

    expect(cardEl().dataset.tilt).toBe('live');

    setReduce(true);
    expect(mousemoves(remove)).toBe(1);
    expect(cardEl().dataset.tilt).toBeUndefined();
    expect(cardEl().style.transform).toBe(LEVEL);
    move(0, 0);
    expect(cardEl().style.transform).toBe(LEVEL);

    // Turning it back off tilts again, from the next mouse move, not from the old angle.
    setReduce(false);
    expect(cardEl().dataset.tilt).toBe('live');
    expect(cardEl().style.transform).toBe(LEVEL);
    move(100, 100);
    expect(cardEl().style.transform).not.toBe(LEVEL);
  });

  it('leaves no mousemove or media listeners behind when it closes', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    render();
    setReduce(true);
    setReduce(false);
    act(() => root.unmount());
    expect(mousemoves(remove)).toBe(mousemoves(add));
    expect(listeners.size).toBe(0);
    root = createRoot(host);
  });
});
