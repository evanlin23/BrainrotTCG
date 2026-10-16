/**
 * The design tokens that code paints with directly: canvas (the share images) can't read CSS
 * variables, and a few inline styles pass a colour through to a sheet. Each value mirrors a token in
 * tokens.css, and tests/style-scan.test.ts fails if the two drift apart. Change tokens.css first.
 */
import type { Finish, Rarity } from '../engine';

/** --bg */
export const INK = '#121114';
/** --text */
export const PAPER = '#f3efe6';
/** --text-muted */
export const MUTED = '#b6b0ba';
/** --brand: the one price-sticker yellow. */
export const BRAND = '#ffd23f';
/** --chip-bg: small labels laid over card art. */
export const CHIP_BG = 'rgba(18, 17, 20, 0.88)';

/** --rarity-*, with brainrot as its solid colour (--rarity-brainrot-solid). */
export const RARITY_COLORS = {
  COMMON: '#b8b4bd',
  UNCOMMON: '#5fd38d',
  RARE: '#6aa8ff',
  EPIC: '#c08bff',
  LEGENDARY: '#ffa24d',
  BRAINROT: BRAND,
} as const satisfies Record<Rarity, string>;

/** --finish-* */
export const FINISH_COLORS = {
  SILVER: '#cfd6dd',
  GOLD: '#ffcf4a',
  PLATINUM: '#a8e6ff',
  DIAMOND: '#c9b6ff',
} as const satisfies Record<Finish, string>;

/** --finish-platinum-glow, --finish-diamond-glow and --finish-diamond-glow-2 */
export const FINISH_GLOWS = {
  PLATINUM: 'rgba(168, 230, 255, 0.45)',
  DIAMOND: 'rgba(201, 182, 255, 0.65)',
  DIAMOND_2: 'rgba(126, 231, 255, 0.35)',
} as const;

/** The --foil stops, evenly spaced and closed back to pink so a sweep can repeat. */
export const FOIL_STOPS = ['#ff7ac8', BRAND, '#6ff2c6', '#7ab8ff', '#d38bff', '#ff7ac8'] as const;
