// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PullViewerPage from './PullViewerPage';
import ProfileSummary from '../profile/ProfileSummary';
import AchievementsSection from '../achievements/AchievementsSection';
import { getSet } from '../../content/sets';
import type { ProfilePack, ProfileStats } from '../../engine';
import type { CardWithMeta } from '../cards/Card';

// Signed proof vectors from spec/vectors.json
const WEB_ANCIENTS_V1_PROOF =
  'AQx3ZWItYW5jaWVudHMAAcgklFOmlHeFiPZ1XIUIRr3ARo67BTbINmtTwGnVKqjSARJab8OrIPCfp6AgQnJhaW5yb3SGoZIzmo1PTU57xVWJFalZAdm3tn_P_f22CrNXGT4TORw3kuDhPVnUIk-vpdyJL8I4zVQ2UP3N0CaPnSsOwdsG';

const RIGHT_NOW_V2_PROOF =
  'AQlyaWdodC1ub3cAAk0__3rjsovdR9T7Ijt5NAE9d8IVqpAH0N8yHF65jlUcAQxTaGlueSBIdW50ZXLTcXcVtiSkyOUxNymy3AaT8azp-UQaKztRcaP2CONmzLuUok_3WUCZ8AuJz5VWBdUPHtRUjWO5mzw71D6GyIQJ';

const GENESIS_V1_PROOF =
  'AQdnZW5lc2lzAAFNP_9647KL3UfU-yI7eTQBPXfCFaqQB9DfMhxeuY5VHKwCANEileIcH4yb4o1ySvrgl-ZXQ9wF5uLl39nxuD-YozmuQPGvLEuhsFsR99aoaK5kNJXqAS3Ov1q0I3j-1Cxq6AY';

let root: Root;
let container: HTMLElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const waitForVerification = async () => {
  for (let i = 0; i < 50; i++) {
    if (document.body.textContent?.includes('This pull checks out')) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  }
  throw new Error('Pull verification timed out');
};

const openCardGuide = async () => {
  const guideBtn = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
    b.textContent?.includes('Card guide'),
  );
  if (!guideBtn) throw new Error('Card guide button not found');
  await act(async () => {
    guideBtn.click();
  });
};

