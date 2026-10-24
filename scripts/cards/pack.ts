/**
 * Booster pack wrapper for a set: one hero brainrot and the set's name on a glossy foil pouch.
 *
 * The hero is a character from the set's own card art (scripts/cards/pack-heroes.json says which),
 * cut on its own silhouette with a bold ink outline and a soft drop shadow, no white border, over a
 * burst in the set's colours. The set's name sits under it in chunky gradient lettering. There is no
 * site logo and no era: the app's header carries the logo, and the pack's button says the name to a
 * screen reader. Written to `src/content/sets/<set>/pack.webp`, with a small `pack-thumb.webp` for
 * the pack picker.
 *
 * The hero's outline comes from scripts/cards/cut-stickers.py, run by hand: its committed output in
 * `src/content/sets/<set>/stickers/` (index.json and the hero's mask) says which part of which art
 * file the hero is. This file only composites committed files, so a build gives the same bytes every
 * time.
 *
 * Layout (768x1376, same shape as the pack opener): the face is designed at the full frame, then
 * scaled into the pouch (BODY) inside it, shaded like a foil pillow with chrome crimped seals. The
 * flap above the tear line (19%) holds only field, for the cut that tears it off; the hero and the
 * name stay below it.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import sharp from 'sharp';
import type { SetDefinition } from '../../src/engine/index.ts';
import { SETS_DIR } from './lib.ts';
import { titleFont, toPathData } from './text.ts';

export const PACK_WIDTH = 768;
export const PACK_HEIGHT = 1376;
/** Bump when the design changes, so `npm run cards` rebuilds every pack. */
const DESIGN_VERSION = 11;

const W = PACK_WIDTH;
const H = PACK_HEIGHT;
/** Where the pack body sits in the frame. The face is designed at W x H, then scaled into this box. */
export const BODY = { x: 48, y: 148, w: 672, h: 1204 };
/** The pack opener's seam (TEAR_LINE_RATIO in src/hooks/usePackCutter.ts), as a share of the frame's height. */
export const TEAR_LINE = 0.19;
/**
 * Nothing but field above this line of the face: the flap the cutting UI tears off. The seam is 19%
 * down the frame; the face starts BODY.y into it, scaled from H to BODY.h tall. Eight px of
 * clearance below that.
 */
export const FLAP = Math.ceil(((TEAR_LINE * H - BODY.y) * H) / BODY.h) + 8;

/** Ink for outlines and shadows (the card frames' dark outline family). */
const INK: Rgb = [14, 8, 34];
/** The burst's centre. */
const CX = 384;
const BURST_Y = 640;
/** The hero: its long side and the centre of its box, in the face's px. */
export const HERO = { size: 680, y: 600, pad: 30 };
/** The set's name: the middle of its block and the widest size, in the face's px. */
export const NAME = { y: 1040, size: 124, wrapWidth: 600, maxWidth: 640, stroke: 10, depth: 8 };
/** The name's fill, top to bottom. */
const NAME_STOPS = ['#ffffff', '#fff6aa', '#ffcd28', '#ff8c28'];

type Rgb = [number, number, number];

const hexRgb = (hex: string): Rgb => {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as Rgb;
};

