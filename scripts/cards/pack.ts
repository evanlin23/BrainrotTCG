/**
 * Booster pack wrapper for a set, built from the set itself: its colours, the site logo (the mark
 * in src/styles/logoMark.ts and the Rubik Glitch wordmark) and the loud motifs of the card frames
 * and back (starbursts, lightning, skulls, stars, hearts, heavy dark outlines). One sealed foil
 * wrapper with a single central burst badge, no cards on it. Written to `src/content/sets/<set>/pack.webp`,
 * with a small `pack-thumb.webp` for the pack picker.
 *
 * Layout (768x1376, same shape as the pack opener): crimped foil edges, the flap above the tear
 * line (19%) is left clear for the set ribbon the app draws, then the logo, the burst badge and the
 * era.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import sharp from 'sharp';
import type { SetDefinition } from '../../src/engine/index.ts';
import { LOGO_MARK_PATH, LOGO_MARK_SIZE } from '../../src/styles/logoMark.ts';
import { SETS_DIR } from './lib.ts';
import { logoFont, trackedText } from './logo.ts';
import { bodyFont, centredText, fitSize, titleFont } from './text.ts';

export const PACK_WIDTH = 768;
export const PACK_HEIGHT = 1376;
/** Bump when the design changes, so `npm run cards` rebuilds every pack. */
const DESIGN_VERSION = 9;

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
/** Where the burst badge sits: centred, in the band between the logo's plate and the era's. */
export const EMBLEM = { x: W / 2, y: 858, r: 292 };
/** The logo's dark plate, and the era's: spiky bands, like the card back's logo shield and banners. */
export const LOGO_PLATE = { x: 22, y: 270, w: W - 44, h: 292 };
export const ERA_PLATE = { x: 22, y: 1168, w: W - 44, h: 138 };

type Rgb = [number, number, number];
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

/** A small deterministic generator (mulberry32), so a set's confetti is the same on every build. */
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

/** The motifs of the card frames, each drawn in a box about 100 wide, centred on its middle. */
const MOTIFS = {
  star: 'M50 4 L62 36 L96 38 L69 59 L79 92 L50 73 L21 92 L31 59 L4 38 L38 36 Z',
  bolt: 'M62 0 L8 112 L44 112 L26 200 L92 78 L54 78 Z',
  heart: 'M50 90 C8 58 4 28 26 15 C38 9 48 17 50 28 C52 17 62 9 74 15 C96 28 92 58 50 90 Z',
  skull: 'M50 6 C22 6 8 28 13 52 C15 62 24 66 28 70 L28 90 L72 90 L72 70 C76 66 85 62 87 52 C92 28 78 6 50 6 Z',
} as const;
type Motif = keyof typeof MOTIFS;
const BOX: Record<Motif, [number, number]> = { star: [50, 50], bolt: [50, 100], heart: [50, 50], skull: [50, 50] };

/** A skull's features, over a skull of `MOTIFS.skull`: eye sockets, nose and teeth in the outline's ink. */
const skullFace = `<circle cx="34" cy="48" r="11" fill="${INK}"/><circle cx="66" cy="48" r="11" fill="${INK}"/><path d="M50 58 L43 72 L57 72 Z" fill="${INK}"/><path d="M39 78 V90 M50 78 V90 M61 78 V90" stroke="${INK}" stroke-width="4" fill="none"/>`;

/** One motif at (x, y), `size` px tall, tilted `rot` degrees, filled `fill` inside a heavy dark outline. */
const motif = (kind: Motif, x: number, y: number, size: number, rot: number, fill: string, outline = 9) => {
  const [bx, by] = BOX[kind];
  const k = size / (by * 2);
  return (
    `<g transform="translate(${f(x)} ${f(y)}) rotate(${f(rot)}) scale(${k.toFixed(3)}) translate(${-bx} ${-by})">` +
    `<path d="${MOTIFS[kind]}" fill="${fill}" stroke="${INK}" stroke-width="${f(outline / k)}" stroke-linejoin="round"/>` +
    `${kind === 'skull' ? skullFace : ''}</g>`
  );
};

/** A band with spiky top and bottom edges, for the plates behind the logo and the era. */
const spikyPlate = (x: number, y: number, w: number, h: number, depth: number, teeth: number) => {
  const step = w / teeth;
  let d = `M${x} ${y + depth}`;
  for (let i = 0; i < teeth; i++) d += `L${f(x + (i + 0.5) * step)} ${y}L${f(x + (i + 1) * step)} ${y + depth}`;
  d += `L${x + w} ${y + h - depth}`;
  for (let i = teeth; i > 0; i--) d += `L${f(x + (i - 0.5) * step)} ${y + h}L${f(x + (i - 1) * step)} ${y + h - depth}`;
  return `${d}Z`;
};

