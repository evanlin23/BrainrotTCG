// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSetCards, type Card } from '../../data/cards';
import { DEFAULT_SET_ID } from '../../content/sets';
import CardViewerModal from './CardViewerModal';
import type { OwnedVersion } from '../../game/versions';

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
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('CardViewerModal versions presentation (issue #655)', () => {
  const card: Card = getSetCards(DEFAULT_SET_ID)[0];

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
    expect(document.querySelector('.card-viewer-version')?.textContent).toBe('Gold · Misprint');
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

    expect(document.querySelector('.card-viewer-version')?.textContent).toBe('Gold · Misprint (uncertain)');
    expect(document.querySelector('.modifier-sticker')?.textContent).toBe('Gold · Misprint');
    expect(shareButton()).toBeUndefined();

    act(() => document.querySelectorAll<HTMLButtonElement>('.version-chip')[1].click());
    expect(document.querySelector('.card-viewer-version')?.textContent).toBe('Silver');
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
    expect(document.querySelector('.card-viewer-version')?.textContent).toBe('Gold');

    act(() => {
      chips[1].click();
    });

    expect(chips[1].getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('.card-viewer-version')?.textContent).toBe('Plain');
  });
});
