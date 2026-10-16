/**
 * Booster pack wrapper for a set, built from the set itself: its colours, the
 * logo mark (src/styles/logoMark.ts) and its three rarest cards. Written to `src/content/sets/<set>/pack.webp`, with a small
 * `pack-thumb.webp` for the pack picker.
 *
 * Layout (768x1376, same shape as the pack opener): crimped foil edges, the
 * flap above the tear line (19%) is left clear for the set ribbon the app
 * draws, then the mark, a fan of cards and the era.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import sharp, { type OverlayOptions } from 'sharp';
import { RARITIES_RAREST_FIRST, type SetDefinition } from '../../src/engine/index.ts';
import { LOGO_MARK_PATH, LOGO_MARK_SIZE } from '../../src/styles/logoMark.ts';
import { SETS_DIR } from './lib.ts';
import { bodyFont, centredText, fitSize, titleFont } from './text.ts';

export const PACK_WIDTH = 768;
export const PACK_HEIGHT = 1376;
/** Bump when the design changes, so `npm run cards` rebuilds every pack. */
const DESIGN_VERSION = 5;

const W = PACK_WIDTH;
const H = PACK_HEIGHT;
const CRIMP = 46;
/** Where the pack body sits in the frame. The face is designed at W x H, then scaled into this box. */
const BODY = { x: 48, y: 148, w: 672, h: 1204 };

/** Opaque everywhere except saw-tooth cuts along the top and bottom edges. */
const serratedMask = (w: number, h: number) => {
  const teeth = 28;
  const step = w / teeth;
  const depth = 10;
  let d = `M0 ${depth}`;
  for (let i = 0; i < teeth; i++) d += ` L${(i + 0.5) * step} 0 L${(i + 1) * step} ${depth}`;
  d += ` L${w} ${h - depth}`;
  for (let i = teeth; i > 0; i--) d += ` L${(i - 0.5) * step} ${h} L${(i - 1) * step} ${h - depth}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><path d="${d} Z" fill="#fff"/></svg>`;
};

/** The cards on the wrapper: the rarest card of each of the three rarest tiers present. */
export const packCards = (set: SetDefinition) =>
  RARITIES_RAREST_FIRST.map((r) => set.cards.find((c) => c.rarity === r))
    .filter((c) => c !== undefined)
    .slice(0, 3);

const escapeXml = (s: string) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

const zigzag = (y: number, depth: number, up: boolean) => {
  const teeth = 32;
  const step = W / teeth;
  let d = `M0 ${y}`;
  for (let i = 0; i < teeth; i++) d += ` L${(i + 0.5) * step} ${y + (up ? -depth : depth)} L${(i + 1) * step} ${y}`;
  return d;
};

