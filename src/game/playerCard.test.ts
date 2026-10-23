import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scorePulled, type ProfilePack, type ProfileStats, type SetDefinition } from '../engine';
import { COLLECTIBLE_CARDS } from '../data/cards';
import { SETS, getSet } from '../content/sets';
import { toPulled } from './cardCode';
import { playerCardInput, renderPlayerCard } from './playerCard';
import { renderProfilePoster } from './bragImage';

vi.mock('./bragImage', () => ({ renderProfilePoster: vi.fn() }));

const PLAYER = { name: 'Skibidi Sam', fingerprint: 'ab12-cd34' };
const SET = getSet('right-now', 2)!;

const blankStats = (over: Partial<ProfileStats> = {}): ProfileStats => ({
  packs: 0, xp: 0, level: 1, uniqueBySet: {}, holoUniqueBySet: {}, unique: 0, holos: 0, totalScore: 0, points: 0, hands: {}, best: [], ...over,
});

const pack = (cardIds: string[], holoFirst = false, nonce = 1): ProfilePack => {
  const cards = toPulled(cardIds.map((id, i) => ({ id, holo: holoFirst && i === 0 })), SET)!;
  return { nonce, set: SET, cards, score: scorePulled(cards) };
};

describe('playerCardInput', () => {
  it('carries the player, level, xp bracket, counts and url through', () => {
    const input = playerCardInput(
      blankStats({ packs: 7, xp: 350, level: 3, holos: 2, unique: 99, points: 0 }),
      PLAYER,
      'https://example.test/#/p/abc',
    );
    expect(input).toMatchObject({
      playerName: 'Skibidi Sam',
      fingerprint: 'ab12-cd34',
      level: 3,
      title: 'Pack Rat',
      xp: 350,
      levelXp: 300,
      nextLevelXp: 600,
      packs: 7,
      holos: 2,
      totalCards: COLLECTIBLE_CARDS.length,
      url: 'https://example.test/#/p/abc',
    });
  });

  it('leaves the url out when none is given', () => {
    expect(playerCardInput(blankStats(), PLAYER).url).toBeUndefined();
  });

  it('titles a new player Fresh Pull at the first level bracket', () => {
    expect(playerCardInput(blankStats(), PLAYER)).toMatchObject({ level: 1, title: 'Fresh Pull', levelXp: 0, nextLevelXp: 100 });
  });

  it('counts only collectible cards as unique, not the sum on the stats or an archived set', () => {
    const input = playerCardInput(blankStats({ unique: 500, uniqueBySet: { 'web-ancients': 3, 'vine-and-dank': 4, genesis: 5 } }), PLAYER);
    expect(input.unique).toBe(7);
  });

  it.each([
    [2, 'Fresh Pull'],
    [3, 'Pack Rat'],
    [4, 'Pack Rat'],
    [5, 'Certified Opener'],
  ])('titles level %i %s, a title holding until the next one is reached', (level, title) => {
    expect(playerCardInput(blankStats({ level }), PLAYER).title).toBe(title);
  });

  describe('milestones', () => {
    it('has none reached and Bronze next at zero points', () => {
      expect(playerCardInput(blankStats({ points: 0 }), PLAYER)).toMatchObject({
        points: 0,
        milestone: undefined,
        nextMilestone: { name: 'Bronze', points: 1000 },
        milestoneFloor: 0,
      });
    });

    it('sits on a milestone exactly at its points', () => {
      expect(playerCardInput(blankStats({ points: 5000 }), PLAYER)).toMatchObject({
        points: 5000,
        milestone: 'Silver',
        nextMilestone: { name: 'Gold', points: 25000 },
        milestoneFloor: 5000,
      });
    });

    it('stays on the previous milestone one point short of the next', () => {
      expect(playerCardInput(blankStats({ points: 24999 }), PLAYER)).toMatchObject({
        milestone: 'Silver',
        nextMilestone: { name: 'Gold', points: 25000 },
        milestoneFloor: 5000,
      });
    });

    it('has no next milestone once the last is reached', () => {
      const input = playerCardInput(blankStats({ points: 3_000_000 }), PLAYER);
      expect(input).toMatchObject({ milestone: 'Brainrot', milestoneFloor: 2_000_000 });
      expect(input.nextMilestone).toBeUndefined();
    });
  });

  describe('sets', () => {
    const real = (id: string): SetDefinition => SETS.find((s) => s.id === id)!;
    const original = [...SETS];
    // Open whatever web-ancients is on disk, so the other cases don't lean on it staying released.
    const open = (id: string): SetDefinition => {
      const { draft: _draft, archivedAt: _archivedAt, ...rest } = real(id);
      return rest;
    };
    // Open, unowned draft, unowned archived, owned draft, owned archived: every branch of the filter.
    const fixture = (): SetDefinition[] => [
      open('web-ancients'),
      { ...real('vine-and-dank'), draft: true },
      { ...real('lockdown-lore'), archivedAt: '2026-01-01' },
      { ...real('gen-alpha-uprising'), draft: true },
      { ...real('peak-brain-rot'), archivedAt: '2026-01-01' },
    ];

    beforeEach(() => {
      SETS.splice(0, SETS.length, ...fixture());
    });
    afterEach(() => {
      SETS.splice(0, SETS.length, ...original);
    });

    it('lists openable sets and any other set you own cards from, in timeline order', () => {
      const input = playerCardInput(
        blankStats({ uniqueBySet: { 'gen-alpha-uprising': 2, 'peak-brain-rot': 1 } }),
        PLAYER,
      );
      expect(input.sets.map((s) => s.code)).toEqual(['WA', 'GAU', 'PBR']);
    });

    it('drops an unowned draft or archived set, and an owned count of zero does not bring it back', () => {
      const input = playerCardInput(blankStats({ uniqueBySet: { 'lockdown-lore': 0 } }), PLAYER);
      expect(input.sets.map((s) => s.code)).toEqual(['WA']);
    });

    it('maps each set to its code, first palette colour, owned count and size', () => {
      const wa = real('web-ancients');
      const input = playerCardInput(blankStats({ uniqueBySet: { 'web-ancients': 5 } }), PLAYER);
      expect(input.sets[0]).toEqual({ code: 'WA', color: wa.palette![0], have: 5, size: wa.cards.length, done: null });
    });

    it('starts an unowned open set at zero', () => {
      expect(playerCardInput(blankStats(), PLAYER).sets).toEqual([
        expect.objectContaining({ code: 'WA', have: 0, done: null }),
      ]);
    });

    it('marks a set complete with every card and master with every card as a holo', () => {
      const wa = real('web-ancients');
      const gau = real('gen-alpha-uprising');
      const peak = real('peak-brain-rot');
      const input = playerCardInput(
        blankStats({
          uniqueBySet: { 'web-ancients': wa.cards.length, 'gen-alpha-uprising': gau.cards.length, 'peak-brain-rot': peak.cards.length - 1 },
          holoUniqueBySet: { 'web-ancients': wa.cards.length - 1, 'gen-alpha-uprising': gau.cards.length, 'peak-brain-rot': peak.cards.length - 1 },
        }),
        PLAYER,
      );
      expect(input.sets.map((s) => [s.code, s.done])).toEqual([['WA', 'complete'], ['GAU', 'master'], ['PBR', null]]);
    });
  });

  describe('best pull', () => {
    const ids = SET.cards.slice(0, SET.packSize).map((c) => c.id);

    it('maps the best pack to its cards, hand, score and set name', () => {
      const best = pack(ids, true);
      const input = playerCardInput(blankStats({ best: [best] }), PLAYER);
      expect(input.bestScore).toBe(best.score.score);
      expect(input.bestScore).toBeGreaterThan(0);
      expect(input.best).toMatchObject({ hand: best.score.hand.name, score: best.score.score, setName: SET.name });
      const names = ids.map((id) => SET.cards.find((c) => c.id === id)!.name);
      expect(input.best!.cards.map((c) => [c.name, c.isHolo])).toEqual(names.map((name, i) => [name, i === 0]));
    });

    it('uses the first pack with cards, skipping empty ones', () => {
      const empty: ProfilePack = { ...pack(ids), cards: [] };
      const first = pack(ids, false, 2);
      const second = pack(ids.slice().reverse(), false, 3);
      const input = playerCardInput(blankStats({ best: [empty, first, second] }), PLAYER);
      expect(input.bestScore).toBe(first.score.score);
      expect(input.best!.score).toBe(first.score.score);
      expect(input.best!.cards.map((c) => c.name)).toEqual(ids.map((id) => SET.cards.find((c) => c.id === id)!.name));
    });

    it('has no best pull and a zero best score when there are no packs', () => {
      const input = playerCardInput(blankStats(), PLAYER);
      expect(input.best).toBeUndefined();
      expect(input.bestScore).toBe(0);
    });

    it('has no best pull when every listed pack is empty', () => {
      const empty: ProfilePack = { ...pack(ids), cards: [] };
      const input = playerCardInput(blankStats({ best: [empty, empty] }), PLAYER);
      expect(input.best).toBeUndefined();
      expect(input.bestScore).toBe(0);
    });
  });
});

