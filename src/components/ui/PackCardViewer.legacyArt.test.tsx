// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../../constants';
import { ALL_CARDS } from '../../data/cards';
import { importSaveFile } from '../../game/saveFile';
import type { CardWithMeta } from '../cards/Card';
import PackCardViewer from './PackCardViewer';

const TRACKER = 'https://tracker.example/pixel.gif?id=victim';
const legacy = (n: number, image: string) => ({
  id: `old-${n}`, key: `archived/old-${n}`, setId: 'archived', name: `Old Card ${n}`, image, rarity: 'COMMON', isHolo: false, uniqueId: n, isRevealed: true,
});
const known = ALL_CARDS[0];

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // jsdom has no ResizeObserver or matchMedia; the card viewer only uses them for layout and tilt.
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  localStorage.clear();
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.clear();
  vi.unstubAllGlobals();
});

/** Imports a backup that carries only a legacy best pack, then shows what the profile would from storage. */
const importAndShow = async (cards: unknown[]) => {
  const stats = JSON.stringify({ packsOpened: 1, holoCards: {}, highestPackLegacy: true, highestPackCards: cards });
  expect(importSaveFile(JSON.stringify({ version: 2, exportedAt: '2026-10-17T00:00:00.000Z', stats }))).toBeNull();
  // The backup's bytes are kept exactly: nothing is discarded or rewritten to fix how the art is shown.
  expect(localStorage.getItem(STORAGE_KEYS.STATS)).toBe(stats);
  const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.STATS)!) as { highestPackCards: CardWithMeta[] };
  await act(async () => root.render(<PackCardViewer cards={stored.highestPackCards} displayMode="grid" canShareCards />));
};

const shownImages = () => [...document.querySelectorAll('img')].map((img) => img.getAttribute('src') ?? '');

it('imports a legacy pack with external art unchanged but never requests the external address', async () => {
  await importAndShow([legacy(1, TRACKER), legacy(2, '//tracker.example/pixel.gif'), legacy(3, 'javascript:alert(1)'), legacy(4, 'data:image/svg+xml,<svg/>')]);
  const images = shownImages();
  expect(images).toHaveLength(4);
  for (const src of images) expect(src).toMatch(/^data:image\/gif;base64,/);
  expect([...document.querySelectorAll('img')].every((img) => img.dataset.state === 'blocked')).toBe(true);
  expect(container.innerHTML).not.toContain('tracker.example');

  // Opening a card in the viewer doesn't fetch it either.
  await act(async () => container.querySelector<HTMLButtonElement>('.pack-viewer-grid button')!.click());
  expect(document.body.innerHTML).not.toContain('tracker.example');
  expect(shownImages().every((src) => src.startsWith('data:image/gif;base64,'))).toBe(true);
});

it('keeps showing catalog art for known cards, whatever image their saved copy carries, and archived art on this site', async () => {
  const stale = { ...legacy(0, TRACKER), id: known.id, key: known.key, setId: known.setId, name: known.name, rarity: known.rarity };
  await importAndShow([stale, legacy(5, '/BrainrotTCG/assets/old-5-1a2b3c.webp')]);
  expect(shownImages()).toEqual([known.image, '/BrainrotTCG/assets/old-5-1a2b3c.webp']);
  expect(container.innerHTML).not.toContain('tracker.example');
});
