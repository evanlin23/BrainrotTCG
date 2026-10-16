import { describe, expect, it } from 'vitest';
import { scorePack, type Rarity } from '../engine';
import { bragText } from './share';

const card = (rarity: Rarity, isHolo = false) => ({ cardId: `${rarity}-${isHolo}`, rarity, isHolo });

describe('bragText', () => {
  it('marks every rarity with a letter as well as a colour, and holo cards with a sparkle', () => {
    const cards = [card('COMMON'), card('UNCOMMON'), card('RARE', true), card('EPIC'), card('LEGENDARY'), card('BRAINROT', true)];
    const lines = bragText(cards, scorePack(cards), 'Peak Brain Rot', 'https://example.test/p').split('\n');
    expect(lines[0]).toBe('🧠 Brainrot TCG · Peak Brain Rot');
    expect(lines[1]).toBe('⬜C 🟩U 🟦R✨ 🟪E 🟧L 🟥B✨');
    expect(lines[3]).toBe('Verify it yourself: https://example.test/p');
  });

  it('keeps the rarity row readable with the colour emoji stripped', () => {
    const cards = [card('LEGENDARY'), card('EPIC', true), card('COMMON')];
    const row = bragText(cards, scorePack(cards), 'Set', 'u').split('\n')[1];
    expect(row.replace(/\p{Extended_Pictographic}|️/gu, '')).toBe('L E C');
  });
});
