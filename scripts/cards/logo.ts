/**
 * The site logo's wordmark for build-time art, as vector paths. Kept apart from text.ts, whose
 * source is part of every card's build hash, so the pack logo can change without touching cards.
 */
import opentype from 'opentype.js';
import { readFileSync } from 'node:fs';
import { toPathData } from './text.ts';

const buf = readFileSync(new URL('./fonts/RubikGlitch-Regular.ttf', import.meta.url));
/** The wordmark face (--font-logo in src/styles/tokens.css). */
export const logoFont = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

/**
 * Letter-spaced text from `x` along a baseline, set the way the site header sets its wordmark: one
 * span per letter, so no kerning, each advance plus `tracking` em, and a word gap of `space` em.
 * Characters map straight to glyphs: opentype.js 2.0's shaper throws on Rubik Glitch's contextual
 * ccmp lookup, and capitals need no substitutions. Returns the path data and the ink's bounds
 * (from the glyphs' boxes, which can overhang their advances).
 */
export const trackedText = (font: opentype.Font, text: string, x: number, baseline: number, size: number, tracking: number, space: number) => {
  const scale = size / font.unitsPerEm;
  const ink = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
  let pen = x;
  let d = '';
  for (const char of text) {
    if (char === ' ') {
      pen += space * size;
      continue;
    }
    const glyph = font.charToGlyph(char);
    if (glyph.index === 0) throw new Error(`The font has no glyph for "${char}"`);
    d += toPathData(glyph.getPath(pen, baseline, size).commands);
    ink.left = Math.min(ink.left, pen + (glyph.xMin ?? 0) * scale);
    ink.right = Math.max(ink.right, pen + (glyph.xMax ?? 0) * scale);
    ink.top = Math.min(ink.top, baseline - (glyph.yMax ?? 0) * scale);
    ink.bottom = Math.max(ink.bottom, baseline - (glyph.yMin ?? 0) * scale);
    pen += (glyph.advanceWidth ?? 0) * scale + tracking * size;
  }
  return { d, ink };
};