/** `rgb` pushed to at least this saturation and brightness (HSV), so a muted palette still pops. */
export const vivid = (rgb: Rgb, sMin = 0.78, vMin = 0.96): Rgb => {
  const [r, g, b] = rgb.map((c) => c / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  const s = Math.max(max === 0 ? 0 : d / max, sMin);
  const v = Math.max(max, vMin);
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  const out = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
  return out.map((c) => Math.trunc(c * 255)) as Rgb;
};

/** The two colours the field is made of: the set's first two palette colours, made vivid. */
export const packColours = (set: SetDefinition): [Rgb, Rgb] => {
  const given = (set.palette ?? []).filter((c) => /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(c));
  const [a, b] = given.length >= 2 ? given : ['#ff3df2', '#29f0ff'];
  return [vivid(hexRgb(a)), vivid(hexRgb(b))];
};

const clamp8 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const gauss = (z: number) => Math.exp(-z * z);

/** The hero of each set: a card id in that set (pack-heroes.json). */
export const packHeroes = (): Record<string, string> => JSON.parse(readFileSync(new URL('./pack-heroes.json', import.meta.url), 'utf8'));

/** One card's cut as cut-stickers.py describes it in the set's `stickers/index.json`. */
export interface HeroSource {
  /** The art file, relative to the set folder (always under `art/`). */
  art: string;
  kind: 'die' | 'round' | 'rect' | 'skip';
  /** [x, y, width, height] of the hero in the art file's pixels. */
  crop: [number, number, number, number];
  /** The 1-bit mask of the crop, in `stickers/`. */
  mask: string;
  flag?: string;
  source: string;
}

export const heroCard = (setId: string): string => {
  const id = packHeroes()[setId];
  if (!id) throw new Error(`${setId} has no hero: add it to scripts/cards/pack-heroes.json`);
  return id;
};

export const heroSource = (setId: string): HeroSource => {
  const path = `${SETS_DIR}/${setId}/stickers/index.json`;
  if (!existsSync(path)) throw new Error(`${setId} has no hero cut: run scripts/cards/cut-stickers.py --set ${setId}`);
  const entry = JSON.parse(readFileSync(path, 'utf8')).stickers?.[heroCard(setId)];
  if (!entry?.mask || !entry.crop) throw new Error(`${setId}'s hero ${heroCard(setId)} has no die-cut mask: run scripts/cards/cut-stickers.py --set ${setId}`);
  return entry;
};

// ---------------------------------------------------------------------------------------------
// The field

/** The set's own colours: a soft two-tone burst, a centre glow and a few sparkles. Opaque RGBA. */
const field = async ([c0, c1]: [Rgb, Rgb]) => {
  const a0 = c0.map((v) => v / 255);
  const a1 = c1.map((v) => v / 255);
  const deep = a0.map((v, i) => v * 0.38 + [0.04, 0.04, 0.16][i] * 0.62);
  const out = Buffer.alloc(W * H * 4, 255);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - CX;
      const dy = y - BURST_Y;
      const r = Math.hypot(dx, dy);
      const th = (Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI);
      const ray = Math.floor(th * 18) % 2;
      const t = clamp01(1 - r / 700) * 0.7;
      const glow = Math.exp(-((r / 260) ** 2)) * 0.65;
      const o = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) {
        const base = deep[c] * (1 - 0.18 * ray) + a0[c] * 0.18 * ray;
        const img = base * (1 - t) + a0[c] * t;
        out[o + c] = clamp8((img + (a1[c] * 0.5 + 0.5 - img) * glow) * 255);
      }
    }
  }
  const star = (cx: number, cy: number, outer: number, inner: number) =>
    Array.from({ length: 8 }, (_, k) => {
      const r = k % 2 === 0 ? outer : inner;
      const a = (k * Math.PI) / 4;
      return `${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`;
    }).join(' ');
  const stars = [[140, 300, 22], [640, 380, 16], [120, 860, 14], [660, 820, 24], [560, 250, 12]]
    .map(([x, y, s]) => `<polygon points="${star(x, y, s, s * 0.18)}" fill="#fff" fill-opacity="0.9"/>`)
    .join('');
  return { rgba: out, stars: await overlay(stars) };
};

/** SVG shapes in the face's px, drawn at twice the size and scaled down, as an RGBA layer. */
const overlay = async (shapes: string, defs = '') => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W * 2}" height="${H * 2}" viewBox="0 0 ${W} ${H}"><defs>${defs}</defs>${shapes}</svg>`;
  return sharp(Buffer.from(svg)).resize(W, H, { kernel: 'lanczos3' }).ensureAlpha().raw().toBuffer();
};

// ---------------------------------------------------------------------------------------------
// The hero

/** sharp hands a one-channel image back as three, so a grey result keeps only its first channel. */
const grey = (image: ReturnType<typeof sharp>) => image.extractChannel(0).raw().toBuffer();

const blurred = (buf: Uint8Array, w: number, h: number, channels: 1 | 3 | 4, sigma: number) => {
  const image = sharp(buf, { raw: { width: w, height: h, channels } }).blur(sigma);
  return channels === 1 ? grey(image) : image.raw().toBuffer();
};

