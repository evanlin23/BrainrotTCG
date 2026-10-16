import { describe, expect, it } from 'vitest';
import { ALL_CARDS } from '../../data/cards';
import { cardFaceLabel, revealAnnouncement } from './cardLabel';
import type { CardWithMeta } from './Card';

const legendary = ALL_CARDS.find((c) => c.rarity === 'LEGENDARY')!;
const meta = (overrides: Partial<CardWithMeta> = {}): CardWithMeta => ({ ...legendary, uniqueId: 1, isRevealed: true, isHolo: false, ...overrides });

describe('cardFaceLabel', () => {
  it('names the card, its rarity and holo', () => {
    expect(cardFaceLabel(meta())).toBe(`${legendary.name}, Legendary`);
    expect(cardFaceLabel(meta({ isHolo: true }))).toBe(`${legendary.name}, Holo Legendary`);
  });
});

describe('revealAnnouncement', () => {
  it('says which card of the pack turned up, with its rarity', () => {
    expect(revealAnnouncement(meta({ isHolo: true }), 2, 5)).toBe(`Card 3 of 5: ${legendary.name}, Holo Legendary`);
  });

  it('adds what the stickers show: the finish, a misprint, and a card new to the player', () => {
    expect(revealAnnouncement(meta({ finish: 'GOLD', misprint: true, isNew: true }), 0, 5))
      .toBe(`Card 1 of 5: ${legendary.name}, Legendary, Gold, Misprint, new`);
    expect(revealAnnouncement(meta({ finish: null, misprint: false, isNew: false }), 4, 5))
      .toBe(`Card 5 of 5: ${legendary.name}, Legendary`);
  });

  it('says nothing for a face-down card, so it cannot spoil the flip', () => {
    expect(revealAnnouncement(meta({ isRevealed: false, isHolo: true, finish: 'DIAMOND', isNew: true }), 0, 5)).toBeNull();
  });
});
