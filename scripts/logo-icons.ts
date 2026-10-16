/**
 * Writes the logo files from the mark in src/styles/logoMark.ts:
 *
 * - src/assets/images/logo-mark.svg, the bare mark in currentColor;
 * - public/favicon.svg, the rounded tile, and public/favicon-32.png from it;
 * - public/apple-touch-icon.png, the square tile at 180px (iOS rounds it).
 *
 *   npm run icons
 *
 * scripts/logo-icons.test.ts fails if the committed SVGs drift from the mark.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { logoMarkSvg, logoTileSvg } from '../src/styles/logoMark.ts';
import { isMainModule } from './main-module.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

export const SVG_FILES: Record<string, string> = {
  'src/assets/images/logo-mark.svg': logoMarkSvg(),
  'public/favicon.svg': logoTileSvg(),
};

export const PNG_FILES: Record<string, { svg: string; size: number; opaque?: boolean }> = {
  'public/favicon-32.png': { svg: logoTileSvg({ size: 32 }), size: 32 },
  'public/apple-touch-icon.png': { svg: logoTileSvg({ rounded: false, size: 180 }), size: 180, opaque: true },
};

if (isMainModule(import.meta.url)) {
  for (const [file, svg] of Object.entries(SVG_FILES)) writeFileSync(`${ROOT}${file}`, svg);
  for (const [file, { svg, size, opaque }] of Object.entries(PNG_FILES)) {
    // Render at 8x and shrink, so the small icon's edges are averaged rather than rasterised.
    const big = await sharp(Buffer.from(svg), { density: 72 * 8 }).png().toBuffer();
    const icon = sharp(big).resize(size, size, { kernel: 'lanczos3' });
    await (opaque ? icon.flatten({ background: '#000' }) : icon).png({ compressionLevel: 9 }).toFile(`${ROOT}${file}`);
  }
  console.log(`wrote ${[...Object.keys(SVG_FILES), ...Object.keys(PNG_FILES)].join(', ')}`);
}
