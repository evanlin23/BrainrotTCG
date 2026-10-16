/**
 * Builds public/og-image.jpg, the 1200x630 link preview: the logo mark (src/styles/logoMark.ts) over
 * a fan of the Brainrot-rarity cards from the five newest openable sets, so it never shows archived
 * cards. The page title names the site beside the preview, so the mark stands alone here.
 *
 *   npm run og-image
 */
import { fileURLToPath } from 'node:url';
import sharp, { type OverlayOptions } from 'sharp';
import { isOpenable, SETS } from '../src/content/sets/index.ts';
import { LOGO_MARK_PATH, LOGO_MARK_SIZE } from '../src/styles/logoMark.ts';
import { BRAND, PAPER } from '../src/styles/palette.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const W = 1200;
const H = 630;
const CARD_H = 360;
const CARD_W = Math.round((CARD_H * 687) / 1024);

const cards = SETS.filter(isOpenable)
  .slice(-5)
  .map((set) => ({ set, card: set.cards.find((c) => c.rarity === 'BRAINROT') ?? set.cards[set.cards.length - 1] }));
// Fan layout, outermost first so the centre card ends up on top.
const SLOTS = [
  { dx: -460, dy: 290, angle: -8 },
  { dx: 460, dy: 290, angle: 8 },
  { dx: -235, dy: 272, angle: -4 },
  { dx: 235, dy: 272, angle: 4 },
  { dx: 0, dy: 250, angle: 0 },
];
const order = [0, 4, 1, 3, 2];

// Binder black, like the app (docs/DESIGN.md): the cards bring the colour.
const background = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#121114"/></svg>`,
);

const layers: OverlayOptions[] = [];
for (const [i, slot] of SLOTS.entries()) {
  const entry = cards[order[i]];
  if (!entry) continue;
  const card = await sharp(`${ROOT}src/content/sets/${entry.set.id}/cards/${entry.card.id}.webp`)
    .resize(CARD_W, CARD_H)
    .rotate(slot.angle, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer({ resolveWithObject: true });
  const left = Math.round(W / 2 + slot.dx - card.info.width / 2);
  const top = Math.round(slot.dy);
  // Crop anything that falls off the canvas (sharp refuses overlays bigger than the base).
  const cropLeft = Math.max(0, -left);
  const cropRight = Math.max(0, left + card.info.width - W);
  const visible = await sharp(card.data)
    .extract({ left: cropLeft, top: 0, width: card.info.width - cropLeft - cropRight, height: Math.min(card.info.height, H - top) })
    .toBuffer();
  layers.push({ input: visible, left: left + cropLeft, top });
}
// The mark in card-stock white with a hard yellow misprint offset, as in the app's header.
const MARK = 150;
const SHIFT = 4;
const box = LOGO_MARK_SIZE + SHIFT;
const markSvg =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${(MARK * box) / LOGO_MARK_SIZE}" height="${(MARK * box) / LOGO_MARK_SIZE}" viewBox="0 0 ${box} ${box}">` +
  `<path transform="translate(${SHIFT} ${SHIFT})" fill="${BRAND}" d="${LOGO_MARK_PATH}"/><path fill="${PAPER}" d="${LOGO_MARK_PATH}"/></svg>`;
layers.push({ input: Buffer.from(markSvg), left: Math.round(W / 2 - MARK / 2), top: 36 });

const out = `${ROOT}public/og-image.jpg`;
await sharp(background).composite(layers).jpeg({ quality: 82, mozjpeg: true }).toFile(out);
console.log(`wrote ${out}: ${cards.map((c) => `${c.set.id}/${c.card.id}`).join(', ')}`);
