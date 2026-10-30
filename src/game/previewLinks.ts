/**
 * Link previews for shared pulls. A pull link carries its proof after the '#', which link-preview
 * bots (chat apps, social sites) never see, so every link used to preview as the generic site.
 * Share links go through a small static page per set, hand and the cards that make the hand, built
 * by scripts/preview-pages.ts: p/<code>.html#/pull/<proof>, where the code is 8 hex characters of
 * sha256("set/card+card/HAND"), so it's short and never changes (set and card ids never do). Its
 * preview is the pack laid out as five cards: the ones that make the hand face up, the rest face
 * down. A Full House is the whole pack; No Matches shows its best card. A card shared on its own
 * gets a page showing just that card. Opening any of them forwards to the pull.
 *
 * Every pull can't have its own picture without a server to draw it, but every hand's cards can:
 * about 2,200 pictures for all the sets.
 *
 * A card with a modifier (a finish, a misprint or holo) also gets one page per modifier, naming it in
 * the link text and reusing the card's picture: sha256("set/card/TOKEN"). A pack whose headline
 * modifier is Gold or rarer (see headline) links to its headline card's page instead of its hand's.
 *
 * The cards and hand in the path only choose the preview. The pull itself is re-derived from the
 * proof when the link is opened, as always, so a hand-edited path can dress up a preview but can't
 * change what the link proves.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { handFromCounts, POKER_HANDS, toHex, utf8, type Finish, type HandKey } from '../engine';

/** How many copies of each face-up card a hand's preview shows, in order; card backs fill the rest. */
export const PREVIEW_COPIES: Record<HandKey, readonly number[]> = {
  FIVE_OF_A_KIND: [5],
  FOUR_OF_A_KIND: [4],
  FULL_HOUSE: [3, 2],
  THREE_OF_A_KIND: [3],
  TWO_PAIR: [2, 2],
  PAIR: [2],
  NO_MATCH: [1],
};

/** What a pack's link preview shows. `cardIds` are the cards that make the hand (see PREVIEW_COPIES). */
export interface Preview {
  setId: string;
  cardIds: readonly string[];
  hand: HandKey;
}

/**
 * Consistent card key/id order for link previews: code-unit comparison matches Array#sort()
 * so share links and generated static preview pages agree on pair order (#1315).
 */
export const compareCardIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The preview for a pack, from its cards (`set/card` keys; rarest last, as revealOrder sorts them):
 * the matching cards, most copies first (Two Pair in id order, so each pair of cards has one
 * picture), or the best card if nothing matches.
 */
export const previewOf = (cards: readonly { key: string }[]): Preview | undefined => {
  if (!cards.length) return undefined;
  const counts = new Map<string, number>();
  for (const card of cards) counts.set(card.key, (counts.get(card.key) ?? 0) + 1);
  const hand = handFromCounts([...counts.values()]);
  const matching = [...counts].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || compareCardIds(a[0], b[0]));
  const keys = matching.length ? matching.map(([key]) => key) : [cards[cards.length - 1].key];
  return { setId: keys[0].split('/')[0], cardIds: keys.map((key) => key.split('/')[1]), hand };
};

/**
 * The preview page, relative to the site root. With one card the code is the same as the earlier
 * one-card pages', so links shared before still preview (scripts/preview-pages.ts keeps those).
 */
export const previewPath = ({ setId, cardIds, hand }: Preview): string => pagePath(`${setId}/${cardIds.join('+')}/${hand}`);

/**
 * The preview page for one card, shared on its own (from the collection): just that card. With a
 * modifier token, the page that names that modifier (only sets with modifiers have them; see
 * hasModifierPages). Without one, the code is the same as before.
 */
export const cardPreviewPath = (setId: string, cardId: string, token?: ModifierToken): string =>
  pagePath(token ? `${setId}/${cardId}/${token}` : `${setId}/${cardId}`);

/**
 * A card's modifiers, rarest first: its finish, a misprint and holo. Equal odds (Platinum and a
 * misprint, both 50 in 10,000) go to the finish. previewLinks.test.ts checks this order against the
 * engine's odds.
 */
export const MODIFIER_TOKENS = ['DIAMOND', 'PLATINUM', 'MISPRINT', 'GOLD', 'HOLO', 'SILVER'] as const;
export type ModifierToken = (typeof MODIFIER_TOKENS)[number];

/** The modifiers rare enough to headline a pack's link (a card page instead of the hand's). */
export const PACK_HEADLINE_TOKENS: readonly ModifierToken[] = ['DIAMOND', 'PLATINUM', 'MISPRINT', 'GOLD'];

export interface ModifiedCard {
  isHolo?: boolean;
  finish?: Finish | null;
  misprint?: boolean;
}

/** A card's modifier tokens, rarest first ([] for none). */
export const modifierTokens = (card: ModifiedCard): ModifierToken[] =>
  MODIFIER_TOKENS.filter((token) => (token === 'HOLO' ? card.isHolo : token === 'MISPRINT' ? card.misprint : card.finish === token));

/** The rarest modifier among the cards and the card that has it (the first in the given order on a tie), or null. */
export const headline = (cards: readonly ModifiedCard[]): { token: ModifierToken; cardIndex: number } | null => {
  let best: { token: ModifierToken; cardIndex: number } | null = null;
  cards.forEach((card, cardIndex) => {
    const token = modifierTokens(card)[0];
    if (token && (!best || MODIFIER_TOKENS.indexOf(token) < MODIFIER_TOKENS.indexOf(best.token))) best = { token, cardIndex };
  });
  return best;
};

/** Whether a set's cards have modifier pages: some version of the set rolls modifiers. */
export const hasModifierPages = (setId: string, versions: readonly { id: string; modifiers?: number }[]): boolean =>
  versions.some((set) => set.id === setId && !!set.modifiers);

const pagePath = (key: string) => `p/${toHex(sha256(utf8(key))).slice(0, 8)}.html`;

/** The preview image, relative to the site root. */
export const previewImagePath = ({ setId, cardIds, hand }: Preview): string =>
  `p/img/${setId}/${hand.toLowerCase().replace(/_/g, '-')}/${cardIds.join('_')}.jpg`;

/** The one-card image: a card shared on its own, and earlier Full House and Two Pair links. */
export const singleCardImagePath = (setId: string, cardId: string): string => `p/img/${setId}/${cardId}.jpg`;

/** What a preview says, from the hand and set (the cards' names go in the description). */
export const previewTitle = (hand: HandKey, setName: string): string =>
  hand === 'NO_MATCH' ? `A pack from ${setName}` : `A ${POKER_HANDS[hand].name} in ${setName}`;

/** A set's own page, relative to the site root: it previews as the set and opens the app on it. */
export const setPagePath = (setId: string): string => `s/${setId}/`;
