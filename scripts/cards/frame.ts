/**
 * Composes a card in the Genesis style: the shared Genesis frame (recovered
 * from the original cards by extract-genesis-frame.py) over the card's art,
 * with the title set along the banner's arch and the caption in the box.
 */
import { readFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';
import { balancedLines, bodyFont, centredText, fitSize, textOnCurve, titleFont } from './text.ts';

interface FrameLayout {
  width: number;
  height: number;
  art: { x: number; y: number; width: number; height: number };
  title: { arc: [number, number, number]; xMin: number; xMax: number; height: number };
  caption: { x: number; y: number; width: number; height: number };
}

const TEMPLATE_PNG = new URL('./templates/genesis-frame.png', import.meta.url);
export const LAYOUT: FrameLayout = JSON.parse(readFileSync(new URL('./templates/genesis-frame.json', import.meta.url), 'utf8'));
export const CARD_WIDTH = LAYOUT.width;
export const CARD_HEIGHT = LAYOUT.height;
/** Art window. Illustrations should be drawn for this aspect ratio (about 6:7). */
export const ART_BOX = LAYOUT.art;

/** Bleed so art reaches under the frame's irregular inner edge. */
const BLEED = 8;

/**
 * Title lettering on the pink banner: a near-white fill inside one dark outline, over a dark drop
 * shadow. No light stroke between fill and outline, so letter counters stay open at small sizes.
 */
export const TITLE_STYLE = {
  fillTop: '#ffffff',
  fillBottom: '#ffe3f7',
  outline: '#2a0638',
  /** Outline stroke width as a fraction of the font size (half of it shows outside the letter). */
  outlineWidth: 0.2,
  /** Drop shadow offset (down) as a fraction of the font size. */
  shadowOffset: 0.06,
  /** Narrowest condensing before a long title shrinks instead. */
  minSqueeze: 0.85,
} as const;

export const textOverlaySvg = (title: string, caption: string) => {
  const { arc, xMin, xMax, height } = LAYOUT.title;
  const curve = (x: number) => arc[0] * x * x + arc[1] * x + arc[2];
  const slope = (x: number) => 2 * arc[0] * x + arc[1];
  const titleText = title.toUpperCase();
  // Like the Genesis titles: tall letters first, a little condensed before shrinking.
  const preferred = Math.min(46, height * 0.95);
  const available = xMax - xMin;
  const natural = titleFont.getAdvanceWidth(titleText, preferred);
  const squeeze = Math.max(TITLE_STYLE.minSqueeze, Math.min(1, available / natural));
  const titleSize = fitSize(titleFont, titleText, available / squeeze, preferred, 18);
  const glyphs = textOnCurve(titleFont, titleText, titleSize, (xMin + xMax) / 2, curve, slope, squeeze);
  const glyphPaths = glyphs.map((g) => `<path transform="${g.transform}" d="${g.d}"/>`).join('');

  const box = LAYOUT.caption;
  const { lines, size } = balancedLines(bodyFont, caption, box.width - 24, 40, 34);
  const capSize = Math.max(16, size);
  const mid = box.y + box.height / 2;
  const capPaths = lines
    .map((line, i) => {
      const offset = (i - (lines.length - 1) / 2) * capSize * 1.1;
      return centredText(bodyFont, line, box.x + box.width / 2, mid + offset + capSize * 0.36, capSize);
    })
    .join(' ');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}">
<defs>
  <linearGradient id="title-fill" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${TITLE_STYLE.fillTop}"/><stop offset="1" stop-color="${TITLE_STYLE.fillBottom}"/>
  </linearGradient>
  <g id="title-glyphs">${glyphPaths}</g>
</defs>
<use href="#title-glyphs" y="${(titleSize * TITLE_STYLE.shadowOffset).toFixed(1)}" fill="${TITLE_STYLE.outline}" stroke="${TITLE_STYLE.outline}" stroke-width="${(titleSize * TITLE_STYLE.outlineWidth).toFixed(1)}" stroke-linejoin="round"/>
<use href="#title-glyphs" fill="none" stroke="${TITLE_STYLE.outline}" stroke-width="${(titleSize * TITLE_STYLE.outlineWidth).toFixed(1)}" stroke-linejoin="round"/>
<use href="#title-glyphs" fill="url(#title-fill)"/>
<path d="${capPaths}" fill="none" stroke="#ffffff" stroke-width="${(capSize * 0.14).toFixed(1)}" stroke-linejoin="round"/>
<path d="${capPaths}" fill="#2a0845"/>
</svg>`;
};

/** Render art (any image buffer sharp understands) into a complete card PNG. */
export const composeCard = async (art: Buffer, title: string, caption: string): Promise<Buffer> => {
  const artLayer = await sharp(art)
    .resize(ART_BOX.width + BLEED * 2, ART_BOX.height + BLEED * 2, { fit: 'cover' })
    .png()
    .toBuffer();
  const text = new Resvg(textOverlaySvg(title, caption)).render().asPng();
  return sharp({ create: { width: CARD_WIDTH, height: CARD_HEIGHT, channels: 4, background: '#14022f' } })
    .composite([
      { input: artLayer, left: ART_BOX.x - BLEED, top: ART_BOX.y - BLEED },
      { input: TEMPLATE_PNG.pathname },
      { input: text },
    ])
    .png()
    .toBuffer();
};

/** Rasterise an SVG illustration at 2x the art window size. */
export const rasteriseSvgArt = (svg: Buffer): Buffer =>
  Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: (ART_BOX.width + BLEED * 2) * 2 } }).render().asPng());
