// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ALL_CARDS } from '../../data/cards';
import PackCardViewer from './PackCardViewer';

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // jsdom has no ResizeObserver or matchMedia; the card viewer only uses them for layout and tilt.
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

it("fetches the pack's faces at high priority, as they're what the screen shows first (#762)", async () => {
  const cards = ALL_CARDS.slice(0, 5).map((card, n) => ({ ...card, uniqueId: n + 1, isRevealed: true, isHolo: false }));
  await act(async () => root.render(<PackCardViewer cards={cards} displayMode="grid" />));
  const faces = [...container.querySelectorAll('.pack-viewer-grid img')];
  expect(faces.map((img) => img.getAttribute('fetchpriority'))).toEqual(Array(5).fill('high'));
});
