import { STORAGE_KEYS } from '../constants';
import type { AchievementData, CollectionItem, HallOfFameData, Settings, Stats } from '../types';
import { setStoredData } from '../utils/storage';
import { collectionRecoveryDismissed, collectionRecoveryNote, collectionRecoveryState, persistCollection } from './collectionRecovery';
import { recordMissing } from './history';
import { getPlayer } from './player';
import { clearPendingPack, onShelf, savePendingPack, type OpenedPack } from './pulls';

/** The progress a tab holds and stores, each field under its own key. Fields are compared by reference. */
export interface HeldProgress {
  collection: Record<string, CollectionItem>;
  achievements: Record<string, AchievementData | number>;
  stats: Stats;
  hallOfFame: HallOfFameData;
  settings: Settings;
}

/**
 * What the writer needs from the tab around it. The writer keeps these for the tab's life, so they
 * must not change (App passes stable callbacks and state setters).
 */
export interface ProgressWriterHost {
  /** False once another tab replaced the save (an import, a player switch, cleared storage). Latched by the tab. */
  samePlayer(): boolean;
  /** False once another tab of this player stored progress since this one read it (game/progressGuard.ts). Latched by the tab. */
  progressCurrent(): boolean;
  /** After this tab's writes: what storage holds now is this tab's (ProgressGuard.noted). */
  noted(): void;
  /** The save changed in another tab: this tab stores nothing more and asks for a reload. */
  stale(): void;
  /** Something couldn't be stored: warn that changes may be lost. */
  failed(): void;
  /** Unreadable collection data is kept aside after a collection write: its note, and whether the player hid it. */
  keptAside(note: string | undefined, dismissed: boolean): void;
  /** Just before a collection write holding these packs: records that it holds them (ProgressGuard.storing). */
  storing(player: string, nonces: readonly number[]): boolean;
  /** That collection write failed: the record goes back as it was (ProgressGuard.unstored). */
  unstored(): void;
  /** Of the packs this tab stored, the ones another tab's collection write dropped (ProgressGuard.dropped). */
  dropped(player: string, nonces: readonly number[]): number[];
}

export interface ProgressWriter {
  /** A pack given to the collection, which stays on the pending shelf until a stored collection holds it. */
  packAdded(pack: OpenedPack): void;
  /** The packs this tab took off the pending shelf at load (an older build's stay in their own entry). */
  packsTaken(packs: readonly OpenedPack[]): void;
  /**
   * Puts the packs only this tab holds back on the shelf, once another tab of this player stored progress:
   * the ones it took at load, and the ones it stored that the other tab's collection then dropped.
   */
  putBack(): void;
  /**
   * Stores what changed since the last call. Call it with committed state only, never from inside a React
   * updater (which can be replayed). The first call only notes what the tab loaded; nothing retries by
   * itself, and the fields are stored one by one, not as one commit.
   */
  commit(progress: HeldProgress): void;
}

