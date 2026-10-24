// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_CARDS } from '../../data/cards';
import Card, { type CardWithMeta } from './Card';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let reduce = false;
const addEventListener = vi.spyOn(window, 'addEventListener');

beforeEach(() => {
  reduce = false;
  addEventListener.mockClear();
  // A real mouse, so the tilt would follow it unless motion is reduced.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(prefers-reduced-motion: reduce)' ? reduce : true,
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

const legendary = ALL_CARDS.find((c) => c.rarity === 'LEGENDARY')!;
const meta = (overrides: Partial<CardWithMeta> = {}): CardWithMeta => ({ ...legendary, uniqueId: 1, isRevealed: false, isHolo: false, ...overrides });
const render = (card: CardWithMeta, isFlipped: boolean) => act(() => root.render(<Card card={card} isFlipped={isFlipped} onFlip={() => {}} />));
const front = () => host.querySelector('.card-front')!;
const back = () => host.querySelector('.card-back')!;

describe('card faces for screen readers', () => {
  it('names the front by card, rarity and holo, once the card is flipped', () => {
    render(meta({ isHolo: true }), true);
    expect(front().querySelector('img.card-full-image')!.getAttribute('alt')).toBe(`${legendary.name}, Holo Legendary`);
    expect(front().getAttribute('aria-hidden')).toBe('false');
    expect(back().getAttribute('aria-hidden')).toBe('true');
  });

  it('leaves holo out for a plain card, and the finish to the announcement, so the modifier sticker stays silent and New is not on the art', () => {
    render(meta({ finish: 'GOLD', misprint: true, isNew: true }), true);
    expect(front().querySelector('img.card-full-image')!.getAttribute('alt')).toBe(`${legendary.name}, Legendary`);
    const sticker = front().querySelector('.modifier-sticker')!;
    expect(sticker.textContent).toBe('Gold · Misprint');
    expect(sticker.getAttribute('aria-hidden')).toBe('true');
    expect(front().querySelector('.new-sticker')).toBeNull();
  });

  it('leaves the back image unnamed, since the flip button already says which card it is', () => {
    render(meta(), false);
    expect(back().querySelector('img')!.getAttribute('alt')).toBe('');
  });

  it('hides the front before the flip, so its name and rarity cannot spoil it', () => {
    render(meta(), false);
    expect(front().getAttribute('aria-hidden')).toBe('true');
    expect(back().getAttribute('aria-hidden')).toBe('false');
  });
});

describe('card tilt', () => {
  it('follows the mouse only when motion is allowed', () => {
    render(meta(), true);
    expect(addEventListener.mock.calls.some(([type]) => String(type) === 'mousemove')).toBe(true);
    act(() => root.unmount());
    root = createRoot(host);
    addEventListener.mockClear();
    reduce = true;
    render(meta(), true);
    expect(addEventListener.mock.calls.some(([type]) => String(type) === 'mousemove')).toBe(false);
  });

  it('stops tilting, and levels the card, when reduced motion turns on mid-pack', () => {
    const listeners = new Set<() => void>();
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)' ? reduce : true,
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    }));
    const removeEventListener = vi.spyOn(window, 'removeEventListener');
    render(meta(), true);
    const wrapper = host.querySelector<HTMLElement>('.card-wrapper')!;
    vi.spyOn(wrapper, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 100, height: 100 } as DOMRect);
    act(() => { window.dispatchEvent(new MouseEvent('mousemove', { clientX: 100, clientY: 100 })); });
    expect(wrapper.style.transform).not.toContain('rotateX(0deg)');

    act(() => {
      reduce = true;
      listeners.forEach((listener) => listener());
    });
    expect(removeEventListener.mock.calls.some(([type]) => String(type) === 'mousemove')).toBe(true);
    expect(wrapper.style.transform).toBe('perspective(1000px) rotateX(0deg) rotateY(0deg)');
    act(() => { window.dispatchEvent(new MouseEvent('mousemove', { clientX: 0, clientY: 0 })); });
    expect(wrapper.style.transform).toBe('perspective(1000px) rotateX(0deg) rotateY(0deg)');

    // Turning it back off doesn't snap the card to the old angle: it stays level until the mouse moves.
    act(() => {
      reduce = false;
      listeners.forEach((listener) => listener());
    });
    expect(wrapper.style.transform).toBe('perspective(1000px) rotateX(0deg) rotateY(0deg)');
    act(() => { window.dispatchEvent(new MouseEvent('mousemove', { clientX: 100, clientY: 100 })); });
    expect(wrapper.style.transform).not.toContain('rotateX(0deg)');
    removeEventListener.mockRestore();
  });
});
