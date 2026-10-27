import { describe, it, expect } from 'vitest';
import { getNextMilestone } from './nextMilestone';
import type { SetDefinition, CardDefinition } from '../engine';

const mockCards: CardDefinition[] = [
  { id: 'c1', name: 'Card 1', rarity: 'COMMON' },
  { id: 'c2', name: 'Card 2', rarity: 'COMMON' },
  { id: 'c3', name: 'Card 3', rarity: 'RARE' },
  { id: 'c4', name: 'Card 4', rarity: 'BRAINROT' },
];

const mockSet = {
  id: 'mock-set',
  name: 'Mock Set',
  cards: mockCards,
} as unknown as SetDefinition;

describe('getNextMilestone', () => {
  it('returns set completion milestone for a level 1 player with no cards', () => {
    // Level 1: next cosmetic is Level 3 (Pack Rat). Since level 3 > 1 + 1, set completion is prioritized.
    const goal = getNextMilestone(1, 0, mockSet, {});

    expect(goal.kind).toBe('set-complete');
    expect(goal.title).toBe('Set milestone');
    expect(goal.targetName).toBe('Mock Set Complete');
    expect(goal.detail).toContain('0/4 cards collected (4 to go)');
    expect(goal.progressPct).toBe(0);
    expect(goal.progressText).toBe('0%');
    expect(goal.actionTarget).toBe('cards');
    expect(goal.actionText).toBe('View binder');
    expect(goal.previewBadge).toBe('0/4');
  });

  it('returns cosmetic unlock when next reward is 1 level away', () => {
    // Level 2: next cosmetic is Level 3 (Pack Rat, title).
    // xpForLevel(2) = 100, xpForLevel(3) = 300. XP = 200 => 50%
    const goal = getNextMilestone(2, 200, mockSet, {});

    expect(goal.kind).toBe('cosmetic');
    expect(goal.title).toBe('Next cosmetic unlock');
    expect(goal.targetName).toBe('Pack Rat (title)');
    expect(goal.detail).toContain('(does not change odds)');
    expect(goal.progressPct).toBe(50);
    expect(goal.progressText).toBe('50% to Level 3');
    expect(goal.actionTarget).toBe('rewards');
    expect(goal.actionText).toBe('Select rewards');
    expect(goal.previewBadge).toBe('Lvl 3');
  });

  it('returns set mastery when set is complete but missing holos and cosmetic is not 1 level away', () => {
    // Level 8: next cosmetic is Level 10 (Gold card back, 2 levels away).
    // All 4 cards owned, but only 1 holo.
    const collection = {
      'mock-set/c1': { normalCount: 1, holoCount: 1 },
      'mock-set/c2': { normalCount: 2, holoCount: 0 },
      'mock-set/c3': { normalCount: 1, holoCount: 0 },
      'mock-set/c4': { normalCount: 1, holoCount: 0 },
    };

    const goal = getNextMilestone(8, 2800, mockSet, collection);

    expect(goal.kind).toBe('set-master');
    expect(goal.title).toBe('Set mastery');
    expect(goal.targetName).toBe('Mock Set Master');
    expect(goal.detail).toContain('1/4 holos collected (3 to go)');
    expect(goal.progressPct).toBe(25);
    expect(goal.progressText).toBe('25% holo');
    expect(goal.actionTarget).toBe('cards');
    expect(goal.previewBadge).toBe('1/4');
  });

  it('falls back to cosmetic reward if set is already complete and mastered', () => {
    // All cards owned as holos
    const collection = {
      'mock-set/c1': { normalCount: 1, holoCount: 1 },
      'mock-set/c2': { normalCount: 1, holoCount: 1 },
      'mock-set/c3': { normalCount: 1, holoCount: 1 },
      'mock-set/c4': { normalCount: 1, holoCount: 1 },
    };

    // Level 8: next cosmetic is Level 10 (Gold card back). Set is already mastered, so shows next cosmetic.
    const goal = getNextMilestone(8, 2800, mockSet, collection);

    expect(goal.kind).toBe('cosmetic');
    expect(goal.targetName).toBe('Gold (card back)');
    expect(goal.detail).toContain('(does not change odds)');
    expect(goal.actionTarget).toBe('rewards');
  });

  it('returns completed milestone when all cosmetics and current set are mastered', () => {
    const collection = {
      'mock-set/c1': { normalCount: 1, holoCount: 1 },
      'mock-set/c2': { normalCount: 1, holoCount: 1 },
      'mock-set/c3': { normalCount: 1, holoCount: 1 },
      'mock-set/c4': { normalCount: 1, holoCount: 1 },
    };

    // Level 35: all rewards unlocked (highest is 30)
    const goal = getNextMilestone(35, 100000, mockSet, collection);

    expect(goal.kind).toBe('set-master');
    expect(goal.title).toBe('Milestone reached');
    expect(goal.targetName).toBe('Mock Set Mastered');
    expect(goal.progressPct).toBe(100);
    expect(goal.previewBadge).toBe('Master');
  });

  it('clamps progress safely when xp exceeds target level or is below current', () => {
    const goalOver = getNextMilestone(2, 500, mockSet, {});
    expect(goalOver.progressPct).toBe(100);

    const goalUnder = getNextMilestone(2, 0, mockSet, {});
    expect(goalUnder.progressPct).toBe(0);
  });
});
