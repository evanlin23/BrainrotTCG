/**
 * Text-to-vector helpers for card titles and captions. Text becomes SVG paths
 * at build time, so card images don't depend on fonts at runtime.
 */
import opentype from 'opentype.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const fontsDir = fileURLToPath(new URL('./fonts/', import.meta.url));
const loadFont = (file: string) => {
  const buf = readFileSync(fontsDir + file);
  return opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
};
export const titleFont = loadFont('LuckiestGuy-Regular.ttf');
export const bodyFont = loadFont('LilitaOne-Regular.ttf');

const fmt = (n: number) => Number(n.toFixed(2));

/**
 * Serialise opentype path commands ourselves: opentype.js 2.0 sometimes leaves a
 * quadratic control point's x undefined (TrueType "same x as previous point"),
 * which its own toPathData() prints as NaN and truncates the path.
 */
export const toPathData = (commands: opentype.PathCommand[]) => {
  let px = 0;
  const num = (v: number | undefined, fallback: number) => fmt(Number.isFinite(v) ? (v as number) : fallback);
  return commands
    .map((c) => {
      switch (c.type) {
        case 'M':
        case 'L':
          px = num(c.x, px);
          return `${c.type}${px} ${fmt(c.y)}`;
        case 'Q': {
          const x1 = num(c.x1, px);
          px = num(c.x, x1);
          return `Q${x1} ${fmt(c.y1)} ${px} ${fmt(c.y)}`;
        }
        case 'C': {
          const x1 = num(c.x1, px);
          const x2 = num(c.x2, x1);
          px = num(c.x, x2);
          return `C${x1} ${fmt(c.y1)} ${x2} ${fmt(c.y2)} ${px} ${fmt(c.y)}`;
        }
        default:
          return 'Z';
      }
    })
    .join('');
};

/** Largest font size (<= max, >= min) at which the text fits the width. */
export const fitSize = (font: opentype.Font, text: string, maxWidth: number, max: number, min = 12) => {
  const atMax = font.getAdvanceWidth(text, max);
  return Math.max(min, atMax <= maxWidth ? max : Math.floor((max * maxWidth) / atMax));
};

/** Text centred on (cx, baseline) as path data. */
export const centredText = (font: opentype.Font, text: string, cx: number, baseline: number, size: number) => {
  const width = font.getAdvanceWidth(text, size);
  return toPathData(font.getPath(text, cx - width / 2, baseline, size).commands);
};

/** Split text into one or two balanced lines, picking whichever allows the larger font size. */
export const balancedLines = (font: opentype.Font, text: string, maxWidth: number, oneLineMax: number, twoLineMax: number) => {
  const words = text.split(/\s+/).filter(Boolean);
  let best = { lines: [text], size: fitSize(font, text, maxWidth, oneLineMax) };
  for (let i = 1; i < words.length; i++) {
    const lines = [words.slice(0, i).join(' '), words.slice(i).join(' ')];
    const size = Math.min(...lines.map((l) => fitSize(font, l, maxWidth, twoLineMax)));
    if (size > best.size * 1.15) best = { lines, size };
  }
  return best;
};

/**
 * Lay text along a curve y = f(x): each glyph is centred on the curve and
 * rotated to its slope, optionally squeezed horizontally (condensed look).
 * The squeeze is applied to the outline itself, not the transform, so a stroke
 * around the glyph stays the same thickness on every side.
 * Returns one path per glyph with its transform.
 */
export const textOnCurve = (
  font: opentype.Font,
  text: string,
  size: number,
  cx: number,
  curve: (x: number) => number,
  slope: (x: number) => number,
  squeeze = 1,
) => {
  const glyphs = font.stringToGlyphs(text);
  const scale = size / font.unitsPerEm;
  const advances = glyphs.map((g, i) => {
    const kern = i < glyphs.length - 1 ? font.getKerningValue(g, glyphs[i + 1]) : 0;
    return ((g.advanceWidth ?? 0) + kern) * scale * squeeze;
  });
  const total = advances.reduce((a, b) => a + b, 0);
  const capHeight = ((font.tables.os2 as { sCapHeight?: number } | undefined)?.sCapHeight ?? font.unitsPerEm * 0.7) * scale;
  let x = cx - total / 2;
  return glyphs.map((glyph, i) => {
    const width = advances[i];
    const gx = x + width / 2;
    x += width;
    const angle = (Math.atan(slope(gx)) * 180) / Math.PI;
    // Undefined x values (see toPathData) stay undefined, so they still fall back to the previous point.
    const squeezeX = (v: number | undefined) => (v === undefined ? v : v * squeeze);
    const commands = glyph.getPath(-width / 2 / squeeze, capHeight / 2, size).commands.map((c) =>
      c.type === 'Z' ? c : { ...c, x: squeezeX(c.x), ...('x1' in c ? { x1: squeezeX(c.x1) } : {}), ...('x2' in c ? { x2: squeezeX(c.x2) } : {}) },
    ) as opentype.PathCommand[];
    return { d: toPathData(commands), transform: `translate(${fmt(gx)} ${fmt(curve(gx))}) rotate(${fmt(angle)})` };
  });
};
