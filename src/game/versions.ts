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
}

export const versionOf = (card: Partial<CardVersion>): CardVersion => ({
  isHolo: !!card.isHolo,
  finish: card.finish ?? null,
  misprint: !!card.misprint,
});

export const sameVersion = (a: CardVersion, b: CardVersion): boolean =>
  a.isHolo === b.isHolo && (a.finish ?? null) === (b.finish ?? null) && !!a.misprint === !!b.misprint;

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
 * come from the pack history; copies it has no cards for (older packs, trimmed history) come from the
 * collection's tallies, one modifier at a time.
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
    const key = encodeCard({ id: '', holo: version.isHolo, finish: version.finish, misprint: version.misprint });
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
  // What's left: finishes and misprints on copies the history doesn't show, then plain and holo.
  for (const [finish, n] of Object.entries(finishes) as [Finish, number][]) {
    for (let i = 0; i < n; i++) {
      const asHolo = normal <= 0 && holo > 0;
      add({ isHolo: asHolo, finish, misprint: false }, 1);
      if (asHolo) holo--;
      else normal = Math.max(0, normal - 1);
    }
  }
  for (let i = 0; i < misprints; i++) {
    const asHolo = normal <= 0 && holo > 0;
    add({ isHolo: asHolo, finish: null, misprint: true }, 1);
    if (asHolo) holo--;
    else normal = Math.max(0, normal - 1);
  }
  add({ isHolo: false, finish: null, misprint: false }, normal);
  add({ isHolo: true, finish: null, misprint: false }, holo);

  const points = (v: CardVersion) => cardPoints(rarity, v.isHolo, v.finish, v.misprint);
  return [...tally.values()].sort((a, b) => points(b.version) - points(a.version));
};