const luma = (r: number, g: number, b: number) => (19595 * r + 38470 * g + 7471 * b + 32768) >> 16;

/** The cut art, scaled so its long side is `size`: a touch more colour and contrast, and sharper. */
const heroArt = async (setId: string, hero: HeroSource, size: number) => {
  const [left, top, width, height] = hero.crop;
  const k = size / Math.max(width, height);
  const [w, h] = [Math.max(1, Math.trunc(width * k)), Math.max(1, Math.trunc(height * k))];
  const rgb = await sharp(`${SETS_DIR}/${setId}/${hero.art}`)
    .extract({ left, top, width, height })
    .removeAlpha()
    .resize(w, h, { kernel: 'lanczos3', fit: 'fill' })
    .raw()
    .toBuffer();
  // Colour 1.18, then contrast 1.06 about the mean luma, then an unsharp mask (1.4, 70%, threshold 2).
  const n = w * h;
  const sat = Buffer.alloc(n * 3);
  let lumaSum = 0;
  for (let i = 0; i < n; i++) {
    const l = luma(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
    for (let c = 0; c < 3; c++) sat[i * 3 + c] = clamp8(l + (rgb[i * 3 + c] - l) * 1.18);
    lumaSum += luma(sat[i * 3], sat[i * 3 + 1], sat[i * 3 + 2]);
  }
  const mean = Math.floor(lumaSum / n + 0.5);
  for (let i = 0; i < n * 3; i++) sat[i] = clamp8(mean + (sat[i] - mean) * 1.06);
  const soft = await blurred(sat, w, h, 3, 1.4);
  const sharpened = Buffer.alloc(n * 3);
  for (let i = 0; i < n * 3; i++) {
    const diff = sat[i] - soft[i];
    sharpened[i] = Math.abs(diff) > 2 ? clamp8(sat[i] + diff * 0.7) : sat[i];
  }
  // The mask is stored small: widen it to the crop, then to the hero's size, and cut it hard.
  const { data: maskFile, info: maskInfo } = await sharp(`${SETS_DIR}/${setId}/stickers/${hero.mask}`).greyscale().raw().toBuffer({ resolveWithObject: true });
  const atCrop = await grey(sharp(maskFile, { raw: { width: maskInfo.width, height: maskInfo.height, channels: 1 } }).resize(width, height, { kernel: 'linear', fit: 'fill' }));
  const soft8 = await grey(sharp(atCrop, { raw: { width, height, channels: 1 } }).resize(w, h, { kernel: 'lanczos3', fit: 'fill' }));
  const mask = Buffer.alloc(n);
  for (let i = 0; i < n; i++) mask[i] = soft8[i] > 127 ? 255 : 0;
  return { rgb: sharpened, mask, w, h };
};

/** Max over a (2r+1) square: a hard-edged grow. */
const dilate = (src: Uint8Array, w: number, h: number, r: number) => {
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let i = Math.max(0, x - r); i <= Math.min(w - 1, x + r); i++) m = Math.max(m, src[y * w + i]);
      tmp[y * w + x] = m;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let j = Math.max(0, y - r); j <= Math.min(h - 1, y + r); j++) m = Math.max(m, tmp[j * w + x]);
      out[y * w + x] = m;
    }
  }
  return out;
};

