import { describe, expect, it } from 'vitest';
import { cardPoints, versionPackChance } from '../engine';
import { DEFAULT_SET_ID, getLatestSet } from '../content/sets';
import { getSetCards } from '../data/cards';
import { FINISH_COLORS } from '../styles/palette';
import { cardStats, formatOneIn, packOddsText } from './cardStats';

describe('formatOneIn', () => {
  it('is the one "1 in N" number: two significant figures, separators, one decimal under 10', () => {
    expect(formatOneIn(2437)).toBe('2,400');
    expect(formatOneIn(1234.5)).toBe('1,200');
    expect(formatOneIn(13.4)).toBe('13');
    expect(formatOneIn(3.33)).toBe('3.3');
    expect(formatOneIn(3)).toBe('3');
  });
});

describe('packOddsText', () => {
  it('rounds to two significant figures with thousands separators', () => {
    expect(packOddsText(1 / 2437)).toBe('1 in 2,400 packs');
    expect(packOddsText(1 / 123456)).toBe('1 in 120,000 packs');
    expect(packOddsText(1 / 37.4)).toBe('1 in 37 packs');
  });

  it('keeps one decimal under 10 packs', () => {
    expect(packOddsText(0.3)).toBe('1 in 3.3 packs');
    expect(packOddsText(0.5)).toBe('1 in 2 packs');
  });

  it('says "Most packs" above one in two, and nothing when unknown or impossible', () => {
    expect(packOddsText(0.51)).toBe('Most packs');
    expect(packOddsText(1)).toBe('Most packs');
    expect(packOddsText(0)).toBeNull();
    expect(packOddsText(null)).toBeNull();
  });
});

describe('cardStats', () => {
  const card = getSetCards(DEFAULT_SET_ID)[0];
  const set = getLatestSet(DEFAULT_SET_ID)!;

  it('uses card points with no pack multiplier and the latest set\'s odds', () => {
    const version = { isHolo: true, finish: null, misprint: false };
    const stats = cardStats(card, version);
    expect(stats.points).toBe(cardPoints(card.rarity, true, null, false));
    expect(stats.chance).toBe(versionPackChance(set, { cardId: card.id, ...version }));
    expect(stats.line).toMatch(/^[\d,]+ pts · (1 in [\d,.]+ packs|Most packs)$/);
  });

  it('shows only the points for a card the latest set no longer has', () => {
    const stats = cardStats({ ...card, id: 'not-a-card' }, { isHolo: false });
    expect(stats.chance).toBe(0);
    expect(stats.line).toBe(`${stats.points.toLocaleString('en-US')} pts`);
  });
});

// WCAG relative luminance contrast, for the finish names RarityBadge prints on its pills.
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe('finish names', () => {
  // --bg-elevated and --surface-2, the pill backgrounds.
  it.each(Object.entries(FINISH_COLORS))('%s reads at 4.5:1 or better on the badge pills', (_, color) => {
    for (const bg of ['#18171b', '#27262c']) expect(contrast(color, bg)).toBeGreaterThanOrEqual(4.5);
  });
});
