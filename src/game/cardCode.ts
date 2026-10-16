/**
 * A pulled card in a few characters, for storage (pack history, the re-open cache): its id, then
 * `*` if holo, a finish letter (S, G, P or D) and `!` if it's a misprint, e.g. `sigma*G!`. Card ids
 * are lowercase, so the letters can't clash with them. Older records are just `id` or `id*`.
 */
import type { Finish, PulledCard, SetDefinition } from '../engine';

const LETTERS: Record<Finish, string> = { SILVER: 'S', GOLD: 'G', PLATINUM: 'P', DIAMOND: 'D' };
const FINISH_OF = Object.fromEntries(Object.entries(LETTERS).map(([finish, letter]) => [letter, finish])) as Record<string, Finish>;

export interface StoredCard {
  id: string;
  holo: boolean;
  finish?: Finish | null;
  misprint?: boolean;
}

export const encodeCard = (card: StoredCard): string =>
  card.id + (card.holo ? '*' : '') + (card.finish ? LETTERS[card.finish] : '') + (card.misprint ? '!' : '');

export const decodeCard = (text: string): StoredCard => {
  const [, id, holo, letter, misprint] = /^(.*?)(\*?)([SGPD]?)(!?)$/.exec(text)!;
  return { id, holo: holo === '*', ...(letter ? { finish: FINISH_OF[letter] } : {}), ...(misprint ? { misprint: true } : {}) };
};

/** A stored card as the engine pulls it: sets with modifiers always say "no finish" and "not a misprint". */
export const modifiersFor = (card: StoredCard, setHasModifiers: boolean) =>
  setHasModifiers ? { finish: card.finish ?? null, misprint: !!card.misprint } : {};

/** Stored cards as the engine pulls them from this set version, or null if one isn't in it. */
export const toPulled = (stored: readonly StoredCard[], set: SetDefinition): PulledCard[] | null => {
  const cards = stored.map((c, slot) => {
    // This exact version's rarity: a later version may change it (spec section 12).
    const rarity = set.cards.find((card) => card.id === c.id)?.rarity;
    return rarity ? { setId: set.id, cardId: c.id, rarity, isHolo: c.holo, ...modifiersFor(c, set.modifiers === 1), slot } : null;
  });
  return cards.every((c) => c) ? (cards as PulledCard[]) : null;
};