/** The hero cut on its own silhouette: a bold ink outline and a soft drop shadow, no white border. */
export const heroSticker = async (setId: string, hero: HeroSource) => {
  const art = await heroArt(setId, hero, HERO.size);
  const pad = HERO.pad;
  const [cw, ch] = [art.w + pad * 2, art.h + pad * 2];
  const paste = new Uint8Array(cw * ch);
  for (let y = 0; y < art.h; y++) paste.set(art.mask.subarray(y * art.w, (y + 1) * art.w), (y + pad) * cw + pad);
  const edge = await blurred(paste, cw, ch, 1, 0.6);
  const cut = new Uint8Array(cw * ch);
  for (let i = 0; i < cw * ch; i++) cut[i] = edge[i] > 90 ? 255 : 0;
  const ink = await blurred(dilate(cut, cw, ch, 6), cw, ch, 1, 0.7);
  const moved = new Uint8Array(cw * ch);
  for (let y = 9; y < ch; y++) moved.set(ink.subarray((y - 9) * cw, (y - 9) * cw + cw - 6), y * cw + 6);
  const shadow = await blurred(moved, cw, ch, 1, 7);
  const out = new Float32Array(cw * ch * 4);
  // Paste a colour through a mask, as a straight blend of all four channels (a shadow, then the outline, then the art).
  const blend = (r: number, g: number, b: number, a: number, m: number, o: number) => {
    out[o] = r * m + out[o] * (1 - m);
    out[o + 1] = g * m + out[o + 1] * (1 - m);
    out[o + 2] = b * m + out[o + 2] * (1 - m);
    out[o + 3] = a * m + out[o + 3] * (1 - m);
  };
  for (let i = 0; i < cw * ch; i++) blend(8, 4, 30, 255, (shadow[i] * 0.5) / 255, i * 4);
  for (let i = 0; i < cw * ch; i++) blend(INK[0], INK[1], INK[2], 255, ink[i] / 255, i * 4);
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const i = y * cw + x;
      const inside = x >= pad && x < pad + art.w && y >= pad && y < pad + art.h;
      const j = ((y - pad) * art.w + (x - pad)) * 3;
      blend(inside ? art.rgb[j] : 0, inside ? art.rgb[j + 1] : 0, inside ? art.rgb[j + 2] : 0, inside ? 255 : 0, edge[i] / 255, i * 4);
    }
  }
  const rgba = Buffer.alloc(cw * ch * 4);
  for (let i = 0; i < rgba.length; i++) rgba[i] = clamp8(out[i]);
  return { rgba, width: cw, height: ch, left: Math.trunc(CX - cw / 2), top: Math.trunc(HERO.y - ch / 2) };
};

// ---------------------------------------------------------------------------------------------
// The name

/** The set's name in at most two lines at the largest size (from NAME.size down in steps of 6) that fits. */
export const nameLines = (name: string) => {
  const width = (text: string, size: number) => titleFont.getAdvanceWidth(text, size);
  const wrap = (size: number) => {
    const lines: string[] = [];
    let cur = '';
    for (const word of name.toUpperCase().split(/\s+/).filter(Boolean)) {
      const next = `${cur} ${word}`.trim();
      if (width(next, size) <= NAME.wrapWidth || !cur) cur = next;
      else {
        lines.push(cur);
        cur = word;
      }
    }
    lines.push(cur);
    return lines;
  };
  let size = NAME.size;
  let lines = wrap(size);
  while (lines.length > 2 || Math.max(...lines.map((l) => width(l, size))) > NAME.maxWidth) {
    size -= 6;
    lines = wrap(size);
  }
  return { size, lines };
};

/**
 * Where each line of the name is drawn: the printed ink (the letters, without the outline), centred
 * across the face with its outline, and the lines stacked one font size apart round NAME.y.
 */
export const nameLayout = (name: string) => {
  const { size, lines } = nameLines(name);
  const first = NAME.y - (size * (lines.length - 1)) / 2;
  return {
    size,
    lines: lines.map((text, k) => {
      const box = titleFont.getPath(text, 0, 0, size).getBoundingBox();
      const advance = titleFont.getAdvanceWidth(text, size);
      const x = CX - (Math.min(0, box.x1) + Math.max(advance, box.x2)) / 2;
      const baseline = first + k * size - (box.y1 + box.y2) / 2;
      return { text, x, baseline, ink: { left: x + box.x1, top: baseline + box.y1, right: x + box.x2, bottom: baseline + box.y2 } };
    }),
  };
};