/** Confetti for the gaps around the badge: no two touching, none on the badge, plates or flap. */
const confetti = (set: SetDefinition, colours: string[]) => {
  const rand = seeded(`pack:${set.id}`);
  const kinds: Motif[] = ['star', 'bolt', 'heart', 'skull', 'star', 'bolt'];
  const placed: { x: number; y: number; r: number }[] = [];
  let out = '';
  for (let attempt = 0; attempt < 400 && placed.length < 18; attempt++) {
    const size = 56 + rand() * 50;
    const r = size * 0.6;
    const x = 36 + r + rand() * (W - 72 - 2 * r);
    const y = LOGO_PLATE.y + LOGO_PLATE.h + 30 + r + rand() * (ERA_PLATE.y - LOGO_PLATE.y - LOGO_PLATE.h - 60 - 2 * r);
    if (Math.hypot(x - EMBLEM.x, y - EMBLEM.y) < EMBLEM.r + r + 6) continue;
    if (placed.some((p) => Math.hypot(p.x - x, p.y - y) < p.r + r + 8)) continue;
    placed.push({ x, y, r });
    const kind = kinds[placed.length % kinds.length];
    out += motif(kind, x, y, size, (rand() - 0.5) * 70, colours[Math.floor(rand() * colours.length)]);
  }
  return out;
};

