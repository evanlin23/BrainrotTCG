// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SET_ID } from '../../content/sets';
import { getSetCards } from '../../data/cards';
import { cardStats } from '../../game/cardStats';
import CardVersionStats from './CardVersionStats';

let root: Root;
let container: HTMLElement;

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

describe('CardVersionStats', () => {
  const card = getSetCards(DEFAULT_SET_ID)[0];

  it('names a special version in words above its points and odds', () => {
    const version = { isHolo: true, finish: 'GOLD' as const, misprint: true };
    act(() => root.render(<CardVersionStats card={card} version={version} />));
    expect(container.querySelector('.card-viewer-version')!.textContent).toBe('Gold · Holo · Misprint');
    expect(container.querySelector('.card-viewer-points')!.textContent).toBe(cardStats(card, version).line);
  });

  it('names a plain card "Plain", as the version chips do', () => {
    act(() => root.render(<CardVersionStats card={card} version={{ isHolo: false }} />));
    expect(container.querySelector('.card-viewer-version')!.textContent).toBe('Plain');
    expect(container.querySelector('.card-viewer-points')!.textContent).toMatch(/ pts/);
  });
});
