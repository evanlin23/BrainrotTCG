/**
 * Observational drought counters derived from local pack history (#757).
 *
 * Counts packs opened since the player's last pull of each top rarity (Brainrot, Legendary+, Epic+)
 * and last Rankings qualifier, across every set (or one, with setId), each ticket once.
 *
 * Invariant (no-pity design stance):
 * Every pack proof is self-contained with independent odds (Argon2id ticket -> SHA-256 seed -> sfc32).
 * Prior misses never increase future odds. These counters are strictly descriptive and observational;
 * they change no odds, derivation, or engine logic.
 */
import { getSet } from '../content/sets';
import { decodeCards } from './cardCode';
import { firstOpened, isHallOfFameWorthy, isKeysEntry, type HistoryEntry } from './history';
import { getStoredPack } from './packStore';

export interface DroughtStreak {
  /** How many packs have been opened since the last hit (0 = hit was in the most recent pack). */
  packsSince: number;
  /** Whether at least one qualifying hit was found in the examined history. */
  foundInHistory: boolean;
  /**
   * True if the streak reached a pack whose cards can't be read: their details are missing (storage
   * eviction, un-reopened tickets) or it is from a set version this build doesn't know. The true
   * streak is then at least `packsSince`.
   */
  isBoundedByIncompleteHistory?: boolean;
}

export interface PullDroughtStats {
  /** Total packs opened in the evaluated scope. */
  totalPacks: number;
  /** Packs since last Brainrot card. */
  brainrot: DroughtStreak;
  /** Packs since last Legendary or Brainrot card (Legendary+). */
  legendaryPlus: DroughtStreak;
  /** Packs since last Epic, Legendary, or Brainrot card (Epic+). */
  epicPlus: DroughtStreak;
  /** Packs since last Rankings qualifier pull. */
  rankingsQualifier: DroughtStreak;
}

export interface DroughtOptions {
  /** Scope counters to packs from this set id only. */
  setId?: string;
  /** Scope counters to packs opened by this player key (records whose key prefix is exactly its own). */
  playerKeyHex?: string;
}

/**
 * Derives observational drought counters from local pack history (newest first).
 */
export const computeDroughtCounters = (
  history: readonly HistoryEntry[],
  options?: DroughtOptions,
): PullDroughtStats => {
  let entries = history;
  if (options?.playerKeyHex) {
    entries = entries.filter(isKeysEntry(options.playerKeyHex));
  }
  // One record per ticket: history keeps every conflicting record of a ticket, and a profile admits
  // the one opened first (firstOpened), so a pack recorded twice counts once.
  const admitted = new Map<string, HistoryEntry>();
  for (const e of entries) {
    const ticket = `${e.key}:${e.nonce}`;
    const other = admitted.get(ticket);
    if (!other || firstOpened(e, other) < 0) admitted.set(ticket, e);
  }
  entries = entries.filter((e) => admitted.get(`${e.key}:${e.nonce}`) === e);
  if (options?.setId) {
    const sId = options.setId;
    entries = entries.filter((e) => e.setId === sId);
  }

  const totalPacks = entries.length;

  let brainrotPacks = 0;
  let brainrotFound = false;
  let brainrotBounded = false;

  let legPacks = 0;
  let legFound = false;
  let legBounded = false;

  let epicPacks = 0;
  let epicFound = false;
  let epicBounded = false;

  let hofPacks = 0;
  let hofFound = false;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];

    // Rankings qualification check (hand and score are always preserved in history).
    if (!hofFound) {
      if (isHallOfFameWorthy(entry)) {
        hofFound = true;
      } else {
        hofPacks++;
      }
    }

    // Card contents check (resolves cached codes, or looks up in pack store if evicted from raw history).
    // A pack from a set version this build doesn't know has no rarities to read, so it is unknown too.
    const set = getSet(entry.setId, entry.setVersion);
    const cards = !set
      ? null
      : (entry.cards ??
        (() => {
          const reopened = getStoredPack(`${entry.setId}@${entry.setVersion}`, entry.key, entry.nonce);
          return reopened ? decodeCards(reopened) : null;
        })());

    if (!set || cards === null) {
      // Unknown card contents: this pack and older ones can't be counted, so the count is a lower bound.
      if (!brainrotFound) brainrotBounded = true;
      if (!legFound) legBounded = true;
      if (!epicFound) epicBounded = true;
    } else {
      let hasBrainrot = false;
      let hasLeg = false;
      let hasEpic = false;

      for (const c of cards) {
        const rarity = set.cards.find((d) => d.id === c.id)?.rarity;
        if (rarity === 'BRAINROT') {
          hasBrainrot = true;
          hasLeg = true;
          hasEpic = true;
          break;
        } else if (rarity === 'LEGENDARY') {
          hasLeg = true;
          hasEpic = true;
        } else if (rarity === 'EPIC') {
          hasEpic = true;
        }
      }

      if (!brainrotFound && !brainrotBounded) {
        if (hasBrainrot) {
          brainrotFound = true;
        } else {
          brainrotPacks++;
        }
      }

      if (!legFound && !legBounded) {
        if (hasLeg) {
          legFound = true;
        } else {
          legPacks++;
        }
      }

      if (!epicFound && !epicBounded) {
        if (hasEpic) {
          epicFound = true;
        } else {
          epicPacks++;
        }
      }
    }

    // Stop scanning early if all four counters have found their last hit or are bounded.
    if (
      (brainrotFound || brainrotBounded) &&
      (legFound || legBounded) &&
      (epicFound || epicBounded) &&
      hofFound
    ) {
      break;
    }
  }

  return {
    totalPacks,
    brainrot: {
      packsSince: brainrotPacks,
      foundInHistory: brainrotFound,
      ...(brainrotBounded ? { isBoundedByIncompleteHistory: true } : {}),
    },
    legendaryPlus: {
      packsSince: legPacks,
      foundInHistory: legFound,
      ...(legBounded ? { isBoundedByIncompleteHistory: true } : {}),
    },
    epicPlus: {
      packsSince: epicPacks,
      foundInHistory: epicFound,
      ...(epicBounded ? { isBoundedByIncompleteHistory: true } : {}),
    },
    rankingsQualifier: {
      packsSince: hofPacks,
      foundInHistory: hofFound,
    },
  };
};

/**
 * Formats a drought streak compactly (e.g. "0", "12", "50*", "24+").
 * "+" is a lower bound: the count reached a pack whose cards can't be read. Otherwise "*" means none
 * pulled in any recorded pack, so the drought is at least as long as this device's history.
 */
export const formatDroughtStreak = (streak: DroughtStreak): string => {
  const count = streak.packsSince.toLocaleString();
  if (streak.isBoundedByIncompleteHistory) {
    return `${count}+`;
  }
  if (!streak.foundInHistory) {
    return `${count}*`;
  }
  return count;
};

/**
 * Human-accessible explanation of a drought counter for screen readers.
 */
export const formatDroughtAccessible = (streak: DroughtStreak, label: string): string => {
  const count = streak.packsSince.toLocaleString();
  const unit = streak.packsSince === 1 ? 'pack' : 'packs';
  if (streak.isBoundedByIncompleteHistory) {
    return `${label}: at least ${count} ${unit} since last pull (older packs' cards unavailable)`;
  }
  if (!streak.foundInHistory) {
    return `${label}: none in ${count} recorded ${unit}`;
  }
  if (streak.packsSince === 0) {
    return `${label}: 0 packs (pulled in your most recent pack)`;
  }
  return `${label}: ${count} ${unit} since last pull`;
};
