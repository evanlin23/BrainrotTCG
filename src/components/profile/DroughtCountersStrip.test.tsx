// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DroughtCountersStrip from './DroughtCountersStrip';
import type { PullDroughtStats } from '../../game/droughtCounters';

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const render = (stats: PullDroughtStats) => {
  act(() => root.render(<DroughtCountersStrip stats={stats} />));
};

describe('DroughtCountersStrip', () => {
  it('renders nothing when totalPacks is 0', () => {
    const stats: PullDroughtStats = {
      totalPacks: 0,
      brainrot: { packsSince: 0, foundInHistory: false },
      legendaryPlus: { packsSince: 0, foundInHistory: false },
      epicPlus: { packsSince: 0, foundInHistory: false },
      rankingsQualifier: { packsSince: 0, foundInHistory: false },
    };

    render(stats);
    expect(container.textContent).toBe('');
  });

  it('renders observational drought counters and no-pity note', () => {
    const stats: PullDroughtStats = {
      totalPacks: 25,
      brainrot: { packsSince: 25, foundInHistory: false },
      legendaryPlus: { packsSince: 12, foundInHistory: true },
      epicPlus: { packsSince: 1, foundInHistory: true },
      rankingsQualifier: { packsSince: 5, foundInHistory: true },
    };

    render(stats);

    expect(container.textContent).toContain('Packs since last');
    expect(container.textContent).toContain('Independent odds');
    expect(container.textContent).toContain('25*');
    expect(container.textContent).toContain('12');
    expect(container.textContent).toContain('1');
    expect(container.textContent).toContain('5');

    const brainrotEl = container.querySelector('[aria-label="Brainrot: none in 25 recorded packs"]');
    expect(brainrotEl).not.toBeNull();
    // "*" is explained by its own footnote, and the scope is stated; no "+" footnote without a "+".
    expect(container.textContent).toContain('* None pulled in any pack recorded here.');
    expect(container.textContent).toContain("Counts this player's packs recorded on this device, from every set, each ticket once.");
    expect(container.textContent).not.toContain('+ At least');
  });

  it('shows no marker footnotes when every count is exact', () => {
    render({
      totalPacks: 9,
      brainrot: { packsSince: 9, foundInHistory: true },
      legendaryPlus: { packsSince: 4, foundInHistory: true },
      epicPlus: { packsSince: 0, foundInHistory: true },
      rankingsQualifier: { packsSince: 2, foundInHistory: true },
    });
    expect(container.textContent).not.toContain('*');
    expect(container.textContent).not.toContain('+ At least');
    expect(container.textContent).toContain('each ticket once');
  });

  it('renders footnote when history is incomplete/bounded', () => {
    const stats: PullDroughtStats = {
      totalPacks: 40,
      brainrot: {
        packsSince: 10,
        foundInHistory: false,
        isBoundedByIncompleteHistory: true,
      },
      legendaryPlus: { packsSince: 2, foundInHistory: true },
      epicPlus: { packsSince: 0, foundInHistory: true },
      rankingsQualifier: { packsSince: 8, foundInHistory: true },
    };

    render(stats);

    expect(container.textContent).toContain('10+');
    expect(container.textContent).toContain("+ At least this many: an older pack's cards aren't saved on this device");
    // The bounded count is marked "+", not "*", so the "*" footnote doesn't show.
    expect(container.textContent).not.toContain('* None');
  });
});
