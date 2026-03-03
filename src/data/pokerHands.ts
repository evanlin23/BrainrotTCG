export interface PokerHand {
  name: string;
  multiplier: number;
}

// Poker hand definitions with their multipliers
export const POKER_HANDS: Record<string, PokerHand> = {
  FIVE_OF_A_KIND: { name: '5 of a Kind', multiplier: 1000 },
  FOUR_OF_A_KIND: { name: '4 of a Kind', multiplier: 250 },
  FULL_HOUSE: { name: 'Full House', multiplier: 50 },
  THREE_OF_A_KIND: { name: '3 of a Kind', multiplier: 10 },
  TWO_PAIR: { name: 'Two Pair', multiplier: 5 },
  PAIR: { name: 'Pair', multiplier: 2 },
  NO_MATCH: { name: 'No Matches', multiplier: 1 },
} as const;
