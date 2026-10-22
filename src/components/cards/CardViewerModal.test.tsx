// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_CARDS } from '../../data/cards';
import CardViewerModal from './CardViewerModal';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LEVEL = 'perspective(1000px) rotateX(0deg) rotateY(0deg)';
const card = ALL_CARDS.find((c) => c.rarity === 'LEGENDARY')!;

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
const render = () => act(() => root.render(<CardViewerModal card={card} onClose={() => {}} />));
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
  vi.restoreAllMocks();
});

/** Lays the card out as a 100x100 box at the origin, so a mouse at (100, 100) tilts it. */
const layOut = () => vi.spyOn(cardEl(), 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 100, height: 100 } as DOMRect);

describe('card close-up tilt', () => {
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
    act(() => root.unmount());
    root = createRoot(host);
    reduce = false;
    mouse = false;
    render();
    layOut();
    move(100, 100);
    expect(cardEl().style.transform).toBe(LEVEL);
  });

  it('levels an already tilted card the moment reduced motion turns on, and ignores the mouse after', () => {
    const remove = vi.spyOn(window, 'removeEventListener');
    render();
    layOut();
    move(100, 100);
    expect(cardEl().style.transform).not.toBe(LEVEL);

    setReduce(true);
    expect(mousemoves(remove)).toBe(1);
    expect(cardEl().style.transform).toBe(LEVEL);
    move(0, 0);
    expect(cardEl().style.transform).toBe(LEVEL);

    // Turning it back off tilts again, from the next mouse move, not from the old angle.
    setReduce(false);
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
