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

  // Copies not covered by cached history
  normal = Math.max(0, normal);
  holo = Math.max(0, holo);
  let rem = normal + holo;
  if (rem > 0) {
    const finishList: Finish[] = [];
    for (const [finish, n] of Object.entries(finishes) as [Finish, number][]) {
      for (let i = 0; i < Math.max(0, n); i++) finishList.push(finish);
    }
    const totalFinishes = finishList.length;
    const totalMisprints = Math.max(0, misprints);

    // Pigeonhole principle: at least minOverlap copies MUST have both a finish and a misprint
    const minOverlap = Math.max(0, totalFinishes + totalMisprints - rem);
    const maxOverlap = Math.min(totalFinishes, totalMisprints);
    const overlapDetermined = minOverlap === maxOverlap;

    // 1. Guaranteed combined finish+misprint copies (when overlap is established)
    if (minOverlap > 0) {
      for (let i = 0; i < minOverlap; i++) {
        const finish = finishList[i];
        const isHolo = normal <= 0 && holo > 0;
        const holoAmbiguous = normal > 0 && holo > 0 && rem > minOverlap;
        add(
          {
            isHolo,
            finish,
            misprint: true,
            ...(holoAmbiguous ? { uncertain: true } : {}),
          },
          1,
        );
        if (isHolo) holo--;
        else normal = Math.max(0, normal - 1);
        rem--;
      }
    }

    // Remaining finishes and misprints after guaranteed overlap
    const remFinishes = finishList.slice(minOverlap);
    const remMisprints = totalMisprints - minOverlap;

    // If overlap between remaining finishes and misprints cannot be established:
    // Do not invent a combined variant, and do not assign overlapping marginals to separate copies.
    // Flag ambiguous modifiers as visibly uncertain.
    const isAmbiguous = !overlapDetermined;

    // 2. Remaining finishes
    for (const finish of remFinishes) {
      if (rem <= 0) break;
      const isHolo = normal <= 0 && holo > 0;
      const holoAmbiguous = normal > 0 && holo > 0;
      add(
        {
          isHolo,
          finish,
          misprint: false,
          ...(isAmbiguous || holoAmbiguous ? { uncertain: true } : {}),
        },
        1,
      );
      if (isHolo) holo--;
      else normal = Math.max(0, normal - 1);
      rem--;
    }

    // 3. Remaining misprints
    for (let i = 0; i < remMisprints; i++) {
      if (rem <= 0) break;
      const isHolo = normal <= 0 && holo > 0;
      const holoAmbiguous = normal > 0 && holo > 0;
      add(
        {
          isHolo,
          finish: null,
          misprint: true,
          ...(isAmbiguous || holoAmbiguous ? { uncertain: true } : {}),
        },
        1,
      );
      if (isHolo) holo--;
      else normal = Math.max(0, normal - 1);
      rem--;
    }

    // 4. Remaining plain and holo copies
    if (normal > 0) {
      add({ isHolo: false, finish: null, misprint: false, ...(isAmbiguous ? { uncertain: true } : {}) }, normal);
    }
    if (holo > 0) {
      add({ isHolo: true, finish: null, misprint: false, ...(isAmbiguous ? { uncertain: true } : {}) }, holo);
    }
  }

  const points = (v: CardVersion) => cardPoints(rarity, v.isHolo, v.finish, v.misprint);
  return [...tally.values()].sort((a, b) => points(b.version) - points(a.version));
};
