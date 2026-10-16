import { CARD_RARITIES } from '../../data/cards';
import { FINISH_INFO } from '../../game/modifiers';
import type { CardWithMeta } from './Card';

type Labelled = Pick<CardWithMeta, 'name' | 'rarity' | 'isHolo'>;

/**
 * A card face's accessible name: the card's name, rarity and holo, which the art shows only by colour
 * and shine. A finish, misprint or New is left out: the reveal's announcement says it, and the face's
 * stickers that show it are hidden from screen readers.
 */
export const cardFaceLabel = (card: Labelled): string =>
  `${card.name}, ${card.isHolo ? 'Holo ' : ''}${CARD_RARITIES[card.rarity].name}`;

/**
 * What the reveal's live region says as a card turns face up, e.g. "Card 3 of 5: Bukangi, Holo Legendary,
 * Gold, new". It is the reveal's one announcement of the card, so it carries what the face's stickers
 * show as well. A face-down card says nothing (null), so nothing is spoiled before the flip.
 */
export const revealAnnouncement = (
  card: Labelled & Pick<CardWithMeta, 'isRevealed' | 'finish' | 'misprint' | 'isNew'>,
  index: number,
  total: number,
): string | null => {
  if (!card.isRevealed) return null;
  const extras = [card.finish && FINISH_INFO[card.finish].name, card.misprint && 'Misprint', card.isNew && 'new'].filter(Boolean);
  return [`Card ${index + 1} of ${total}: ${cardFaceLabel(card)}`, ...extras].join(', ');
};
