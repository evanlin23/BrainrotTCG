import { describe, expect, it } from 'vitest';
import { scorePack, type Finish, type Rarity } from '../engine';
import { bragText } from './share';

const card = (rarity: Rarity, isHolo = false, finish: Finish | null = null, misprint = false) => ({ cardId: `${rarity}-${isHolo}`, rarity, isHolo, finish, misprint });

describe('bragText', () => {
  it('marks every rarity with a letter as well as a colour, and holo cards with a sparkle', () => {
    const cards = [card('COMMON'), card('UNCOMMON'), card('RARE', true), card('EPIC'), card('LEGENDARY'), card('BRAINROT', true)];
    const lines = bragText(cards, scorePack(cards), 'Peak Brain Rot', 'https://example.test/p').split('\n');
    expect(lines[0]).toBe('🧠 Brainrot TCG · Peak Brain Rot');
    expect(lines[1]).toBe('⬜C 🟩U 🟦R✨ 🟪E 🟧L 🟥B✨');
    expect(lines[2]).toBe('✨ Holo');
    expect(lines).toHaveLength(5);
    expect(lines[4]).toBe('Verify it yourself: https://example.test/p');
  });

  it('marks each card with its modifiers and names the pack\'s, rarest first', () => {
    const cards = [card('COMMON', true), card('RARE', false, 'GOLD'), card('EPIC', true, 'SILVER', true), card('LEGENDARY', false, 'DIAMOND'), card('COMMON')];
    const lines = bragText(cards, scorePack(cards), 'Set', 'u').split('\n');
    expect(lines[1]).toBe('⬜C✨ 🟦R🥇 🟪E🖨️✨🥈 🟧L💎 ⬜C');
    expect(lines[2]).toBe('💎 Diamond · 🖨️ Misprint · 🥇 Gold · ✨ Holo · 🥈 Silver');
    expect(lines[lines.length - 1]).toBe('Verify it yourself: u');
    const platinum = [card('RARE', false, 'PLATINUM'), card('RARE', false, null, true)];
    expect(bragText(platinum, scorePack(platinum), 'Set', 'u').split('\n')[2]).toBe('💿 Platinum · 🖨️ Misprint');
  });

  it('leaves the modifier line out of a pack without any', () => {
    const cards = [card('COMMON'), card('RARE', false, null, false), card('EPIC')];
    const lines = bragText(cards, scorePack(cards), 'Set', 'u').split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[1]).toBe('⬜C 🟦R 🟪E');
    expect(lines[2]).toMatch(/Brainrot Score$/);
  });

  it('keeps the rarity row readable with the colour emoji stripped', () => {
    const cards = [card('LEGENDARY', false, 'GOLD'), card('EPIC', true, 'PLATINUM', true), card('COMMON')];
    const row = bragText(cards, scorePack(cards), 'Set', 'u').split('\n')[1];
    expect(row.replace(/\p{Extended_Pictographic}|️/gu, '')).toBe('L E C');
  });
});
