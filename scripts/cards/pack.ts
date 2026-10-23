/**
 * Booster pack wrapper for a set: a sticker bomb, like the original March packs. Characters from
 * the set's own card art, die-cut as stickers with thick white borders and a thin dark edge, overlap
 * each other and the pack's edges at random tilts around a die-cut sticker of the site logo (the
 * mark in src/styles/logoMark.ts and the Rubik Glitch wordmark) on a starburst, over foil in the
 * set's colours. Written to `src/content/sets/<set>/pack.webp`, with a small `pack-thumb.webp` for
 * the pack picker.
 *
 * The stickers' outlines come from scripts/cards/cut-stickers.py, run by hand: its committed output
 * in `src/content/sets/<set>/stickers/` (index.json, and a mask per die-cut sticker) says which part
 * of which art file each sticker is. This file only composites those committed files, so a build
 * gives the same bytes every time.
 *
 * Layout (768x1376, same shape as the pack opener): crimped foil edges; the flap above the tear line
 * (19%) holds only foil, crimp and border, for the set ribbon the app draws and the cut that tears
 * it off; then the stickers and the logo; the era and "N CARDS INSIDE" on a plate at the bottom.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import sharp from 'sharp';
import type { SetDefinition } from '../../src/engine/index.ts';
import { LOGO_MARK_PATH, LOGO_MARK_SIZE } from '../../src/styles/logoMark.ts';
import { SETS_DIR } from './lib.ts';
import { logoFont, trackedText } from './logo.ts';
import { clipToCanvas, dieCut, shadowAndTurn, shapeCoverage, WHITE, type Rgb } from './sticker.ts';
import { bodyFont, centredText, fitSize, titleFont } from './text.ts';

export const PACK_WIDTH = 768;
export const PACK_HEIGHT = 1376;
/** Bump when the design changes, so `npm run cards` rebuilds every pack. */
const DESIGN_VERSION = 10;

const W = PACK_WIDTH;
const H = PACK_HEIGHT;
const CRIMP = 46;
/** Where the pack body sits in the frame. The face is designed at W x H, then scaled into this box. */
export const BODY = { x: 48, y: 148, w: 672, h: 1204 };
/** The pack opener's seam (TEAR_LINE_RATIO in src/hooks/usePackCutter.ts), as a share of the frame's height. */
export const TEAR_LINE = 0.19;
/**
 * Nothing but foil, crimp and border above this line of the face: the flap the cutting UI tears
 * off. The seam is 19% down the frame; the face starts BODY.y into it, scaled from H to BODY.h tall.
 * Eight px of clearance below that.
 */
export const FLAP = Math.ceil(((TEAR_LINE * H - BODY.y) * H) / BODY.h) + 8;

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

const escapeXml = (s: string) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

const zigzag = (y: number, depth: number, up: boolean) => {
  const teeth = 32;
  const step = W / teeth;
  let d = `M0 ${y}`;
  for (let i = 0; i < teeth; i++) d += ` L${(i + 0.5) * step} ${y + (up ? -depth : depth)} L${(i + 1) * step} ${y}`;
  return d;
};

/** The card frames' dark outline colour (the title's outline, TITLE_STYLE.outline in frame.ts). */
const INK = '#2a0638';
/** The starburst behind the logo sticker, centred on the logo. */
export const EMBLEM = { x: W / 2, y: 706, r: 372 };
/** The era's dark plate: a spiky band, like the card back's banners. */
export const ERA_PLATE = { x: 22, y: 1168, w: W - 44, h: 138 };