/** Two SVG layers: the foil goes under the logo and cards, the trim (crimps and text) over them. */
const wrapperSvg = (set: SetDefinition) => {
  const [a = '#ff3df2', b = '#29f0ff', c = '#ffe14d'] = set.palette ?? [];
  const rays = Array.from({ length: 24 }, (_, i) => {
    const t0 = (i / 24) * Math.PI * 2;
    const t1 = t0 + Math.PI / 24;
    const r = 1400;
    const cx = W / 2;
    const cy = 860;
    return `<path d="M${cx} ${cy} L${cx + r * Math.cos(t0)} ${cy + r * Math.sin(t0)} L${cx + r * Math.cos(t1)} ${cy + r * Math.sin(t1)} Z"/>`;
  }).join('');
  const ridges = Array.from({ length: 96 }, (_, i) => `<rect x="${i * 8}" y="0" width="4" height="${H}"/>`).join('');
  const footer = `${set.packSize} CARDS INSIDE`;
  const eraSize = fitSize(titleFont, set.era.toUpperCase(), W - 160, 64, 30);
  const footerSize = fitSize(bodyFont, footer, W - 200, 40, 20);
  const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${body}</svg>`;
  const foil = svg(`
  <defs>
    <linearGradient id="foil" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${escapeXml(a)}"/>
      <stop offset="0.5" stop-color="#2a0f4f"/>
      <stop offset="1" stop-color="${escapeXml(b)}"/>
    </linearGradient>
    <linearGradient id="sheen" x1="0" y1="0" x2="1" y2="0.6">
      <stop offset="0" stop-color="#fff" stop-opacity="0"/>
      <stop offset="0.45" stop-color="#fff" stop-opacity="0"/>
      <stop offset="0.5" stop-color="#fff" stop-opacity="0.22"/>
      <stop offset="0.55" stop-color="#fff" stop-opacity="0"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.62" r="0.55">
      <stop offset="0" stop-color="${escapeXml(c)}" stop-opacity="0.55"/>
      <stop offset="1" stop-color="${escapeXml(c)}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="vignette" cx="0.5" cy="0.5" r="0.75">
      <stop offset="0.6" stop-color="#000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000" stop-opacity="0.55"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#foil)"/>
  <g fill="#fff" opacity="0.05">${rays}</g>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>
  <rect width="${W}" height="${H}" fill="url(#sheen)"/>
  <rect width="${W}" height="${H}" fill="url(#vignette)"/>
  <g fill="#fff" opacity="0.08">${ridges}</g>`);
  const trim = svg(`
  <defs>
    <linearGradient id="silver" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#f4f4f8"/><stop offset="0.5" stop-color="#9a9ab0"/><stop offset="1" stop-color="#e2e2ea"/>
    </linearGradient>
  </defs>
  <path d="${zigzag(CRIMP, 14, false)} L${W} 0 L0 0 Z" fill="url(#silver)"/>
  <path d="${zigzag(H - CRIMP, 14, true)} L${W} ${H} L0 ${H} Z" fill="url(#silver)"/>
  <g fill="#000" opacity="0.18">${Array.from({ length: 48 }, (_, i) => `<rect x="${i * 16 + 4}" y="6" width="6" height="${CRIMP - 18}"/><rect x="${i * 16 + 4}" y="${H - CRIMP + 12}" width="6" height="${CRIMP - 18}"/>`).join('')}</g>
  <path d="${centredText(titleFont, set.era.toUpperCase(), W / 2, H - 150, eraSize)}" fill="#fff" stroke="#12002a" stroke-width="10" paint-order="stroke" stroke-linejoin="round"/>
  <path d="${centredText(bodyFont, footer, W / 2, H - 92, footerSize)}" fill="#ffe14d" stroke="#12002a" stroke-width="6" paint-order="stroke" stroke-linejoin="round"/>`);
  return { foil, trim };
};

const cardLayer = async (path: string, height: number, angle: number) => {
  const width = Math.round((height * 687) / 1024);
  const card = await sharp(path).resize(width, height).png().toBuffer();
  // Soft shadow behind the card.
  const shadow = await sharp({
    create: { width: width + 40, height: height + 40, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width + 40}" height="${height + 40}"><rect x="20" y="26" width="${width}" height="${height}" rx="14" fill="#000" opacity="0.6"/></svg>`) }])
    .blur(10)
    .png()
    .toBuffer();
  return sharp(shadow)
    .composite([{ input: card, left: 20, top: 20 }])
    .rotate(angle, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer({ resolveWithObject: true });
};

/** The logo slot under the ribbon, where the old badge sat. */
const LOGO_SLOT = { size: 280, top: 278 };

/**
 * The mark filling the slot, white outlined in the era text's ink so it reads on every set's
 * colours. (The black favicon tile read too, but sat on the foil as a heavy block.)
 */
const logoSvg = () =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${LOGO_SLOT.size}" height="${LOGO_SLOT.size}" viewBox="-4 -4 ${LOGO_MARK_SIZE + 8} ${LOGO_MARK_SIZE + 8}">` +
  `<path d="${LOGO_MARK_PATH}" fill="#fff" stroke="#12002a" stroke-width="3.6" stroke-linejoin="round" paint-order="stroke"/></svg>`;