/** The name as chunky cartoon lettering: gradient fill, thick ink outline with a drop extrusion, a gloss on the top half. */
const nameLayer = (name: string) => {
  const { size, lines } = nameLayout(name);
  let defs = '';
  let body = '';
  lines.forEach((line, k) => {
    const d = toPathData(titleFont.getPath(line.text, line.x, line.baseline, size).commands);
    const { top, bottom, left, right } = line.ink;
    defs +=
      `<linearGradient id="g${k}" gradientUnits="userSpaceOnUse" x1="0" y1="${top.toFixed(2)}" x2="0" y2="${bottom.toFixed(2)}">` +
      NAME_STOPS.map((c, i) => `<stop offset="${(i / (NAME_STOPS.length - 1)).toFixed(4)}" stop-color="${c}"/>`).join('') +
      `</linearGradient><clipPath id="c${k}"><rect x="${(left - 4).toFixed(2)}" y="${top.toFixed(2)}" width="${(right - left + 8).toFixed(2)}" height="${((bottom - top) * 0.42).toFixed(2)}"/></clipPath>`;
    const inkStyle = `fill="rgb(${INK})" stroke="rgb(${INK})" stroke-width="${NAME.stroke * 2}" stroke-linejoin="round"`;
    body +=
      `<path d="${d}" ${inkStyle}/><path d="${d}" ${inkStyle} transform="translate(0 ${NAME.depth})"/>` +
      `<path d="${d}" fill="url(#g${k})"/><path d="${d}" fill="#fff" fill-opacity="0.43" clip-path="url(#c${k})"/>`;
  });
  return overlay(body, defs);
};

// ---------------------------------------------------------------------------------------------
// The pouch

/** A glossy foil pillow pouch: the art stays clean; light adds a smooth sheen and bright chrome seals. */
const pouch = (rgb: Uint8Array, w: number, h: number) => {
  const seal = 66;
  const out = Buffer.alloc(w * h * 4);
  const alpha = Buffer.alloc(w * h, 255);
  const tooth = 12;
  const depth = 8;
  for (let y = 0; y < h; y++) {
    const vv = ((y - seal) / (h - 2 * seal - 1)) * 2 - 1;
    const vb = Math.max(-1, Math.min(1, vv));
    const body = y >= seal && y < h - seal;
    const sy = y < seal ? y / seal : (h - 1 - y) / seal;
    for (let x = 0; x < w; x++) {
      const u = (x / (w - 1)) * 2 - 1;
      const au = Math.abs(u);
      const o = (y * w + x) * 4;
      const col = [0, 0, 0];
      if (body) {
        const shade = 1.0 - 0.1 * au ** 4 - 0.28 * clamp01((au - 0.9) / 0.08) ** 2 - 0.1 * Math.abs(vb) ** 10;
        const diag = (x * 0.62 + y) / h;
        let band =
          0.42 * gauss((diag - 0.3) / 0.05) + 0.3 * gauss((diag - 0.4) / 0.014) + 0.22 * gauss((diag - 0.86) / 0.03) + 0.14 * gauss((diag - 0.93) / 0.01);
        band += 0.18 * Math.exp(-(((u + 0.55) / 0.35) ** 2 + ((vv + 0.7) / 0.3) ** 2));
        band *= 1 - Math.abs(vb) ** 6;
        const side = 0.7 * gauss((au - 0.925) / 0.01) * (0.6 + 0.4 * Math.cos(vb * 1.3)) + 0.35 * gauss((au - 0.955) / 0.006);
        const hl = clamp01(band + side);
        const rim = clamp01((au - 0.968) / 0.012);
        const rimC = clamp01(0.8 + 0.16 * Math.cos(vb * 3 + 1.0) + 0.18 * gauss((au - 0.985) / 0.005));
        const tint = [0.93, 0.95, 1.0];
        for (let c = 0; c < 3; c++) {
          const lit = 1 - (1 - (rgb[(y * w + x) * 3 + c] / 255) * shade) * (1 - hl);
          col[c] = lit * (1 - rim) + rimC * tint[c] * rim;
        }
      } else {
        const ridge = 0.5 + 0.5 * Math.cos((x * 2 * Math.PI) / 6.0);
        const prof = 0.7 + 0.22 * gauss((sy - 0.4) / 0.16) - 0.1 * gauss((sy - 0.92) / 0.05);
        const refl = 0.1 * Math.sin(x / 47.0 + 0.7) + 0.06 * Math.sin(x / 19.0 + 2.1);
        const metal = prof + refl + (ridge - 0.5) * 0.3;
        const hue = ((x / w) * 0.9 + sy * 0.25 + 0.15) % 1.0;
        const groove = gauss((sy - 0.985) / 0.02);
        const base = [0.95, 0.96, 1.0];
        for (let c = 0; c < 3; c++) {
          const rainbow = 0.5 + 0.5 * Math.cos(2 * Math.PI * (hue - c / 3));
          col[c] = clamp01(metal * (base[c] * 0.82 + rainbow * 0.18)) * (1 - 0.5 * groove);
        }
      }
      for (let c = 0; c < 3; c++) out[o + c] = clamp8(col[c] * 255);
      // Saw-tooth cuts along the top and bottom edges.
      const zig = depth * Math.abs(((x / tooth) % 1.0) * 2 - 1);
      if (y < zig || h - 1 - y < zig) alpha[y * w + x] = 0;
    }
  }
  return { rgb: out, alpha };
};