const toRgb = (hex: string): Rgb => {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as Rgb;
};
const toHex = (c: Rgb) => `#${c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;
/** `a` with `t` of `b` mixed in. */
const mix = (a: string, b: string, t: number) => {
  const [x, y] = [toRgb(a), toRgb(b)];
  return toHex([0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * t) as Rgb);
};
const luma = (hex: string) => {
  const [r, g, b] = toRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
};

/** The set's three colours as a lightest, middle and darkest, whatever order set.json lists them in. */
export const packColours = (set: SetDefinition) => {
  const given = (set.palette ?? []).filter((c) => /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(c));
  const [hi, mid, lo] = [...(given.length >= 3 ? given : ['#ff3df2', '#29f0ff', '#ffe14d'])].sort((x, y) => luma(y) - luma(x));
  // A dark third colour is the foil's body; one too near black would leave every dark set alike.
  const base = luma(lo) > 0.15 ? mix(lo, INK, 0.45) : mix(mid, INK, 0.7);
  return { hi, mid, lo, base, glow: mix(mid, INK, 0.25) };
};

/** A small deterministic generator (mulberry32), so a set's pack is the same on every build. */
const seeded = (seed: string) => {
  let a = createHash('sha256').update(seed).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const f = (n: number) => Number(n.toFixed(1));

/** A starburst: spikes between `inner` and `outer` radius, each jittered by up to `jitter` of the radius. */
const burstPath = (cx: number, cy: number, outer: number, inner: number, points: number, rot: number, rand: () => number, jitter = 0) => {
  let d = '';
  for (let i = 0; i < points * 2; i++) {
    const r = (i % 2 === 0 ? outer : inner) * (1 + (rand() - 0.5) * 2 * jitter);
    const t = rot + (i / (points * 2)) * Math.PI * 2;
    d += `${i ? 'L' : 'M'}${f(cx + r * Math.cos(t))} ${f(cy + r * Math.sin(t))}`;
  }
  return `${d}Z`;
};

/** A band with spiky top and bottom edges, for the plate behind the era. */
const spikyPlate = (x: number, y: number, w: number, h: number, depth: number, teeth: number) => {
  const step = w / teeth;
  let d = `M${x} ${y + depth}`;
  for (let i = 0; i < teeth; i++) d += `L${f(x + (i + 0.5) * step)} ${y}L${f(x + (i + 1) * step)} ${y + depth}`;
  d += `L${x + w} ${y + h - depth}`;
  for (let i = teeth; i > 0; i--) d += `L${f(x + (i - 0.5) * step)} ${y + h}L${f(x + (i - 1) * step)} ${y + h - depth}`;
  return `${d}Z`;
};

/**
 * Two SVG layers: the foil (colour, rays, halftone and the starburst) goes under the stickers; the
 * trim (era plate, sheen, border, crimps and text) over them.
 */
export const wrapperSvg = (set: SetDefinition) => {
  const { hi, mid, base, glow } = packColours(set);
  const rand = seeded(`burst:${set.id}`);
  const { x: cx, y: cy, r: R } = EMBLEM;
  const rays = Array.from({ length: 28 }, (_, i) => {
    const t0 = (i / 28) * Math.PI * 2;
    const t1 = t0 + Math.PI / 28;
    const r = 1600;
    return `<path d="M${cx} ${cy} L${f(cx + r * Math.cos(t0))} ${f(cy + r * Math.sin(t0))} L${f(cx + r * Math.cos(t1))} ${f(cy + r * Math.sin(t1))} Z"/>`;
  }).join('');
  const ridges = Array.from({ length: 96 }, (_, i) => `<rect x="${i * 8}" y="0" width="4" height="${H}"/>`).join('');
  const points = 18 + Math.floor(rand() * 5);
  const spin = rand() * Math.PI;
  const burst =
    `<path d="${burstPath(cx, cy, R, R * 0.74, points, spin, rand, 0.06)}" fill="${escapeXml(hi)}" stroke="${INK}" stroke-width="14" stroke-linejoin="round"/>` +
    `<path d="${burstPath(cx, cy, R * 0.82, R * 0.62, points, spin + Math.PI / points, rand, 0.06)}" fill="${escapeXml(mid)}" stroke="${INK}" stroke-width="10" stroke-linejoin="round"/>`;
  const footer = `${set.packSize} CARDS INSIDE`;
  const eraSize = fitSize(titleFont, set.era.toUpperCase(), W - 160, 64, 30);
  const footerSize = fitSize(bodyFont, footer, W - 200, 40, 20);
  const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${body}</svg>`;
  const foil = svg(`
  <defs>
    <linearGradient id="foil" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${escapeXml(mix(base, hi, 0.25))}"/>
      <stop offset="0.5" stop-color="${escapeXml(base)}"/>
      <stop offset="1" stop-color="${escapeXml(mix(base, mid, 0.35))}"/>
    </linearGradient>
    <radialGradient id="glow" cx="${cx / W}" cy="${cy / H}" r="0.5">
      <stop offset="0" stop-color="${escapeXml(glow)}" stop-opacity="0.95"/>
      <stop offset="1" stop-color="${escapeXml(glow)}" stop-opacity="0"/>
    </radialGradient>
    <pattern id="halftone" width="14" height="14" patternUnits="userSpaceOnUse">
      <circle cx="7" cy="7" r="3.2" fill="${INK}"/>
    </pattern>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#foil)"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>
  <g fill="${escapeXml(hi)}" opacity="0.28">${rays}</g>
  <rect width="${W}" height="${H}" fill="url(#halftone)" opacity="0.28"/>
  ${burst}`);
  const trim = svg(`
  <defs>
    <linearGradient id="sheen" x1="0" y1="0" x2="1" y2="0.6">
      <stop offset="0" stop-color="#fff" stop-opacity="0"/>
      <stop offset="0.45" stop-color="#fff" stop-opacity="0"/>
      <stop offset="0.5" stop-color="#fff" stop-opacity="0.16"/>
      <stop offset="0.55" stop-color="#fff" stop-opacity="0"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="vignette" cx="0.5" cy="0.5" r="0.75">
      <stop offset="0.62" stop-color="#000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000" stop-opacity="0.3"/>
    </radialGradient>
    <linearGradient id="silver" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#f4f4f8"/><stop offset="0.5" stop-color="#9a9ab0"/><stop offset="1" stop-color="#e2e2ea"/>
    </linearGradient>
  </defs>
  <path d="${spikyPlate(ERA_PLATE.x, ERA_PLATE.y, ERA_PLATE.w, ERA_PLATE.h, 12, 30)}" fill="${INK}" stroke="${escapeXml(mid)}" stroke-width="6" stroke-linejoin="round"/>
  <rect width="${W}" height="${H}" fill="url(#sheen)"/>
  <rect width="${W}" height="${H}" fill="url(#vignette)"/>
  <g fill="#fff" opacity="0.05">${ridges}</g>
  <rect x="14" y="14" width="${W - 28}" height="${H - 28}" rx="26" fill="none" stroke="${INK}" stroke-width="16"/>
  <rect x="24" y="24" width="${W - 48}" height="${H - 48}" rx="18" fill="none" stroke="${escapeXml(hi)}" stroke-width="4"/>
  <path d="${zigzag(CRIMP, 14, false)} L${W} 0 L0 0 Z" fill="url(#silver)"/>
  <path d="${zigzag(H - CRIMP, 14, true)} L${W} ${H} L0 ${H} Z" fill="url(#silver)"/>
  <g fill="#000" opacity="0.18">${Array.from({ length: 48 }, (_, i) => `<rect x="${i * 16 + 4}" y="6" width="6" height="${CRIMP - 18}"/><rect x="${i * 16 + 4}" y="${H - CRIMP + 12}" width="6" height="${CRIMP - 18}"/>`).join('')}</g>
  <path d="${centredText(titleFont, set.era.toUpperCase(), W / 2, H - 150, eraSize)}" fill="#fff" stroke="${INK}" stroke-width="10" paint-order="stroke" stroke-linejoin="round"/>
  <path d="${centredText(bodyFont, footer, W / 2, H - 92, footerSize)}" fill="#ffe14d" stroke="${INK}" stroke-width="6" paint-order="stroke" stroke-linejoin="round"/>`);
  return { foil, trim };
};