describe('renderPlayerCard', () => {
  beforeEach(() => {
    vi.mocked(renderProfilePoster).mockReset();
  });

  it('draws the poster from playerCardInput and returns its blob', async () => {
    const blob = new Blob(['png'], { type: 'image/png' });
    vi.mocked(renderProfilePoster).mockResolvedValue(blob);
    const stats = blankStats({ packs: 3, xp: 120, level: 2, points: 1500 });

    const result = await renderPlayerCard(stats, PLAYER, 'https://example.test/#/p/abc');

    expect(result).toBe(blob);
    expect(renderProfilePoster).toHaveBeenCalledTimes(1);
    expect(renderProfilePoster).toHaveBeenCalledWith(playerCardInput(stats, PLAYER, 'https://example.test/#/p/abc'));
  });

  it('passes no url when none is given', async () => {
    vi.mocked(renderProfilePoster).mockResolvedValue(new Blob());
    await renderPlayerCard(blankStats(), PLAYER);
    expect(vi.mocked(renderProfilePoster).mock.calls[0][0].url).toBeUndefined();
  });

  it('rejects when the poster does', async () => {
    vi.mocked(renderProfilePoster).mockRejectedValue(new Error('canvas failed'));
    await expect(renderPlayerCard(blankStats(), PLAYER)).rejects.toThrow('canvas failed');
  });
});
