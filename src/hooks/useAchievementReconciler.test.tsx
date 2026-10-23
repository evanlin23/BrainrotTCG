// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { POKER_HANDS } from '../engine';
import { STORAGE_KEYS } from '../constants';
import type { Achievement } from '../data/achievements';
import type { HistoryEntry } from '../game/history';
import type { ReopenStatus } from '../game/profiles';
import type { PullRef } from '../game/pulls';
import type { CollectionItem, Stats } from '../types';
import type { AchievementReconciler } from './useAchievementReconciler';
import { useAchievementReconciler } from './useAchievementReconciler';

// The pack history and the saved-pack readiness are the game's state, not this hook's: tests set them.
const game = vi.hoisted(() => ({
  history: [] as HistoryEntry[],
  packs: 'ready' as 'ready' | 'loading' | 'failed',
  ready: true,
  listeners: new Set<(status: ReopenStatus) => void>(),
}));
vi.mock('../game/history', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../game/history')>()),
  getHistory: () => game.history,
}));
vi.mock('../game/profiles', () => ({
  historyAchievementsReady: () => game.ready,
  historyPacksState: () => game.packs,
  onReopenProgress: (listener: (status: ReopenStatus) => void) => {
    game.listeners.add(listener);
    return () => { game.listeners.delete(listener); };
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = 5_000_000;
const stats = (packsOpened: number): Stats => ({ packsOpened, holoCards: {}, highestPackValue: 0, highestPackCards: [] });
const pair = (nonce: number, openedAt: number, key = 'aa'.repeat(8)): HistoryEntry =>
  ({ setId: 'genesis', setVersion: 1, nonce, key, cards: null, hand: POKER_HANDS.PAIR.name, score: 0, openedAt });
const ref = (nonce: number): PullRef => ({ setId: 'genesis', setVersion: 1, nonce, publicKeyHex: 'aa'.repeat(32) });

interface Props { stats: Stats; collection: Record<string, CollectionItem>; historyReady: boolean; samePlayer: () => boolean }
const initial = (): Props => ({ stats: stats(0), collection: {}, historyReady: true, samePlayer: () => true });

let root: Root;
let props: Props;
let announce: Mock<(achievement: Achievement) => void>;
const renders: AchievementReconciler[] = [];
const latest = () => renders[renders.length - 1];

const Probe = ({ current }: { current: Props }) => {
  renders.push(useAchievementReconciler({ ...current, announce }));
  return null;
};
const render = (next: Partial<Props> = {}) => {
  props = { ...props, ...next };
  act(() => root.render(<Probe current={props} />));
};
const mount = (next: Partial<Props> = {}) => { props = { ...initial(), ...next }; render(); };
const stored = (id: string) => latest().achievements[id];
/** A re-opening run ends: the saved packs' cards are back. */
const reopened = () => act(() => game.listeners.forEach((listener) => listener({ done: 1, total: 1, running: false })));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  localStorage.clear();
  Object.assign(game, { history: [], packs: 'ready', ready: true });
  game.listeners.clear();
  renders.length = 0;
  announce = vi.fn<(achievement: Achievement) => void>();
  root = createRoot(document.createElement('div'));
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

describe('useAchievementReconciler', () => {
  it('starts from the stored achievements', () => {
    localStorage.setItem(STORAGE_KEYS.ACHIEVEMENTS, JSON.stringify({ first_pack: { unlockedAt: 7 }, packs_10: 8 }));
    mount();
    expect(latest().achievements).toEqual({ first_pack: { unlockedAt: 7 }, packs_10: 8 });
  });

  it('credits what the loaded progress already earned once, silently, and keeps earlier dates', () => {
    localStorage.setItem(STORAGE_KEYS.ACHIEVEMENTS, JSON.stringify({ first_pack: { unlockedAt: 7 } }));
    mount({ stats: stats(10) });
    expect(latest().achievements.first_pack).toEqual({ unlockedAt: 7 });
    expect(stored('packs_10')).toBe(NOW);
    expect(announce).not.toHaveBeenCalled();
  });

  it('unlocks every achievement of several commands before a render, once each and in one snapshot', () => {
    mount();
    let seen: string[] = [];
    act(() => {
      latest().unlock('first_pack', [], ref(0));
      latest().unlock('two_of_kind', [], ref(0));
      latest().unlock('first_pack', [], ref(1));
      // A command arriving now, before React renders, already sees both.
      seen = Object.keys(latest().snapshot());
    });
    expect(seen).toEqual(['first_pack', 'two_of_kind']);
    expect(Object.keys(latest().achievements)).toEqual(['first_pack', 'two_of_kind']);
    // The first command's pack stays the one that earned it.
    expect(stored('first_pack')).toMatchObject({ unlockedAt: NOW, ref: { nonce: 0 } });
    expect(announce.mock.calls.map(([achievement]) => achievement.id)).toEqual(['first_pack', 'two_of_kind']);
  });

  it('ignores an achievement this build does not have, and one already unlocked later on', () => {
    mount();
    act(() => latest().unlock('no_such_achievement'));
    expect(latest().achievements).toEqual({});
    act(() => latest().unlock('first_pack', [], ref(0)));
    render();
    act(() => latest().unlock('first_pack', [], ref(5)));
    expect(announce).toHaveBeenCalledTimes(1);
    expect(stored('first_pack')).toMatchObject({ ref: { nonce: 0 } });
  });

  it('does not credit a live unlock to the history afterwards, nor the history over a live unlock', () => {
    game.history = [pair(0, 1000)];
    mount({ historyReady: false });
    act(() => latest().unlock('two_of_kind', [], ref(3)));
    render({ historyReady: true });
    expect(stored('two_of_kind')).toMatchObject({ unlockedAt: NOW, ref: { nonce: 3 } });
    expect(announce).toHaveBeenCalledTimes(1);
  });

  describe('the pack history', () => {
    it('waits until every pack in it is readable, then credits its achievements quietly with the pack that earned them', () => {
      game.history = [pair(0, 2000), pair(1, 1000)];
      mount({ historyReady: false });
      expect(latest().achievements.two_of_kind).toBeUndefined();

      render({ historyReady: true });
      // The oldest pack earned it, not the first one listed.
      expect(stored('two_of_kind')).toEqual({ unlockedAt: 1000, ref: { setId: 'genesis', setVersion: 1, nonce: 1, publicKeyHex: 'aa'.repeat(8) } });
      expect(announce).not.toHaveBeenCalled();
    });

    it('credits again when re-opened packs bring back cards, and only once a run has ended', () => {
      mount();
      game.history = [pair(0, 1000)];
      act(() => game.listeners.forEach((listener) => listener({ done: 0, total: 1, running: true })));
      expect(latest().achievements.two_of_kind).toBeUndefined();

      game.ready = false;
      reopened();
      expect(latest().achievements.two_of_kind).toBeUndefined();

      game.ready = true;
      reopened();
      expect(stored('two_of_kind')).toMatchObject({ unlockedAt: 1000, ref: { nonce: 0 } });
      expect(announce).not.toHaveBeenCalled();
    });

    it('is idempotent: reconciling again changes nothing', () => {
      game.history = [pair(0, 1000)];
      mount();
      const first = latest().achievements;
      reopened();
      render();
      reopened();
      expect(latest().achievements).toBe(first);
      expect(stored('two_of_kind')).toMatchObject({ unlockedAt: 1000 });
    });

    it('credits nothing from another player\'s history once the save under this tab was replaced', () => {
      let same = true;
      game.history = [];
      mount({ historyReady: false, samePlayer: () => same });
      // Another tab imported a save: the history now holds the new player's packs.
      same = false;
      game.history = [pair(0, 1000)];
      render({ historyReady: true });
      reopened();
      expect(latest().achievements.two_of_kind).toBeUndefined();

      // Packs this tab opens itself still count for the player it loaded.
      act(() => latest().unlock('two_of_kind', [], ref(9)));
      expect(stored('two_of_kind')).toMatchObject({ unlockedAt: NOW, ref: { nonce: 9 } });
    });

    it('stops listening when the tab unmounts', () => {
      mount();
      expect(game.listeners.size).toBe(1);
      act(() => root.unmount());
      expect(game.listeners.size).toBe(0);
      root = createRoot(document.createElement('div'));
    });

    it('listens once however often it renders, and again for a new readiness', () => {
      mount();
      render();
      render({ historyReady: false });
      expect(game.listeners.size).toBe(1);
      render({ historyReady: true });
      expect(game.listeners.size).toBe(1);
    });
  });

  describe('finishes and misprints from before their achievements existed', () => {
    const card = (extra: Partial<CollectionItem>): CollectionItem => ({ card: {} as CollectionItem['card'], normalCount: 1, holoCount: 0, ...extra });

    it('credits them from the collection\'s tallies and the history\'s cards', () => {
      game.history = [{ ...pair(0, 1000), cards: [{ id: 'amogus', holo: true, finish: 'GOLD', misprint: true }] }];
      mount({ collection: { a: card({ finishes: { SILVER: 2 } }), b: card({ misprints: 1 }) } });
      for (const id of ['finish_silver', 'misprint', 'finish_gold', 'stacked', 'fully_loaded']) expect(stored(id), id).toBe(NOW);
      expect(announce).not.toHaveBeenCalled();
    });

    it('waits for a readable history, and does not run for a replaced save', () => {
      let same = true;
      mount({ historyReady: false, collection: { a: card({ finishes: { SILVER: 1 } }) }, samePlayer: () => same });
      expect(stored('finish_silver')).toBeUndefined();
      same = false;
      render({ historyReady: true });
      expect(stored('finish_silver')).toBeUndefined();
    });

    it('runs once the history is fully read, and not again', () => {
      game.packs = 'failed';
      mount({ collection: { a: card({ finishes: { SILVER: 1 } }) } });
      expect(stored('finish_silver')).toBe(NOW);

      // Only other players' packs failed to read: it looks again when the history is ready again, until all of it is.
      game.history = [{ ...pair(0, 1000), cards: [{ id: 'amogus', holo: false, finish: 'GOLD' }] }];
      render({ historyReady: false });
      render({ historyReady: true });
      expect(stored('finish_gold')).toBe(NOW);

      game.packs = 'ready';
      game.history = [{ ...pair(0, 1000), cards: [{ id: 'amogus', holo: false, finish: 'DIAMOND' }] }];
      render({ historyReady: false });
      render({ historyReady: true });
      expect(stored('finish_diamond')).toBe(NOW);

      game.history = [{ ...pair(0, 1000), cards: [{ id: 'amogus', holo: false, finish: 'PLATINUM' }] }];
      render({ historyReady: false });
      render({ historyReady: true });
      // The pack history credits it, dated by its pack; the check over every card would have dated it now.
      expect(stored('finish_platinum')).toMatchObject({ unlockedAt: 1000, ref: { nonce: 0 } });
    });
  });
});
