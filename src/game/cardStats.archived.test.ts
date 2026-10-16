import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SET_ID } from '../content/sets';
import { getSetCards } from '../data/cards';
import { cardStats } from './cardStats';

// No released set is archived yet, so archive the default one for this file.
vi.mock('../content/sets', async (importOriginal) => {
  const sets = await importOriginal<typeof import('../content/sets')>();
  return { ...sets, getLatestSet: (id: string) => ({ ...sets.getLatestSet(id)!, archivedAt: '2026-01-01' }) };
});

describe('cardStats for a set you can no longer open', () => {
  it('shows only the points, with no pack odds', () => {
    const stats = cardStats(getSetCards(DEFAULT_SET_ID)[0], { isHolo: true });
    expect(stats.chance).toBeNull();
    expect(stats.line).toBe(`${stats.points.toLocaleString('en-US')} pts`);
  });
});
