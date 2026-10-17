/**
 * What each card modifier is called in text: its name and mark (the emoji of the achievement for
 * pulling one). Share text and the link-preview pages (scripts/preview-pages.ts) both use these, so
 * this file stays free of CSS and React. The finish names match game/modifiers.ts FINISH_INFO
 * (modifierLabels.test.ts checks).
 */
import { ACHIEVEMENTS } from '../data/achievements';
import { MODIFIER_TOKENS, type ModifierToken } from './previewLinks';

const ACHIEVEMENT_FOR: Record<ModifierToken, string> = {
  DIAMOND: 'finish_diamond',
  PLATINUM: 'finish_platinum',
  MISPRINT: 'misprint',
  GOLD: 'finish_gold',
  HOLO: 'first_holo',
  SILVER: 'finish_silver',
};

const NAMES: Record<ModifierToken, string> = {
  DIAMOND: 'Diamond',
  PLATINUM: 'Platinum',
  MISPRINT: 'Misprint',
  GOLD: 'Gold',
  HOLO: 'Holo',
  SILVER: 'Silver',
};

const markOf = (token: ModifierToken): string => {
  const icon = ACHIEVEMENTS.find((a) => a.id === ACHIEVEMENT_FOR[token])?.icon;
  if (!icon) throw new Error(`No achievement mark for ${token}`);
  return icon;
};

/** Each modifier's name and mark, e.g. DIAMOND: { name: 'Diamond', mark: '💎' }. */
export const MODIFIER_LABELS: Readonly<Record<ModifierToken, { name: string; mark: string }>> = Object.fromEntries(
  MODIFIER_TOKENS.map((token) => [token, { name: NAMES[token], mark: markOf(token) }]),
) as Record<ModifierToken, { name: string; mark: string }>;

/** A modifier as text: "💎 Diamond". */
export const modifierText = (token: ModifierToken): string => `${MODIFIER_LABELS[token].mark} ${MODIFIER_LABELS[token].name}`;
