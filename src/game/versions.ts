/**
 * A card's version: holo or not, its finish and whether it's a misprint. Screens pass the pulled card
 * itself (which carries its version) instead of the pieces, so none of them can drop one.
 */
import { cardPoints, type Rarity } from '../engine';
import type { Finish } from '../engine';
import type { CollectionItem } from '../types';
import { encodeCard } from './cardCode';
import { getHistory, type HistoryEntry } from './history';

export interface CardVersion {
  isHolo: boolean;
  finish?: Finish | null;
  misprint?: boolean;
  /** True when the version's modifier composition cannot be established unambiguously from aggregate tallies. */
  uncertain?: boolean;
}

export const versionOf = (card: Partial<CardVersion>): CardVersion => ({
  isHolo: !!card.isHolo,
  finish: card.finish ?? null,
  misprint: !!card.misprint,
  ...(card.uncertain ? { uncertain: true } : {}),
});

export const sameVersion = (a: CardVersion, b: CardVersion): boolean =>
  a.isHolo === b.isHolo &&
  (a.finish ?? null) === (b.finish ?? null) &&
  !!a.misprint === !!b.misprint &&
  !!a.uncertain === !!b.uncertain;

/**
 * Total copies owned of a collection card, counting normal and holo copies (and legacy count).
 */
export const ownedCount = (item: (Pick<CollectionItem, 'normalCount' | 'holoCount'> & { count?: number }) | undefined | null): number => {
  if (!item) return 0;
  return (item.normalCount || item.count || 0) + (item.holoCount || 0);
};

/**
 * Whether any copies of this card are owned. Zero-copy records are not owned.
 */
export const isCardOwned = (item: (Pick<CollectionItem, 'normalCount' | 'holoCount'> & { count?: number }) | undefined | null): boolean =>
  ownedCount(item) > 0;

export interface OwnedVersion {
  version: CardVersion;
  count: number;
}

/**
 * Every version of a card you own, most valuable first, with how many of each. Exact combinations
 * come from the pack history; copies it has no cards for (older packs, trimmed history) are rebuilt from
 * the collection's tallies and marked `uncertain` when the tallies fit more than one combination.
 */
export const ownedVersions = (
  cardKey: string,
  rarity: Rarity,
  item: Pick<CollectionItem, 'normalCount' | 'holoCount' | 'count' | 'finishes' | 'misprints'>,
  history: readonly HistoryEntry[] = getHistory(),
): OwnedVersion[] => {
  const tally = new Map<string, OwnedVersion>();
  const add = (version: CardVersion, count: number) => {
    if (count <= 0) return;
    const key = `${encodeCard({ id: '', holo: version.isHolo, finish: version.finish, misprint: version.misprint })}:${version.uncertain ? '?' : ''}`;
    const entry = tally.get(key);
    if (entry) entry.count += count;
    else tally.set(key, { version, count });
  };

  const [setId, cardId] = cardKey.split('/');
  let normal = item.normalCount || item.count || 0;
  let holo = item.holoCount || 0;
  const finishes = { ...item.finishes };
  let misprints = item.misprints ?? 0;
  for (const entry of history) {
    if (entry.setId !== setId || !entry.cards) continue;
    for (const c of entry.cards) {
      if (c.id !== cardId) continue;
      // Never more than the collection holds (a history from another save, say).
      if (c.holo ? holo <= 0 : normal <= 0) continue;
      if (c.finish && !((finishes[c.finish] ?? 0) > 0)) continue;
      if (c.misprint && misprints <= 0) continue;
      add(versionOf({ isHolo: c.holo, finish: c.finish, misprint: c.misprint }), 1);
      if (c.holo) holo--;
      else normal--;
      if (c.finish) finishes[c.finish]! -= 1;
      if (c.misprint) misprints--;
    }
  }

  // Copies the history has no cards for come from the tallies, which don't say which finish went with
  // which misprint, or which copy was holo. Rebuild them, but flag every rebuilt copy uncertain unless
  // the tallies allow only one answer: a guessed combination is never shown as exact (issue #655).
  normal = Math.max(0, normal);
  holo = Math.max(0, holo);
  const rem = normal + holo;
  if (rem > 0) {
    const finishList: Finish[] = [];
    for (const [finish, n] of Object.entries(finishes) as [Finish, number][]) {
      for (let i = 0; i < Math.max(0, n); i++) finishList.push(finish);
    }
    const totalFinishes = finishList.length;
    const totalMisprints = Math.max(0, misprints);

    // Pigeonhole: at least minOverlap copies have both a finish and a misprint, at most maxOverlap.
    const minOverlap = Math.max(0, totalFinishes + totalMisprints - rem);
    const maxOverlap = Math.min(totalFinishes, totalMisprints);
    const overlap = Math.min(minOverlap, maxOverlap);
    // Which finishes carry the misprints is known only when the overlap is fixed and it covers none,
    // all, or only one kind of finish. (minOverlap > maxOverlap means the tallies don't add up.)
    const pairingKnown =
      minOverlap === maxOverlap && (overlap === 0 || overlap === totalFinishes || new Set(finishList).size <= 1);

    // Each uncovered copy's finish and misprint, combined ones first, then plain ones to make up the count.
    const kinds: { finish: Finish | null; misprint: boolean }[] = [
      ...finishList.map((finish, i) => ({ finish, misprint: i < overlap })),
      ...Array.from({ length: totalMisprints - overlap }, () => ({ finish: null, misprint: true })),
    ].slice(0, rem);
    while (kinds.length < rem) kinds.push({ finish: null, misprint: false });

    // Which copies are holo is known only when they all are, none are, or every copy is alike.
    const holoKnown = normal === 0 || holo === 0 || new Set(kinds.map((k) => `${k.finish}${k.misprint}`)).size <= 1;
    const uncertain = !pairingKnown || !holoKnown || totalFinishes + totalMisprints - overlap > rem;
    kinds.forEach((kind, i) => add({ isHolo: i >= normal, ...kind, ...(uncertain ? { uncertain: true } : {}) }, 1));
  }

  const points = (v: CardVersion) => cardPoints(rarity, v.isHolo, v.finish, v.misprint);
  return [...tally.values()].sort((a, b) => points(b.version) - points(a.version));
};
