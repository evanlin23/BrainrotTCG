import { useCallback, useEffect, useRef, useState } from 'react';
import { getAchievementById, type Achievement } from '../data/achievements';
import { getHistory } from '../game/history';
import type { PullRef } from '../game/pulls';
import { historyAchievementsReady, historyPacksState } from '../game/packCache';
import { onReopenProgress } from '../game/reopenJob';
import { isCardOwned } from '../game/versions';
import { STORAGE_KEYS } from '../constants';
import { getStoredData } from '../utils/storage';
import {
  checkCollectionAchievements, checkHistoryAchievements, checkModifierAchievements, checkPackMilestones,
} from '../utils/achievementChecks';
import type { AchievementData, CollectionItem, Stats } from '../types';
import type { CardWithMeta } from '../types/card';

type Unlocked = Record<string, AchievementData | number>;

/** What the tab holds that achievements are reconciled against, as of this render. */
export interface AchievementInputs {
  stats: Stats;
  collection: Record<string, CollectionItem>;
  /** Every pack in the history is readable, so what it unlocks can name the right pack and date. */
  historyReady: boolean;
  /** False once another tab replaced this tab's save: nothing from the new player's history is credited here. */
  samePlayer: () => boolean;
  /** An achievement unlocked live, to announce. Retroactive unlocks are never announced. Pass one that stays the same. */
  announce: (achievement: Achievement) => void;
}

export interface AchievementReconciler {
  /** The unlocked achievements, for rendering and for storing. */
  achievements: Unlocked;
  /** The unlocked achievements as of the latest command, even one React hasn't rendered yet. */
  snapshot: () => Unlocked;
  /** Unlocks one achievement for a pack just opened and announces it, once however many commands arrive before a render. */
  unlock: (id: string, pack?: CardWithMeta[], ref?: PullRef) => void;
}

/**
 * Owns the player's unlocked achievements: loads them, credits what the collection, the pack history and
 * live packs earn, and reports live unlocks to `announce`. Storing them is the progress writer's job.
 *
 * Every change goes through one snapshot that is updated at once, so several commands before React
 * renders (a pack unlocking five achievements) neither lose one another nor unlock twice.
 * Retroactive unlocks (the mount check, finishes and misprints from the history, packs the history
 * never credited) are silent. History unlocks wait until every pack in it is readable and never run
 * after another tab replaced the save this tab loaded.
 */
export function useAchievementReconciler({ stats, collection, historyReady, samePlayer, announce }: AchievementInputs): AchievementReconciler {
  const [achievements, setAchievements] = useState<Unlocked>(() => getStoredData(STORAGE_KEYS.ACHIEVEMENTS, {}));
  const latest = useRef(achievements);
  const snapshot = useCallback(() => latest.current, []);
  const commit = useCallback((next: Unlocked) => {
    latest.current = next;
    setAchievements(next);
  }, []);

  const credit = useCallback((ids: readonly string[]) => {
    if (ids.length === 0) return;
    const timestamp = Date.now();
    const next = { ...latest.current };
    ids.forEach((id) => { if (!next[id]) next[id] = timestamp; });
    commit(next);
  }, [commit]);

  // What the loaded progress already earned, once on mount.
  useEffect(() => {
    credit([...checkPackMilestones(stats.packsOpened || 0, latest.current), ...checkCollectionAchievements(collection, stats, latest.current)]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Finishes and misprints pulled before their achievements existed: from the pack history, and
  // from the collection's tallies for packs the history has no cards for. As soon as the history can
  // be (holos only show in the cards), and once more if other players' packs are read in later.
  const modifiersChecked = useRef(false);
  useEffect(() => {
    if (!historyReady || modifiersChecked.current || !samePlayer()) return;
    modifiersChecked.current = historyPacksState() === 'ready';
    const pulled = getHistory().flatMap((e) => (e.cards ?? []).map((c) => ({ isHolo: c.holo, finish: c.finish, misprint: c.misprint })));
    const tallied = Object.values(collection).filter(isCardOwned).flatMap((item) => [
      ...Object.entries(item?.finishes ?? {}).filter(([, n]) => (n ?? 0) > 0).map(([finish]) => ({ isHolo: false, finish })),
      ...((item?.misprints ?? 0) > 0 ? [{ isHolo: false, misprint: true }] : []),
    ]);
    credit(checkModifierAchievements([...pulled, ...tallied], latest.current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historyReady, credit]);

  // Packs in the history that never got their pack achievements (merged in from a save, or opened
  // before the achievement existed). Unlocked quietly, dated and linked to the pack that earned them.
  const unlockFromHistory = useCallback(() => {
    if (!samePlayer()) return;
    const found = checkHistoryAchievements(getHistory(), latest.current);
    if (found.length === 0) return;
    const next = { ...latest.current };
    for (const { id, entry, cards } of found) {
      next[id] = {
        unlockedAt: entry.openedAt,
        ...(cards ? { pack: cards } : {}),
        ref: { setId: entry.setId, setVersion: entry.setVersion, nonce: entry.nonce, publicKeyHex: entry.key },
      };
    }
    commit(next);
  }, [samePlayer, commit]);

  // Only once the history is readable (other players' packs that failed to read count by hand): a
  // pack whose saved cards weren't read yet would be skipped, or credited to a later pack, and never
  // looked at again. Runs as soon as it is.
  useEffect(() => {
    if (historyReady) unlockFromHistory();
    // Re-opened packs bring back the cards of packs the history only had a hand and score for.
    return onReopenProgress((status) => {
      if (!status.running && historyAchievementsReady()) unlockFromHistory();
    });
  }, [historyReady, unlockFromHistory]);

  const unlock = useCallback((id: string, pack?: CardWithMeta[], ref?: PullRef) => {
    const achievement = getAchievementById(id);
    if (!achievement) return;
    // Commands can unlock several achievements before React renders; deduplicate immediately.
    if (latest.current[id]) return;
    commit({ ...latest.current, [id]: { unlockedAt: Date.now(), pack, ...(ref ? { ref } : {}) } });
    announce(achievement);
  }, [commit, announce]);

  return { achievements, snapshot, unlock };
}