/** The logo's band, in the middle of the pack on the starburst. */
export const LOGO_SLOT = { top: 586, bottom: 816, width: 616 };

/**
 * The site header's wordmark (src/styles/index.css `.app-logo`): Rubik Glitch capitals in --text,
 * tracked 0.06em with a 0.3em word gap, misprinted in --brand-ink at 0.06em then --brand at 0.09em.
 */
export const LOGO_STYLE = {
  text: 'BRAINROT TCG',
  face: '#f3efe6',
  ink: '#17130a',
  brand: '#ffd23f',
  inkOffset: 0.06,
  brandOffset: 0.09,
  tracking: 0.06,
  space: 0.3,
};

/**
 * The logo for the slot: the wordmark as wide as the slot allows along its bottom, and the mark
 * centred above it. Stacked rather than the header's single row, where the mark would be a 50px
 * chip on a 768px wrapper. Both get the wordmark's misprint, as the header's mark does. Returns the
 * W x H overlay, the wordmark's size, and where the mark and the wordmark's ink sit.
 */
export const logoLockup = () => {
  const s = LOGO_STYLE;
  const unit = trackedText(logoFont, s.text, 0, 0, 1, s.tracking, s.space).ink;
  const size = Math.floor(LOGO_SLOT.width / (unit.right - unit.left + s.brandOffset));
  const misprint = s.brandOffset * size;
  // The printed ink, misprint included, centred across the face and resting on the slot's bottom.
  const x = W / 2 - ((unit.left + unit.right) * size + misprint) / 2;
  const baseline = LOGO_SLOT.bottom - misprint - unit.bottom * size;
  const text = trackedText(logoFont, s.text, x, baseline, size, s.tracking, s.space);
  const markSize = text.ink.top - 0.4 * size - LOGO_SLOT.top;
  const mark = { x: W / 2 - (markSize + misprint) / 2, y: LOGO_SLOT.top, size: markSize };
  const markPath = `<path transform="translate(${mark.x.toFixed(2)} ${mark.y.toFixed(2)}) scale(${(markSize / LOGO_MARK_SIZE).toFixed(4)})" d="${LOGO_MARK_PATH}"/>`;
  const layer = (offset: number, fill: string) => `<use href="#logo" x="${(offset * size).toFixed(2)}" y="${(offset * size).toFixed(2)}" fill="${fill}"/>`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<defs><g id="logo">${markPath}<path d="${text.d}"/></g></defs>` +
    `${layer(s.brandOffset, s.brand)}${layer(s.inkOffset, s.ink)}${layer(0, s.face)}</svg>`;
  return { svg, size, mark, text };
};

const logoSvg = () => logoLockup().svg;

/** The logo sticker's die-cut: a dark backing this far round the logo, then white, then the edge. */
export const LOGO_CUT = { backing: 18, white: 12, edge: 4 };
/** A card sticker's die-cut: white border and dark edge, in px of the face. */
export const STICKER_CUT = { white: 11, edge: 3 };

/** One sticker as cut-stickers.py describes it in the set's `stickers/index.json`. */
export interface StickerSource {
  /** The art file, relative to the set folder (always under `art/`). */
  art: string;
  kind: 'die' | 'round' | 'rect' | 'skip';
  /** [x, y, width, height] of the sticker in the art file's pixels. */
  crop?: [number, number, number, number];
  /** Die-cut stickers: the mask of the crop, in `stickers/`. */
  mask?: string;
  flag?: string;
  source: string;
}

export const stickerIndex = (setId: string): Record<string, StickerSource> => {
  const path = `${SETS_DIR}/${setId}/stickers/index.json`;
  if (!existsSync(path)) throw new Error(`${setId} has no stickers: run scripts/cards/cut-stickers.py --set ${setId}`);
  return JSON.parse(readFileSync(path, 'utf8')).stickers;
};

/**
 * Where the stickers go: (x, y) is the centre and `size` the long side, before the border, in the
 * face's px. Roughly a ring round the logo, the outer ones bleeding off the pack's edge; each set
 * jitters them. Listed back to front.
 */
const SLOTS: [number, number, number][] = [
  [384, 300, 214],
  [124, 296, 232],
  [648, 300, 232],
  [392, 488, 190],
  [100, 520, 214],
  [672, 528, 214],
  [84, 790, 214],
  [690, 800, 214],
  [384, 1010, 236],
  [160, 1010, 244],
  [612, 1010, 244],
  [380, 1196, 220],
];
export const STICKER_COUNT = SLOTS.length;

export interface PlacedSticker extends StickerSource {
  card: string;
  crop: [number, number, number, number];
  x: number;
  y: number;
  size: number;
  rot: number;
}

/**
 * The set's stickers and where they go, picked from its own cards' art with a generator seeded by
 * the set id: die-cut characters first, round and rounded-rect ones only to fill the slots.
 */
export const stickerPlan = (set: SetDefinition): PlacedSticker[] => {
  const index = stickerIndex(set.id);
  const rand = seeded(`stickers:${set.id}`);
  const shuffle = <T>(xs: T[]) => {
    const out = [...xs];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  const usable = set.cards.map((c) => c.id).filter((id) => index[id] && index[id].kind !== 'skip' && index[id].crop);
  const die = shuffle(usable.filter((id) => index[id].kind === 'die'));
  const flat = shuffle(usable.filter((id) => index[id].kind !== 'die'));
  const picked = shuffle([...die, ...flat].slice(0, SLOTS.length));
  return picked.map((card, i) => {
    const [x, y, size] = SLOTS[i];
    const tilt = (8 + rand() * 14) * (rand() < 0.5 ? -1 : 1);
    return {
      ...index[card],
      card,
      crop: index[card].crop!,
      x: Math.round(x + (rand() - 0.5) * 36),
      y: Math.round(y + (rand() - 0.5) * 28),
      size: Math.round(size * (0.94 + rand() * 0.12)),
      rot: Number(tilt.toFixed(1)),
    };
  });
};

const INK_RGB = toRgb(INK);

/** One card sticker, bordered, shadowed and turned: a PNG and its size. */
export const renderSticker = async (setId: string, s: PlacedSticker) => {
  const [left, top, width, height] = s.crop;
  const k = s.size / Math.max(width, height);
  const [tw, th] = [Math.max(1, Math.round(width * k)), Math.max(1, Math.round(height * k))];
  const pad = STICKER_CUT.white + STICKER_CUT.edge + 3;
  const [cw, ch] = [tw + 2 * pad, th + 2 * pad];
  const art = await sharp(`${SETS_DIR}/${setId}/${s.art}`)
    .extract({ left, top, width, height })
    .resize(tw, th, { kernel: 'lanczos3' })
    .removeAlpha()
    .extend({ top: pad, bottom: pad, left: pad, right: pad, background: '#000' })
    .raw()
    .toBuffer();
  let shape: Uint8Array;
  if (s.kind === 'die') {
    const mask = await sharp(`${SETS_DIR}/${setId}/stickers/${s.mask}`)
      .greyscale()
      .resize(tw, th, { kernel: 'lanczos3', fit: 'fill' })
      .extend({ top: pad, bottom: pad, left: pad, right: pad, background: '#000' })
      .extractChannel(0)
      .raw()
      .toBuffer();
    shape = new Uint8Array(mask);
  } else {
    const inner = shapeCoverage(s.kind as 'round' | 'rect', tw, th);
    shape = new Uint8Array(cw * ch);
    for (let y = 0; y < th; y++) shape.set(inner.subarray(y * tw, (y + 1) * tw), (y + pad) * cw + pad);
  }
  const top4 = Buffer.alloc(cw * ch * 4);
  for (let i = 0; i < cw * ch; i++) {
    top4[i * 4] = art[i * 3];
    top4[i * 4 + 1] = art[i * 3 + 1];
    top4[i * 4 + 2] = art[i * 3 + 2];
    top4[i * 4 + 3] = shape[i];
  }
  const rgba = dieCut(shape, cw, ch, [{ grow: STICKER_CUT.white + STICKER_CUT.edge, fill: INK_RGB }, { grow: STICKER_CUT.white, fill: WHITE }], top4);
  return shadowAndTurn(rgba, cw, ch, s.rot);
};

/** The logo as a die-cut sticker: the lockup on a dark backing inside a white border and dark edge. */
const renderLogoSticker = async () => {
  const { data } = await sharp(Buffer.from(logoSvg())).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const shape = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) shape[i] = data[i * 4 + 3];
  const c = LOGO_CUT;
  const rgba = dieCut(
    shape,
    W,
    H,
    [
      { grow: c.backing + c.white + c.edge, fill: INK_RGB },
      { grow: c.backing + c.white, fill: WHITE },
      { grow: c.backing, fill: toRgb('#17130a') },
    ],
    data,
  );
  return shadowAndTurn(rgba, W, H, 0, { x: 6, y: 10, blur: 8, opacity: 0.55 });
};

/** Every input of a set's pack, so a change to any of them rebuilds it. */
const inputHash = (set: SetDefinition) => {
  const hash = createHash('sha256')
    .update(JSON.stringify({ DESIGN_VERSION, id: set.id, palette: set.palette, era: set.era, packSize: set.packSize, cards: set.cards.map((c) => c.id) }))
    .update(logoSvg())
    .update(readFileSync(`${SETS_DIR}/${set.id}/stickers/index.json`));
  for (const s of stickerPlan(set)) {
    hash.update(readFileSync(`${SETS_DIR}/${set.id}/${s.art}`));
    if (s.mask) hash.update(readFileSync(`${SETS_DIR}/${set.id}/stickers/${s.mask}`));
  }
  return hash.digest('hex');
};

/**
 * The face's layers, back to front, each a PNG at its place on the W x H face: the foil, the
 * stickers (clipped to the face, and kept below the flap), the logo sticker, the trim.
 */
export const faceLayers = async (set: SetDefinition) => {
  const { foil, trim } = wrapperSvg(set);
  const layers: { name: string; input: Buffer; left: number; top: number }[] = [];
  for (const s of stickerPlan(set)) {
    const sticker = await renderSticker(set.id, s);
    const left = Math.round(s.x - sticker.width / 2);
    // Its top, shadow included, stays under the flap.
    const top = Math.max(FLAP, Math.round(s.y - sticker.height / 2));
    const clipped = await clipToCanvas(sticker.png, sticker.width, sticker.height, left, top, W, H);
    if (clipped) layers.push({ name: `sticker:${s.card}`, ...clipped });
  }
  const logo = await renderLogoSticker();
  const logoLayer = await clipToCanvas(logo.png, logo.width, logo.height, Math.round((W - logo.width) / 2), Math.round((H - logo.height) / 2), W, H);
  if (logoLayer) layers.push({ name: 'logo', ...logoLayer });
  layers.push({ name: 'trim', input: Buffer.from(trim), left: 0, top: 0 });
  return { foil: Buffer.from(foil), layers };
};

/**
 * The pack picker's thumbnail: the wrapper cropped to the pack and its shadow, 300px wide (a quarter
 * of the full image's bytes, since the picker shows every pack at once).
 */
const buildPackThumb = async (dir: string) => {
  const crop = { left: BODY.x - 8, top: BODY.y - 8, width: BODY.w + 24, height: H - BODY.y + 8 };
  await sharp(`${dir}/pack.webp`).extract(crop).resize(300).webp({ quality: 62, alphaQuality: 80 }).toFile(`${dir}/pack-thumb.webp`);
};

/**
 * Build a set's pack wrapper (and its thumbnail) into `outDir` (the set's folder unless given).
 * Returns false when it was already up to date.
 */
export const buildSetPack = async (set: SetDefinition, manifest: Record<string, string>, force = false, outDir = `${SETS_DIR}/${set.id}`): Promise<boolean> => {
  const outPath = `${outDir}/pack.webp`;
  const hash = inputHash(set);
  if (!force && manifest['(pack)'] === hash && existsSync(outPath)) {
    if (existsSync(`${outDir}/pack-thumb.webp`)) return false;
    await buildPackThumb(outDir);
    return true;
  }

  const { foil, layers } = await faceLayers(set);
  // sharp applies one composite() per pipeline, so the face and its mask are two passes.
  const flat = await sharp(foil)
    .composite(layers.map(({ input, left, top }) => ({ input, left, top })))
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
    .webp({ quality: 80, alphaQuality: 90 })
    .toFile(outPath);
  await buildPackThumb(outDir);
  manifest['(pack)'] = hash;
  return true;
};