// ---------------------------------------------------------------------------------------------
// Building

/** Every input of a set's pack, so a change to any of them rebuilds it. */
const inputHash = (set: SetDefinition) => {
  const dir = `${SETS_DIR}/${set.id}`;
  const hero = heroSource(set.id);
  return createHash('sha256')
    .update(JSON.stringify({ DESIGN_VERSION, id: set.id, name: set.name, palette: set.palette, hero: heroCard(set.id), entry: hero }))
    .update(readFileSync(`${dir}/${hero.art}`))
    .update(readFileSync(`${dir}/stickers/${hero.mask}`))
    .digest('hex');
};

/** The face at the full frame (W x H, opaque): the field, the hero and the name. */
export const renderFace = async (set: SetDefinition) => {
  const { rgba, stars } = await field(packColours(set));
  const hero = await heroSticker(set.id, heroSource(set.id));
  const raw = (input: Buffer, width: number, height: number, left = 0, top = 0) => ({ input, raw: { width, height, channels: 4 as const }, left, top });
  return sharp(rgba, { raw: { width: W, height: H, channels: 4 } })
    .composite([raw(stars, W, H), raw(hero.rgba, hero.width, hero.height, hero.left, hero.top), raw(await nameLayer(set.name), W, H)])
    .raw()
    .toBuffer();
};

/** The whole pack frame, as raw RGBA: transparent margins, a soft shadow, and the shaded pouch. */
export const renderPack = async (set: SetDefinition) => {
  const face = await sharp(await renderFace(set), { raw: { width: W, height: H, channels: 4 } })
    .removeAlpha()
    .resize(BODY.w, BODY.h, { kernel: 'lanczos3' })
    .raw()
    .toBuffer();
  const { rgb, alpha } = pouch(face, BODY.w, BODY.h);
  const edge = await blurred(alpha, BODY.w, BODY.h, 1, 0.5);
  const body = Buffer.alloc(BODY.w * BODY.h * 4);
  for (let i = 0; i < BODY.w * BODY.h; i++) {
    body[i * 4] = rgb[i * 4];
    body[i * 4 + 1] = rgb[i * 4 + 1];
    body[i * 4 + 2] = rgb[i * 4 + 2];
    body[i * 4 + 3] = edge[i];
  }
  // Like the original pack art: the pack sits inside the frame with transparent margins.
  const shadow = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect x="${BODY.x + 8}" y="${BODY.y + 18}" width="${BODY.w}" height="${BODY.h - 16}" rx="14" fill="#000" fill-opacity="0.47"/></svg>`,
  );
  return sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: await sharp(shadow).blur(14).png().toBuffer() }, { input: body, raw: { width: BODY.w, height: BODY.h, channels: 4 }, left: BODY.x, top: BODY.y }])
    .raw()
    .toBuffer();
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
  await sharp(await renderPack(set), { raw: { width: W, height: H, channels: 4 } })
    .webp({ quality: 80, alphaQuality: 90 })
    .toFile(outPath);
  await buildPackThumb(outDir);
  manifest['(pack)'] = hash;
  return true;
};