describe('PullViewerPage historical card guide (#676)', () => {
  it('keeps Web Ancients v1 guide free of v2 finishes and misprints', async () => {
    await act(async () => {
      root.render(<PullViewerPage proof={WEB_ANCIENTS_V1_PROOF} onClose={() => {}} />);
    });
    await waitForVerification();

    expect(document.body.textContent).toContain('This pull checks out');
    expect(document.body.textContent).toContain('Web Ancients v1');

    await openCardGuide();

    const text = document.body.textContent ?? '';
    expect(text).toContain('Rarity, modifiers and scoring for Web Ancients');
    expect(text).toContain('Web Ancients has no finishes or misprints: only rarity and holo.');
    expect(text).not.toContain('Finishes and misprints');
    expect(text).not.toContain('Silver 10%');
    expect(text).not.toContain('Gold 2.5%');
    expect(text).not.toContain('Misprint 0.5%');
    expect(text).not.toContain('Holo Gold');
    expect(text).toContain('Example: a holo card');
  });

  it('shows finishes and misprints for current right-now v2', async () => {
    await act(async () => {
      root.render(<PullViewerPage proof={RIGHT_NOW_V2_PROOF} onClose={() => {}} />);
    });
    await waitForVerification();

    expect(document.body.textContent).toContain('This pull checks out');

    await openCardGuide();

    const text = document.body.textContent ?? '';
    expect(text).toContain('Rarity, modifiers and scoring for Summer of Slop');
    expect(text).toContain('Finishes (Silver up to Diamond) and misprints are rarer extras');
    expect(text).toContain('Finishes and misprints');
    expect(text).toContain('Silver');
    expect(text).toContain('Gold');
    expect(text).toContain('Misprint');
    expect(text).toContain('Example: a holo Gold card');
  });

  it('correctly omits finishes and misprints for archived Genesis v1', async () => {
    await act(async () => {
      root.render(<PullViewerPage proof={GENESIS_V1_PROOF} onClose={() => {}} />);
    });
    await waitForVerification();

    expect(document.body.textContent).toContain('This pull checks out');
    expect(document.body.textContent).toContain('Genesis v1');

    await openCardGuide();

    const text = document.body.textContent ?? '';
    expect(text).toContain('Rarity, modifiers and scoring for Genesis');
    expect(text).toContain('Genesis has no finishes or misprints: only rarity and holo.');
    expect(text).not.toContain('Finishes and misprints');
    expect(text).not.toContain('Silver 10%');
    expect(text).toContain('Example: a holo card');
  });

  it('keeps historical set version in ProfileSummary card guide', async () => {
    const set = getSet('web-ancients', 1)!;
    const testPack: ProfilePack = {
      nonce: 1,
      set,
      cards: [
        { slot: 0, setId: 'web-ancients', cardId: 'ceiling-cat', rarity: 'COMMON', isHolo: false },
        { slot: 1, setId: 'web-ancients', cardId: 'ceiling-cat', rarity: 'COMMON', isHolo: false },
        { slot: 2, setId: 'web-ancients', cardId: 'ceiling-cat', rarity: 'COMMON', isHolo: false },
        { slot: 3, setId: 'web-ancients', cardId: 'ceiling-cat', rarity: 'COMMON', isHolo: false },
        { slot: 4, setId: 'web-ancients', cardId: 'ceiling-cat', rarity: 'COMMON', isHolo: false },
      ],
      score: {
        points: 50,
        hand: { name: '5 of a Kind', multiplier: 10000 },
        score: 500000,
      },
    };
    const stats: ProfileStats = {
      packs: 1,
      xp: 100,
      level: 1,
      uniqueBySet: { 'web-ancients': 1 },
      holoUniqueBySet: {},
      unique: 1,
      holos: 0,
      totalScore: 500000,
      points: 50,
      hands: { FIVE_OF_A_KIND: 1 },
      best: [testPack],
    };

    await act(async () => {
      root.render(<ProfileSummary stats={stats} />);
    });

    const pullRow = document.querySelector<HTMLButtonElement>('.pull-row') ?? document.querySelector<HTMLButtonElement>('.profile-best-pulls button');
    if (!pullRow) throw new Error('Pull row not found');
    await act(async () => {
      pullRow.click();
    });

    await openCardGuide();

    const text = document.body.textContent ?? '';
    expect(text).toContain('Rarity, modifiers and scoring for Web Ancients');
    expect(text).toContain('Web Ancients has no finishes or misprints: only rarity and holo.');
    expect(text).not.toContain('Finishes and misprints');
  });

  it('keeps historical set version in AchievementsSection card guide', async () => {
    const card: CardWithMeta = {
      key: 'web-ancients/ceiling-cat',
      id: 'ceiling-cat',
      name: 'Ceiling Cat',
      rarity: 'COMMON',
      image: '/cards/ceiling-cat.webp',
      setId: 'web-ancients',
      isHolo: false,
      isRevealed: true,
      uniqueId: 1,
    };
    const unlockedAchievements = {
      first_pack: {
        unlockedAt: 1000,
        pack: [card, card, card, card, card],
        ref: { setId: 'web-ancients', setVersion: 1, nonce: 1 },
      },
    };

    await act(async () => {
      root.render(<AchievementsSection unlockedAchievements={unlockedAchievements} />);
    });

    const unlockItem = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((b) =>
      b.textContent?.includes('First Pack') || b.className.includes('achievement'),
    );
    if (!unlockItem) throw new Error('Achievement item button not found');
    await act(async () => {
      unlockItem.click();
    });

    await openCardGuide();

    const text = document.body.textContent ?? '';
    expect(text).toContain('Rarity, modifiers and scoring for Web Ancients');
    expect(text).toContain('Web Ancients has no finishes or misprints: only rarity and holo.');
    expect(text).not.toContain('Finishes and misprints');
  });
});
