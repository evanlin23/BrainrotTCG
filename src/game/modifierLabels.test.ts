import { describe, expect, it } from 'vitest';
import { FINISHES_RAREST_FIRST } from '../engine';
import { ACHIEVEMENTS } from '../data/achievements';
import { FINISH_INFO } from './modifiers';
import { MODIFIER_LABELS, modifierText } from './modifierLabels';

describe('modifier labels', () => {
  it('uses the achievement marks and the finish names', () => {
    const icon = (id: string) => ACHIEVEMENTS.find((a) => a.id === id)?.icon;
    expect(MODIFIER_LABELS.DIAMOND.mark).toBe(icon('finish_diamond'));
    expect(MODIFIER_LABELS.MISPRINT.mark).toBe(icon('misprint'));
    expect(MODIFIER_LABELS.HOLO.mark).toBe(icon('first_holo'));
    for (const finish of FINISHES_RAREST_FIRST) {
      expect(MODIFIER_LABELS[finish].name).toBe(FINISH_INFO[finish].name);
      expect(MODIFIER_LABELS[finish].mark).toBe(icon(`finish_${finish.toLowerCase()}`));
    }
    expect(Object.values(MODIFIER_LABELS).map((l) => l.mark)).toEqual(['💎', '💿', '🖨️', '🥇', '✨', '🥈']);
    expect(modifierText('DIAMOND')).toBe('💎 Diamond');
    expect(modifierText('MISPRINT')).toBe('🖨️ Misprint');
  });
});
