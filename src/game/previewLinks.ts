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
 * The cards and hand in the path only choose the preview. The pull itself is re-derived from the
 * proof when the link is opened, as always, so a hand-edited path can dress up a preview but can't
 * change what the link proves.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { handFromCounts, POKER_HANDS, toHex, utf8, type HandKey } from '../engine';

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
 * The preview for a pack, from its cards (`set/card` keys; rarest last, as revealOrder sorts them):
 * the matching cards, most copies first (Two Pair in id order, so each pair of cards has one
 * picture), or the best card if nothing matches.
 */
export const previewOf = (cards: readonly { key: string }[]): Preview | undefined => {
  if (!cards.length) return undefined;
  const counts = new Map<string, number>();
  for (const card of cards) counts.set(card.key, (counts.get(card.key) ?? 0) + 1);
  const hand = handFromCounts([...counts.values()]);
  const matching = [...counts].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const keys = matching.length ? matching.map(([key]) => key) : [cards[cards.length - 1].key];
  return { setId: keys[0].split('/')[0], cardIds: keys.map((key) => key.split('/')[1]), hand };
};

/**
 * The preview page, relative to the site root. With one card the code is the same as the earlier
 * one-card pages', so links shared before still preview (scripts/preview-pages.ts keeps those).
 */
export const previewPath = ({ setId, cardIds, hand }: Preview): string => pagePath(`${setId}/${cardIds.join('+')}/${hand}`);

/** The preview page for one card, shared on its own (from the collection): just that card. */
export const cardPreviewPath = (setId: string, cardId: string): string => pagePath(`${setId}/${cardId}`);

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
