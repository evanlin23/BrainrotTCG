import { CardWithMeta } from '../components/Card';

export interface PokerHandResult {
    name: string;
    multiplier: number;
}

export const getPackMultiplier = (cards: CardWithMeta[]): PokerHandResult => {
    if (!cards || cards.length === 0) return { name: "No Matches", multiplier: 1 };

    // Count occurrences of each card ID
    const counts: Record<string, number> = {};
    for (const card of cards) {
        counts[card.id] = (counts[card.id] || 0) + 1;
    }

    const frequencies = Object.values(counts).sort((a, b) => b - a);

    // Determine hand based on highest frequencies
    if (frequencies[0] === 5) {
        return { name: "5 of a Kind", multiplier: 1000 };
    }

    if (frequencies[0] === 4) {
        return { name: "4 of a Kind", multiplier: 250 };
    }

    if (frequencies[0] === 3 && frequencies[1] === 2) {
        return { name: "Full House", multiplier: 50 };
    }

    if (frequencies[0] === 3) {
        return { name: "3 of a Kind", multiplier: 10 };
    }

    if (frequencies[0] === 2 && frequencies[1] === 2) {
        return { name: "Two Pair", multiplier: 5 };
    }

    if (frequencies[0] === 2) {
        return { name: "Pair", multiplier: 2 };
    }

    return { name: "No Matches", multiplier: 1 };
};