const inputHash = (set: SetDefinition, cardFiles: string[]) => {
  const h = createHash('sha256').update(JSON.stringify({ DESIGN_VERSION, palette: set.palette, era: set.era, packSize: set.packSize }));
  h.update(logoSvg());
  for (const f of cardFiles) h.update(readFileSync(f));
  return h.digest('hex');
};

/**
 * The pack picker's thumbnail: the wrapper cropped to the pack and its shadow, 300px wide (a quarter
 * of the full image's bytes, since the picker shows every pack at once).
 */
const buildPackThumb = async (setId: string) => {
  const crop = { left: BODY.x - 8, top: BODY.y - 8, width: BODY.w + 24, height: H - BODY.y + 8 };
  await sharp(`${SETS_DIR}/${setId}/pack.webp`).extract(crop).resize(300).webp({ quality: 70, alphaQuality: 80 }).toFile(`${SETS_DIR}/${setId}/pack-thumb.webp`);
};

/** Build a set's pack wrapper (and its thumbnail). Returns false when it was already up to date. */
export const buildSetPack = async (set: SetDefinition, manifest: Record<string, string>, force = false): Promise<boolean> => {
  const outPath = `${SETS_DIR}/${set.id}/pack.webp`;
  const cards = packCards(set).map((c) => `${SETS_DIR}/${set.id}/cards/${c.id}.webp`);
  if (cards.some((f) => !existsSync(f))) throw new Error(`${set.id}: build the cards before the pack`);
  const hash = inputHash(set, cards);
  if (!force && manifest['(pack)'] === hash && existsSync(outPath)) {
    if (existsSync(`${SETS_DIR}/${set.id}/pack-thumb.webp`)) return false;
    await buildPackThumb(set.id);
    return true;
  }

  const layers: OverlayOptions[] = [];
  layers.push({ input: Buffer.from(logoSvg()), left: Math.round(W / 2 - LOGO_SLOT.size / 2), top: LOGO_SLOT.top });
  // Fan: sides first, rarest card last so it sits on top in the middle.
  const fan = [
    { file: cards[1], dx: -200, top: 610, angle: -10, height: 470 },
    { file: cards[2], dx: 200, top: 610, angle: 10, height: 470 },
    { file: cards[0], dx: 0, top: 568, angle: 0, height: 540 },
  ].filter((f) => f.file);
  for (const f of fan) {
    const layer = await cardLayer(f.file, f.height, f.angle);
    layers.push({ input: layer.data, left: Math.round(W / 2 + f.dx - layer.info.width / 2), top: f.top - 20 });
  }
  const { foil, trim } = wrapperSvg(set);
  // sharp applies one composite() per pipeline, so the face and its mask are two passes.
  const flat = await sharp(Buffer.from(foil))
    .composite([...layers, { input: Buffer.from(trim) }])
    .png()
    .toBuffer();
  const face = await sharp(await sharp(flat).resize(BODY.w, BODY.h).png().toBuffer())
    .composite([{ input: Buffer.from(serratedMask(BODY.w, BODY.h)), blend: 'dest-in' }])
    .png()
    .toBuffer();
  // Like the original pack art: the pack sits inside the frame with transparent margins, and the
  // set ribbon the app draws at 7.5% overlaps its top edge.
  const shadow = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect x="${BODY.x + 6}" y="${BODY.y + 14}" width="${BODY.w}" height="${BODY.h - 10}" rx="10" fill="#000" opacity="0.45"/></svg>`,
  );
  await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: await sharp(shadow).blur(12).png().toBuffer() }, { input: face, left: BODY.x, top: BODY.y }])
    .webp({ quality: 82, alphaQuality: 90 })
    .toFile(outPath);
  await buildPackThumb(set.id);
  manifest['(pack)'] = hash;
  return true;
};
