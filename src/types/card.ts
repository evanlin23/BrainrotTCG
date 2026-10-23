import type { Card } from '../data/cards';
import type { Finish } from '../engine';

/** A card copy as dealt or saved: which card, and the modifiers that make this copy what it is. */
export interface DealtCard extends Card {
  uniqueId: number;
  isHolo: boolean;
  /** Sets with modifiers: the card's finish and whether it's a misprint (game/modifiers.ts). */
  finish?: Finish | null;
  misprint?: boolean;
}

/** A card copy plus the reveal's own state: whether it is face up, and whether the player is new to it. */
export interface CardWithMeta extends DealtCard {
  isRevealed: boolean;
  /** The player didn't own this card before the pack it came in. */
  isNew?: boolean;
}
