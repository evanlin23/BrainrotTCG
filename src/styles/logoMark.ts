/**
 * The Brainrot TCG mark: nine squares on a grid turned 10.5 degrees anticlockwise, traced from the
 * owner's 400px artwork. This file is the mark's only source. The header and the share images draw
 * the path directly, and scripts/logo-icons.ts writes the SVG and PNG icons from it, so change the
 * mark here and rerun `npm run icons`, `npm run og-image` and `npm run cards`.
 */

/** The mark fills this box edge to edge vertically, and is centred across it. */
export const LOGO_MARK_SIZE = 100;
export const LOGO_MARK_VIEWBOX = `0 0 ${LOGO_MARK_SIZE} ${LOGO_MARK_SIZE}`;

/** One closed quad per square, in absolute coordinates, so canvas Path2D can draw it as is. */
export const LOGO_MARK_PATH =
  'M2.85 30.36 22.62 26.7 26.28 46.47 6.51 50.14Z M7.47 55.29 27.24 51.63 30.9 71.4 11.13 75.07Z ' +
  'M12.09 80.23 31.86 76.56 35.52 96.34 15.75 100Z M32.4 50.67 52.17 47.01 55.84 66.78 36.06 70.45Z ' +
  'M37.02 75.61 56.79 71.94 60.46 91.72 40.68 95.38Z M39.54 8.28 59.32 4.62 62.98 24.39 43.21 28.06Z ' +
  'M64.48 3.66 84.25 0 87.91 19.77 68.14 23.44Z M69.1 28.6 88.87 24.93 92.53 44.71 72.76 48.37Z ' +
  'M73.72 53.53 93.49 49.86 97.15 69.64 77.38 73.3Z';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The bare mark: squares in `fill`, no background. currentColor follows the text it sits in. */
export const logoMarkSvg = (fill = 'currentColor'): string =>
  `<svg xmlns="${SVG_NS}" viewBox="${LOGO_MARK_VIEWBOX}"><path fill="${fill}" d="${LOGO_MARK_PATH}"/></svg>\n`;

/** Margin around the mark inside the tile, in mark units. */
const TILE_PAD = 14;
const TILE = LOGO_MARK_SIZE + TILE_PAD * 2;

/**
 * The tile: white squares on black, like the artwork. Rounded for the favicon; square for the
 * apple-touch-icon, which iOS rounds itself.
 */
export const logoTileSvg = ({ rounded = true, size, pad = TILE_PAD }: { rounded?: boolean; size?: number; pad?: number } = {}): string => {
  const tile = LOGO_MARK_SIZE + pad * 2;
  const rx = rounded ? Math.round(tile * (24 / TILE)) : 0;
  return (
    `<svg xmlns="${SVG_NS}" viewBox="0 0 ${tile} ${tile}"${size ? ` width="${size}" height="${size}"` : ''}>` +
    `<rect width="${tile}" height="${tile}"${rounded ? ` rx="${rx}"` : ''} fill="#000"/>` +
    `<path transform="translate(${pad} ${pad})" fill="#fff" d="${LOGO_MARK_PATH}"/></svg>\n`
  );
};