/** Stores a tab's progress as it changes, refusing once another tab changed the save under it. */
export const createProgressWriter = (host: ProgressWriterHost): ProgressWriter => {
  let previous: Map<string, unknown> | null = null;
  // Packs given to the collection that it hasn't stored yet: each stays on the pending shelf till then.
  let unsavedPacks: OpenedPack[] = [];
  // Of those, the ones this tab took off the shelf at load and that haven't been back on it since: only
  // this tab has them. Once one is back on the shelf it is the next load's to add (another tab may take
  // and store it), so it leaves this list.
  let takenPacks: OpenedPack[] = [];
  // Packs this tab stored in a collection. Two tabs can pass the progress check at once (see
  // game/progressGuard.ts): the later collection write then drops the earlier tab's packs, which are off
  // the shelf by then, so that tab puts them back once it hears of the write.
  let storedPacks: OpenedPack[] = [];
  // The packs that came off the shelf at load already counted: the stats every tab of this player loaded
  // count them, so one put back stays counted.
  const arrivedCounted = new Set<number>();

  // A tab that stops for another tab's progress (see progressCurrent) puts these back on the shelf for the
  // next load, as they were (its count of them was never stored). Its other packs went on the shelf when
  // they opened, and the other tab may have taken and stored them since: one put back would be added
  // twice. Packs it opened and stored that the other tab's collection dropped go back uncounted: the stats
  // the other tab stored over this tab's never counted them. One that came off the shelf counted stays
  // counted: the other tab's stats count it too, as they did at load. If storage refuses, they stay owed
  // here with the save warning up, and the next change or another tab's write tries again.
  // After another tab's import or player switch (see samePlayer) they stay here, as on every write: the
  // shelf then holds another save's packs, and onShelf matches a nonce, not a player.
  const putBack = () => {
    if (!host.samePlayer()) return;
    const dropped = storedPacks.length > 0 ? host.dropped(getPlayer().publicKeyHex, storedPacks.map((pack) => pack.nonce)) : [];
    const lost = storedPacks
      .filter((pack) => dropped.includes(pack.nonce))
      .map(({ counted, legacy: _legacy, ...pack }) => (counted && arrivedCounted.has(pack.nonce) ? { ...pack, counted } : pack));
    const owed = [...takenPacks, ...lost];
    if (owed.length === 0) return;
    savePendingPack(...owed);
    takenPacks = takenPacks.filter((pack) => !onShelf(pack.nonce));
    storedPacks = storedPacks.filter((pack) => !dropped.includes(pack.nonce) || !onShelf(pack.nonce));
    const left = owed.filter((pack) => !onShelf(pack.nonce)).length;
    if (left === 0) return;
    host.failed();
    console.error(`${left} pack(s) couldn't be put back on the pending shelf: only this tab has them, and newer progress from another tab is stored.`);
  };

  const commit = ({ collection, achievements, stats, hallOfFame, settings }: HeldProgress) => {
    const fields: [string, unknown][] = [
      [STORAGE_KEYS.ACHIEVEMENTS, achievements], [STORAGE_KEYS.STATS, stats],
      [STORAGE_KEYS.HALL_OF_FAME, hallOfFame], [STORAGE_KEYS.SETTINGS, settings],
    ];
    const last = previous;
    previous = new Map([[STORAGE_KEYS.COLLECTION, collection], ...fields]);
    if (!last) return;
    // Checked at every write, not only on the storage event (which can come late, or not at all):
    // packs given to the collection meanwhile stay on the pending shelf, under the player they opened as.
    if (!host.samePlayer()) {
      host.stale();
      return;
    }
    // Another tab of this player stored progress since this one read it (see progressCurrent).
    if (!host.progressCurrent()) {
      host.stale();
      putBack();
      return;
    }
    let statsHandled = false;
    // The collection archives stored entries it couldn't read before replacing them (or keeps them).
    if (last.get(STORAGE_KEYS.COLLECTION) !== collection) {
      const packs = unsavedPacks;
      // Recorded first, so a tab that hears of this collection also finds which packs it holds.
      const stamped = packs.length > 0 && host.storing(getPlayer().publicKeyHex, packs.map((pack) => pack.nonce));
      const result = persistCollection(collection);
      if (result === 'blocked') {
        if (stamped) host.unstored();
        host.failed();
        // Every pack the collection couldn't store goes (back) on the shelf for the next load to add (an
        // older build's pack goes back into its own entry, while it is still there: see game/pulls.ts).
        // Marked as counted first, then the stats that count them are stored; if they can't be (or a
        // full shelf can't take one), the packs go back unmarked so that load counts them (and the stats
        // wait for it). If the marked copies fit but neither the stats nor the unmarked copies can be
        // stored, the shelf keeps the marked ones: the next load adds those packs without counting them
        // unless this tab stores them first.
        if (packs.length > 0) {
          const marked = packs.map((pack) => ({ ...pack, counted: true }));
          statsHandled = true;
          const shelved = savePendingPack(...marked);
          if (shelved && setStoredData(STORAGE_KEYS.STATS, stats)) unsavedPacks = marked;
          // Packs taken off the shelf at load may not fit back on it: they stay owed by this tab, and the
          // next collection change tries again. If the marked copies did fit but the stats didn't, those
          // copies are what the shelf still holds.
          else if (!savePendingPack(...packs)) {
            console.error(
              shelved
                ? `${packs.length} pack(s) are on the pending shelf marked as counted, but the stats counting them couldn't be stored: the next load would add them uncounted unless this tab stores them first.`
                : `${packs.length} pack(s) couldn't be put back on the pending shelf: only this tab has them until its collection is stored.`,
            );
          }
          // Any taken at load that went back on the shelf (marked or not) are the next load's now.
          takenPacks = takenPacks.filter((pack) => !onShelf(pack.nonce));
        }
      } else {
        if (stamped) storedPacks.push(...packs);
        unsavedPacks = [];
        takenPacks = [];
        if (packs.length > 0) clearPendingPack(...packs.map((pack) => pack.nonce));
      }
      // A ticket mapping the history couldn't take when its pack opened goes in once this save is done.
      if (packs.length > 0 && !recordMissing(packs, getPlayer().publicKeyHex)) host.failed();
      // The archive can be written even when the collection then can't be.
      if (result !== 'saved' && collectionRecoveryState() !== 'none') {
        host.keptAside(collectionRecoveryNote(), collectionRecoveryDismissed());
      }
    }
    for (const [key, value] of fields) {
      if (key === STORAGE_KEYS.STATS && statsHandled) continue;
      if (last.get(key) === value) continue;
      if (!setStoredData(key, value)) host.failed();
    }
    // What this tab just stored (or, where storage refused, what it kept) is the progress it now holds.
    host.noted();
  };

  return {
    packAdded: (pack) => { unsavedPacks.push(pack); },
    // An older build's pack stays in its own entry until stored, so it was never taken off (see game/pulls.ts).
    packsTaken: (packs) => {
      takenPacks = packs.filter((pack) => !pack.legacy);
      for (const pack of packs) if (pack.counted) arrivedCounted.add(pack.nonce);
    },
    putBack,
    commit,
  };
};
