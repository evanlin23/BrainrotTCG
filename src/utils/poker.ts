import { CardWithMeta } from '../components/Card';
import { POKER_HANDS, PokerHand } from '../data/pokerHands';

export type PokerHandResult = PokerHand;

/**
 * Determine the poker hand type and multiplier for a pack of cards
 */
export const getPackMultiplier = (cards: CardWithMeta[]): PokerHandResult => {
    if (!cards || cards.length === 0) return POKER_HANDS.NO_MATCH;

    // Count occurrences of each card ID
    const counts: Record<string, number> = {};
    for (const card of cards) {
        counts[card.id] = (counts[card.id] || 0) + 1;
    }

    const frequencies = Object.values(counts).sort((a, b) => b - a);

    // Determine hand based on highest frequencies
    if (frequencies[0] === 5) return POKER_HANDS.FIVE_OF_A_KIND;
    if (frequencies[0] === 4) return POKER_HANDS.FOUR_OF_A_KIND;
    if (frequencies[0] === 3 && frequencies[1] === 2) return POKER_HANDS.FULL_HOUSE;
    if (frequencies[0] === 3) return POKER_HANDS.THREE_OF_A_KIND;
    if (frequencies[0] === 2 && frequencies[1] === 2) return POKER_HANDS.TWO_PAIR;
    if (frequencies[0] === 2) return POKER_HANDS.PAIR;

    return POKER_HANDS.NO_MATCH;
};