/** Two SVG layers: the foil goes under the logo, the trim (crimps and text) over it. */
export const wrapperSvg = (set: SetDefinition) => {
  const { hi, mid, lo, base, glow } = packColours(set);
  const rand = seeded(`burst:${set.id}`);
  const { x: cx, y: cy, r: R } = EMBLEM;
  const rays = Array.from({ length: 28 }, (_, i) => {
    const t0 = (i / 28) * Math.PI * 2;
    const t1 = t0 + Math.PI / 28;
    const r = 1600;
    return `<path d="M${cx} ${cy} L${f(cx + r * Math.cos(t0))} ${f(cy + r * Math.sin(t0))} L${f(cx + r * Math.cos(t1))} ${f(cy + r * Math.sin(t1))} Z"/>`;
  }).join('');
  const ridges = Array.from({ length: 96 }, (_, i) => `<rect x="${i * 8}" y="0" width="4" height="${H}"/>`).join('');
  // Big half-cropped bursts on the sides, like the card frame's corner stars.
  const sideBursts = [
    [-14, 690, 170, hi],
    [W + 14, 760, 190, mid],
    [-10, 1080, 190, mid],
    [W + 10, 1050, 170, hi],
  ]
    .map(([x, y, r, c]) => `<path d="${burstPath(x as number, y as number, r as number, (r as number) * 0.55, 11, rand() * 2, rand, 0.08)}" fill="${c}" stroke="${INK}" stroke-width="12" stroke-linejoin="round"/>`)
    .join('');
  const points = 20 + Math.floor(rand() * 5);
  const spin = rand() * Math.PI;
  const badge =
    // Two lightning bolts crossing behind the burst, then the burst in three tiers.
    motif('bolt', cx - 150, cy + 10, 640, 32, mid, 14) +
    motif('bolt', cx + 150, cy + 10, 640, -32, hi, 14) +
    `<path d="${burstPath(cx, cy, R, R * 0.72, points, spin, rand, 0.05)}" fill="${hi}" stroke="${INK}" stroke-width="18" stroke-linejoin="round"/>` +
    `<path d="${burstPath(cx, cy, R * 0.84, R * 0.6, points, spin + Math.PI / points, rand, 0.05)}" fill="${mid}" stroke="${INK}" stroke-width="12" stroke-linejoin="round"/>` +
    `<circle cx="${cx}" cy="${cy}" r="${R * 0.5}" fill="${INK}" stroke="${hi}" stroke-width="10"/>` +
    `<circle cx="${cx}" cy="${cy}" r="${R * 0.43}" fill="${lo}" stroke="${mid}" stroke-width="5"/>` +
    motif('skull', cx, cy + 6, R * 0.74, 0, '#fff7e0', 11) +
    [0, 1, 2, 3, 4, 5].map((i) => motif('star', cx + R * 0.64 * Math.cos(spin + i * (Math.PI / 3)), cy + R * 0.64 * Math.sin(spin + i * (Math.PI / 3)), 56, 0, '#fff7e0', 6)).join('');
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
    <linearGradient id="sheen" x1="0" y1="0" x2="1" y2="0.6">
      <stop offset="0" stop-color="#fff" stop-opacity="0"/>
      <stop offset="0.45" stop-color="#fff" stop-opacity="0"/>
      <stop offset="0.5" stop-color="#fff" stop-opacity="0.2"/>
      <stop offset="0.55" stop-color="#fff" stop-opacity="0"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="glow" cx="${cx / W}" cy="${cy / H}" r="0.5">
      <stop offset="0" stop-color="${escapeXml(glow)}" stop-opacity="0.95"/>
      <stop offset="1" stop-color="${escapeXml(glow)}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="vignette" cx="0.5" cy="0.5" r="0.75">
      <stop offset="0.62" stop-color="#000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000" stop-opacity="0.32"/>
    </radialGradient>
    <pattern id="halftone" width="14" height="14" patternUnits="userSpaceOnUse">
      <circle cx="7" cy="7" r="3.2" fill="${INK}"/>
    </pattern>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#foil)"/>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>
  <g fill="${escapeXml(hi)}" opacity="0.28">${rays}</g>
  <rect width="${W}" height="${H}" fill="url(#halftone)" opacity="0.28"/>
  ${sideBursts}
  ${confetti(set, [hi, mid, '#fff7e0', lo].map(escapeXml))}
  ${badge}
  <path d="${spikyPlate(LOGO_PLATE.x, LOGO_PLATE.y, LOGO_PLATE.w, LOGO_PLATE.h, 12, 30)}" fill="${INK}" stroke="${escapeXml(hi)}" stroke-width="6" stroke-linejoin="round"/>
  ${motif('bolt', 118, 350, 190, -14, hi)}${motif('bolt', W - 118, 350, 190, 14, mid)}${motif('star', 214, 318, 80, -12, mid, 8)}${motif('star', W - 214, 318, 80, 12, hi, 8)}${motif('star', 232, 404, 54, 10, '#fff7e0', 7)}${motif('star', W - 232, 404, 54, -10, '#fff7e0', 7)}
  <path d="${spikyPlate(ERA_PLATE.x, ERA_PLATE.y, ERA_PLATE.w, ERA_PLATE.h, 12, 30)}" fill="${INK}" stroke="${escapeXml(mid)}" stroke-width="6" stroke-linejoin="round"/>
  <rect width="${W}" height="${H}" fill="url(#sheen)"/>
  <rect width="${W}" height="${H}" fill="url(#vignette)"/>
  <g fill="#fff" opacity="0.06">${ridges}</g>
  <rect x="14" y="14" width="${W - 28}" height="${H - 28}" rx="26" fill="none" stroke="${INK}" stroke-width="16"/>
  <rect x="24" y="24" width="${W - 48}" height="${H - 48}" rx="18" fill="none" stroke="${escapeXml(hi)}" stroke-width="4"/>`);
  const trim = svg(`
  <defs>
    <linearGradient id="silver" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#f4f4f8"/><stop offset="0.5" stop-color="#9a9ab0"/><stop offset="1" stop-color="#e2e2ea"/>
    </linearGradient>
  </defs>
  <path d="${zigzag(CRIMP, 14, false)} L${W} 0 L0 0 Z" fill="url(#silver)"/>
  <path d="${zigzag(H - CRIMP, 14, true)} L${W} ${H} L0 ${H} Z" fill="url(#silver)"/>
  <g fill="#000" opacity="0.18">${Array.from({ length: 48 }, (_, i) => `<rect x="${i * 16 + 4}" y="6" width="6" height="${CRIMP - 18}"/><rect x="${i * 16 + 4}" y="${H - CRIMP + 12}" width="6" height="${CRIMP - 18}"/>`).join('')}</g>
  <path d="${centredText(titleFont, set.era.toUpperCase(), W / 2, H - 150, eraSize)}" fill="#fff" stroke="${INK}" stroke-width="10" paint-order="stroke" stroke-linejoin="round"/>
  <path d="${centredText(bodyFont, footer, W / 2, H - 92, footerSize)}" fill="#ffe14d" stroke="${INK}" stroke-width="6" paint-order="stroke" stroke-linejoin="round"/>`);
  return { foil, trim };
};

/** The logo's band: under the flap the set ribbon covers (19%), above the burst badge. */
export const LOGO_SLOT = { top: 288, bottom: 540, width: 660 };

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

const inputHash = (set: SetDefinition) =>
  createHash('sha256')
    .update(JSON.stringify({ DESIGN_VERSION, id: set.id, palette: set.palette, era: set.era, packSize: set.packSize }))
    .update(logoSvg())
    .digest('hex');

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
  const hash = inputHash(set);
  if (!force && manifest['(pack)'] === hash && existsSync(outPath)) {
    if (existsSync(`${SETS_DIR}/${set.id}/pack-thumb.webp`)) return false;
    await buildPackThumb(set.id);
    return true;
  }

  const { foil, trim } = wrapperSvg(set);
  // sharp applies one composite() per pipeline, so the face and its mask are two passes.
  const flat = await sharp(Buffer.from(foil))
    .composite([{ input: Buffer.from(logoSvg()) }, { input: Buffer.from(trim) }])
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
